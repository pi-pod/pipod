// @ts-check
/**
 * Editors for what a launch is built from: stored settings layers (organization defaults,
 * organization policy, a person's own defaults) and templates. Each saves whole values with the
 * version it read, so a concurrent change is refused by the server instead of overwritten.
 */
import { api, ApiError } from "./api.js";
import { button, el, jsonArea, statusLine, textArea } from "./dom.js";

const CONFIG_HINT =
  'Pod configuration, in the same shape as .pi-pod/config.json. Example: {"resources": {"cpu": 1, "memoryGB": 2}}';
const PI_FILES_HINT =
  "Files Pi reads in every pod: settings, models, mcporter and subagents (JSON objects), and agents (path → text).";
const INIT_HINT = "Runs in every pod before Pi starts.";
const BAKE_HINT = "Runs once when the pod image is built; its result is cached.";

/** A save refused because someone else saved first: offer the current version instead. */
function staleOffer() {
  return el("p", {}, "It changed since you opened it. ", button("Reload", async () => location.reload()), " to edit the current version (your changes here are discarded).");
}

/**
 * One stored settings layer. Policy holds only constraints; defaults layers also carry the
 * init and bake scripts and the Pi files.
 *
 * @param {{ title: string, intro: string, path: string, policy?: boolean, writable: boolean, readOnlyReason: string }} spec
 */
export async function layerEditor(spec) {
  const layer = await api("GET", spec.path);
  let version = /** @type {number} */ (layer.version);
  const readOnly = !spec.writable;
  const config = jsonArea({
    label: spec.policy ? "Policy" : "Configuration",
    hint: spec.policy
      ? 'Limits every launch in the organization must stay within. Example: {"maxConcurrentPods": 3, "requireTemplate": true}'
      : CONFIG_HINT,
    value: layer.config,
    rows: 10,
    readOnly,
  });
  const init = spec.policy ? null : textArea({ label: "Init script", hint: INIT_HINT, value: layer.initScript, readOnly });
  const bake = spec.policy ? null : textArea({ label: "Bake script", hint: BAKE_HINT, value: layer.bakeScript, readOnly });
  const piFiles = spec.policy ? null : jsonArea({ label: "Pi files", hint: PI_FILES_HINT, value: layer.piFiles, readOnly });
  const status = statusLine();

  /**
   * @param {() => Record<string, unknown>} body
   * @returns {Promise<boolean>} whether it saved
   */
  const save = async (body) => {
    status.clear();
    try {
      const saved = await api("PUT", spec.path, { ...body(), version });
      version = saved.version;
      status.ok(`Saved (version ${version}).`);
      return true;
    } catch (e) {
      status.fail(e, e instanceof ApiError && e.status === 409 ? staleOffer() : undefined);
      return false;
    }
  };
  const write = () => ({
    config: config.read(),
    ...(init && bake && piFiles
      ? { initScript: init.input.value, bakeScript: bake.input.value, piFiles: piFiles.read() }
      : {}),
  });
  const clear = async () => {
    if (!confirm(`Clear everything in ${spec.title}?`)) return;
    const cleared = await save(() => ({ config: {}, ...(spec.policy ? {} : { initScript: "", bakeScript: "", piFiles: {} }) }));
    if (cleared) location.reload();
  };

  return el(
    "section",
    { class: "card" },
    el("h2", {}, spec.title),
    el("p", { class: "intro" }, spec.intro),
    readOnly ? el("p", { class: "notice" }, `Read only: ${spec.readOnlyReason}`) : null,
    config.node,
    init?.node,
    bake?.node,
    piFiles?.node,
    readOnly
      ? null
      : el(
          "div",
          { class: "actions" },
          button("Save", async () => void (await save(write)), { kind: "primary" }),
          button("Clear", clear, { kind: "danger" }),
        ),
    status.node,
  );
}

/**
 * @typedef {object} Template
 * @property {string} id
 * @property {string} name
 * @property {string | null} description
 * @property {"user" | "org"} scope
 * @property {string | null} initScript
 * @property {string | null} bakeScript
 * @property {Record<string, unknown>} config
 * @property {Record<string, unknown>} piSettings
 * @property {number} version
 * @property {string} updatedAt
 */

/**
 * Who may change a template: anyone with templates:write for their own, and only an
 * organization manager for one the whole organization launches.
 * @param {string[]} permissions
 * @param {"user" | "org"} scope
 */
export function canWriteTemplate(permissions, scope) {
  return permissions.includes("templates:write") && (scope === "user" || permissions.includes("org:manage"));
}

/**
 * Creates a template when `id` is null, otherwise edits or deletes it.
 * @param {{ id: string | null, permissions: string[] }} spec
 */
export async function templateEditor(spec) {
  /** @type {Template | null} */
  const existing = spec.id ? await api("GET", `/templates/${encodeURIComponent(spec.id)}`) : null;
  let version = existing?.version ?? 0;
  const readOnly = existing ? !canWriteTemplate(spec.permissions, existing.scope) : !canWriteTemplate(spec.permissions, "user");

  const name = el("input", { type: "text", value: existing?.name ?? "", maxLength: 100, readOnly, required: true });
  const description = textArea({ label: "Description", value: existing?.description ?? "", rows: 2, code: false, readOnly });
  // Sharing is one way: an organization template cannot be taken back from the people using it.
  const scope = el(
    "select",
    { disabled: readOnly || existing?.scope === "org" },
    el("option", { value: "user", selected: existing?.scope !== "org" }, "Personal — only you launch it"),
    el("option", {
      value: "org",
      selected: existing?.scope === "org",
      disabled: !spec.permissions.includes("org:manage"),
    }, "Organization — everyone in the organization launches it"),
  );
  const config = jsonArea({ label: "Configuration", hint: CONFIG_HINT, value: existing?.config ?? {}, rows: 10, readOnly });
  const init = textArea({ label: "Init script", hint: INIT_HINT, value: existing?.initScript ?? "", readOnly });
  const bake = textArea({ label: "Bake script", hint: BAKE_HINT, value: existing?.bakeScript ?? "", readOnly });
  const piSettings = jsonArea({ label: "Pi files", hint: PI_FILES_HINT, value: existing?.piSettings ?? {}, readOnly });
  const status = statusLine();

  const save = async () => {
    status.clear();
    try {
      if (existing && existing.scope === "user" && scope.value === "org" &&
        !confirm("Share this template with the whole organization? It cannot be made personal again.")) return;
      const body = {
        name: name.value.trim(),
        description: description.input.value,
        scope: /** @type {"user" | "org"} */ (scope.value),
        config: config.read(),
        initScript: init.input.value,
        bakeScript: bake.input.value,
        piSettings: piSettings.read(),
      };
      if (!body.name) throw new Error("A template needs a name.");
      if (!existing) {
        /** @type {Template} */
        const created = await api("POST", "/templates", body);
        location.hash = `#/templates/${created.id}`;
        return;
      }
      /** @type {Template} */
      const saved = await api("PATCH", `/templates/${encodeURIComponent(existing.id)}`, { ...body, expectedVersion: version });
      version = saved.version;
      if (saved.scope === "org") scope.disabled = true;
      status.ok(`Saved (version ${version}).`);
    } catch (e) {
      status.fail(e, e instanceof ApiError && e.status === 409 && /version/.test(e.message) ? staleOffer() : undefined);
    }
  };
  const remove = async () => {
    if (!existing || !confirm(`Delete the template "${existing.name}"?`)) return;
    try {
      await api("DELETE", `/templates/${encodeURIComponent(existing.id)}`);
      location.hash = "#/templates";
    } catch (e) {
      status.fail(e);
    }
  };

  return el(
    "section",
    { class: "card" },
    el("h2", {}, existing ? `Template: ${existing.name}` : "New template"),
    readOnly
      ? el("p", { class: "notice" }, existing?.scope === "org"
          ? "Read only: changing an organization template requires templates:write and org:manage."
          : "Read only: requires templates:write.")
      : null,
    el("label", { class: "field" }, el("span", { class: "label" }, "Name"), name),
    description.node,
    el("label", { class: "field" }, el("span", { class: "label" }, "Who launches it"), scope),
    config.node,
    init.node,
    bake.node,
    piSettings.node,
    readOnly
      ? null
      : el(
          "div",
          { class: "actions" },
          button(existing ? "Save" : "Create", save, { kind: "primary" }),
          existing ? button("Delete", remove, { kind: "danger" }) : null,
        ),
    status.node,
  );
}

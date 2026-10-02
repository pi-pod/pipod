// @ts-check
/**
 * Editors for what a launch is built from: stored settings layers (organization defaults, a
 * person's own settings), organization policy, and templates. Each is one form with one Save,
 * which sends the whole value with the version it read, so a concurrent change is refused by
 * the server instead of overwritten.
 */
import { api, ApiError } from "./api.js";
import { button, el } from "./dom.js";
import {
  FieldError,
  checkField,
  choiceField,
  createForm,
  filesField,
  jsonField,
  linesField,
  numberField,
  someOfField,
  textBlockField,
  textField,
} from "./form.js";

/**
 * GET /settings/defaults: what a key no layer sets comes to, and the choices on this server.
 * @typedef {object} Defaults
 * @property {Record<string, unknown>} config
 * @property {Record<string, number | boolean>} nestedPods
 * @property {string[]} providers
 * @property {string[]} thinkingLevels
 * @property {{ cpu?: number, memoryGB?: number, diskGB?: number }} podLimits
 */

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

/** @typedef {import("./form.js").Section} Section */
/** @typedef {import("./form.js").Inherited} Inherited */

/** The open editor's unsaved-changes check; the page asks it before navigating away. */
let unsaved = () => false;

export function hasUnsavedChanges() {
  return unsaved();
}

/** Called when the page moves on, so a closed editor's changes stop counting. */
export function closeEditor() {
  unsaved = () => false;
}

/**
 * Who may change a template: anyone with templates:write for their own, and only an
 * organization manager for one the whole organization launches.
 * @param {string[]} permissions
 * @param {"user" | "org"} scope
 */
export function canWriteTemplate(permissions, scope) {
  return permissions.includes("templates:write") && (scope === "user" || permissions.includes("org:manage"));
}

// ---------------------------------------------------------------------------
// What each form shows
// ---------------------------------------------------------------------------

/**
 * The settings every layer and template carries: pod configuration, scripts and Pi's files.
 * @param {{ pi: string, defaults: Defaults, policy: Record<string, any> }} spec
 *   `pi` is where the document keeps Pi's files: `piFiles` on a layer, `piSettings` on a template.
 * @returns {Section[]}
 */
function settingsSections({ pi, defaults, policy }) {
  const limits = defaults.podLimits;
  const limit = (/** @type {number | undefined} */ max) => (max ? `Up to ${max} on this server.` : undefined);
  const capped = (/** @type {unknown} */ max) => (typeof max === "number" ? ` Organization policy allows at most ${max}.` : "");
  return [
    {
      title: "Pod size",
      fields: [
        // More than this server runs is never useful: CPU and disk would be reduced at launch,
        // and memory would fail every launch.
        numberField({ path: "config.resources.cpu", label: "CPUs", min: 1, max: limits.cpu, hint: limit(limits.cpu) }),
        numberField({ path: "config.resources.memoryGB", label: "Memory", unit: "GB", min: 1, max: limits.memoryGB, hint: limit(limits.memoryGB) }),
        numberField({ path: "config.resources.diskGB", label: "Disk", unit: "GB", min: 1, max: limits.diskGB, hint: limit(limits.diskGB) }),
      ],
    },
    {
      title: "Pi",
      fields: [
        textField({
          path: "config.pi.model",
          label: "Model",
          placeholder: "Pi's default",
          hint: "provider/model-id, such as anthropic/claude-opus-4-7.",
        }),
        choiceField({
          path: "config.pi.thinking",
          label: "Thinking",
          blank: "Pi's default",
          options: defaults.thinkingLevels.map((level) => /** @type {[string, string]} */ ([level, level])),
        }),
        choiceField({
          path: "config.pi.sessionNaming",
          label: "Session names",
          blank: "Not set",
          options: [["auto", "From the first prompt"], ["off", "Leave unnamed"]],
        }),
      ],
    },
    {
      title: "When a pod is idle",
      intro: "A stopped pod keeps its files and starts again when you attach. An archived pod is moved to cold storage and can be restored.",
      fields: [
        numberField({
          path: "config.idleTimeoutMinutes",
          label: "Stop after idle",
          unit: "minutes",
          min: 0,
          hint: `0 never stops it.${capped(policy["maxIdleTimeoutMinutes"])}`,
        }),
        numberField({
          path: "config.archiveAfterMinutes",
          label: "Archive after stopped",
          unit: "minutes",
          min: 0,
          hint: `0 never archives it.${capped(policy["maxArchiveAfterMinutes"])}`,
        }),
      ],
    },
    {
      title: "Network",
      fields: [
        choiceField({
          path: "config.egress.mode",
          label: "Internet access",
          blank: "Not set",
          options: [["open", "Any host"], ["allowlist", "Only the allowed hosts"]],
          hint: policy["requireEgressMode"] === "allowlist" ? "Organization policy requires allowed hosts only." : undefined,
        }),
        choiceField({
          path: "config.egress.builtins",
          label: "Project hosts",
          blank: "Not set",
          options: [[true, "Also allowed"], [false, "Not allowed"]],
          hint: "The project's git remote and the base URLs in its env file.",
        }),
        linesField({
          path: "config.egress.allow",
          label: "Allowed hosts",
          hint: "One per line; *.example.com covers its subdomains. Pi packages from npm need registry.npmjs.org.",
          rows: 4,
        }),
      ],
    },
    {
      title: "Setup scripts",
      intro: "Shell scripts. Every level's script runs: the organization's first, then the template's and your own.",
      fields: [
        textBlockField({
          path: "bakeScript",
          label: "Build script",
          code: true,
          placeholder: "# apt-get install -y ripgrep",
          hint: "Runs once when the pod image is built, and the result is reused. Put slow installs here.",
        }),
        textBlockField({
          path: "initScript",
          label: "Start script",
          code: true,
          placeholder: "# git clone https://github.com/you/project .",
          hint: "Runs in every new pod before Pi starts.",
        }),
        choiceField({
          path: "config.initOnFailure",
          label: "If the start script fails",
          blank: "Not set",
          options: [["abort", "Stop the launch"], ["continue", "Start Pi anyway"], ["prompt", "Ask"]],
        }),
        numberField({ path: "config.initTimeoutSeconds", label: "Start script time limit", unit: "seconds", min: 1 }),
      ],
    },
    {
      title: "Pi packages and files",
      collapsed: true,
      intro: "Installed and written into every pod, in addition to what other levels add.",
      fields: [
        linesField({
          path: `${pi}.settings.packages`,
          label: "Packages",
          placeholder: "npm:pi-mcporter",
          hint: "One package source per line, as in Pi's settings.json.",
        }),
        filesField({
          path: `${pi}.agents`,
          label: "Agent files",
          namePlaceholder: "reviewer.md",
          hint: "Written to ~/.pi/agent/agents/, such as subagent definitions.",
        }),
        jsonField({ path: `${pi}.settings`, rest: true, label: "settings.json", hint: "Any other Pi settings." }),
        jsonField({ path: `${pi}.models`, label: "models.json", hint: "Custom models and providers." }),
        jsonField({ path: `${pi}.mcporter`, label: "mcporter.json" }),
        jsonField({ path: `${pi}.subagents`, label: "subagents.json" }),
      ],
    },
    {
      title: "Advanced",
      collapsed: true,
      fields: [
        jsonField({
          path: "config",
          rest: true,
          rows: 6,
          label: "Other configuration",
          hint: "Any other key of .pi-pod/config.json, such as labels, image, workdir, deniedProviders or pi.chords.",
        }),
      ],
    },
  ];
}

/**
 * Organization policy: ceilings and denials applied after every other layer.
 * @param {Defaults} defaults
 * @returns {Section[]}
 */
function policySections(defaults) {
  const nested = defaults.nestedPods;
  const childLimit = (/** @type {string} */ key) => `${nested[key]} (default)`;
  return [
    {
      title: "Launches",
      fields: [
        numberField({ path: "maxConcurrentPods", label: "Pods running at once", min: 1, blank: "No limit", hint: "Across the whole organization. Stopped pods do not count." }),
        checkField({ path: "requireTemplate", label: "Every launch must use a template" }),
        someOfField({ path: "allowedProviders", label: "Providers", options: defaults.providers }),
      ],
    },
    {
      title: "Idle limits",
      intro: "Pods that ask for longer, or for never, get these instead.",
      fields: [
        numberField({ path: "maxIdleTimeoutMinutes", label: "Longest idle before stopping", unit: "minutes", min: 1, blank: "No limit" }),
        numberField({ path: "maxArchiveAfterMinutes", label: "Longest stopped before archiving", unit: "minutes", min: 1, blank: "No limit" }),
      ],
    },
    {
      title: "Network",
      fields: [
        checkField({
          path: "requireEgressMode",
          label: "Allowed hosts only",
          on: "allowlist",
          off: undefined,
          hint: "Pods set to reach any host are limited to their allowed hosts.",
        }),
        linesField({ path: "forbiddenEgressHosts", label: "Forbidden hosts", hint: "One per line. Removed from every allowlist." }),
      ],
    },
    {
      title: "Pods launching pods",
      intro: "What a pod's own agent may do with child pods.",
      fields: [
        checkField({ path: "nestedPods.enabled", label: "Pods may launch child pods", otherwise: true }),
        numberField({ path: "nestedPods.maxDepth", label: "Deepest nesting", min: 0, max: 8, blank: childLimit("maxDepth") }),
        numberField({ path: "nestedPods.maxChildrenPerPod", label: "Children per pod", min: 0, max: 100, blank: childLimit("maxChildrenPerPod") }),
        numberField({ path: "nestedPods.maxPodsPerLineage", label: "Pods per family", min: 1, max: 500, blank: childLimit("maxPodsPerLineage") }),
        checkField({ path: "nestedPods.allowFileSend", label: "Pods may send files to other pods", otherwise: true }),
        checkField({ path: "nestedPods.allowFileReceive", label: "Pods may copy files out of other pods", otherwise: true }),
      ],
    },
    {
      title: "Notifications",
      fields: [
        checkField({ path: "notifications.redacted", label: "Hide pod names and summaries in push notifications" }),
      ],
    },
  ];
}

/**
 * The policy as stored, with the day-valued archive ceiling it may still carry read as the
 * minute one the server now applies, so saving the form keeps the ceiling.
 * @param {Record<string, any>} stored
 */
function currentPolicy(stored) {
  const { maxArchiveAfterDays, ...policy } = stored;
  if (policy["maxArchiveAfterMinutes"] === undefined && typeof maxArchiveAfterDays === "number") {
    policy["maxArchiveAfterMinutes"] = maxArchiveAfterDays * 24 * 60;
  }
  return policy;
}

// ---------------------------------------------------------------------------
// The editing page
// ---------------------------------------------------------------------------

/**
 * One card that edits one stored value, with a bar that saves or discards the changes.
 * @param {{
 *   title: string | Node,
 *   intro?: string | Node | null,
 *   notice?: string | null,
 *   head?: Node[],
 *   sections: Section[],
 *   value: Record<string, unknown>,
 *   inherited?: Inherited[],
 *   readOnly: boolean,
 *   errorPrefix: string,
 *   save: (doc: Record<string, unknown>) => Promise<Record<string, unknown>>,
 *   saved?: (value: Record<string, unknown>) => void,
 *   saveLabel?: string,
 *   alwaysSavable?: boolean,
 * }} spec
 */
function editor(spec) {
  let current = spec.value;
  let dirty = false;
  const messages = el("div", { class: "messages", role: "alert" });
  const state = el("span", { class: "state" });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let fade;
  // The bar shows only while there is something to save or say, so it never hides the form
  // for nothing.
  const setDirty = (/** @type {boolean} */ value) => {
    dirty = value;
    clearTimeout(fade);
    state.textContent = dirty ? "Unsaved changes" : "";
    discardButton.hidden = !dirty;
    bar.hidden = !dirty && !spec.alwaysSavable;
  };
  const form = createForm(spec.sections, {
    value: current,
    inherited: spec.inherited,
    readOnly: spec.readOnly,
    onChange: () => {
      messages.replaceChildren();
      setDirty(true);
    },
  });

  /** @param {string} text @param {string[]} [lines] @param {Node} [action] */
  const fail = (text, lines = [], action) => {
    messages.replaceChildren(el("strong", {}, text));
    if (lines.length) messages.append(el("ul", {}, ...lines.map((line) => el("li", {}, line))));
    if (action) messages.append(action);
    form.node.querySelector(".invalid, .field-error:not(:empty)")?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const save = async () => {
    messages.replaceChildren();
    let doc;
    try {
      doc = form.read();
    } catch (e) {
      if (!(e instanceof FieldError)) throw e;
      e.field?.error(e.message);
      return fail("Fix the highlighted field first.");
    }
    state.textContent = "Saving…";
    try {
      current = await spec.save(doc);
    } catch (e) {
      setDirty(true);
      if (e instanceof ApiError && e.status === 409 && /version/.test(e.message)) {
        const reload = button("Load the current version", async () => {
          unsaved = () => false;
          location.reload();
        });
        return fail("Someone else saved this since you opened it. Your changes were not saved.", [], el("p", {}, reload));
      }
      if (!(e instanceof ApiError)) return fail(e instanceof Error ? e.message : String(e));
      if (e.status === 401) return fail("Not saved: your session ended. Copy what you need, then reload the page to sign in again.");
      const lines = form.showErrors(e.lines.map(withoutRepeatedPath), spec.errorPrefix);
      const placed = lines.length < e.lines.length ? " See the highlighted fields." : "";
      return fail(`Not saved: ${e.message}.${placed}`, lines);
    }
    form.load(current);
    setDirty(false);
    state.textContent = "Saved.";
    bar.hidden = false;
    fade = setTimeout(() => setDirty(false), 2500);
    spec.saved?.(current);
  };

  const saveButton = button(spec.saveLabel ?? "Save", save, { kind: "primary" });
  const discardButton = button("Discard", async () => {
    form.load(current);
    form.clearErrors();
    messages.replaceChildren();
    setDirty(false);
  });
  const bar = el("div", { class: "save-bar" }, messages, el("div", { class: "bar-row" }, state, discardButton, saveButton));
  setDirty(false);
  unsaved = () => dirty;

  return el(
    "section",
    { class: "card" },
    el("div", { class: "card-head" }, el("h2", {}, spec.title), ...(spec.head ?? [])),
    spec.intro ? el("p", { class: "intro" }, spec.intro) : null,
    spec.notice ? el("p", { class: "notice" }, spec.notice) : null,
    form.node,
    spec.readOnly ? null : bar,
  );
}

/**
 * The server prefixes a config finding with its path, and the finding often names the path
 * again ("resources.cpu: resources.cpu: must be >= 1"); one is enough beside the field.
 * @param {string} line
 */
function withoutRepeatedPath(line) {
  const match = /^([\w.[\]-]+): (.+)$/.exec(line);
  return match && match[2]?.startsWith(`${match[1]}: `) ? match[2] : line;
}

// ---------------------------------------------------------------------------
// The three kinds of thing edited
// ---------------------------------------------------------------------------

/**
 * One stored settings layer: the organization's defaults or a person's own.
 * @param {{
 *   title: string,
 *   intro: string | Node,
 *   path: string,
 *   writable: boolean,
 *   readOnlyReason: string,
 *   defaults: Defaults,
 *   policy: Record<string, any>,
 *   inherited: Inherited[],
 * }} spec
 */
export async function layerEditor(spec) {
  const layer = await api("GET", spec.path);
  let version = /** @type {number} */ (layer.version);
  return editor({
    title: spec.title,
    intro: spec.intro,
    notice: spec.writable ? null : `Read only: ${spec.readOnlyReason}`,
    sections: settingsSections({ pi: "piFiles", defaults: spec.defaults, policy: spec.policy }),
    value: { config: layer.config, initScript: layer.initScript, bakeScript: layer.bakeScript, piFiles: layer.piFiles },
    inherited: spec.inherited,
    readOnly: !spec.writable,
    errorPrefix: "config.",
    async save(doc) {
      const body = {
        config: doc["config"] ?? {},
        initScript: doc["initScript"] ?? "",
        bakeScript: doc["bakeScript"] ?? "",
        piFiles: doc["piFiles"] ?? {},
      };
      ({ version } = await api("PUT", spec.path, { ...body, version }));
      return body;
    },
  });
}

/**
 * The organization's policy.
 * @param {{ path: string, writable: boolean, defaults: Defaults }} spec
 */
export async function policyEditor(spec) {
  const layer = await api("GET", spec.path);
  let version = /** @type {number} */ (layer.version);
  return editor({
    title: "Policy",
    intro: "Limits every launch in the organization stays within, whatever its settings, template or project ask for.",
    notice: spec.writable ? null : "Read only: changing policy requires policy:write.",
    sections: policySections(spec.defaults),
    value: currentPolicy(layer.config ?? {}),
    readOnly: !spec.writable,
    errorPrefix: "",
    async save(doc) {
      ({ version } = await api("PUT", spec.path, { config: doc, version }));
      return doc;
    },
  });
}

/**
 * Creates a template when `id` is null, otherwise edits or deletes it.
 * @param {{
 *   id: string | null,
 *   permissions: string[],
 *   organization: string,
 *   defaults: Defaults,
 *   policy: Record<string, any>,
 *   layers: { org: Inherited, mine: Inherited },
 * }} spec
 */
export async function templateEditor(spec) {
  /** @type {Template | null} */
  const existing = spec.id ? await api("GET", `/templates/${encodeURIComponent(spec.id)}`) : null;
  let version = existing?.version ?? 0;
  const scope = existing?.scope ?? "user";
  const readOnly = !canWriteTemplate(spec.permissions, scope);
  const canShare = canWriteTemplate(spec.permissions, "org");
  const defaults = { label: "default", value: { config: spec.defaults.config } };

  // Sharing is one way: an organization template cannot be taken back from the people using it.
  const sharing =
    scope === "user" && canShare
      ? [
          choiceField({
            path: "scope",
            label: "Who can launch it",
            options: [["user", "Only me"], ["org", `Everyone in ${spec.organization}`]],
            hint: "Sharing with the organization cannot be undone.",
          }),
        ]
      : [];
  const sections = [
    {
      title: "Template",
      fields: [
        textField({ path: "name", label: "Name", required: true, maxLength: 100, placeholder: "backend" }),
        textBlockField({ path: "description", label: "Description", rows: 2, placeholder: "What a pod launched from it is for" }),
        ...sharing,
      ],
    },
    ...settingsSections({ pi: "piSettings", defaults: spec.defaults, policy: spec.policy }),
  ];

  const title = el("span", {}, existing?.name ?? "New template");
  const command = el("code", {});
  const showName = (/** @type {string} */ name) => {
    title.textContent = name;
    command.textContent = `pipod --template ${/\s/.test(name) ? JSON.stringify(name) : name}`;
  };
  if (existing) showName(existing.name);

  const remove = existing && !readOnly
    ? button("Delete", async () => {
        if (!confirm(`Delete the template "${existing.name}"?`)) return;
        try {
          await api("DELETE", `/templates/${encodeURIComponent(existing.id)}`);
        } catch (e) {
          return alert(e instanceof Error ? e.message : String(e));
        }
        unsaved = () => false;
        location.hash = "#/templates";
      }, { kind: "danger" })
    : null;

  return editor({
    title,
    head: [el("a", { href: "#/templates", class: "back" }, "← All templates"), ...(remove ? [remove] : [])],
    intro: existing
      ? el("span", {}, "Launch it with ", command, ".")
      : "A named set of settings you choose at launch. It applies over the organization's defaults; a personal template also applies over your own settings.",
    notice: readOnly
      ? scope === "org"
        ? "Read only: changing an organization template requires templates:write and org:manage."
        : "Read only: requires templates:write."
      : scope === "org"
        ? `Shared with everyone in ${spec.organization}.`
        : null,
    sections,
    value: existing
      ? { ...existing, description: existing.description ?? "" }
      : { scope: "user", config: {}, piSettings: {} },
    inherited: scope === "org" ? [spec.layers.org, defaults] : [spec.layers.mine, spec.layers.org, defaults],
    readOnly,
    errorPrefix: "config.",
    saveLabel: existing ? "Save" : "Create template",
    alwaysSavable: !existing,
    async save(doc) {
      const shareNow = existing?.scope === "user" && doc["scope"] === "org";
      if (shareNow && !confirm(`Share "${doc["name"]}" with everyone in ${spec.organization}? It cannot be made personal again.`)) {
        throw new Error("Not saved.");
      }
      const body = {
        name: doc["name"],
        description: doc["description"] ?? "",
        ...(existing?.scope === "org" ? {} : { scope: doc["scope"] ?? "user" }),
        config: doc["config"] ?? {},
        initScript: doc["initScript"] ?? "",
        bakeScript: doc["bakeScript"] ?? "",
        piSettings: doc["piSettings"] ?? {},
      };
      /** @type {Template} */
      const stored = existing
        ? await api("PATCH", `/templates/${encodeURIComponent(existing.id)}`, { ...body, expectedVersion: version })
        : await api("POST", "/templates", body);
      version = stored.version;
      return { ...stored, description: stored.description ?? "" };
    },
    saved(value) {
      showName(String(value["name"]));
      // A new template gets its own page; one just shared is shown as the organization's.
      if (!existing) location.hash = `#/templates/${value["id"]}`;
      else if (value["scope"] !== scope) location.reload();
    },
  });
}

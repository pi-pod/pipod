// @ts-check
/**
 * The dashboard: the settings a launch is built from — your own settings, the organization's
 * defaults and policy, and templates. Pages are hash routes (#/me, #/org, #/policy,
 * #/templates, #/templates/<id>), so the server serves one document.
 */
import { completeSignIn, signIn, signOut, signedIn, SignInError } from "./auth.js";
import { api, ApiError } from "./api.js";
import { button, el } from "./dom.js";
import { canWriteTemplate, closeEditor, hasUnsavedChanges, layerEditor, policyEditor, templateEditor } from "./editors.js";

/**
 * @typedef {object} Me
 * @property {{ id: string, email?: string, displayName?: string }} user
 * @property {{ id: string, alias: string | null, name: string | null } | null} organization
 * @property {string[]} permissions
 * @property {string} accountConsoleUrl
 * @property {string} adminConsoleUrl
 */

/** @typedef {import("./editors.js").Defaults} Defaults */
/** @typedef {import("./editors.js").Template} Template */

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const account = /** @type {HTMLElement} */ (document.getElementById("account"));
const nav = /** @type {HTMLElement} */ (document.getElementById("nav"));

/** @type {Me | null} */
let me = null;
/** @type {Defaults | null} */
let defaults = null;

/** @param {...(Node | string | null | false)} content */
function show(...content) {
  main.replaceChildren(...content.filter((node) => node !== null && node !== false));
}

/** @param {string} [message] why the person has to sign in, when it is not the first time */
function showSignIn(message) {
  me = null;
  nav.hidden = true;
  account.replaceChildren();
  show(
    el(
      "section",
      { class: "card narrow" },
      el("h2", {}, "Sign in"),
      el("p", {}, "Choose the settings your pods start with, and manage your templates, on this pi pod server."),
      message ? el("p", { class: "status error" }, message) : null,
      button("Sign in", async () => {
        try {
          await signIn();
        } catch (e) {
          showSignIn(e instanceof Error ? e.message : String(e));
        }
      }, { kind: "primary" }),
    ),
  );
}

/** @param {unknown} error */
function showError(error) {
  if (error instanceof ApiError && error.status === 401) return showSignIn("Your session ended. Sign in again.");
  const lines = error instanceof ApiError ? error.lines : [];
  show(
    el(
      "section",
      { class: "card" },
      el("h2", {}, "Something went wrong"),
      el("p", { class: "status error" }, error instanceof Error ? error.message : String(error)),
      lines.length ? el("ul", {}, ...lines.map((line) => el("li", {}, line))) : null,
      button("Try again", async () => render()),
    ),
  );
}

/**
 * @param {string} url
 * @param {string} label
 */
function externalLink(url, label) {
  return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);
}

/** @param {Me} who */
function orgName(who) {
  const org = /** @type {NonNullable<Me["organization"]>} */ (who.organization);
  return org.name ?? org.alias ?? org.id;
}

/**
 * What the settings pages read besides their own layer: the organization's defaults (what
 * your settings and templates inherit) and its policy (the limits shown beside the fields).
 * @param {Me} who
 */
async function context(who) {
  const id = encodeURIComponent(/** @type {NonNullable<Me["organization"]>} */ (who.organization).id);
  defaults ??= /** @type {Defaults} */ (await api("GET", "/settings/defaults"));
  const [org, policy] = await Promise.all([api("GET", `/orgs/${id}/settings`), api("GET", `/orgs/${id}/policy`)]);
  return {
    id,
    defaults,
    policy: /** @type {Record<string, unknown>} */ (policy.config ?? {}),
    org: { label: "organization", value: { config: org.config } },
    builtIn: { label: "default", value: { config: defaults.config } },
  };
}

/** @param {Me} who */
async function userPage(who) {
  const ctx = await context(who);
  const path = `/users/${encodeURIComponent(who.user.id)}/settings`;
  return [
    await layerEditor({
      title: "My settings",
      intro: `Applied over ${orgName(who)}'s defaults on every pod you launch. Leave a field blank to keep the value shown in it.`,
      path,
      writable: who.permissions.includes("settings:own:write"),
      readOnlyReason: "changing your settings requires settings:own:write.",
      defaults: ctx.defaults,
      policy: ctx.policy,
      inherited: [ctx.org, ctx.builtIn],
    }),
  ];
}

/** @param {Me} who */
async function organizationPage(who) {
  const ctx = await context(who);
  const org = /** @type {NonNullable<Me["organization"]>} */ (who.organization);
  return [
    await layerEditor({
      title: `${orgName(who)} defaults`,
      intro: el(
        "span",
        {},
        "The starting point for every pod in the organization. Each person's own settings and templates apply over it. ",
        "Members and roles are managed in ",
        externalLink(who.adminConsoleUrl, "the Zitadel Console"),
        org.alias && org.alias !== org.id ? ` (${org.alias}).` : ".",
      ),
      path: `/orgs/${ctx.id}/settings`,
      writable: who.permissions.includes("org:manage"),
      readOnlyReason: "changing organization defaults requires org:manage.",
      defaults: ctx.defaults,
      policy: ctx.policy,
      inherited: [ctx.builtIn],
    }),
  ];
}

/** @param {Me} who */
async function policyPage(who) {
  const ctx = await context(who);
  return [
    await policyEditor({
      path: `/orgs/${ctx.id}/policy`,
      writable: who.permissions.includes("policy:write"),
      defaults: ctx.defaults,
    }),
  ];
}

/** @param {string} iso */
function ago(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of /** @type {Array<[Intl.RelativeTimeFormatUnit, number]>} */ ([
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3600], ["minute", 60],
  ])) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** @param {Me} who */
async function templatesPage(who) {
  /** @type {{ templates: Template[] }} */
  const { templates } = await api("GET", "/templates?limit=200");
  const creatable = canWriteTemplate(who.permissions, "user");
  const create = creatable ? el("a", { href: "#/templates/new", class: "button primary" }, "New template") : null;
  const rows = templates
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) =>
      el(
        "tr",
        {},
        el("td", {}, el("a", { href: `#/templates/${t.id}` }, t.name)),
        el("td", {}, t.scope === "org" ? "Everyone" : "Only me"),
        el("td", { class: "muted" }, t.description ?? ""),
        el("td", { class: "muted nowrap", title: new Date(t.updatedAt).toLocaleString() }, ago(t.updatedAt)),
      ),
    );
  return [
    el(
      "section",
      { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "Templates"), rows.length ? create : null),
      el(
        "p",
        { class: "intro" },
        "Named settings you choose when you launch, with ",
        el("code", {}, "pipod --template <name>"),
        ". Yours are only yours; the organization's are launched by everyone in it.",
      ),
      rows.length
        ? el(
            "table",
            {},
            el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Who can launch it"), el("th", {}, "Description"), el("th", {}, "Updated"))),
            el("tbody", {}, ...rows),
          )
        : el("div", { class: "empty" }, el("p", {}, "No templates yet."), create),
    ),
  ];
}

/** @param {Me} who */
async function templatePage(who, /** @type {string | null} */ id) {
  const ctx = await context(who);
  const mine = await api("GET", `/users/${encodeURIComponent(who.user.id)}/settings`);
  return [
    await templateEditor({
      id,
      permissions: who.permissions,
      organization: orgName(who),
      defaults: ctx.defaults,
      policy: ctx.policy,
      layers: { org: ctx.org, mine: { label: "your settings", value: { config: mine.config } } },
    }),
  ];
}

/** @param {Me} who */
function noOrganizationPage(who) {
  return [
    el(
      "section",
      { class: "card narrow" },
      el("h2", {}, "No organization"),
      el(
        "p",
        {},
        `${who.user.email ?? "This account"} belongs to no organization, so there are no settings to manage. `,
        "Ask an administrator to add you, or sign out and sign in with an account that has one.",
      ),
    ),
  ];
}

/** @param {Me} who */
async function route(who) {
  const [hashPage, id] = location.hash.replace(/^#\/?/, "").split("/");
  const page = hashPage || "me";
  for (const link of nav.querySelectorAll("a")) {
    link.classList.toggle("current", link.getAttribute("href") === `#/${page}`);
  }
  if (!who.organization) return noOrganizationPage(who);
  if (page === "org") return organizationPage(who);
  if (page === "policy") return policyPage(who);
  if (page === "templates" && id === "new") return templatePage(who, null);
  if (page === "templates" && id) return templatePage(who, decodeURIComponent(id));
  if (page === "templates") return templatesPage(who);
  return userPage(who);
}

async function render() {
  if (!signedIn()) return showSignIn();
  closeEditor();
  try {
    me ??= /** @type {Me} */ (await api("GET", "/me"));
    nav.hidden = !me.organization;
    account.replaceChildren(
      externalLink(me.accountConsoleUrl, me.user.email ?? me.user.displayName ?? "Account"),
      button("Sign out", async () => signOut()),
    );
    show(el("p", { class: "loading" }, "Loading…"));
    show(...(await route(me)));
  } catch (e) {
    showError(e);
  }
}

/** Where the page was last rendered, to come back to when leaving it is cancelled. */
let shownHash = location.hash;

function onHashChange() {
  if (hasUnsavedChanges() && !confirm("You have unsaved changes. Leave without saving them?")) {
    history.replaceState(null, "", shownHash || "#/me");
    return;
  }
  shownHash = location.hash;
  void render();
}

async function boot() {
  try {
    await completeSignIn();
  } catch (e) {
    return showSignIn(e instanceof SignInError ? e.message : `sign-in failed: ${String(e)}`);
  }
  shownHash = location.hash;
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsavedChanges()) event.preventDefault();
  });
  await render();
}

void boot();

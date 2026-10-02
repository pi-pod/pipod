// @ts-check
/**
 * The dashboard: who you are signed in as, and the settings a launch is built from — the
 * organization's defaults and policy, your own defaults, and templates. Pages are hash routes
 * (#/org, #/me, #/templates, #/templates/<id>), so the server serves one document.
 */
import { completeSignIn, signIn, signOut, signedIn, SignInError } from "./auth.js";
import { api, ApiError } from "./api.js";
import { button, el } from "./dom.js";
import { canWriteTemplate, layerEditor, templateEditor } from "./editors.js";

/**
 * @typedef {object} Me
 * @property {{ id: string, email?: string, displayName?: string }} user
 * @property {{ id: string, alias: string | null, name: string | null } | null} organization
 * @property {string[]} permissions
 * @property {string} accountConsoleUrl
 * @property {string} adminConsoleUrl
 */

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const account = /** @type {HTMLElement} */ (document.getElementById("account"));
const nav = /** @type {HTMLElement} */ (document.getElementById("nav"));

/** @type {Me | null} */
let me = null;

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
      el("p", {}, "Manage your organization's settings, your own settings and your templates on this pi pod server."),
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
async function organizationPage(who) {
  const org = who.organization;
  if (!org) {
    return [el("section", { class: "card" }, el("h2", {}, "No organization"), el("p", {}, "Your account belongs to no organization, so there are no organization settings to manage. Ask an administrator to add you, or sign in with an account that has one."))];
  }
  const can = (/** @type {string} */ permission) => who.permissions.includes(permission);
  const id = encodeURIComponent(org.id);
  return [
    el(
      "section",
      { class: "card" },
      el("h2", {}, org.name ?? org.alias ?? org.id),
      el(
        "dl",
        {},
        el("dt", {}, "Domain"),
        el("dd", {}, org.alias ?? "—"),
        el("dt", {}, "ID"),
        el("dd", { class: "code" }, org.id),
        el("dt", {}, "Your permissions"),
        el("dd", {}, who.permissions.length ? who.permissions.join(", ") : "none"),
      ),
      el(
        "p",
        { class: "intro" },
        "Members, roles and the organization itself are managed in the identity provider: ",
        externalLink(who.adminConsoleUrl, "open the Zitadel Console"),
        ".",
      ),
    ),
    await layerEditor({
      title: "Organization defaults",
      intro: "The base every launch in the organization starts from. Templates, your own settings and the project override it.",
      path: `/orgs/${id}/settings`,
      writable: can("org:manage"),
      readOnlyReason: "changing organization defaults requires org:manage.",
    }),
    await layerEditor({
      title: "Organization policy",
      intro: "Ceilings and denials applied after every other layer. Policy can only narrow what a launch gets.",
      path: `/orgs/${id}/policy`,
      policy: true,
      writable: can("policy:write"),
      readOnlyReason: "changing policy requires policy:write.",
    }),
  ];
}

/** @param {Me} who */
async function userPage(who) {
  return [
    el(
      "section",
      { class: "card" },
      el("h2", {}, who.user.displayName ?? who.user.email ?? who.user.id),
      el(
        "dl",
        {},
        el("dt", {}, "Email"),
        el("dd", {}, who.user.email ?? "—"),
        el("dt", {}, "ID"),
        el("dd", { class: "code" }, who.user.id),
      ),
      el("p", { class: "intro" }, "Your password, name and sign-in methods are in the identity provider: ", externalLink(who.accountConsoleUrl, "manage your account"), "."),
    ),
    who.organization
      ? await layerEditor({
          title: "My settings",
          intro: "Your own defaults, applied over the organization's on every pod you launch.",
          path: `/users/${encodeURIComponent(who.user.id)}/settings`,
          writable: who.permissions.includes("settings:own:write"),
          readOnlyReason: "changing your settings requires settings:own:write.",
        })
      : null,
  ];
}

/** @param {Me} who */
async function templatesPage(who) {
  /** @type {{ templates: import("./editors.js").Template[] }} */
  const { templates } = await api("GET", "/templates?limit=200");
  const rows = templates.map((t) =>
    el(
      "tr",
      {},
      el("td", {}, el("a", { href: `#/templates/${t.id}` }, t.name)),
      el("td", {}, t.scope === "org" ? "Organization" : "Personal"),
      el("td", {}, t.description ?? ""),
      el("td", {}, new Date(t.updatedAt).toLocaleString()),
    ),
  );
  return [
    el(
      "section",
      { class: "card" },
      el("h2", {}, "Templates"),
      el("p", { class: "intro" }, "Named configurations a launch can select with --template. Personal templates are yours alone; organization templates are launched by everyone in it."),
      canWriteTemplate(who.permissions, "user") ? el("p", {}, el("a", { href: "#/templates/new", class: "button primary" }, "New template")) : null,
      rows.length
        ? el(
            "table",
            {},
            el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Scope"), el("th", {}, "Description"), el("th", {}, "Updated"))),
            el("tbody", {}, ...rows),
          )
        : el("p", { class: "empty" }, "No templates yet."),
    ),
  ];
}

/** @param {Me} who */
async function route(who) {
  const [hashPage, id] = location.hash.replace(/^#\/?/, "").split("/");
  const page = hashPage || "org";
  for (const link of nav.querySelectorAll("a")) {
    link.classList.toggle("current", link.getAttribute("href") === `#/${page}`);
  }
  if (page === "me") return userPage(who);
  if (page === "templates" && id === "new") return [await templateEditor({ id: null, permissions: who.permissions })];
  if (page === "templates" && id) return [await templateEditor({ id: decodeURIComponent(id), permissions: who.permissions })];
  if (page === "templates") return templatesPage(who);
  return organizationPage(who);
}

async function render() {
  if (!signedIn()) return showSignIn();
  try {
    me ??= /** @type {Me} */ (await api("GET", "/me"));
    nav.hidden = false;
    account.replaceChildren(
      el("span", {}, me.user.email ?? me.user.id),
      button("Sign out", async () => signOut()),
    );
    show(el("p", { class: "loading" }, "Loading…"));
    show(...(await route(me)));
  } catch (e) {
    showError(e);
  }
}

async function boot() {
  try {
    await completeSignIn();
  } catch (e) {
    return showSignIn(e instanceof SignInError ? e.message : `sign-in failed: ${String(e)}`);
  }
  window.addEventListener("hashchange", () => void render());
  await render();
}

void boot();

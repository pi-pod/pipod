// @ts-check
/**
 * Confirming a machine's sign-in with a code (`pipod login --device`). Two pages:
 *
 *   #/sign-in/<code>  a sign-in limited to one template (`--template`). This server shows what the
 *                     code asks for — the template, the account — and the person grants it or not.
 *   #/device/<code>   a sign-in for the whole account, which the identity provider confirms. This
 *                     page says so before sending the person there.
 *
 * A limited sign-in is never confirmed at the identity provider, so a page there that names no
 * template is a sign-in for the whole account, whatever the machine said.
 */
import { api, ApiError } from "./api.js";
import { handOverSession, signInConfig } from "./auth.js";
import { button, el } from "./dom.js";

/**
 * @typedef {object} SignInRequest
 * @property {string} userCode
 * @property {"pending" | "approved" | "denied" | "redeemed"} state
 * @property {string} requestedAt
 * @property {string} expiresAt
 * @property {string} templateRef
 * @property {{ id: string, name: string, scope: "user" | "org" | "shared", sharedBy?: string | null, description: string | null } | null} template
 * @property {string | null} problem
 * @property {boolean} decidedByAnother
 */

/**
 * @typedef {object} Who
 * @property {{ id: string, email?: string }} user
 * @property {{ id: string, alias: string | null, name: string | null } | null} organization
 */

/**
 * Whose template the machine would be limited to, as the person confirming reads it.
 * @param {NonNullable<SignInRequest["template"]>} template
 */
function templateOrigin(template) {
  if (template.scope === "user") return "Your personal template";
  if (template.scope === "shared") return `Shared with you by ${template.sharedBy ?? "another member"}, who owns it`;
  return "Organization template";
}

/** @param {string} raw */
function normalizeCode(raw) {
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : raw.trim().toUpperCase();
}

/** @param {string} iso */
function minutesFromNow(iso) {
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

/** @param {(code: string) => void} go */
function codeForm(go) {
  const input = el("input", { type: "text", placeholder: "XXXX-XXXX", autocomplete: "off", spellcheck: false });
  const form = el(
    "form",
    { class: "code-form" },
    el("label", { class: "field" }, el("span", { class: "label" }, "Code shown by the machine"), input),
    el("button", { type: "submit", class: "primary" }, "Next"),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.value.trim()) go(normalizeCode(input.value));
  });
  return form;
}

/**
 * #/device/<code>: the statement a full sign-in gets before the identity provider's own page.
 * Needs no sign-in here; the identity provider asks for one.
 * @param {string | undefined} rawCode
 */
export async function wholeAccountPage(rawCode) {
  const code = rawCode ? normalizeCode(decodeURIComponent(rawCode)) : "";
  const { issuer } = await signInConfig();
  // The identity provider's own device verification address (RFC 8628 verification_uri), which
  // takes the code from the query and sends the person on to whichever login UI it runs.
  const target = new URL(`${issuer.replace(/\/+$/, "")}/device`);
  if (code) target.searchParams.set("user_code", code);
  return [
    el(
      "section",
      { class: "card narrow grant" },
      el("h2", {}, "Sign a machine in with your whole account"),
      el(
        "p",
        { class: "scope whole" },
        "This sign-in is for your whole account. The machine will be able to do everything you can do on this server: ",
        "launch from any template you can use, reach every pod you can reach, and use every permission your account has — ",
        "including managing templates, secrets, settings, policy and the organization, if your account can.",
      ),
      el(
        "p",
        {},
        "A sign-in limited to one template is never confirmed at the identity provider. It is confirmed on this server, ",
        "on a page that names the template. If you meant to grant one template only, stop here.",
      ),
      code ? el("p", {}, "Code: ", el("strong", { class: "code" }, code)) : null,
      el("div", { class: "bar-row" }, el("a", { class: "button primary", href: target.toString() }, `Continue to ${target.host}`)),
      el("p", { class: "muted small" }, "If you did not start this sign-in, close this page."),
    ),
  ];
}

/**
 * #/sign-in[/<code>]: what a limited sign-in asks for, and the decision.
 * @param {Who} who
 * @param {string | undefined} rawCode
 */
export async function limitedSignInPage(who, rawCode) {
  if (!rawCode) {
    return [
      el(
        "section",
        { class: "card narrow grant" },
        el("h2", {}, "Sign a machine in"),
        el("p", {}, "Enter the code the machine printed. You will see what it asks for before anything is granted."),
        codeForm((code) => { location.hash = `#/sign-in/${code}`; }),
      ),
    ];
  }
  const code = normalizeCode(decodeURIComponent(rawCode));
  /** @type {SignInRequest} */
  let request;
  try {
    request = await api("GET", `/sign-ins/requests/${encodeURIComponent(code)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return [notice("No sign-in is waiting for this code", error.message)];
    }
    throw error;
  }
  if (request.decidedByAnother) return [notice("This sign-in was already decided", "Someone else answered this code.")];
  if (request.state === "approved" || request.state === "redeemed") {
    return [done(request.template?.name ?? "its template", request.template?.id ?? null)];
  }
  if (request.state === "denied") return [notice("You declined this sign-in", "The machine was not signed in.")];

  const card = el("section", { class: "card grant" });
  const status = el("p", { class: "status error" });
  const account = who.user.email ?? who.user.id;
  const org = who.organization ? (who.organization.name ?? who.organization.alias ?? who.organization.id) : "";
  const template = request.template;
  const header = el("div", {}, el("h2", {}, "Sign a machine in, limited to one template"));

  if (!template || request.problem) {
    card.append(
      header,
      el("p", { class: "status error" }, `This sign-in cannot be granted: ${request.problem ?? "unknown template"}.`),
      el("p", { class: "muted" }, `The machine asked for template ${JSON.stringify(request.templateRef)}.`),
      el("div", { class: "bar-row" }, button("Decline", async () => decline(code, card, status), { kind: "danger" })),
      status,
    );
    return [card];
  }

  card.append(
    header,
    el(
      "div",
      { class: "scope limited" },
      el("div", { class: "muted small" }, "Template"),
      el("div", { class: "template-name" }, template.name),
      el("div", { class: "muted small" }, `${templateOrigin(template)} · ID `, el("code", {}, template.id)),
    ),
    el("p", {}, "Signing in as ", el("strong", {}, account), org ? ` in ${org}.` : "."),
    el("h3", {}, "The machine will be able to"),
    el(
      "ul",
      {},
      el("li", {}, `launch pods from ${template.name}, and from no other template;`),
      el("li", {}, `see and manage your pods launched from ${template.name}: attach, prompt, stop, rename, send and receive files, archive and delete them, and read their sessions;`),
      el("li", {}, `read your settings, the organization's defaults and ${template.name} itself (secret names, never values).`),
    ),
    el("h3", {}, "It will not be able to"),
    el(
      "ul",
      {},
      el("li", {}, "reach any other pod: yours from other templates or launched without one, or anyone else's;"),
      el("li", {}, "see any other template, or create, edit, share or delete any template;"),
      el("li", {}, "set or remove secrets, change settings or policy, manage model credentials or scheduled jobs, or read the audit log or billing;"),
      el("li", {}, "act in the identity provider's console or call its APIs: it never receives a token for them."),
    ),
    el(
      "p",
      { class: "muted small" },
      `Code ${request.userCode} · expires in ${Math.max(0, minutesFromNow(request.expiresAt))} min. `,
      "The sign-in lasts as long as your own would, and ends if your account is removed. ",
      "Allowing hands this page's sign-in to the machine; this tab is signed out afterwards.",
    ),
    el(
      "div",
      { class: "bar-row" },
      button("Decline", async () => decline(code, card, status), { kind: "danger" }),
      button(`Allow ${template.name} only`, async () => allow(code, template, card, status), { kind: "primary" }),
    ),
    status,
  );
  return [card];
}

/**
 * @param {string} code
 * @param {{ id: string, name: string }} template
 * @param {HTMLElement} card
 * @param {HTMLElement} status
 */
async function allow(code, template, card, status) {
  status.textContent = "";
  const session = await handOverSession();
  if (!session) {
    status.textContent = "This page is no longer signed in. Reload it and sign in again.";
    return;
  }
  // From here this tab holds no sign-in: the server renews the handed-over one, which spends it.
  document.getElementById("account")?.replaceChildren();
  const nav = document.getElementById("nav");
  if (nav) nav.hidden = true;
  const res = await fetch(`/v1/sign-ins/requests/${encodeURIComponent(code)}/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  }).catch(() => null);
  if (!res?.ok) {
    const body = res ? await res.json().catch(() => null) : null;
    card.replaceWith(
      notice(
        "The machine was not signed in",
        `${body?.error ?? "The server could not be reached."} This tab is signed out; reload the page and sign in to try again.`,
      ),
    );
    return;
  }
  card.replaceWith(done(template.name, template.id));
}

/**
 * @param {string} code
 * @param {HTMLElement} card
 * @param {HTMLElement} status
 */
async function decline(code, card, status) {
  try {
    await api("POST", `/sign-ins/requests/${encodeURIComponent(code)}/deny`);
    card.replaceWith(notice("You declined this sign-in", "The machine was not signed in."));
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}

/**
 * @param {string} name
 * @param {string | null} id
 */
function done(name, id) {
  return el(
    "section",
    { class: "card narrow grant" },
    el("h2", {}, "The machine is signed in"),
    el("p", {}, "It is limited to template ", el("strong", {}, name), id ? " (" : "", id ? el("code", {}, id) : null, id ? ")." : "."),
    el("p", { class: "muted" }, "You can close this tab. ", el("code", {}, "pipod logout"), " on the machine ends the sign-in."),
  );
}

/**
 * @param {string} title
 * @param {string} message
 */
function notice(title, message) {
  return el("section", { class: "card narrow" }, el("h2", {}, title), el("p", {}, message));
}

// @ts-check
/**
 * Building the page. Everything the server or a person wrote is set as text, never parsed as
 * HTML, so a template name or a script cannot become markup.
 */
import { ApiError } from "./api.js";

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Partial<Omit<HTMLElementTagNameMap[K], "style">> & { class?: string }} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child) node.append(child);
  return node;
}

/**
 * A labelled multi-line text box.
 * @param {{ label: string, hint?: string, value: string, rows?: number, code?: boolean, readOnly: boolean }} spec
 */
export function textArea(spec) {
  const input = el("textarea", {
    value: spec.value,
    rows: spec.rows ?? 8,
    readOnly: spec.readOnly,
    spellcheck: false,
    class: spec.code === false ? "" : "code",
  });
  const node = el("label", { class: "field" }, el("span", { class: "label" }, spec.label), spec.hint ? el("span", { class: "hint" }, spec.hint) : null, input);
  return { node, input };
}

/**
 * A labelled JSON object box; `read` returns the parsed object or throws naming the field.
 * @param {{ label: string, hint?: string, value: unknown, rows?: number, readOnly: boolean }} spec
 */
export function jsonArea(spec) {
  const field = textArea({ ...spec, value: JSON.stringify(spec.value ?? {}, null, 2) });
  const read = () => {
    const text = field.input.value.trim();
    if (!text) return {};
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`${spec.label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${spec.label} must be a JSON object`);
    }
    return /** @type {Record<string, unknown>} */ (parsed);
  };
  return { node: field.node, read };
}

/** A line that reports what the last action did, including the server's validation detail. */
export function statusLine() {
  const node = el("div", { class: "status", role: "status" });
  return {
    node,
    /** @param {string} message */
    ok(message) {
      node.className = "status ok";
      node.replaceChildren(message);
    },
    /**
     * @param {unknown} error
     * @param {Node} [action] offered beside the message, such as a reload
     */
    fail(error, action) {
      node.className = "status error";
      const lines = error instanceof ApiError ? error.lines : [];
      const message = error instanceof Error ? error.message : String(error);
      node.replaceChildren(el("strong", {}, message));
      if (lines.length) node.append(el("ul", {}, ...lines.map((line) => el("li", {}, line))));
      if (action) node.append(action);
    },
    clear() {
      node.className = "status";
      node.replaceChildren();
    },
  };
}

/**
 * @param {string} label
 * @param {() => Promise<void>} action
 * @param {{ kind?: "primary" | "danger" }} [style]
 */
export function button(label, action, style = {}) {
  const node = el("button", { type: "button", class: style.kind ?? "" }, label);
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await action();
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

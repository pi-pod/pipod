// @ts-check
/**
 * Forms over a stored JSON document. Each field owns one dotted path in the document. A blank
 * field leaves its path unset, which in a settings layer means "inherit from the layer below",
 * and shows what it would inherit. A `rest` field owns whatever under its path no other field
 * took, edited as JSON. A value the form has no input for, or holds in a shape its input
 * cannot show, is never dropped: it goes to the rest that covers it, or failing that is saved
 * back unchanged until its field is edited.
 */
import { el } from "./dom.js";

/** A value a person typed that cannot be saved; `field` names where to show it. */
export class FieldError extends Error {
  /**
   * @param {string} message
   * @param {Field} [field]
   */
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * @typedef {object} Field
 * @property {string} path dotted path in the document
 * @property {HTMLElement} node
 * @property {(value: unknown) => boolean} accepts whether the input can show this stored value
 * @property {(value: unknown) => void} set
 * @property {() => unknown} read the value to store; undefined leaves the path unset
 * @property {(value: unknown, source: string) => void} [inherit] show what a blank field gets
 * @property {(message: string | null) => void} error
 * @property {(message: string) => void} [warn] a problem with a value shown but not held
 * @property {boolean} [rest] owns what no other field under its path took
 */

/**
 * @typedef {object} Section
 * @property {string} title
 * @property {string | Node} [intro]
 * @property {Field[]} fields
 * @property {boolean} [collapsed] folded unless one of its fields holds a value
 */

/**
 * A source of inherited values, nearest first: a layer the edited one sits on, or the
 * server's built-in defaults.
 * @typedef {{ label: string, value: unknown }} Inherited
 */

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} doc
 * @param {string} path
 * @returns {unknown}
 */
export function getPath(doc, path) {
  let node = doc;
  for (const key of path.split(".")) {
    if (!isObject(node)) return undefined;
    node = /** @type {Record<string, unknown>} */ (node)[key];
  }
  return node;
}

/**
 * @param {Record<string, unknown>} doc
 * @param {string} path
 * @param {unknown} value
 */
function setPath(doc, path, value) {
  const keys = path.split(".");
  let node = doc;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = /** @type {Record<string, unknown>} */ (node[key]);
  }
  node[/** @type {string} */ (keys.at(-1))] = value;
}

/**
 * Removes `path`, then every object on the way to it that the removal left empty.
 * @param {unknown} doc
 * @param {string} path
 */
function deletePath(doc, path) {
  const [key, ...more] = path.split(".");
  if (!isObject(doc) || key === undefined) return;
  const record = /** @type {Record<string, unknown>} */ (doc);
  if (more.length === 0) {
    delete record[key];
    return;
  }
  deletePath(record[key], more.join("."));
  const child = record[key];
  if (isObject(child) && Object.keys(/** @type {object} */ (child)).length === 0) delete record[key];
}

/** @param {unknown} value */
function isBlank(value) {
  return value === undefined || value === "" || (isObject(value) && Object.keys(/** @type {object} */ (value)).length === 0);
}

/**
 * @param {Section[]} sections
 * @param {{ value: unknown, inherited?: Inherited[], readOnly: boolean, onChange: () => void }} spec
 */
export function createForm(sections, spec) {
  const fields = sections.flatMap((section) => section.fields);
  const rests = fields.filter((field) => field.rest);
  const plain = fields.filter((field) => !field.rest);

  /** Stored values no field or rest can show, by path; written back while their field is blank. */
  /** @type {Map<string, unknown>} */
  let kept = new Map();

  /** Hands every stored value to the field that can show it; rests get what is left. */
  const load = (/** @type {unknown} */ value) => {
    const leftover = structuredClone(value ?? {});
    const before = kept;
    kept = new Map();
    for (const field of plain) {
      const stored = getPath(value, field.path);
      if (field.accepts(stored)) {
        field.set(stored);
        deletePath(leftover, field.path);
        if (before.has(field.path)) field.warn?.("");
      } else {
        field.set(undefined);
        if (!rests.some((rest) => field.path.startsWith(`${rest.path}.`))) {
          kept.set(field.path, stored);
          field.warn?.(`Stored as ${JSON.stringify(stored)}, which this field cannot show. It is kept unless you change this field.`);
        }
      }
    }
    for (const field of rests) field.set(getPath(leftover, field.path));
  };

  for (const field of plain) {
    if (!field.inherit) continue;
    // null is how the defaults say "nothing chosen"; the field's own placeholder says that.
    const source = (spec.inherited ?? []).find((layer) => getPath(layer.value, field.path) != null);
    if (source) field.inherit(getPath(source.value, field.path), source.label);
  }

  load(spec.value);
  const clearErrors = () => {
    for (const field of fields) field.error(null);
  };

  const node = el("div", { class: "form" });
  for (const section of sections) {
    const body = el(
      "div",
      { class: "section-body" },
      section.intro ? el("p", { class: "intro" }, section.intro) : null,
      ...section.fields.map((field) => field.node),
    );
    if (section.collapsed) {
      const used = section.fields.some((field) => {
        try {
          return !isBlank(field.read());
        } catch {
          return true;
        }
      });
      node.append(el("details", { class: "section", open: used }, el("summary", {}, section.title), body));
    } else {
      node.append(el("section", { class: "section" }, el("h3", {}, section.title), body));
    }
  }
  if (spec.readOnly) {
    for (const input of node.querySelectorAll("input, textarea, select, button")) {
      /** @type {HTMLInputElement} */ (input).disabled = true;
    }
  }
  /**
   * A field being edited drops its error, and a stored value it could not show is replaced by
   * whatever it now holds, blank included. The change is reported.
   * @param {Event} event
   */
  const changed = (event) => {
    const field = fields.find((candidate) => candidate.node.contains(/** @type {Node} */ (event.target)));
    if (field) {
      field.error(null);
      if (kept.delete(field.path)) field.warn?.("");
    }
    spec.onChange();
  };
  node.addEventListener("input", changed);
  node.addEventListener("change", changed);

  return {
    node,
    /** @param {unknown} value */
    load,
    clearErrors,
    /**
     * The document to store. Rests first, so a field that has a value overrides the same
     * key typed into a rest. Throws a FieldError naming the first field that cannot be read.
     * @returns {Record<string, unknown>}
     */
    read() {
      clearErrors();
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const field of [...rests, ...plain]) {
        let value;
        try {
          value = field.read();
        } catch (e) {
          if (e instanceof FieldError) e.field ??= field;
          throw e;
        }
        if (field.rest && isObject(value)) {
          for (const [key, child] of Object.entries(/** @type {object} */ (value))) setPath(out, `${field.path}.${key}`, child);
        } else if (value !== undefined) {
          setPath(out, field.path, value);
        } else if (kept.has(field.path)) {
          setPath(out, field.path, kept.get(field.path));
        }
      }
      return out;
    },
    /**
     * Puts the server's "path: message" validation lines under the fields they name.
     * @param {string[]} lines
     * @param {string} prefix the path, in this document, the server's paths are relative to
     * @returns {string[]} the lines no field claimed
     */
    showErrors(lines, prefix) {
      return lines.filter((line) => {
        const match = /^([\w.[\]-]+): (.+)$/.exec(line);
        if (!match) return true;
        const path = `${prefix}${/** @type {string} */ (match[1]).replace(/\[\d+\]/g, "")}`;
        const owner =
          plain.find((field) => path === field.path || path.startsWith(`${field.path}.`)) ??
          rests.find((field) => path.startsWith(`${field.path}.`));
        owner?.error(/** @type {string} */ (match[2]));
        return !owner;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FieldBase
 * @property {string} path
 * @property {string} label
 * @property {string | Node} [hint]
 */

/**
 * The label, hint, input and error line every field is laid out with. A field made of
 * several controls is a group rather than one label, so a click lands where it was aimed.
 * @param {FieldBase & { wide?: boolean, group?: boolean }} spec
 * @param {Node} input
 */
function frame(spec, input) {
  const message = el("span", { class: "field-error", role: "alert" });
  const warning = el("span", { class: "field-warning" });
  const node = el(
    spec.group ? "div" : "label",
    { class: spec.wide ? "field wide" : "field" },
    el("span", { class: "label" }, spec.label),
    input,
    spec.hint ? el("span", { class: "hint" }, spec.hint) : null,
    warning,
    message,
  );
  return {
    node,
    /** @param {string} text a problem with a value the field shows but does not hold */
    warn(text) {
      warning.textContent = text;
    },
    /** @param {string | null} text */
    error(text) {
      message.textContent = text ?? "";
      node.classList.toggle("invalid", Boolean(text));
    },
  };
}

/** @param {unknown} value */
function describe(value) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === null) return "not set";
  return String(value);
}

/**
 * A whole number. Blank inherits.
 * @param {FieldBase & { unit?: string, min?: number, max?: number, blank?: string }} spec
 * @returns {Field}
 */
export function numberField(spec) {
  const input = el("input", { type: "number", step: "1", inputMode: "numeric", placeholder: spec.blank ?? "" });
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  const box = el("span", { class: "with-unit" }, input, spec.unit ? el("span", { class: "unit" }, spec.unit) : null);
  const { node, error, warn } = frame(spec, box);
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) => value === undefined || Number.isInteger(value),
    set: (value) => void (input.value = value === undefined ? "" : String(value)),
    read() {
      const text = input.value.trim();
      if (text === "") {
        if (input.validity.badInput) throw new FieldError(`${spec.label}: enter a whole number`);
        return undefined;
      }
      const value = Number(text);
      if (!Number.isInteger(value)) throw new FieldError(`${spec.label}: enter a whole number`);
      if (spec.min !== undefined && value < spec.min) throw new FieldError(`${spec.label}: at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw new FieldError(`${spec.label}: at most ${spec.max}`);
      return value;
    },
    inherit(value, source) {
      input.placeholder = `${describe(value)} (${source})`;
      if (spec.max !== undefined && typeof value === "number" && value > spec.max) {
        warn(`The ${source} value ${value} is more than ${spec.max}; set a smaller one here.`);
      }
    },
  };
}

/**
 * One line of text. Blank inherits.
 * @param {FieldBase & { placeholder?: string, required?: boolean, maxLength?: number }} spec
 * @returns {Field}
 */
export function textField(spec) {
  const input = el("input", { type: "text", placeholder: spec.placeholder ?? "", spellcheck: false });
  if (spec.maxLength) input.maxLength = spec.maxLength;
  const { node, error, warn } = frame(spec, input);
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) => value === undefined || typeof value === "string",
    set: (value) => void (input.value = typeof value === "string" ? value : ""),
    read() {
      const text = input.value.trim();
      if (!text && spec.required) throw new FieldError(`${spec.label} is required`);
      return text || undefined;
    },
    inherit: (value, source) => void (input.placeholder = `${describe(value)} (${source})`),
  };
}

/**
 * Free text kept exactly as typed, such as a description or a script; never inherits.
 * @param {FieldBase & { rows?: number, code?: boolean, placeholder?: string, maxLength?: number }} spec
 * @returns {Field}
 */
export function textBlockField(spec) {
  const input = el("textarea", {
    rows: spec.rows ?? 6,
    spellcheck: !spec.code,
    class: spec.code ? "code" : "",
    placeholder: spec.placeholder ?? "",
  });
  if (spec.maxLength) input.maxLength = spec.maxLength;
  const { node, error, warn } = frame({ ...spec, wide: true }, input);
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) => value === undefined || value === null || typeof value === "string",
    set: (value) => void (input.value = typeof value === "string" ? value : ""),
    read: () => input.value,
  };
}

/**
 * One of a few values. With `blank`, the first option leaves the path unset; it is labelled
 * with what that inherits, or with `blank` when nothing below sets one. Without, a value is
 * always chosen.
 * @param {FieldBase & { options: Array<[string | boolean | null, string]>, blank?: string }} spec
 * @returns {Field}
 */
export function choiceField(spec) {
  const blankOption = spec.blank === undefined ? null : el("option", { value: "" }, spec.blank);
  const select = el(
    "select",
    {},
    blankOption,
    ...spec.options.map(([value, label], i) => el("option", { value: String(i) }, label)),
  );
  const { node, error, warn } = frame(spec, select);
  const indexOf = (/** @type {unknown} */ value) => spec.options.findIndex(([option]) => option === value);
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) => (value === undefined && blankOption !== null) || indexOf(value) >= 0,
    set(value) {
      const i = indexOf(value);
      select.value = i >= 0 ? String(i) : blankOption ? "" : "0";
    },
    read: () => (select.value === "" ? undefined : spec.options[Number(select.value)]?.[0]),
    inherit(value, source) {
      if (!blankOption) return;
      const option = spec.options.find(([candidate]) => candidate === value);
      blankOption.textContent = `${option ? option[1] : describe(value)} (${source})`;
    },
  };
}

/**
 * A yes/no setting stored only when it differs from `otherwise`, the value the server
 * assumes when the key is unset.
 * @param {FieldBase & { on?: unknown, off?: unknown, otherwise?: unknown }} spec
 * @returns {Field}
 */
export function checkField(spec) {
  const on = "on" in spec ? spec.on : true;
  const off = "off" in spec ? spec.off : false;
  const otherwise = "otherwise" in spec ? spec.otherwise : off;
  const input = el("input", { type: "checkbox" });
  const message = el("span", { class: "field-error", role: "alert" });
  const node = el(
    "label",
    { class: "field check" },
    input,
    el("span", {}, el("span", { class: "label" }, spec.label), spec.hint ? el("span", { class: "hint" }, spec.hint) : null, message),
  );
  return {
    path: spec.path,
    node,
    error: (text) => void (message.textContent = text ?? ""),
    accepts: (value) => value === undefined || value === on || value === off,
    set: (value) => void (input.checked = (value === undefined ? otherwise : value) === on),
    read() {
      const value = input.checked ? on : off;
      return value === otherwise ? undefined : value;
    },
  };
}

/**
 * A list of strings, one per line. Blank inherits.
 * @param {FieldBase & { placeholder?: string, rows?: number }} spec
 * @returns {Field}
 */
export function linesField(spec) {
  const input = el("textarea", { rows: spec.rows ?? 3, spellcheck: false, class: "code", placeholder: spec.placeholder ?? "" });
  const { node, error, warn } = frame({ ...spec, wide: true }, input);
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string")),
    set: (value) => void (input.value = Array.isArray(value) ? value.join("\n") : ""),
    read() {
      const lines = input.value.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.length ? lines : undefined;
    },
    inherit: (value, source) =>
      void (input.placeholder = Array.isArray(value) && value.length ? `${value.join("\n")}\n(${source})` : `none (${source})`),
  };
}

/**
 * Some of a fixed set of names; every one checked stores nothing (no restriction).
 * @param {FieldBase & { options: string[] }} spec
 * @returns {Field}
 */
export function someOfField(spec) {
  const boxes = spec.options.map((name) => ({ name, input: el("input", { type: "checkbox", checked: true }) }));
  const { node, error, warn } = frame(
    { ...spec, group: true },
    el("span", { class: "some-of" }, ...boxes.map(({ name, input }) => el("label", {}, input, ` ${name}`))),
  );
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) =>
      value === undefined || (Array.isArray(value) && value.every((item) => spec.options.includes(item))),
    set(value) {
      for (const box of boxes) box.input.checked = !Array.isArray(value) || value.includes(box.name);
    },
    read() {
      const chosen = boxes.filter((box) => box.input.checked).map((box) => box.name);
      if (chosen.length === 0) throw new FieldError(`${spec.label}: choose at least one`);
      return chosen.length === boxes.length ? undefined : chosen;
    },
  };
}

/**
 * Named text files (relative path → contents), added and removed one by one.
 * @param {FieldBase & { namePlaceholder?: string }} spec
 * @returns {Field}
 */
export function filesField(spec) {
  const list = el("div", { class: "files" });
  /** @type {Array<{ name: HTMLInputElement, text: HTMLTextAreaElement }>} */
  let rows = [];
  const add = (/** @type {string} */ name, /** @type {string} */ text) => {
    const row = {
      name: el("input", { type: "text", value: name, placeholder: spec.namePlaceholder ?? "name", spellcheck: false, class: "code" }),
      text: el("textarea", { value: text, rows: 6, spellcheck: false, class: "code" }),
    };
    rows.push(row);
    const remove = el("button", { type: "button", class: "link danger" }, "Remove");
    const node = el("div", { class: "file" }, el("div", { class: "file-head" }, row.name, remove), row.text);
    remove.addEventListener("click", () => {
      rows = rows.filter((other) => other !== row);
      node.remove();
      list.dispatchEvent(new Event("change", { bubbles: true }));
    });
    list.append(node);
    return row;
  };
  const addButton = el("button", { type: "button" }, "Add file");
  addButton.addEventListener("click", () => add("", "").name.focus());
  const { node, error, warn } = frame({ ...spec, wide: true, group: true }, el("div", {}, list, addButton));
  return {
    path: spec.path,
    node,
    error,
    warn,
    accepts: (value) =>
      value === undefined || (isObject(value) && Object.values(/** @type {object} */ (value)).every((text) => typeof text === "string")),
    set(value) {
      rows = [];
      list.replaceChildren();
      for (const [name, text] of Object.entries(isObject(value) ? /** @type {Record<string, string>} */ (value) : {})) add(name, text);
    },
    read() {
      if (rows.length === 0) return undefined;
      /** @type {Record<string, string>} */
      const files = {};
      for (const row of rows) {
        const name = row.name.value.trim();
        if (!name) throw new FieldError(`${spec.label}: every file needs a name`);
        if (Object.hasOwn(files, name)) throw new FieldError(`${spec.label}: ${name} is listed twice`);
        files[name] = row.text.value;
      }
      return files;
    },
  };
}

/**
 * A JSON object. As a rest field it holds whatever under its path the other fields did not
 * take; blank stores nothing.
 * @param {FieldBase & { rows?: number, rest?: boolean, placeholder?: string }} spec
 * @returns {Field}
 */
export function jsonField(spec) {
  const input = el("textarea", { rows: spec.rows ?? 4, spellcheck: false, class: "code", placeholder: spec.placeholder ?? "{ }" });
  const { node, error, warn } = frame({ ...spec, wide: true }, input);
  const field = {
    path: spec.path,
    node,
    error,
    warn,
    rest: spec.rest,
    accepts: (/** @type {unknown} */ value) => value === undefined || isObject(value),
    set: (/** @type {unknown} */ value) => void (input.value = isBlank(value) ? "" : JSON.stringify(value, null, 2)),
    read() {
      const text = input.value.trim();
      if (!text) return undefined;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new FieldError(`${spec.label} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!isObject(parsed)) throw new FieldError(`${spec.label} must be a JSON object, in { }`);
      return isBlank(parsed) ? undefined : parsed;
    },
  };
  // Reformat valid JSON on leaving the box, so a pasted one-liner reads like the stored value
  // will. Invalid JSON is reported on save instead: a message appearing on blur would move
  // the button being clicked out from under the pointer.
  input.addEventListener("blur", () => {
    try {
      field.set(field.read());
    } catch {
      // reported by read() when saving
    }
  });
  return field;
}

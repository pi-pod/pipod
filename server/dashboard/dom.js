// @ts-check
/**
 * Building the page. Everything the server or a person wrote is set as text, never parsed as
 * HTML, so a template name or a script cannot become markup.
 */
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
 * A button that ignores clicks while its action runs. Whether it is disabled otherwise is
 * the caller's to decide.
 * @param {string} label
 * @param {() => Promise<void>} action
 * @param {{ kind?: "primary" | "danger" }} [style]
 */
export function button(label, action, style = {}) {
  const node = el("button", { type: "button", class: style.kind ?? "" }, label);
  node.addEventListener("click", async () => {
    if (node.ariaBusy === "true") return;
    node.ariaBusy = "true";
    try {
      await action();
    } finally {
      node.ariaBusy = null;
    }
  });
  return node;
}

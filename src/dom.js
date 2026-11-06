// Small helpers for building the page. Children are always text nodes or
// elements, never markup.
export function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith("on")) e.addEventListener(name.slice(2), value);
    else if (name === "class") e.className = value;
    else if (name === "value") e.value = value;
    else if (value === true) {
      e.setAttribute(name, "");
      if (name in e) e[name] = true;
    } else e.setAttribute(name, value);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== "") e.append(c);
  return e;
}

export function mount(parent, ...children) {
  parent.replaceChildren(...children.filter((c) => c !== null && c !== undefined));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h("textarea", {}, text);
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

export function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = h("a", { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

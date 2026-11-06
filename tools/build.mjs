// Builds gapwallet.html: one file holding the page, its style and all its
// code. No dependencies, so that what makes the file can be read in a sitting;
// the same inputs give the same bytes.
//
//   node tools/build.mjs          writes gapwallet.html
//   node tools/build.mjs --check  exit 1 if gapwallet.html isn't what it would write
//
// The modules (src/, vendor/) are joined as they are, unminified: each one
// becomes a function, in the order of its imports, and imports and exports
// become plain assignments. It understands the forms of import and export
// these modules use, and stops on any other.
//
// The Content-Security-Policy allows the inline script and style by their
// SHA-256, so the page runs nothing it wasn't built with.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src/main.js");
const OUT = join(ROOT, "gapwallet.html");

// Not an ES module: runs with CommonJS's `module`.
const COMMONJS = /\.cjs$/;

const die = (message) => {
  console.error("build: " + message);
  process.exit(1);
};

// The names one `export const/let/var` statement declares, from just after
// the keyword. Finds the commas outside any brackets, strings and comments.
function declaredNames(src, start, file) {
  const names = [];
  let i = start, depth = 0, expectName = true;
  for (;;) {
    if (expectName) {
      const m = /^\s*([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 200));
      if (!m) die(`${file}: unsupported export at ${src.slice(i, i + 40)}`);
      names.push(m[1]);
      i += m[0].length;
      expectName = false;
    }
    const c = src[i];
    if (c === undefined) die(`${file}: unterminated export`);
    if (c === '"' || c === "'" || c === "`") {
      for (i++; src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return names;
    else if (c === "," && depth === 0) expectName = true;
    i++;
  }
}

function transform(path, src) {
  const file = relative(ROOT, path);
  const deps = [], exported = [];
  const dep = (spec) => {
    if (!spec.startsWith(".")) die(`${file}: bare import ${spec}`);
    const p = resolve(dirname(path), spec);
    if (!deps.includes(p)) deps.push(p);
    return JSON.stringify(relative(ROOT, p));
  };
  let body = src;
  body = body.replace(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?/gm, (_, names, spec) => {
    const binds = names.split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^(\S+)\s+as\s+(\S+)$/, "$1: $2"));
    return `const { ${binds.join(", ")} } = __mod(${dep(spec)});`;
  });
  body = body.replace(/^import\s*\*\s*as\s+(\S+)\s+from\s*"([^"]+)";?/gm, (_, name, spec) => `const ${name} = __mod(${dep(spec)});`);
  body = body.replace(/^import\s+(\S+)\s+from\s*"([^"]+)";?/gm, (_, name, spec) => `const ${name} = __mod(${dep(spec)}).default;`);
  if (/^import\b/m.test(body)) die(`${file}: an import this build doesn't understand`);
  body = body.replace(/^export\s*\{([^}]*)\};?/gm, (_, names) => {
    for (const s of names.split(",").map((x) => x.trim()).filter(Boolean)) {
      const m = /^(\S+)(?:\s+as\s+(\S+))?$/.exec(s);
      exported.push([m[2] || m[1], m[1]]);
    }
    return "";
  });
  body = body.replace(/^export\s+default\s+([A-Za-z_$][\w$]*);?/gm, (_, name) => {
    exported.push(["default", name]);
    return "";
  });
  body = body.replace(/^export\s+((?:async\s+)?function\*?|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exported.push([name, name]);
    return `${kind} ${name}`;
  });
  for (;;) {
    const m = /^export\s+(const|let|var)\s/m.exec(body);
    if (!m) break;
    const names = declaredNames(body, m.index + m[0].length, file);
    for (const n of names) exported.push([n, n]);
    body = body.slice(0, m.index) + m[1] + " " + body.slice(m.index + m[0].length);
  }
  if (/^export\b/m.test(body)) die(`${file}: an export this build doesn't understand`);
  const sets = exported.map(([as, name]) => `__exports[${JSON.stringify(as)}] = ${name};`).join(" ");
  return { deps, body: body + "\n" + sets + "\n" };
}

// In dependency order; each module once.
function collect(path, seen = new Map(), stack = []) {
  if (seen.has(path)) return seen;
  if (stack.includes(path)) die(`import cycle at ${relative(ROOT, path)}`);
  const src = readFileSync(path, "utf8");
  const mod = COMMONJS.test(path) ? { deps: [], body: src, commonjs: true } : transform(path, src);
  for (const d of mod.deps) collect(d, seen, [...stack, path]);
  seen.set(path, mod);
  return seen;
}

function bundle() {
  const out = ['"use strict";', "const __modules = new Map();", "const __mod = (name) => __modules.get(name);"];
  for (const [path, mod] of collect(ENTRY)) {
    const name = JSON.stringify(relative(ROOT, path));
    out.push(`\n// ======== ${relative(ROOT, path)} ========`);
    if (mod.commonjs) {
      out.push(`{ const module = { exports: {} }; const exports = module.exports;\n${mod.body}\n__modules.set(${name}, { default: module.exports }); }`);
    } else {
      out.push(`{ const __exports = {}; __modules.set(${name}, __exports);\n${mod.body}}`);
    }
  }
  return out.join("\n") + "\n";
}

const sha256b64 = (text) => createHash("sha256").update(text, "utf8").digest("base64");

function page() {
  const template = readFileSync(join(ROOT, "src/index.html"), "utf8");
  const style = readFileSync(join(ROOT, "src/style.css"), "utf8");
  const script = bundle();
  for (const [what, text] of [["script", script], ["style", style]]) {
    if (/<\/(script|style)|<!--/i.test(text)) die(`the ${what} holds a sequence that would end its element`);
  }
  const csp = ["default-src 'none'", `script-src 'sha256-${sha256b64(script)}'`, `style-src 'sha256-${sha256b64(style)}'`,
    "img-src data:", "connect-src https: http:", "base-uri 'none'", "form-action 'none'"].join("; ");
  const fill = (name, value) => (t) => {
    if (t.split(name).length !== 2) die(`src/index.html needs ${name} once`);
    return t.split(name).join(value);
  };
  return [fill("%%CSP%%", csp), fill("%%STYLE%%", style), fill("%%SCRIPT%%", script)].reduce((t, f) => f(t), template);
}

const html = page();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch { /* reported below */ }
  if (current !== html) die("gapwallet.html is out of date: run node tools/build.mjs");
  console.log("gapwallet.html is up to date");
} else {
  writeFileSync(OUT, html);
  console.log(`gapwallet.html: ${html.length} bytes`);
}

// Builds the prototype into self-contained HTML (all JS and CSS inline, works offline):
//   dist/receivasg-prototype.html  — open directly in a browser, or host on GitHub Pages
//   dist/artifact.html             — same app, as a page fragment for publishing as an artifact
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "fs/promises";

const here = (p) => new URL(p, import.meta.url).pathname;
const stub = here("./src/empty-module.cjs");

const cspSafe = {
  name: "csp-safe",
  setup(b) {
    // @ethereumjs/evm detects the browser with new Function(...), which a strict CSP forbids.
    b.onLoad({ filter: /@ethereumjs[\\/]evm[\\/]dist[\\/]evm\.js$/ }, async (args) => {
      let src = await readFile(args.path, "utf8");
      src = src.replace("new Function('try {return this===window;}catch(e){ return false;}')", "(() => true)");
      if (src.includes("new Function")) throw new Error("evm.js patch failed");
      return { contents: src, loader: "js" };
    });
  },
};

const result = await build({
  entryPoints: [here("./src/app.jsx")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  write: false,
  jsx: "automatic",
  loader: { ".json": "json" },
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  inject: [here("./src/node-shims.mjs")],
  alias: {
    crypto: stub, fs: stub, http: stub, https: stub, path: stub, url: stub, zlib: stub,
    "mcl-wasm": stub,
    "rustbn.js": here("./src/rustbn-stub.cjs"),
  },
  plugins: [cspSafe],
  logLevel: "warning",
});

let js = result.outputFiles[0].text
  .replace(/<\/script/gi, "<\\/script")
  // Library metadata contains GitHub links (one to a pull request); they are inert strings,
  // but some hosts treat pages that contain PR links specially, so shorten them.
  .replace(/https?:\/\/github\.com\//g, "gh:")
  .replace(/\/pull\/(\d+)/g, " PR $1");
if (/new Function\(|[^a-zA-Z_$.]eval\(/.test(js)) console.warn("warning: bundle contains eval/new Function");
const css = await readFile(here("./src/styles.css"), "utf8");
const fonts = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap">';
const title = "<title>ReceivaSG Prototype</title>";
const body = `<div id="root"></div>\n<script>${js}</script>`;

await mkdir(here("../dist"), { recursive: true });
await writeFile(
  here("../dist/receivasg-prototype.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${title}\n${fonts}\n<style>${css}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`
);
// Artifact variant: small page + the app bundle as a separate file published alongside it.
await mkdir(here("../dist/artifact"), { recursive: true });
await writeFile(here("../dist/artifact/app.js"), js);
await writeFile(
  here("../dist/artifact/index.html"),
  `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${fonts}\n<style>${css}</style>\n<div id="root"></div>\n<script src="app.js"></script>\n`
);
// GitHub Pages copy: served from the /docs folder on the main branch.
await mkdir(here("../docs"), { recursive: true });
await writeFile(here("../docs/index.html"), await readFile(here("../dist/receivasg-prototype.html"), "utf8"));
await writeFile(here("../docs/.nojekyll"), "");
console.log(`built dist/receivasg-prototype.html (${(js.length / 1024 / 1024).toFixed(2)} MB of JS)`);

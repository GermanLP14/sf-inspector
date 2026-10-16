// Compila entry.js en un único módulo ES dentro de la extensión.
// Uso: npm install && node build.mjs
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.ORGLENS_OUT || resolve(here, "../../lib/vendor/codemirror.js");

await build({
  entryPoints: [resolve(here, "entry.js")],
  bundle: true,
  format: "esm",
  minify: true,
  target: "chrome114",
  legalComments: "eof",
  outfile: out,
});
console.log("Bundle generado en", out);

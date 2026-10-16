// Genera las páginas HTML de las piezas de la Chrome Web Store (capturas con título, promos, ícono).
// Uso: node make-store-assets.mjs <carpeta-capturas-crudas> <carpeta-html-salida>
// Luego render-store-assets.ps1 las convierte en PNG de 24 bits (sin alfa) en store/.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const raw = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const iconSvg = readFileSync(join(here, "../icon/icon.svg"), "utf8");

const FONT = `"Segoe UI Variable Display","Segoe UI",Inter,system-ui,sans-serif`;
const BG = `radial-gradient(900px 500px at 15% -10%, rgba(34,211,238,.35), transparent 60%),
  radial-gradient(800px 500px at 100% 110%, rgba(192,38,211,.35), transparent 60%),
  linear-gradient(135deg, #0b1020 0%, #1e1b4b 55%, #2e1065 100%)`;
const GRAD_TEXT = `background:linear-gradient(90deg,#22d3ee,#818cf8,#e879f9);-webkit-background-clip:text;background-clip:text;color:transparent`;
const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
  body{font-family:${FONT};background:${BG};color:#fff;position:relative}
  .g{${GRAD_TEXT}}
</style></head><body>${body}</body></html>`;

// ───── Capturas 1280×800 con título
const SHOTS = [
  ["1-home", "Find anything in your org", "in seconds", "Metadata and records of any Salesforce org, with instant search and filters."],
  ["2-conflict", "Spot metadata conflicts", "before they bite", "Clashing triggers, flow order, retired automations — why it happens and how to fix it."],
  ["3-record", "Every field of any record,", "editable in place", "Respects field-level security, sharing and validation rules. Browse related records too."],
  ["4-soql", "Live SOQL console", "with autocomplete", "Results as you type, query history, and export to Excel, CSV or JSON."],
  ["5-ide", "Edit Apex & LWC", "and save to your org", "Built-in IDE with syntax colors, compile errors on the exact line, and Validate."],
];
for (const [file, title, accent, sub] of SHOTS) {
  writeFileSync(
    join(out, `${file}.html`),
    page(
      1280,
      800,
      `<div style="position:absolute;top:30px;left:0;right:0;text-align:center">
        <div style="font-size:40px;font-weight:800;letter-spacing:-.025em;line-height:1.1">${title} <span class="g">${accent}</span></div>
        <div style="margin-top:9px;font-size:18px;color:#c7d2fe">${sub}</div>
      </div>
      <img src="${fileUrl(join(raw, file + ".png"))}" style="position:absolute;left:120px;top:140px;width:1040px;border-radius:14px;
        border:1px solid rgba(255,255,255,.14);box-shadow:0 34px 80px -24px rgba(0,0,0,.75), 0 0 0 6px rgba(255,255,255,.04)">`
    )
  );
}

// ───── Promo pequeña 440×280
writeFileSync(
  join(out, "promo-small.html"),
  page(
    440,
    280,
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center">
      <div style="width:92px;height:92px">${iconSvg.replace("<svg ", '<svg width="92" height="92" ')}</div>
      <div style="font-size:38px;font-weight:800;letter-spacing:-.03em">Org<span class="g">Gadget</span></div>
      <div style="font-size:15px;color:#c7d2fe;max-width:360px;line-height:1.35">The Salesforce toolkit: data, metadata,<br>SOQL, code & conflicts in one place</div>
    </div>`
  )
);

// ───── Marquesina 1400×560
const chip = (t) =>
  `<span style="display:inline-block;padding:8px 14px;margin:0 8px 10px 0;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);font-size:17px;font-weight:600">${t}</span>`;
writeFileSync(
  join(out, "promo-marquee.html"),
  page(
    1400,
    560,
    `<div style="position:absolute;left:80px;top:0;bottom:0;width:560px;display:flex;flex-direction:column;justify-content:center">
      <div style="display:flex;align-items:center;gap:18px">
        <div style="width:84px;height:84px">${iconSvg.replace("<svg ", '<svg width="84" height="84" ')}</div>
        <div style="font-size:56px;font-weight:800;letter-spacing:-.035em">Org<span class="g">Gadget</span></div>
      </div>
      <div style="margin-top:18px;font-size:30px;font-weight:700;line-height:1.2;letter-spacing:-.02em">Your whole Salesforce org,<br><span class="g">one click away</span></div>
      <div style="margin-top:22px">${["Metadata & records", "Conflict detection", "Live SOQL", "Apex & LWC IDE", "Excel export"].map(chip).join("")}</div>
    </div>
    <img src="${fileUrl(join(raw, "1-home.png"))}" style="position:absolute;left:700px;top:70px;width:760px;border-radius:16px;
      transform:perspective(1600px) rotateY(-14deg) rotateX(4deg);transform-origin:left center;
      border:1px solid rgba(255,255,255,.16);box-shadow:0 40px 90px -20px rgba(0,0,0,.8)">`
  )
);

// ───── Ícono de la tienda: 128×128 con el dibujo en 96×96 y 16 px de margen transparente
writeFileSync(
  join(out, "icon-store.html"),
  `<!doctype html><html><body style="margin:0;width:128px;height:128px;background:transparent">
    <div style="position:absolute;left:16px;top:16px;width:96px;height:96px">${iconSvg.replace("<svg ", '<svg width="96" height="96" ')}</div>
  </body></html>`
);
console.log("HTML generados en", out);

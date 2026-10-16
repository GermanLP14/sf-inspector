// Genera el SVG del ícono (maestro + versiones simplificadas para tamaños chicos).
// Uso: node make-icon.mjs <carpeta-salida>  → icon.svg, icon-small.svg, icon-tiny.svg
// Los PNG (16/32/48/128) se renderizan desde estos SVG con un navegador (ver render-icons.ps1).
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Marca en una grilla de 24×24 (la misma que usa el logo dentro de la app).
// Aro de la lupa con un corte arriba a la derecha (θ de -20° a -70°, centro 10.5,10.5, r 6.5).
const RING = "M16.61 8.28A6.5 6.5 0 1 1 12.72 4.39";
const HANDLE = "M15.4 15.4 20.6 20.6";
const NODES = [
  [7.9, 12.3],
  [13, 11.6],
  [10.3, 7.9],
];
const SPARK = "M16.4 2.6 17 4.5 18.9 5.1 17 5.7 16.4 7.6 15.8 5.7 13.9 5.1 15.8 4.5Z";

function svg({ detail = "full" } = {}) {
  const tiny = detail === "tiny";
  const ringW = tiny ? 3 : 2.3;
  const handleW = tiny ? 3.6 : 2.9;
  const scale = tiny ? 4.6 : 4.15;
  const graph = tiny
    ? `<circle cx="10.5" cy="10.5" r="2.2" fill="#fff"/>`
    : `<path d="M${NODES[0]} L${NODES[1]} L${NODES[2]} Z" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.15" stroke-linejoin="round"/>
       ${NODES.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === 1 ? 1.55 : 1.3}" fill="#fff"/>`).join("")}`;
  const spark = detail === "full" || detail === "small" ? `<path d="${SPARK}" fill="url(#spark)"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset=".46" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#c026d3"/>
    </linearGradient>
    <radialGradient id="shine" cx=".28" cy=".12" r=".85">
      <stop offset="0" stop-color="#fff" stop-opacity=".42"/>
      <stop offset=".55" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="spark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fef08a"/>
      <stop offset="1" stop-color="#fb923c"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${tiny ? 0 : 2.2}" stdDeviation="${tiny ? 0 : 2.4}" flood-color="#1e1b4b" flood-opacity=".5"/>
    </filter>
  </defs>
  <rect x="4" y="4" width="120" height="120" rx="${tiny ? 26 : 30}" fill="url(#bg)"/>
  ${tiny ? "" : `<rect x="4" y="4" width="120" height="120" rx="30" fill="url(#shine)"/>
  <rect x="4.75" y="4.75" width="118.5" height="118.5" rx="29.25" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="1.5"/>`}
  <g filter="url(#drop)" transform="translate(64 64) scale(${scale}) translate(-12.3 -12)">
    <path d="${RING}" fill="none" stroke="#fff" stroke-width="${ringW}" stroke-linecap="round"/>
    <path d="${HANDLE}" fill="none" stroke="#fff" stroke-width="${handleW}" stroke-linecap="round"/>
    ${graph}
    ${spark}
  </g>
</svg>`;
}

const out = process.argv[2] || ".";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon.svg"), svg({ detail: "full" }));
writeFileSync(join(out, "icon-small.svg"), svg({ detail: "small" }));
writeFileSync(join(out, "icon-tiny.svg"), svg({ detail: "tiny" }));
console.log("SVG generados en", out);

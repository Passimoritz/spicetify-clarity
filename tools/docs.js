// node tools/docs.js – measures Clarity against the live AutoEq database and draws the
// README graphics (docs/*.svg) plus docs/stats.json. Needs internet.
const fs = require("node:fs");
const path = require("node:path");
const c = require("../src/clarity.js");

const root = path.join(__dirname, "..");
const out = (f, s) => fs.writeFileSync(path.join(root, "docs", f), s);
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
const AUTOEQ = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/";

async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return r.text();
  }
  throw new Error("fetch failed: " + url);
}

// Deterministic sample so the numbers don't jump between runs.
function sample(list, n, seed = 7) {
  const a = list.slice();
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

(async () => {
  const entries = c.parseIndex(await get(AUTOEQ + "INDEX.md"));

  // Detection: how Windows would name the device – with brand, and without (common for Bluetooth/USB).
  // AutoEq also lists variants (switch positions, nozzles, ear pads) that no device name
  // ever contains – the same model with a different variant counts as found.
  const base = (n) => n.replace(/\s*\(.*\)\s*$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let withBrand = 0, withoutBrand = 0, wrong = 0;
  for (const e of entries) {
    const a = c.matchDevice(entries, `Headphones (${e.name})`);
    if (a && base(a.name) === base(e.name)) withBrand++;
    else if (a) wrong++;
    const model = e.name.split(" ").slice(1).join(" ");
    const b = c.matchDevice(entries, `Headphones (${model})`);
    if (b && base(b.name) === base(e.name)) withoutBrand++;
  }

  // Fit quality on a sample of real profiles.
  const picked = sample(entries, 80);
  const fits = [];
  for (const e of picked) {
    try {
      const points = c.parseGraphicEq(await get(AUTOEQ + e.path + "/" + e.path.split("/").pop() + "%20GraphicEQ.txt"));
      const raw = Math.sqrt(points.reduce((s, p) => s + (p.f >= 20 && p.f <= 16000 ? p.g * p.g : 0), 0) / points.filter((p) => p.f >= 20 && p.f <= 16000).length);
      fits.push({ name: e.name, raw, ...c.fitWithHeadroom(points, 0.5) });
    } catch {
      /* skip unreachable profiles */
    }
  }

  const stats = {
    date: new Date().toISOString().slice(0, 10),
    profiles: entries.length,
    detectedWithBrand: withBrand / entries.length,
    detectedWithoutBrand: withoutBrand / entries.length,
    wrongProfile: wrong / entries.length,
    sample: fits.length,
    medianError: median(fits.map((f) => f.rmsError)),
    medianUncorrected: median(fits.map((f) => f.raw)),
    medianQuieter: median(fits.map((f) => f.quieterBy)),
    languages: fs.readdirSync(path.join(root, "locales")).filter((f) => f.endsWith(".json")).length,
    texts: Object.keys(JSON.parse(fs.readFileSync(path.join(root, "locales", "en.json"), "utf8"))).length,
  };
  out("stats.json", JSON.stringify(stats, null, 2) + "\n");
  console.log(stats);

  // ---- Graphics ----
  const pct = (x) => Math.round(x * 1000) / 10 + " %";
  const db = (x) => "±" + x.toFixed(1) + " dB";
  const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";
  const css = `<style>
    .t{${FONT};fill:#e8eaf0}.s{${FONT};fill:#9aa3b2}
    @media (prefers-color-scheme: light){.t{fill:#14161c}.s{fill:#596172}.bg{fill:#f6f7f9;stroke:#e1e4ea}}
  </style>`;

  // Banner with an animated spectrum.
  const bars = Array.from({ length: 34 }, (_, i) => {
    const h = 18 + Math.round(40 * Math.abs(Math.sin(i * 0.55)) + 12 * Math.abs(Math.sin(i * 1.7)));
    const x = 500 + i * 14;
    const d = (0.9 + (i % 5) * 0.17).toFixed(2);
    return `<rect x="${x}" y="${150 - h}" width="8" height="${h}" rx="4" fill="url(#g)" style="transform-origin:${x + 4}px 150px;animation:b ${d}s ease-in-out ${(i * 0.07).toFixed(2)}s infinite alternate"/>`;
  }).join("");
  out("banner.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 220" width="1000" height="220">${css}
<style>@keyframes b{from{transform:scaleY(.35)}to{transform:scaleY(1)}}@media (prefers-reduced-motion:reduce){rect{animation:none!important}}</style>
<defs><linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#1ed760"/><stop offset="1" stop-color="#7cf5b0"/></linearGradient>
<linearGradient id="bgg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1115"/><stop offset="1" stop-color="#16201a"/></linearGradient></defs>
<rect class="bg" x="1" y="1" width="998" height="218" rx="22" fill="url(#bgg)" stroke="#242a33"/>
<text class="t" x="56" y="104" font-size="64" font-weight="800" letter-spacing="-1.5">Clarity</text>
<text class="s" x="58" y="142" font-size="20">Best Spotify sound in one click.</text>
<text class="s" x="58" y="170" font-size="15">Lossless · headphone correction · ${stats.languages} languages</text>
${bars}</svg>`);

  // Stat cards.
  const cards = [
    [stats.profiles.toLocaleString("en-US"), "headphone profiles"],
    [pct(stats.detectedWithBrand), "found from the device name"],
    [db(stats.medianError), "median fit to the ideal"],
    [String(stats.languages), "languages, like Spotify"],
  ];
  out("stats.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 130" width="1000" height="130">${css}
${cards.map(([v, l], i) => `<g transform="translate(${i * 250 + 4},4)"><rect class="bg" width="238" height="120" rx="18" fill="#12151b" stroke="#242a33"/>
<text class="t" x="22" y="62" font-size="36" font-weight="800">${v}</text><text class="s" x="22" y="94" font-size="15">${l}</text>
<rect x="22" y="18" width="28" height="4" rx="2" fill="#1ed760"/></g>`).join("\n")}</svg>`);

  // Example curves: ideal vs Spotify's EQ.
  const examples = ["Sennheiser HD 600", "Sony WH-1000XM4", "HyperX Cloud II", "Apple AirPods Pro"];
  const panels = [];
  for (const [i, name] of examples.entries()) {
    const e = entries.find((x) => x.name === name);
    if (!e) continue;
    const points = c.parseGraphicEq(await get(AUTOEQ + e.path + "/" + e.path.split("/").pop() + "%20GraphicEQ.txt"));
    const fit = c.fitWithHeadroom(points, 0.5);
    const W = 450, H = 150, ox = (i % 2) * 500 + 25, oy = Math.floor(i / 2) * 248 + 52;
    const lo = Math.log10(20), hi = Math.log10(20000);
    const x = (f) => ox + ((Math.log10(f) - lo) / (hi - lo)) * W;
    const y = (g) => oy + ((14 - Math.max(-14, Math.min(14, g))) / 28) * H;
    const ideal = points.filter((p) => p.f >= 20 && p.f <= 20000).map((p) => `${x(p.f).toFixed(1)},${y(p.g - fit.quieterBy).toFixed(1)}`).join(" ");
    const fr = [];
    for (let f = 20; f <= 20000; f *= 1.04) fr.push(f);
    const got = c.curveDb(fit.gains, fr).map((g, k) => `${x(fr[k]).toFixed(1)},${y(g).toFixed(1)}`).join(" ");
    const grid = [100, 1000, 10000].map((f) => `<line x1="${x(f)}" x2="${x(f)}" y1="${oy}" y2="${oy + H}" stroke="#8a93a3" opacity=".18"/><text class="s" x="${x(f)}" y="${oy + H + 16}" font-size="11" text-anchor="middle">${f >= 1000 ? f / 1000 + "k" : f} Hz</text>`).join("");
    panels.push(`<rect class="bg" x="${ox - 21}" y="${oy - 48}" width="${W + 42}" height="${H + 78}" rx="16" fill="#12151b" stroke="#242a33"/>
<text class="t" x="${ox}" y="${oy - 20}" font-size="16" font-weight="700">${name}</text>
<text class="s" x="${ox + W}" y="${oy - 20}" font-size="13" text-anchor="end">${db(fit.rmsError)} · ${e.source}</text>
${grid}<line x1="${ox}" x2="${ox + W}" y1="${y(0)}" y2="${y(0)}" stroke="#8a93a3" opacity=".35"/>
<polyline points="${ideal}" fill="none" stroke="#8a93a3" stroke-width="1.5" stroke-dasharray="4 3"/>
<polyline points="${got}" fill="none" stroke="#1ed760" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  out("curves.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 482" width="1000" height="482">${css}
${panels.join("\n")}</svg>`);
  console.log("docs/banner.svg, docs/stats.svg, docs/curves.svg written");
})();

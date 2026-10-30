// node tools/build.js – bundles src/clarity.js and locales/*.json into dist/clarity.js.
// Fails if a language misses a key, breaks a {placeholder} or the code uses an unknown key.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "src", "clarity.js"), "utf8");

// Every UI language Spotify ships (Apps/xpui/i18n, Spotify 1.3.6).
const SPOTIFY_LANGUAGES = (
  "af am ar ar-EG ar-MA ar-SA az bg bho bn bs ca cs da de el en en-GB es es-419 es-AR es-MX et eu fa fi fil fr fr-CA " +
  "gl gu he hi hr hu id is it ja kn ko lt lv mk ml mr ms nb ne nl or pa-IN pa-PK pl pt-BR pt-PT ro ru sk sl sr sv sw " +
  "ta te th tr uk ur vi zh-CN zh-HK zh-TW zu"
).split(" ");

const dir = path.join(root, "locales");
const locales = {};
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  locales[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}

const errors = [];
const en = locales.en;
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const [code, dict] of Object.entries(locales)) {
  for (const key of Object.keys(en)) {
    if (typeof dict[key] !== "string" || !dict[key].trim()) errors.push(`${code}: missing "${key}"`);
    else if (placeholders(dict[key]) !== placeholders(en[key])) errors.push(`${code}: placeholders differ in "${key}"`);
  }
  for (const key of Object.keys(dict)) if (!(key in en)) errors.push(`${code}: unknown key "${key}"`);
}
const used = new Set([...src.matchAll(/\bt\(\s*"([\w.-]+)"/g)].map((m) => m[1]));
for (const m of src.matchAll(/t\(\s*\w+\s*\?\s*"([\w.-]+)"\s*:\s*"([\w.-]+)"/g)) used.add(m[1]).add(m[2]);
for (const key of used) if (!key.endsWith(".") && !(key in en)) errors.push(`code uses unknown key "${key}"`);
const missing = SPOTIFY_LANGUAGES.filter((c) => !locales[c]);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const marker = "const LOCALES = {};";
if (!src.includes(marker)) throw new Error("LOCALES marker not found in src/clarity.js");
const out = src.replace(marker, () => "const LOCALES = " + JSON.stringify(locales) + ";");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "clarity.js"), out);
console.log(`dist/clarity.js: ${Object.keys(locales).length} languages, ${Object.keys(en).length} texts, ${(out.length / 1024).toFixed(0)} KB`);
if (missing.length) console.log("not translated yet (English is used):", missing.join(" "));

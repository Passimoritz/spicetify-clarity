// @ts-nocheck
// NAME: Clarity
// AUTHOR: Passimoritz
// VERSION: 2.0.0
// DESCRIPTION: Best Spotify sound in one click: best source quality, headphone correction from AutoEq measurements and optional exclusive mode. Leaves "Normalize volume" exactly as you set it.
//
// Clarity never touches audio data (no Spicetify extension can – playback is native and
// DRM-protected). It sets Spotify's own sound settings correctly and keeps them that way.
// Internal APIs (Spotify 1.3.6):
//   Platform.SettingsAPI.quality.* / .playback.*   getValue()/setValue()
//   Platform.EqualizerAPI           6 fixed bands, gain −12…+12 dB
//   Platform.ExclusiveModeAPI       get/setExclusiveModeEnabled, device list
//   Platform.ProductStateAPI        getValues().catalogue === "premium"

(function clarity() {
  "use strict";

  // ---------- Pure math (also testable in Node) ----------

  const FS = 44100;

  // Spotify's bands (from xpui: types and frequencies are fixed, only gain is adjustable).
  // Q is not exposed; Spotify uses the Web Audio type names, so we assume their
  // defaults: peaking Q = 1, shelves with slope S = 1.
  const BANDS = [
    { key: "audio.equalizer.low_shelf_gain_v2", type: "lowshelf", f: 60 },
    { key: "audio.equalizer.low_peak_gain_v2", type: "peaking", f: 150 },
    { key: "audio.equalizer.low_mid_peak_gain_v2", type: "peaking", f: 400 },
    { key: "audio.equalizer.high_mid_peak_gain_v2", type: "peaking", f: 1000 },
    { key: "audio.equalizer.high_peak_gain_v2", type: "peaking", f: 2400 },
    { key: "audio.equalizer.high_shelf_gain_v2", type: "highshelf", f: 15000 },
  ];
  const GAIN_LIMIT = 12;

  // Biquad coefficients from the RBJ Audio EQ Cookbook.
  function biquad(type, f0, gainDb, q = 1) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / FS;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    if (type === "peaking") {
      const alpha = sin / (2 * q);
      return [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
    }
    const alpha = (sin / 2) * Math.SQRT2; // S = 1
    const s = 2 * Math.sqrt(A) * alpha;
    if (type === "lowshelf") {
      return [
        A * (A + 1 - (A - 1) * cos + s),
        2 * A * (A - 1 - (A + 1) * cos),
        A * (A + 1 - (A - 1) * cos - s),
        A + 1 + (A - 1) * cos + s,
        -2 * (A - 1 + (A + 1) * cos),
        A + 1 + (A - 1) * cos - s,
      ];
    }
    return [
      A * (A + 1 + (A - 1) * cos + s),
      -2 * A * (A - 1 + (A + 1) * cos),
      A * (A + 1 + (A - 1) * cos - s),
      A + 1 - (A - 1) * cos + s,
      2 * (A - 1 - (A + 1) * cos),
      A + 1 - (A - 1) * cos - s,
    ];
  }

  // Magnitude of a biquad at frequency f in dB.
  function responseDb(c, f) {
    const w = (2 * Math.PI * f) / FS;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = c[3] + c[4] * c1 + c[5] * c2, di = -(c[4] * s1 + c[5] * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }

  function curveDb(gains, freqs) {
    const coeffs = BANDS.map((b, i) => biquad(b.type, b.f, gains[i]));
    return freqs.map((f) => coeffs.reduce((sum, c) => sum + responseDb(c, f), 0));
  }

  // "GraphicEQ: 20 -0.2; 21 -0.2; ..." → [{f, g}]
  function parseGraphicEq(text) {
    const body = String(text).replace(/^\s*GraphicEQ:\s*/i, "");
    return body
      .split(";")
      .map((p) => p.trim().split(/\s+/).map(Number))
      .filter(([f, g]) => Number.isFinite(f) && Number.isFinite(g) && f > 0)
      .map(([f, g]) => ({ f, g }));
  }

  // Weighting: bass and mids count fully; above 10 kHz measurements are unreliable
  // (fit, ear shape), so only follow them loosely.
  function weightAt(f) {
    if (f < 20 || f > 16000) return 0;
    return f > 10000 ? 0.3 : 1;
  }

  // Least squares via Gauss-Newton with a numeric Jacobian.
  function fitGains(points, offset = 0) {
    const freqs = points.map((p) => p.f);
    const target = points.map((p) => p.g - offset);
    const w = freqs.map(weightAt);
    const n = BANDS.length;
    const lambda = 0.02; // light damping against wild values
    let g = new Array(n).fill(0);
    for (let iter = 0; iter < 25; iter++) {
      const base = curveDb(g, freqs);
      const J = [];
      for (let k = 0; k < n; k++) {
        const gk = g.slice();
        gk[k] += 0.5;
        const c = curveDb(gk, freqs);
        J.push(c.map((v, i) => (v - base[i]) / 0.5));
      }
      // (JᵀWJ + λI) Δ = JᵀW r
      const M = Array.from({ length: n }, () => new Array(n).fill(0));
      const v = new Array(n).fill(0);
      for (let i = 0; i < freqs.length; i++) {
        const r = target[i] - base[i];
        for (let a = 0; a < n; a++) {
          v[a] += w[i] * J[a][i] * r;
          for (let b = 0; b < n; b++) M[a][b] += w[i] * J[a][i] * J[b][i];
        }
      }
      for (let a = 0; a < n; a++) M[a][a] += lambda;
      const delta = solve(M, v);
      let moved = 0;
      g = g.map((x, k) => {
        const next = Math.max(-GAIN_LIMIT, Math.min(GAIN_LIMIT, x + delta[k]));
        moved = Math.max(moved, Math.abs(next - x));
        return next;
      });
      if (moved < 0.01) break;
    }
    return g;
  }

  function solve(M, v) {
    const n = v.length;
    const a = M.map((row, i) => [...row, v[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      [a[c], a[p]] = [a[p], a[c]];
      const d = a[c][c] || 1e-9;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const k = a[r][c] / d;
        for (let j = c; j <= n; j++) a[r][j] -= k * a[c][j];
      }
    }
    return a.map((row, i) => row[n] / (row[i] || 1e-9));
  }

  // How far the final curve may boost without clipping. Spotify has no preamp. Without
  // normalization, peaks sit near 0 dBFS, so there is hardly any room. With normalization
  // on Quiet/Normal, Spotify turns loud tracks down and lifts quiet ones only up to
  // −1 dBTP – about 1 dB more room. Loud uses a limiter and lifts hard, so treat it
  // like normalization off.
  const VOLUME_LEVEL = { QUIET: 0, NORMAL: 1, LOUD: 2 };
  function headroomFor(normalize, level) {
    return normalize === true && level !== VOLUME_LEVEL.LOUD ? 1.5 : 0.5;
  }

  // Lower the target until the final curve boosts at most maxBoost dB.
  function fitWithHeadroom(points, maxBoost = 0.5) {
    const grid = [];
    for (let f = 20; f <= 20000; f *= 1.03) grid.push(f);
    let offset = 0;
    let gains = fitGains(points, offset);
    for (let i = 0; i < 6; i++) {
      const peak = Math.max(...curveDb(gains, grid));
      if (peak <= maxBoost) break;
      offset += peak - maxBoost + 0.05;
      gains = fitGains(points, offset);
    }
    const freqs = points.map((p) => p.f);
    const fitted = curveDb(gains, freqs);
    let se = 0, sw = 0;
    points.forEach((p, i) => {
      const w = weightAt(p.f);
      se += w * Math.pow(p.g - offset - fitted[i], 2);
      sw += w;
    });
    return {
      gains: gains.map((x) => Math.round(x * 10) / 10),
      rmsError: Math.sqrt(se / (sw || 1)),
      quieterBy: offset,
    };
  }

  // ---------- AutoEq database and device detection ----------

  const AUTOEQ = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/";
  const SOURCE_RANK = { oratory1990: 5, crinacle: 4, Rtings: 3, "Super Review": 2 };
  // Words Windows and drivers put into device names in many languages. They say nothing about the model.
  const GENERIC = new Set(
    ("headphones headphone headset kopfhorer kopfhoerer lautsprecher speakers speaker realtek high definition " +
      "audio device gerat geraet usb stereo hands free handsfree freisprech digital output ausgang line out " +
      "casque ecouteurs haut parleurs parleur auriculares altavoces cuffie altoparlanti fones alto falantes " +
      "koptelefoon luidsprekers sluchawki glosniki naushniki dinamiki hoofdtelefoon horlurar hogtalare " +
      "amd nvidia intel the and for with")
      .split(" ")
  );
  // Words many models share. On their own they prove nothing.
  const WEAK = new Set("wireless pro plus max mini lite se gaming true anc bt earbuds buds tws gen ultra".split(" "));
  const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5" };

  function tokens(s) {
    return String(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\((r|tm|c)\)|[®™]/g, " ")
      .split(/[^a-z0-9]+/)
      .map((t) => ROMAN[t] || t)
      .filter((t) => t && !GENERIC.has(t));
  }

  function parseIndex(md) {
    const best = new Map();
    for (const line of String(md).split("\n")) {
      const m = /^- \[(.+?)\]\((\.\/.+?)\) by (.+?)(?: on (.+))?\s*$/.exec(line);
      if (!m) continue;
      const [, name, path, source] = m;
      const rank = SOURCE_RANK[source] ?? 1;
      const prev = best.get(name);
      if (!prev || rank > prev.rank) best.set(name, { name, path: path.slice(2), source, rank, tokens: [...new Set(tokens(name))] });
    }
    return [...best.values()];
  }

  // Windows names devices like "Headphones (2- WH-1000XM4)" or, for USB headsets,
  // "Speakers (HyperX Cloud II Wireless)". The part in parentheses is the model.
  function deviceTokens(description) {
    const inner = /\(([^()]*(?:\([^)]*\)[^()]*)*)\)\s*$/.exec(description || "");
    return tokens(((inner ? inner[1] : description) || "").replace(/^\d+-\s*/, ""));
  }

  // Safe match: every model word must appear (brand optional, Windows often drops it) –
  // better no profile than a wrong one. Merged spellings ("WH1000XM4") count too.
  const brandCache = new WeakMap();
  function brandsOf(entries) {
    if (!brandCache.has(entries)) brandCache.set(entries, new Set(entries.map((e) => e.tokens[0])));
    return brandCache.get(entries);
  }

  function matchDevice(entries, description) {
    const list = deviceTokens(description);
    const dev = new Set(list);
    if (!dev.size) return null;
    // Runs of neighbouring words glued together: "WH 1000XM4" → "wh1000xm4".
    const runs = new Set();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j <= list.length; j++) runs.add(list.slice(i, j).join(""));
    // Names a brand → only that brand's models count (no "Grado PS500" → "Phiaton PS 500").
    const named = list.some((t) => brandsOf(entries).has(t));
    let hit = null;
    for (const e of entries) {
      const model = e.tokens.slice(1).filter((t) => t !== e.tokens[0]);
      if (!model.length) continue;
      const brand = dev.has(e.tokens[0]);
      if (named && !brand) continue;
      let score;
      if (model.every((t) => dev.has(t))) {
        // A single plain word ("Lagoon", "Pro") only counts together with the brand.
        if (model.length < 2 && !/\d/.test(model[0]) && !brand) continue;
        if (model.every((t) => WEAK.has(t)) && !brand) continue;
        score = model.length * 2;
      } else {
        const compact = model.join("");
        if (compact.length < 5 || !/\d/.test(compact) || !runs.has(compact)) continue;
        score = model.length * 2 - 0.5;
      }
      score -= (dev.size - model.length - (brand ? 1 : 0)) * 0.01; // fewer leftover words = closer
      score += (brand ? 1 : 0) + e.rank * 0.1;
      if (!hit || score > hit.score) hit = { entry: e, score };
    }
    return hit && hit.entry;
  }

  // Uncertain candidates when matchDevice finds nothing. Clarity offers them for
  // picking but never applies them on its own.
  function suggestEntries(entries, description, limit = 6) {
    const dev = deviceTokens(description);
    if (!dev.length) return [];
    // Prefixes only count for longer words ("buds2" ~ "buds2pro"), otherwise "pro" ~ "provence".
    const has = (t) => dev.some((d) => d === t || (Math.min(d.length, t.length) >= 4 && (d.startsWith(t) || t.startsWith(d))));
    const telling = (t) => t.length >= 5 || /\d/.test(t);
    const scored = [];
    for (const e of entries) {
      const model = e.tokens.slice(1);
      const brand = dev.includes(e.tokens[0]);
      const strong = model.filter((t) => !WEAK.has(t) && has(t));
      if (!strong.length) continue; // the brand alone is not enough
      if (!brand && !strong.some(telling)) continue;
      const weak = model.filter((t) => WEAK.has(t) && has(t)).length;
      const missing = model.length - strong.length - weak;
      const score = strong.length * 2 + weak * 0.5 + (brand ? 1.5 : 0) - missing * 0.7 + e.rank * 0.05;
      if (score > 1.5) scored.push({ e, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.e.name.length - b.e.name.length)
      .slice(0, limit)
      .map((s) => s.e);
  }

  // "headphones", "speakers" or "unknown" – guessed from the name only.
  function deviceKind(description) {
    const d = String(description || "");
    if (/kopfh|headphone|headset|earphone|ohrh|earbud|buds|airpods|in-ear|casque|ecouteur|écouteur|auricular|cuffie|fone|koptelefoon|słuchawk|наушник/i.test(d)) return "headphones";
    if (/lautsprecher|speaker|haut-parleur|altavoz|altoparlant|alto-falant|luidspreker|głośnik|динамик|hdmi|displayport|monitor|fernseher|\btv\b|spdif|s\/pdif|optical|realtek|line.?out/i.test(d)) return "speakers";
    return "unknown";
  }

  function searchEntries(entries, query, limit = 8) {
    const q = tokens(query);
    if (!q.length) return [];
    return entries
      .filter((e) => q.every((t) => e.tokens.some((et) => et.startsWith(t))))
      .sort((a, b) => b.rank - a.rank || a.name.length - b.name.length)
      .slice(0, limit);
  }

  function graphicEqUrl(entry) {
    const last = entry.path.split("/").pop();
    return `${AUTOEQ}${entry.path}/${last}%20GraphicEQ.txt`;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      BANDS, biquad, curveDb, parseGraphicEq, fitGains, fitWithHeadroom, headroomFor, VOLUME_LEVEL,
      parseIndex, matchDevice, suggestEntries, deviceKind, searchEntries, graphicEqUrl, tokens,
    };
    return;
  }

  // ---------- Language ----------

  // Filled by tools/build.js from locales/*.json (one file per Spotify UI language).
  const LOCALES = {};

  let localeCode = null;
  let strings = null;
  function lang() {
    if (!strings) {
      const raw = String(Spicetify.Locale?.getLocale?.() || navigator.language || "en");
      const keys = Object.keys(LOCALES);
      const find = (c) => keys.find((k) => k.toLowerCase() === c.toLowerCase());
      const code = find(raw) || find(raw.split("-")[0]) || "en";
      localeCode = code;
      strings = LOCALES[code] || {};
    }
    return strings;
  }
  function t(key, vars) {
    let s = lang()[key] ?? LOCALES.en?.[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    return s;
  }
  // Spotify's own translation if it has one – e.g. the official quality names.
  function spotify(key, fallbackKey) {
    try {
      const v = Spicetify.Locale?.getDictionary?.()?.[key];
      if (typeof v === "string" && v) return v;
    } catch {
      /* fall back to our own text */
    }
    return t(fallbackKey);
  }
  function listOf(items) {
    try {
      return new Intl.ListFormat(localeCode || "en", { type: "conjunction" }).format(items);
    } catch {
      return items.join(", ");
    }
  }
  function num(x) {
    try {
      return x.toLocaleString(localeCode || "en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    } catch {
      return x.toFixed(1);
    }
  }

  // ---------- Spotify bridge ----------

  const STORE = "clarity:v1";
  const VERSION = 2;
  const QUALITY = { AUTOMATIC: 0, LOW: 1, NORMAL: 2, HIGH: 3, VERY_HIGH: 4, LOSSLESS: 5 };
  const QUALITY_KEY = ["automatic", "low", "normal", "high", "very-high", "lossless"];
  const qualityName = (q) =>
    q === QUALITY.LOSSLESS
      ? spotify("web-player.pigeon.audio-quality.lossless", "q.lossless")
      : q in QUALITY_KEY
        ? spotify("web-player.pigeon.audio-quality." + QUALITY_KEY[q] + ".label", "q." + QUALITY_KEY[q])
        : t("state.unknown");
  // Player bitrateLevel: 0 unknown … 4 very high, 5 lossless 16-bit, 6 lossless 24-bit.
  function bitrateName(level) {
    if (level === 6) return spotify("web-player.pigeon.audio-quality.lossless-24.label", "q.lossless24");
    if (level === 5) return spotify("web-player.pigeon.audio-quality.lossless-16.label", "q.lossless16");
    if (level === 4) return qualityName(QUALITY.VERY_HIGH) + " · 320 kbps";
    if (level >= 1 && level <= 3) return qualityName(level);
    return t("state.unknown");
  }
  const SOURCE_KEY = { 3: "src.download", 4: "src.cache", 5: "src.local" };

  function load() {
    try {
      return JSON.parse(Spicetify.LocalStorage.get(STORE)) || {};
    } catch {
      return {};
    }
  }
  function save(state) {
    try {
      Spicetify.LocalStorage.set(STORE, JSON.stringify(state));
    } catch {
      /* storage full or blocked – Clarity still works, it just forgets */
    }
  }
  const optionsOf = (state) => ({ correction: true, exclusive: false, ...state.options });

  // Find a Platform API by name first, otherwise by a typical method.
  // Spotify likes to rename internals; this survives small updates.
  function findApi(name, method) {
    const p = Spicetify.Platform || {};
    try {
      if (p[name] && typeof p[name][method] === "function") return p[name];
    } catch {
      /* getter may throw */
    }
    for (const key of Object.keys(p)) {
      try {
        const o = p[key];
        if (o && typeof o[method] === "function") return o;
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  function apis() {
    const settings = Spicetify.Platform?.SettingsAPI;
    return {
      quality: settings?.quality,
      playback: settings?.playback,
      eq: findApi("EqualizerAPI", "setFilterGain"),
      exclusive: findApi("ExclusiveModeAPI", "setExclusiveModeEnabled"),
      product: findApi("ProductStateAPI", "getValues"),
    };
  }

  async function read(setting) {
    if (!setting || typeof setting.getValue !== "function") return undefined;
    try {
      return await setting.getValue();
    } catch {
      return undefined;
    }
  }
  async function write(setting, value) {
    if (!setting || typeof setting.setValue !== "function") return false;
    try {
      await setting.setValue(value);
      return true;
    } catch (e) {
      console.warn("[Clarity] write failed:", setting.key, e);
      return false;
    }
  }
  // Write and read back – only what is actually stored counts.
  async function ensure(setting, value) {
    if (!setting) return undefined;
    if ((await read(setting)) === value) return true;
    await write(setting, value);
    return (await read(setting)) === value;
  }

  // true = Premium, false = Free, undefined = unknown (then try Lossless).
  async function isPremium(product) {
    try {
      const v = await product?.getValues?.();
      if (v && typeof v.catalogue === "string") return v.catalogue === "premium";
    } catch {
      /* unknown */
    }
    return undefined;
  }
  const bestQuality = (premium) => (premium === false ? QUALITY.VERY_HIGH : QUALITY.LOSSLESS);

  // Lossless isn't available everywhere. If Spotify doesn't keep it, take 320 kbps.
  async function setBestQuality(setting, premium) {
    if (!setting) return undefined;
    if (premium !== false && (await ensure(setting, QUALITY.LOSSLESS))) return QUALITY.LOSSLESS;
    await ensure(setting, QUALITY.VERY_HIGH);
    return read(setting);
  }

  function eqEnabled(eq) {
    return new Promise((resolve) => {
      if (!eq?.subscribeToEnabledState) return resolve(undefined);
      let off = null;
      const timer = setTimeout(() => resolve(undefined), 1500);
      try {
        off = eq.subscribeToEnabledState((v) => {
          clearTimeout(timer);
          resolve(!!v);
          setTimeout(() => typeof off === "function" && off(), 0);
        });
      } catch {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  async function eqGains(eq) {
    try {
      const filters = await eq.getFilters();
      return BANDS.map((b) => filters.find((f) => f.key === b.key)?.gain ?? 0);
    } catch {
      return undefined;
    }
  }

  async function setEq(eq, gains, enabled) {
    if (!eq) return false;
    try {
      BANDS.forEach((b, i) => eq.setFilterGain(b.key, gains[i]));
      eq.setEnabledState(enabled);
      return true;
    } catch (e) {
      console.warn("[Clarity] EQ failed:", e);
      return false;
    }
  }

  // Without an explicit choice in Spotify (Windows default device),
  // selectedAudioDevice() returns nothing – then take the first present device.
  async function selectedDevice(ex) {
    const usable = (d) => (d && d.present !== false && (d.id || d.description) ? d : null);
    try {
      const direct = usable(ex?.selectedAudioDevice?.()) || usable(await ex?.getSelectedAudioOutputDevice?.());
      if (direct) return direct;
      let list = ex?.audioDevices?.() || [];
      if (!list.some(usable)) list = (await ex?.fetchDeviceList?.()) || [];
      return list.find(usable) || null;
    } catch {
      return null;
    }
  }
  const deviceId = (device) => device?.id || device?.description || null;

  function isBluetooth(device) {
    if (!device) return false;
    const iface = String(device.interface ?? "");
    return iface === "3" || /bluetooth/i.test(iface) || /bluetooth|hands-?free|freisprech|airpods|buds/i.test(device.description || "");
  }

  function playbackQuality() {
    const p = Spicetify.Platform?.PlayerAPI;
    return Spicetify.Player?.data?.playbackQuality ?? p?._state?.playbackQuality ?? p?.getState?.()?.playbackQuality ?? null;
  }

  // "Normalize volume" (normalizeVolume, volumeLevel) is only read – for the correction's
  // headroom – never written and never saved.
  async function snapshot(a) {
    return {
      streamingQuality: await read(a.quality?.streamingQuality),
      downloadAudioQuality: await read(a.quality?.downloadAudioQuality),
      autoAdjustQuality: await read(a.quality?.autoAdjustQuality),
      audioCrossfade: await read(a.playback?.audioCrossfade),
      autoMix: await read(a.playback?.autoMix),
      monoAudio: await read(a.playback?.monoAudio),
      gapless: await read(a.playback?.gapless),
      eqEnabled: await eqEnabled(a.eq),
      eqGains: a.eq ? await eqGains(a.eq) : undefined,
      exclusive: a.exclusive ? await a.exclusive.getExclusiveModeEnabled().catch(() => undefined) : undefined,
    };
  }

  async function loudness(a) {
    return { normalize: await read(a.quality?.normalizeVolume), level: await read(a.quality?.volumeLevel) };
  }

  // ---------- Headphone profile ----------

  let indexCache = null;
  async function autoEqIndex() {
    if (!indexCache) {
      const res = await fetch(AUTOEQ + "INDEX.md");
      if (!res.ok) throw new Error("AutoEq index " + res.status);
      indexCache = parseIndex(await res.text());
    }
    return indexCache;
  }

  // We store the measurement points, not finished gains: the allowed headroom
  // depends on whether "Normalize volume" is on right now.
  async function profileFor(entry) {
    const res = await fetch(graphicEqUrl(entry));
    if (!res.ok) throw new Error("AutoEq profile " + res.status);
    const points = parseGraphicEq(await res.text()).filter((p, i) => i % 2 === 0 || p.f > 10000);
    if (points.length < 20) throw new Error("AutoEq profile is empty");
    return { name: entry.name, source: entry.source, path: entry.path, points };
  }

  async function withPoints(profile) {
    if (!profile || profile.points) return profile;
    return profileFor(profile); // older entries without points: fetch again
  }

  const fitCache = new Map();
  function fitFor(profile, maxBoost) {
    const k = profile.path + "|" + maxBoost;
    if (!fitCache.has(k)) fitCache.set(k, fitWithHeadroom(profile.points, maxBoost));
    return fitCache.get(k);
  }

  // What Clarity knows about the current device:
  //   saved    – the user picked or confirmed a profile
  //   none     – the user wants no correction for this device
  //   matched  – detected with certainty
  //   speakers – looks like speakers, no correction
  //   ask      – uncertain, candidates to pick from
  async function resolveDevice(state, device) {
    const id = deviceId(device);
    const base = { device, id, profile: null, suggestions: [], kind: deviceKind(device?.description) };
    if (!id) return { ...base, status: "nodevice" };
    state.profiles ??= {};
    if (id in state.profiles) {
      const saved = state.profiles[id];
      if (saved === null) return { ...base, status: "none" };
      try {
        const full = await withPoints(saved);
        if (full !== saved) {
          state.profiles[id] = full;
          save(state);
        }
        return { ...base, status: "saved", profile: full };
      } catch (e) {
        return { ...base, status: "offline", profile: saved, error: e };
      }
    }
    try {
      const entries = await autoEqIndex();
      const entry = matchDevice(entries, device.description);
      if (entry) {
        const profile = { ...(await profileFor(entry)), auto: true };
        state.profiles[id] = profile;
        save(state);
        return { ...base, status: "matched", profile };
      }
      const suggestions = suggestEntries(entries, device.description);
      if (!suggestions.length && base.kind === "speakers") return { ...base, status: "speakers" };
      return { ...base, status: "ask", suggestions };
    } catch (e) {
      console.warn("[Clarity]", e);
      return { ...base, status: "offline", error: e };
    }
  }

  // ---------- Optimize / undo ----------

  // One click: best source, no silent downgrades, gapless, correction for the device.
  // Returns what happened so the panel can show it honestly.
  async function optimize({ quiet = false } = {}) {
    const a = apis();
    const state = load();
    const opts = optionsOf(state);
    if (!state.original) {
      state.original = await snapshot(a);
      save(state);
    }

    const changed = [];
    const before = await snapshot(a);
    const premium = await isPremium(a.product);
    const q = a.quality;
    const quality = await setBestQuality(q?.streamingQuality, premium);
    if (quality !== before.streamingQuality && quality !== undefined) changed.push(t("ch.quality", { quality: qualityName(quality) }));
    await setBestQuality(q?.downloadAudioQuality, premium);
    if (before.autoAdjustQuality && (await ensure(q?.autoAdjustQuality, false))) changed.push(t("ch.autoAdjust"));
    if (before.audioCrossfade && (await ensure(a.playback?.audioCrossfade, false))) changed.push(t("ch.crossfade"));
    if (before.autoMix && (await ensure(a.playback?.autoMix, false))) changed.push(t("ch.automix"));
    if (before.monoAudio && (await ensure(a.playback?.monoAudio, false))) changed.push(t("ch.stereo"));
    if (before.gapless === false && (await ensure(a.playback?.gapless, true))) changed.push(t("ch.gapless"));

    const device = await selectedDevice(a.exclusive);
    const info = await resolveDevice(state, device);
    let eqResult = null;
    if (a.eq) {
      if (opts.correction && info.profile?.points) {
        const lv = await loudness(a);
        eqResult = fitFor(info.profile, headroomFor(lv.normalize, lv.level));
        const same = before.eqEnabled && before.eqGains?.every((g, i) => Math.abs(g - eqResult.gains[i]) < 0.05);
        if (!same && (await setEq(a.eq, eqResult.gains, true))) changed.push(t("ch.correction", { name: info.profile.name }));
        state.eqByClarity = true;
      } else if (state.eqByClarity && (info.status === "none" || info.status === "speakers" || !opts.correction)) {
        // A correction for the previous device must not keep running on this one.
        // An EQ the user set up themselves is left alone.
        await setEq(a.eq, [0, 0, 0, 0, 0, 0], false);
        state.eqByClarity = false;
        if (before.eqEnabled) changed.push(t("ch.correctionOff"));
      }
    }

    if (a.exclusive) {
      const want = !!opts.exclusive && !isBluetooth(device);
      const now = await a.exclusive.getExclusiveModeEnabled().catch(() => undefined);
      if (now !== want && (want || state.exclusiveByClarity)) {
        // Spotify jumps to 100 % volume when turning this on. Remember the volume and
        // restore it so it doesn't suddenly get loud.
        const vol = Spicetify.Player?.getVolume?.();
        await a.exclusive.setExclusiveModeEnabled(want).catch((e) => console.warn("[Clarity]", e));
        if (want && typeof vol === "number") setTimeout(() => Spicetify.Player?.setVolume?.(vol), 600);
        state.exclusiveByClarity = want;
        changed.push(t(want ? "ch.exclusiveOn" : "ch.exclusiveOff"));
      }
    }

    state.auto = true;
    save(state);
    if (!quiet || changed.length) {
      Spicetify.showNotification(changed.length ? t("note.changed", { list: listOf(changed) }) : t("note.nothing"));
    }
    refreshWidget();
    return { changed, info, eqResult, premium };
  }

  async function undo() {
    const a = apis();
    const state = load();
    const o = state.original;
    if (!o) return;
    const restore = [
      [a.quality?.streamingQuality, o.streamingQuality],
      [a.quality?.downloadAudioQuality, o.downloadAudioQuality],
      [a.quality?.autoAdjustQuality, o.autoAdjustQuality],
      [a.playback?.audioCrossfade, o.audioCrossfade],
      [a.playback?.autoMix, o.autoMix],
      [a.playback?.monoAudio, o.monoAudio],
      [a.playback?.gapless, o.gapless],
    ];
    for (const [s, v] of restore) if (v !== undefined) await write(s, v);
    if (a.eq && o.eqGains) await setEq(a.eq, o.eqGains, !!o.eqEnabled);
    if (a.exclusive && o.exclusive !== undefined) await a.exclusive.setExclusiveModeEnabled(o.exclusive).catch(() => {});
    delete state.original;
    state.auto = false;
    state.eqByClarity = false;
    state.exclusiveByClarity = false;
    save(state);
    Spicetify.showNotification(t("note.undone"));
    refreshWidget();
  }

  // Version 1 turned "Normalize volume" off. Undo that once if it came from Clarity,
  // then forget the value.
  async function migrate() {
    const state = load();
    if (state.v >= VERSION) return;
    const old = state.original?.normalizeVolume;
    if (old !== undefined) {
      const a = apis();
      if (state.auto && (await read(a.quality?.normalizeVolume)) !== old && (await ensure(a.quality?.normalizeVolume, old))) {
        Spicetify.showNotification(t("note.migrated"));
      }
      delete state.original.normalizeVolume;
    }
    if (state.profiles) {
      // Old profiles stored finished gains for a fixed headroom. Points are fetched next time.
      for (const [id, p] of Object.entries(state.profiles)) if (p && !p.points) state.profiles[id] = { name: p.name, source: p.source, path: p.path };
    }
    state.v = VERSION;
    save(state);
  }

  // ---------- UI ----------

  const ICON =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M2 6h1.5v4H2zM5 4h1.5v8H5zM8 1.5h1.5v13H8zM11 4h1.5v8H11zM14 6h1.5v4H14z"/></svg>';
  const GLYPH = {
    ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="draw" d="M4 8.4l2.6 2.6L12 5.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.6" r="1.2" fill="currentColor"/><path d="M8 7.5v4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  let widget = null;

  function qualityText() {
    const pq = playbackQuality();
    if (!pq) return { label: "Clarity", detail: "" };
    const detail = SOURCE_KEY[pq.strategy] ? t(SOURCE_KEY[pq.strategy]) : "";
    return { label: "Clarity · " + bitrateName(pq.bitrateLevel), detail, level: pq.bitrateLevel, target: pq.targetBitrateLevel, cached: pq.strategy === 4 };
  }

  function refreshWidget() {
    if (!widget) return;
    const q = qualityText();
    widget.label = q.label + (q.detail ? " (" + q.detail + ")" : "");
  }

  // Own button instead of Spicetify.Playbar.Widget: Spicetify remembers the bar once at
  // startup, Spotify 1.3.6 rebuilds it afterwards – its buttons then end up in a detached,
  // invisible element. We re-attach on every rebuild.
  function mountButton(onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = ICON;
    btn.addEventListener("click", onClick);
    const tip = Spicetify.Tippy?.(btn, { content: "Clarity", ...Spicetify.TippyProps });
    let label = "Clarity";
    const apply = () => {
      btn.setAttribute("aria-label", label);
      if (tip) tip.setContent(label);
      else btn.title = label;
    };
    apply();

    let queued = false;
    const attach = () => {
      queued = false;
      if (btn.isConnected) return;
      const bar = document.querySelector(".main-nowPlayingBar-right > div");
      if (!bar) return;
      const sibling = bar.querySelector("button");
      if (sibling) btn.className = sibling.className + " clarity-button";
      bar.prepend(btn);
    };
    new MutationObserver(() => {
      if (!queued && !btn.isConnected) {
        queued = true;
        requestAnimationFrame(attach);
      }
    }).observe(document.body, { childList: true, subtree: true });
    attach();

    return {
      get label() {
        return label;
      },
      set label(v) {
        label = v;
        apply();
      },
    };
  }

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  }

  const CSS = `
.clarity{--cl-accent:var(--spice-button,#1ed760);--cl-warn:#f5a623;--cl-card:rgba(var(--spice-rgb-text,255,255,255),.06);--cl-line:rgba(var(--spice-rgb-text,255,255,255),.12);--cl-ease:cubic-bezier(.2,.8,.2,1);
  interpolate-size:allow-keywords;display:grid;gap:18px;color:var(--spice-text);font-size:14px;line-height:1.5}
.clarity h3{font-size:13px;font-weight:700;margin:0;text-transform:uppercase;letter-spacing:.08em;color:var(--spice-subtext)}
.clarity p{margin:0}
.clarity .muted{color:var(--spice-subtext)}
.clarity .small{font-size:12.5px;line-height:1.45}
.clarity .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.clarity .stack{display:grid;gap:10px}
.clarity .card{display:grid;gap:12px;padding:16px;border-radius:14px;background:var(--cl-card);border:1px solid var(--cl-line)}
.clarity .hero{grid-template-columns:72px 1fr;align-items:center;gap:16px;position:relative;overflow:hidden}
.clarity .hero::before{content:"";position:absolute;inset:-40% -10% auto auto;width:240px;height:240px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--cl-accent) 22%,transparent),transparent);pointer-events:none;animation:cl-glow 6s ease-in-out infinite alternate}
.clarity .hero > *{position:relative}
.clarity .hero .text{display:grid;gap:6px}
.clarity .hero strong{font-size:18px;line-height:1.3}
.clarity .ring{width:72px;height:72px;display:grid;place-items:center}
.clarity .ring svg{width:72px;height:72px;transform:rotate(-90deg);grid-area:1/1}
.clarity .ring .track{stroke:var(--cl-line)}
.clarity .ring .val{stroke:var(--cl-accent);transition:stroke-dashoffset 1s var(--cl-ease),stroke .4s}
.clarity .ring[data-warn] .val{stroke:var(--cl-warn)}
.clarity .ring b{grid-area:1/1;font-size:17px;font-variant-numeric:tabular-nums}
.clarity button{font:inherit;border-radius:999px;padding:8px 18px;border:1px solid var(--cl-line);background:transparent;color:var(--spice-text);cursor:pointer;min-height:36px;
  transition:transform .18s var(--cl-ease),background-color .2s,border-color .2s}
.clarity button:hover{border-color:var(--spice-subtext);transform:translateY(-1px)}
.clarity button:active{transform:scale(.97)}
.clarity button.primary{background:var(--cl-accent);border-color:var(--cl-accent);color:var(--spice-main,#000);font-weight:700;padding:10px 24px;font-size:15px;display:inline-flex;gap:10px;align-items:center}
.clarity button.primary:hover{transform:translateY(-1px) scale(1.02);filter:brightness(1.06)}
.clarity button[disabled]{cursor:progress;transform:none;filter:none}
.clarity .spin{width:16px;height:16px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:cl-spin .7s linear infinite}
.clarity button:focus-visible,.clarity input:focus-visible,.clarity summary:focus-visible{outline:3px solid var(--spice-text);outline-offset:2px}
.clarity .result{padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--cl-accent) 14%,transparent)}
.clarity ul{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.clarity li{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;padding:7px 4px;border-radius:8px}
.clarity li + li{border-top:1px solid var(--cl-line)}
.clarity .glyph{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;margin-top:-1px}
.clarity .glyph svg{width:14px;height:14px}
.clarity .glyph.ok{color:var(--cl-accent);background:color-mix(in srgb,var(--cl-accent) 18%,transparent)}
.clarity .glyph.warn{color:var(--cl-warn);background:color-mix(in srgb,var(--cl-warn) 18%,transparent)}
.clarity .glyph.info{color:var(--spice-subtext);background:var(--cl-line)}
.clarity .glyph .draw{stroke-dasharray:1;stroke-dashoffset:0}
.clarity label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.clarity input[type=checkbox]{width:18px;height:18px;margin:2px 0 0;accent-color:var(--cl-accent);flex:none}
.clarity input[type=search]{font:inherit;width:100%;box-sizing:border-box;padding:10px 14px;border-radius:10px;border:1px solid var(--cl-line);background:var(--spice-main);color:var(--spice-text);transition:border-color .2s}
.clarity input[type=search]:focus{border-color:var(--cl-accent)}
.clarity .hits{display:flex;flex-wrap:wrap;gap:6px}
.clarity .hits:empty{display:none}
.clarity .hits button{padding:5px 14px;min-height:32px;background:var(--cl-card)}
.clarity .hits button:hover{border-color:var(--cl-accent)}
.clarity details{border-radius:14px;border:1px solid var(--cl-line);padding:0 16px}
.clarity details summary{cursor:pointer;font-weight:700;padding:14px 0;list-style:none;display:flex;justify-content:space-between;align-items:center}
.clarity details summary::-webkit-details-marker{display:none}
.clarity details summary::after{content:"";width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .3s var(--cl-ease)}
.clarity details[open] summary::after{transform:rotate(225deg) translateY(-2px)}
.clarity details::details-content{height:0;overflow:clip;transition:height .35s var(--cl-ease),content-visibility .35s allow-discrete}
.clarity details[open]::details-content{height:auto}
.clarity details ul{padding-bottom:12px}
.clarity svg.curve{width:100%;height:auto;max-height:180px;overflow:visible}
.clarity .curve .got{stroke-dasharray:var(--len);stroke-dashoffset:0}
.clarity .curve .area{opacity:.16}
.clarity .legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--spice-subtext)}
.clarity .legend i{display:inline-block;width:18px;height:0;border-top:2px solid;vertical-align:middle;margin-right:6px}
.clarity .profile{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.clarity .profile strong{font-size:16px}
.clarity .pill{font-size:12px;padding:2px 10px;border-radius:999px;background:var(--cl-line);color:var(--spice-subtext)}
.clarity .sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.clarity[data-anim] .reveal{animation:cl-in .5s var(--cl-ease) both;animation-delay:calc(var(--i,0) * 55ms)}
.clarity[data-anim] .glyph.ok .draw{animation:cl-check .5s var(--cl-ease) both;animation-delay:calc(var(--i,0) * 55ms + 200ms)}
.clarity[data-anim] .curve .got{animation:cl-draw 1.2s var(--cl-ease) both .15s}
.clarity[data-anim] .curve .area{animation:cl-fade 1.2s ease both .5s}
.clarity .swap{animation:cl-in .35s var(--cl-ease) both}
@keyframes cl-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes cl-check{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes cl-draw{from{stroke-dashoffset:var(--len)}to{stroke-dashoffset:0}}
@keyframes cl-fade{from{opacity:0}}
@keyframes cl-spin{to{transform:rotate(360deg)}}
@keyframes cl-glow{from{transform:translate(0,0) scale(1)}to{transform:translate(-30px,20px) scale(1.15)}}
@media (prefers-reduced-motion:reduce){.clarity *,.clarity *::before,.clarity *::after,.clarity details::details-content{animation:none!important;transition:none!important}}
`;

  // Ideal (AutoEq) against what Spotify's 6 bands make of it.
  function curveSvg(profile, fit) {
    const W = 320, H = 140, top = 8, bottom = 18;
    const lo = Math.log10(20), hi = Math.log10(20000);
    const x = (f) => ((Math.log10(f) - lo) / (hi - lo)) * W;
    const range = 12;
    const y = (g) => top + ((range - Math.max(-range, Math.min(range, g))) / (2 * range)) * (H - top - bottom);
    const pts = profile.points.filter((p) => p.f >= 20 && p.f <= 20000);
    const target = pts.map((p) => x(p.f).toFixed(1) + "," + y(p.g - fit.quieterBy).toFixed(1)).join(" ");
    const freqs = [];
    for (let f = 20; f <= 20000; f *= 1.05) freqs.push(f);
    const got = curveDb(fit.gains, freqs).map((g, i) => [x(freqs[i]), y(g)]);
    let len = 0;
    for (let i = 1; i < got.length; i++) len += Math.hypot(got[i][0] - got[i - 1][0], got[i][1] - got[i - 1][1]);
    const line = got.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const area = `0,${y(0)} ${line} ${W},${y(0)}`;
    const grid = [100, 1000, 10000]
      .map((f) => `<line x1="${x(f)}" x2="${x(f)}" y1="${top}" y2="${H - bottom}" stroke="currentColor" opacity=".12"/>` +
        `<text x="${x(f)}" y="${H - 4}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".55">${f >= 1000 ? f / 1000 + "k" : f} Hz</text>`)
      .join("");
    const label = t("curve.aria", { name: profile.name, gains: fit.gains.map(num).join(" / ") }).replace(/"/g, "");
    const wrap = el("div", { class: "stack reveal", style: "--i:2" });
    wrap.innerHTML =
      `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}" style="--len:${Math.ceil(len)}">` +
      grid +
      `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" opacity=".3"/>` +
      `<polygon class="area" points="${area}" fill="var(--cl-accent)"/>` +
      `<polyline points="${target}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity=".6"/>` +
      `<polyline class="got" points="${line}" fill="none" stroke="var(--cl-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    wrap.append(el("div", { class: "legend", "aria-hidden": "true" },
      el("span", {}, el("i", { style: "border-color:currentColor;border-top-style:dashed" }), t("legend.ideal")),
      el("span", {}, el("i", { style: "border-color:var(--cl-accent)" }), t("legend.eq"))));
    return wrap;
  }

  function ring(ok, total, from) {
    const r = 30, c = 2 * Math.PI * r;
    const frac = total ? ok / total : 1;
    const start = total ? from / total : 0;
    const node = el("div", { class: "ring", role: "img", "aria-label": t("score.aria", { ok, total }) });
    if (ok < total) node.setAttribute("data-warn", "");
    node.innerHTML =
      `<svg viewBox="0 0 72 72" aria-hidden="true"><circle class="track" cx="36" cy="36" r="${r}" fill="none" stroke-width="6"/>` +
      `<circle class="val" cx="36" cy="36" r="${r}" fill="none" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - start)}"/></svg>`;
    node.append(el("b", { "aria-hidden": "true" }, ok + "/" + total));
    requestAnimationFrame(() => requestAnimationFrame(() => node.querySelector(".val")?.setAttribute("stroke-dashoffset", String(c * (1 - frac)))));
    return node;
  }

  async function openPanel(autoRun = false) {
    const root = el("div", { class: "clarity", "data-anim": "" }, el("style", {}, CSS));
    const body = el("div", { class: "stack", style: "gap:18px" });
    root.append(body);
    Spicetify.PopupModal.display({ title: t("panel.title"), content: root, isLarge: true });
    let result = null;
    let picking = false;
    let lastScore = 0;
    let animate = true;

    async function run() {
      result = await optimize();
      animate = true;
      await render();
    }

    async function render() {
      const a = apis();
      const state = load();
      const opts = optionsOf(state);
      const [s, premium, lv, device] = await Promise.all([snapshot(a), isPremium(a.product), loudness(a), selectedDevice(a.exclusive)]);
      const info = result?.info && result.info.id === deviceId(device) ? result.info : await resolveDevice(state, device);
      const best = bestQuality(premium);
      const now = qualityText();
      const fit = info.profile?.points ? fitFor(info.profile, headroomFor(lv.normalize, lv.level)) : null;
      const on = (v) => t(v ? "state.on" : "state.off");

      // ---- Checklist ----
      let i = 0;
      const check = (kind, text, hint) =>
        el("li", { class: "reveal", style: "--i:" + i++ },
          el("span", { class: "glyph " + kind, html: GLYPH[kind] }),
          el("span", {}, el("span", { class: "sr-only" }, t("sr." + kind) + " "), text,
            hint ? el("span", { class: "muted" }, " – " + hint) : null));
      const items = [];
      let ok = 0;
      let total = 0;
      const add = (good, text, hint) => {
        total++;
        if (good) ok++;
        items.push(check(good ? "ok" : "warn", text, good ? null : hint));
      };
      add(s.streamingQuality === best, t("chk.streaming", { value: qualityName(s.streamingQuality) }),
        t(premium === false ? "hint.streamingFree" : "hint.streamingPremium"));
      add(s.downloadAudioQuality === best, t("chk.downloads", { value: qualityName(s.downloadAudioQuality) }));
      add(s.autoAdjustQuality === false, t("chk.autoAdjust", { state: on(s.autoAdjustQuality) }), t("hint.autoAdjust"));
      add(!s.audioCrossfade && !s.autoMix, t("chk.crossfade", { state: on(s.audioCrossfade || s.autoMix) }), t("hint.crossfade"));
      add(!s.monoAudio, t("chk.mono", { state: on(s.monoAudio) }), t("hint.mono"));
      add(s.gapless !== false, t("chk.gapless", { state: on(s.gapless !== false) }), t("hint.gapless"));
      if (a.eq && info.profile && opts.correction) {
        const corrOk = !!(s.eqEnabled && fit && s.eqGains?.every((g, k) => Math.abs(g - fit.gains[k]) < 0.05));
        add(corrOk, t("chk.correction", { state: t(corrOk ? "state.active" : "state.inactive") }), t("hint.correction", { name: info.profile.name }));
      }
      if (a.exclusive && opts.exclusive && !isBluetooth(device)) add(!!s.exclusive, t("chk.exclusive", { state: on(s.exclusive) }));
      items.push(check("info", t("chk.normalize", { state: on(lv.normalize) }), t("hint.normalize")));

      // ---- Hero: state + one button ----
      const playing = now.level
        ? now.detail ? t("now.playingFrom", { quality: bitrateName(now.level), source: now.detail }) : t("now.playing", { quality: bitrateName(now.level) })
        : t("now.nothing");
      const cachedLow = now.cached && now.target > now.level;
      const needsPick = opts.correction && a.eq && (info.status === "ask" || info.status === "nodevice");
      const todo = total - ok;
      const allGood = !todo && !needsPick;
      const go = el("button", { type: "button", class: "primary" }, allGood ? t("btn.recheck") : t("btn.optimize"));
      go.addEventListener("click", async () => {
        go.disabled = true;
        go.replaceChildren(el("span", { class: "spin", "aria-hidden": "true" }), t("btn.working"));
        try {
          await run();
        } catch (e) {
          report(e);
          go.disabled = false;
          go.textContent = t("btn.optimize");
        }
      });
      const headline = allGood ? t("head.allGood") : todo ? (todo === 1 ? t("head.one") : t("head.many", { n: todo })) : t("head.pick");
      const hero = el("div", { class: "card hero reveal", style: "--i:0" },
        ring(ok, total, animate ? 0 : lastScore),
        el("div", { class: "text" },
          el("strong", { role: "status", "aria-live": "polite" }, headline),
          el("p", { class: "muted" }, playing),
          cachedLow ? el("p", { class: "muted small" }, t("now.cachedLow")) : null,
          result
            ? el("p", { class: "result swap" }, result.changed.length ? t("result.changed", { list: listOf(result.changed) }) : t("result.none"))
            : null,
          el("div", { class: "row" },
            go,
            state.original ? el("button", { type: "button", onclick: async () => { await undo(); result = null; animate = true; await render(); } }, t("btn.undo")) : null)));
      lastScore = ok;

      // ---- Headphones ----
      const headphones = el("div", { class: "card stack reveal", style: "--i:1" }, el("h3", {}, t("hp.title")));
      const hpNote = el("p", { class: "muted", role: "status", "aria-live": "polite" });
      headphones.append(el("p", {}, el("span", { class: "muted" }, t("hp.output") + " "), device?.description || t("hp.noDeviceName"),
        isBluetooth(device) ? el("span", { class: "muted" }, " – " + t("hp.bluetooth")) : null));
      if (!a.eq) {
        headphones.append(el("p", { class: "muted" }, t("hp.noEq")));
      } else if (!opts.correction) {
        headphones.append(el("p", { class: "muted" }, t("hp.corrOff")));
      } else if (info.profile) {
        headphones.append(el("div", { class: "profile" },
          el("strong", {}, info.profile.name),
          el("span", { class: "pill" }, t(info.profile.auto ? "hp.matched" : "hp.saved")),
          el("span", { class: "muted" }, t("hp.measured", { source: info.profile.source }))));
        if (fit) {
          headphones.append(curveSvg(info.profile, fit));
          headphones.append(el("p", { class: "muted" },
            t("fit.accuracy", { db: num(fit.rmsError) }) + " " +
            (fit.quieterBy > 0.1 ? t("fit.quieter", { db: num(fit.quieterBy) }) : t("fit.noLoss"))));
        }
      } else {
        const key = { none: "hp.none", speakers: "hp.speakers", offline: "hp.offline", nodevice: "hp.nodevice" }[info.status] ||
          (info.suggestions.length ? "hp.askSome" : "hp.askNone");
        headphones.append(el("p", {}, t(key)));
      }

      const hits = el("div", { class: "hits", role: "list", "aria-label": t("hp.listLabel") });
      const showHits = (list) => {
        hits.replaceChildren(...list.map((e, k) =>
          el("div", { role: "listitem", class: "swap", style: "animation-delay:" + k * 35 + "ms" },
            el("button", { type: "button", onclick: () => pick(e) }, e.name))));
      };
      async function pick(entry) {
        hpNote.textContent = t("hp.loading", { name: entry.name });
        try {
          const p = await profileFor(entry);
          const st = load();
          st.profiles ??= {};
          if (info.id) st.profiles[info.id] = p;
          save(st);
          picking = false;
          result = await optimize({ quiet: true });
          animate = true;
          await render();
        } catch {
          hpNote.textContent = t("hp.loadFail");
        }
      }
      async function noCorrection() {
        const st = load();
        st.profiles ??= {};
        if (info.id) st.profiles[info.id] = null;
        save(st);
        if (a.eq) await setEq(a.eq, [0, 0, 0, 0, 0, 0], false);
        picking = false;
        result = null;
        await render();
      }

      if (a.eq && opts.correction) {
        const showPicker = picking || info.status === "ask" || info.status === "none" || info.status === "speakers";
        let suggestions = info.suggestions;
        if (picking && !suggestions.length && device?.description) {
          suggestions = await autoEqIndex().then((all) => suggestEntries(all, device.description)).catch(() => []);
        }
        showHits(showPicker ? suggestions : []);
        if (showPicker) {
          const search = el("input", { type: "search", id: "clarity-search", placeholder: t("hp.placeholder"), autocomplete: "off" });
          let timer = null;
          search.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              if (search.value.trim().length < 2) {
                hpNote.textContent = "";
                showHits(suggestions);
                return;
              }
              try {
                const found = searchEntries(await autoEqIndex(), search.value);
                hpNote.textContent = found.length ? t("hp.hits", { n: found.length }) : t("hp.noHits");
                showHits(found);
              } catch {
                hpNote.textContent = t("hp.listFail");
              }
            }, 200);
          });
          headphones.append(
            hits,
            el("label", { for: "clarity-search", style: "display:block;font-weight:700" }, t("hp.search")),
            search,
            hpNote,
            el("div", { class: "row" },
              info.status !== "none" ? el("button", { type: "button", onclick: noCorrection }, t("hp.noCorrection")) : null,
              picking ? el("button", { type: "button", onclick: () => { picking = false; render(); } }, t("hp.cancel")) : null));
          if (picking) setTimeout(() => search.focus(), 0);
        } else {
          headphones.append(el("div", { class: "row" },
            el("button", { type: "button", onclick: () => { picking = true; render(); } }, t("hp.other"))));
        }
      }

      // ---- Details and options ----
      const optCorrection = el("input", { type: "checkbox", id: "clarity-corr", checked: opts.correction });
      const optExclusive = el("input", { type: "checkbox", id: "clarity-excl", checked: opts.exclusive, disabled: !a.exclusive });
      const persist = async () => {
        const st = load();
        st.options = { correction: optCorrection.checked, exclusive: optExclusive.checked };
        save(st);
        if (st.auto) result = await optimize({ quiet: true });
        await render();
      };
      optCorrection.addEventListener("change", persist);
      optExclusive.addEventListener("change", persist);

      const details = el("details", { class: "reveal", style: "--i:2" },
        el("summary", {}, t("details.title")),
        el("ul", {}, items));
      const options = el("div", { class: "card stack reveal", style: "--i:3" },
        el("h3", {}, t("opt.title")),
        el("label", { for: "clarity-corr" }, optCorrection, el("span", {}, t("opt.correction"))),
        el("label", { for: "clarity-excl" }, optExclusive, el("span", {}, t("opt.exclusive"))));

      const wasOpen = body.querySelector("details")?.open;
      if (wasOpen || (animate && result)) details.open = true;
      const focused = document.activeElement?.id;
      if (animate) root.setAttribute("data-anim", "");
      else root.removeAttribute("data-anim");
      body.replaceChildren(hero, headphones, details, options);
      animate = false;
      if (focused) document.getElementById(focused)?.focus();
    }

    try {
      if (autoRun) await run();
      else await render();
    } catch (e) {
      report(e);
    }
  }

  // ---------- Startup ----------

  function report(e) {
    console.error("[Clarity]", e);
    try {
      Spicetify.showNotification(t("note.error", { msg: e?.message || e }), true, 8000);
    } catch {
      /* notifications unavailable */
    }
  }

  async function waitFor(check, ms) {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
    return true;
  }

  async function main() {
    // Button first – it should show even if Spotify renamed an API.
    await waitFor(() => window.Spicetify?.PopupModal && Spicetify.LocalStorage && Spicetify.showNotification && document.body, 60000);
    widget = mountButton(() => openPanel().catch(report));

    if (!(await waitFor(() => Spicetify.Platform?.SettingsAPI?.quality, 20000))) {
      const keys = Object.keys(Spicetify.Platform || {}).filter((k) => /setting|equal|exclusive|audio/i.test(k));
      report(new Error(t("note.noSettings", { keys: keys.join(", ") || "–" })));
      return;
    }
    await migrate().catch(report);
    refreshWidget();
    Spicetify.Player?.addEventListener?.("songchange", () => setTimeout(refreshWidget, 1500));
    Spicetify.Player?.addEventListener?.("onplaypause", refreshWidget);
    setInterval(refreshWidget, 10000);

    // Once started deliberately, Clarity keeps the settings on its own:
    // on every start and when another output device is chosen.
    if (load().auto) optimize({ quiet: true }).catch(report);
    try {
      apis().exclusive?.getEvents?.().addListener("selectedDeviceChanged", () => {
        if (load().auto) setTimeout(() => optimize({ quiet: true }).catch(report), 800);
      });
    } catch {
      /* without the device event, only on start */
    }

    const st = load();
    if (!st.seenHint) {
      st.seenHint = true;
      save(st);
      Spicetify.showNotification(t("note.hint"));
    }
  }

  main().catch(report);
})();

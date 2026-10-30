// node test/fit.test.js [GraphicEQ.txt] [INDEX.md]
// Checks the filter math, the fit to Spotify's 6 bands and device detection.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const c = require("../src/clarity.js");

// A band at 0 dB is neutral, a peaking band hits its centre exactly.
assert.ok(Math.abs(c.curveDb([0, 0, 0, 0, 0, 0], [1000])[0]) < 1e-9);
assert.ok(Math.abs(c.curveDb([0, 0, 0, 6, 0, 0], [1000])[0] - 6) < 0.05);
assert.ok(Math.abs(c.curveDb([-6, 0, 0, 0, 0, 0], [25])[0] + 6) < 0.5);

// A curve the bands can produce themselves must come back almost exactly.
const truth = [-3, 2, -1, 1.5, -2, 1];
const freqs = [];
for (let f = 20; f <= 20000; f *= 1.05) freqs.push(f);
const synthetic = c.curveDb(truth, freqs).map((g, i) => ({ f: freqs[i], g }));
const back = c.fitGains(synthetic);
back.forEach((g, i) => assert.ok(Math.abs(g - truth[i]) < 0.3, `Band ${i}: ${g} instead of ${truth[i]}`));

// Headroom: the final curve boosts nowhere by more than ~0.5 dB.
const boosty = freqs.map((f) => ({ f, g: f < 100 ? 6 : 0 }));
const h = c.fitWithHeadroom(boosty);
assert.ok(Math.max(...c.curveDb(h.gains, freqs)) <= 0.7, "clipping guard does not work");

// With Normalize volume on Normal the curve may boost a bit more, on Loud it may not.
assert.equal(c.headroomFor(true, c.VOLUME_LEVEL.NORMAL), 1.5);
assert.equal(c.headroomFor(true, c.VOLUME_LEVEL.LOUD), 0.5);
assert.equal(c.headroomFor(false, c.VOLUME_LEVEL.NORMAL), 0.5);
const roomy = c.fitWithHeadroom(boosty, 1.5);
assert.ok(Math.max(...c.curveDb(roomy.gains, freqs)) <= 1.7);
assert.ok(roomy.quieterBy < h.quieterBy, "more headroom must cost less level");

// Device detection against a small list (German and English Windows names).
const md = [
  "- [Sennheiser HD 600](./oratory1990/over-ear/Sennheiser%20HD%20600) by oratory1990",
  "- [Sennheiser HD 600](./crinacle/GRAS%2043AG-7%20over-ear/Sennheiser%20HD%20600) by crinacle on GRAS 43AG-7",
  "- [Sony WH-1000XM4](./oratory1990/over-ear/Sony%20WH-1000XM4) by oratory1990",
  "- [Sony WH-1000XM5](./oratory1990/over-ear/Sony%20WH-1000XM5) by oratory1990",
  "- [HyperX Cloud II](./Rtings/over-ear/HyperX%20Cloud%20II) by Rtings",
  "- [HyperX Cloud II Wireless](./Rtings/over-ear/HyperX%20Cloud%20II%20Wireless) by Rtings",
  "- [HyperX Cloud Alpha](./Rtings/over-ear/HyperX%20Cloud%20Alpha) by Rtings",
  "- [Apple AirPods Pro](./Rtings/in-ear/Apple%20AirPods%20Pro) by Rtings",
].join("\n");
const entries = c.parseIndex(md);
assert.equal(entries.length, 7);
assert.equal(entries.find((e) => e.name === "Sennheiser HD 600").source, "oratory1990");
assert.equal(c.matchDevice(entries, "Kopfhörer (2- WH-1000XM4)")?.name, "Sony WH-1000XM4");
assert.equal(c.matchDevice(entries, "Kopfhörer (WH1000XM4)")?.name, "Sony WH-1000XM4", "merged spelling");
assert.equal(c.matchDevice(entries, "Lautsprecher (HyperX Cloud II Wireless)")?.name, "HyperX Cloud II Wireless");
assert.equal(c.matchDevice(entries, "Lautsprecher (HyperX Cloud 2)")?.name, "HyperX Cloud II", "2 = II");
assert.equal(c.matchDevice(entries, "Lautsprecher (Realtek(R) Audio)"), null);
assert.equal(c.matchDevice(entries, "USB-Audiogerät"), null);
assert.equal(c.matchDevice(entries, "Kopfhörer (Wireless Pro)"), null, "only weak words");
assert.equal(c.searchEntries(entries, "hd 600")[0].name, "Sennheiser HD 600");

// Other brand, partial word, repeated words.
const more = c.parseIndex([
  "- [Grado PS500](./Rtings/over-ear/Grado%20PS500) by Rtings",
  "- [Phiaton PS 500](./Rtings/over-ear/Phiaton%20PS%20500) by Rtings",
  "- [HIFIMAN HE-400](./Rtings/over-ear/HIFIMAN%20HE-400) by Rtings",
  "- [HIFIMAN HE400i](./Rtings/over-ear/HIFIMAN%20HE400i) by Rtings",
  "- [Beyerdynamic DT 250 (250 Ohm)](./Rtings/over-ear/a) by Rtings",
  "- [Beyerdynamic DT 880 (250 Ohm)](./Rtings/over-ear/b) by Rtings",
  "- [Beyerdynamic Lagoon](./Rtings/over-ear/c) by Rtings",
].join("\n"));
assert.equal(c.matchDevice(more, "Headphones (Grado PS500)")?.name, "Grado PS500");
assert.equal(c.matchDevice(more, "Headphones (HIFIMAN HE400i)")?.name, "HIFIMAN HE400i");
assert.equal(c.matchDevice(more, "Headphones (Beyerdynamic DT 880 (250 Ohm))")?.name, "Beyerdynamic DT 880 (250 Ohm)");
assert.equal(c.matchDevice(more, "Headphones (Beyerdynamic Lagoon)")?.name, "Beyerdynamic Lagoon");
assert.equal(c.matchDevice(more, "Headphones (Lagoon)"), null, "single word without brand");

// Uncertain: brand + part of the model → suggestions, but no automatic match.
assert.equal(c.matchDevice(entries, "Headset (HyperX Cloud)"), null);
const sugg = c.suggestEntries(entries, "Headset (HyperX Cloud)").map((e) => e.name);
assert.ok(sugg.includes("HyperX Cloud II") && sugg.includes("HyperX Cloud Alpha"), sugg.join(", "));
assert.deepEqual(c.suggestEntries(entries, "Lautsprecher (Realtek(R) Audio)"), []);
assert.equal(c.deviceKind("Lautsprecher (Realtek(R) Audio)"), "speakers");
assert.equal(c.deviceKind("Kopfhörer (2- WH-1000XM4)"), "headphones");
assert.equal(c.deviceKind("USB-Audiogerät"), "unknown");
assert.equal(
  c.graphicEqUrl(entries[0]),
  "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sennheiser%20HD%20600/Sennheiser%20HD%20600%20GraphicEQ.txt"
);

// Optional: a real profile and the real index.
const [, , eqFile, indexFile] = process.argv;
if (eqFile) {
  const fit = c.fitWithHeadroom(c.parseGraphicEq(fs.readFileSync(eqFile, "utf8")));
  console.log("Real profile:", JSON.stringify(fit));
  assert.ok(fit.gains.every((g) => g >= -12 && g <= 12));
}
if (indexFile) {
  const all = c.parseIndex(fs.readFileSync(indexFile, "utf8"));
  console.log("AutoEq entries:", all.length);
  for (const d of ["Kopfhörer (Sennheiser HD 600)", "Kopfhörer (WH-1000XM4)", "Headphones (HyperX Cloud II)", "Lautsprecher (Realtek(R) Audio)", "Kopfhörer (2- AirPods Pro)"]) {
    console.log("  ", d, "→", c.matchDevice(all, d)?.name ?? "no match");
  }
}
console.log("all tests passed");

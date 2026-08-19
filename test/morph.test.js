// Tests the morph core from nam-morph.html against two real .nam profiles.
// Usage: node test/morph.test.js path/to/A.nam path/to/B.nam
// The two profiles must share an architecture (same trainer, same quality tier).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error("Usage: node test/morph.test.js <profileA.nam> <profileB.nam>");
  process.exit(2);
}

const html = fs.readFileSync(path.join(__dirname, "..", "nam-morph.html"), "utf8");

// Extract the UI-independent core section and run it verbatim in a sandbox.
const start = html.indexOf("/* ---------------- core");
const end = html.indexOf("/* ---------------- UI");
if (start < 0 || end < 0) throw new Error("could not locate core script section");
const sandbox = { window: {} };
vm.runInNewContext(html.slice(start, end), sandbox);
const { getModels, checkCompatible, morph } = sandbox.window.morphCore;

const A = JSON.parse(fs.readFileSync(fileA, "utf8"));
const B = JSON.parse(fs.readFileSync(fileB, "utf8"));

let failures = 0;
function check(label, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + label);
  if (!cond) failures++;
}

// 1. the two provided files are compatible
check("A vs B compatible", checkCompatible(A, B) === null);

// 2. incompatibility detected (chop a weight off a clone of B)
const Bbad = JSON.parse(JSON.stringify(B));
getModels(Bbad)[0].weights.pop();
check("weight-count mismatch detected", checkCompatible(A, Bbad) !== null);

// 3. 50/50 morph correctness
const out = morph(A, B, 0.5, "Test-Morph");
const ma = getModels(A), mb = getModels(B), mo = getModels(out);
check("same submodel count", mo.length === ma.length);
let allMid = true;
for (let i = 0; i < mo.length; i++) {
  if (mo[i].weights.length !== ma[i].weights.length) allMid = false;
  for (let k = 0; k < mo[i].weights.length; k += 997) {
    const expect = (ma[i].weights[k] + mb[i].weights[k]) / 2;
    if (Math.abs(mo[i].weights[k] - expect) > 1e-12) allMid = false;
  }
}
check("all sampled weights are exact midpoints", allMid);
if (typeof ma[0].config.head_scale === "number")
  check("head_scale blended (submodel 0)",
    Math.abs(mo[0].config.head_scale - (ma[0].config.head_scale + mb[0].config.head_scale) / 2) < 1e-12);
check("no NaN in output weights", mo.every(m => m.weights.every(Number.isFinite)));
check("output name set", !out.metadata || out.metadata.name === "Test-Morph");
if (A.metadata && B.metadata && typeof A.metadata.loudness === "number" && typeof B.metadata.loudness === "number")
  check("loudness blended",
    Math.abs(out.metadata.loudness - (A.metadata.loudness + B.metadata.loudness) / 2) < 1e-9);
check("sample_rate preserved", out.sample_rate === A.sample_rate);
check("architecture preserved", out.architecture === A.architecture);

// 4. asymmetric blend: t=0.8 means 80% B
const out80 = morph(A, B, 0.8, "x");
const k0 = Math.min(123, ma[0].weights.length - 1);
const e80 = ma[0].weights[k0] + (mb[0].weights[k0] - ma[0].weights[k0]) * 0.8;
check("80/20 blend correct", Math.abs(getModels(out80)[0].weights[k0] - e80) < 1e-12);

// 5. endpoints reproduce originals
const out0 = morph(A, B, 0, "x"), out1 = morph(A, B, 1, "x");
check("t=0 equals A", JSON.stringify(getModels(out0)[0].weights) === JSON.stringify(ma[0].weights));
check("t=1 equals B", JSON.stringify(getModels(out1)[0].weights) === JSON.stringify(mb[0].weights));

// 6. serialized output parses and keeps its shape
const roundtrip = JSON.parse(JSON.stringify(out));
check("round-trips through JSON",
  getModels(roundtrip)[0].weights.length === ma[0].weights.length);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

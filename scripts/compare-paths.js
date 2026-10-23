// Measures the trade-offs behind legible's search, over random colors that
// fail 4.5:1 on white (darkening) and on #121212 (lightening):
//
//   1. how often rounding the exact boundary color to hex fails again
//   2. how far legible's answer is, in CIEDE2000, from the nearest passing
//      8-bit color with no hue constraint
//   3. how far perceived (OKLCH) hue drifts in legible's answer, and in the
//      answer you get by walking OKLCH lightness with CSS Color 4 gamut
//      mapping instead of chroma reduction, or by walking HSL lightness
//   4. what chroma reduction costs against that CSS path, in CIEDE2000
//      distance from the original
//
// The CSS and HSL answers are found the way legible finds its own: bisect
// for the boundary, then step on until the rounded hex really passes, so no
// approach is credited with a color that fails.
//
// Each line ends with the worst case found, as original -> answer.
// Colors are uniform in the sRGB cube; grays (OKLCH chroma under 0.03) are
// skipped because they have no hue to drift.
//
// Run: node scripts/compare-paths.js [count] [seed]
// The exhaustive search needs about 400 MB and two seconds or so per color;
// the default run takes about 20 minutes.
import { gamutMapOklch, hexOf, hslToRgb, parseColor, reduceChroma, rgbToHsl, rgbToLab, rgbToOklch } from '../src/color.js';
import { luminance, pairRatio, suggest } from '../src/contrast.js';
import { deltaE2000 } from '../src/deltae.js';

const count = Number(process.argv[2] || 300);
let seed = Number(process.argv[3] || 1);
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const TARGET = 4.5;
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const LIN = Array.from({ length: 256 }, (_, i) => lin(i / 255));

// Nearest passing 8-bit color by CIEDE2000 with no hue constraint, found by
// scanning all 16.7 million colors. Lab and luminance are computed once. The
// scan skips colors whose lightness alone rules them out: the cross term in
// CIEDE2000 cannot make the chroma and hue part negative, so
// dE00 >= |dL| / SL, and SL never exceeds 1.7471 (at L = 0 or 100).
// Anything further than 1.75 * bound in L cannot beat `bound`.
let LAB = null;
let LUM = null;
function precompute() {
  LAB = new Float32Array(3 * 2 ** 24);
  LUM = new Float64Array(2 ** 24);
  for (let i = 0; i < 2 ** 24; i++) {
    const rgb = [(i >> 16) / 255, ((i >> 8) & 255) / 255, (i & 255) / 255];
    const lab = rgbToLab(rgb);
    LAB[3 * i] = lab[0];
    LAB[3 * i + 1] = lab[1];
    LAB[3 * i + 2] = lab[2];
    LUM[i] = 0.2126 * LIN[i >> 16] + 0.7152 * LIN[(i >> 8) & 255] + 0.0722 * LIN[i & 255];
  }
}

function nearestAnywhere(orig, bgRgb, bound) {
  if (!LAB) precompute();
  const yBg = luminance(bgRgb);
  const oLab = rgbToLab(orig);
  const band = 1.75 * bound;
  let best = bound;
  let at = -1;
  for (let i = 0; i < 2 ** 24; i++) {
    const L = LAB[3 * i];
    if (Math.abs(L - oLab[0]) > band) continue;
    const y = LUM[i];
    const ratio = (Math.max(y, yBg) + 0.05) / (Math.min(y, yBg) + 0.05);
    if (ratio < TARGET) continue;
    const d = deltaE2000(oLab, [L, LAB[3 * i + 1], LAB[3 * i + 2]]);
    if (d < best) {
      best = d;
      at = i;
    }
  }
  return { deltaE: best, hex: at < 0 ? null : `#${at.toString(16).padStart(6, '0')}` };
}

// Bisect a lightness path for the parameter where it reaches the target.
// `at` maps the parameter to sRGB; `from` is the original, `to` the end.
function boundary(at, from, to, bgRgb) {
  let fail = from;
  let pass = to;
  for (let i = 0; i < 50; i++) {
    const mid = (fail + pass) / 2;
    if (pairRatio(at(mid), 1, bgRgb) >= TARGET) pass = mid;
    else fail = mid;
  }
  return pass;
}

// The first color past the boundary whose rounded hex passes.
function verifiedHex(at, from, to, bgRgb) {
  const step = Math.sign(to - from) * 0.0005;
  for (let t = boundary(at, from, to, bgRgb); ; t += step) {
    if ((step < 0 && t < to) || (step > 0 && t > to)) t = to;
    const color = parseColor(hexOf(at(t)));
    if (pairRatio(color.rgb, 1, bgRgb) >= TARGET) return color;
    if (t === to) return null;
  }
}

const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
// Each sample is [value, example]; the example of the largest value is shown.
const summary = (samples) => {
  const xs = samples.map(([v]) => v);
  const worst = samples.reduce((a, b) => (b[0] > a[0] ? b : a));
  return `min ${Math.min(...xs).toFixed(2)}, median ${pct(xs, 0.5).toFixed(2)}, `
    + `90th ${pct(xs, 0.9).toFixed(2)}, 99th ${pct(xs, 0.99).toFixed(2)}, max ${worst[0].toFixed(2)} (${worst[1]})`;
};

for (const [bgHex, darker] of [['#ffffff', true], ['#121212', false]]) {
  const bg = parseColor(bgHex);
  const roundFails = [];
  const extra = [];
  const okDrift = [];
  const cssDrift = [];
  const hslDrift = [];
  const vsCss = [];
  let n = 0;
  while (n < count) {
    const rgb = [random(), random(), random()].map((c) => Math.round(c * 255) / 255);
    if (pairRatio(rgb, 1, bg.rgb) >= TARGET) continue;
    const [, C] = rgbToOklch(rgb);
    if (C < 0.03) continue; // grays have no hue to drift
    const fg = parseColor(hexOf(rgb));
    const ours = suggest(fg, bg, { target: TARGET, direction: darker ? 'darker' : 'lighter' }).best;
    if (!ours) continue;
    n++;

    const [L0, C0, h0] = rgbToOklch(rgb);
    const end = darker ? 0 : 1;
    const name = hexOf(rgb);
    const lab = rgbToLab(rgb);

    // 1. The exact boundary on legible's path, rounded to hex unchecked.
    const path = (L) => reduceChroma([L, C0, h0]);
    const rounded = parseColor(hexOf(path(boundary(path, L0, end, bg.rgb))));
    roundFails.push(pairRatio(rounded.rgb, 1, bg.rgb) < TARGET ? 1 : 0);

    // 2. Cost of holding hue.
    const free = nearestAnywhere(rgb, bg.rgb, ours.deltaE);
    extra.push([ours.deltaE - free.deltaE, `${name} -> ${ours.text}, unconstrained ${free.hex || ours.text}`]);

    // 3. Hue drift of each approach's hex answer.
    okDrift.push([hueGap(rgbToOklch(ours.rgb)[2], h0), `${name} -> ${ours.text}`]);
    const css = verifiedHex((L) => gamutMapOklch([L, C0, h0]), L0, end, bg.rgb);
    cssDrift.push([hueGap(rgbToOklch(css.rgb)[2], h0), `${name} -> ${hexOf(css.rgb)}, legible ${ours.text}`]);
    const [hh, ss, ll] = rgbToHsl(rgb);
    const hsl = verifiedHex((l) => hslToRgb([hh, ss, l]), ll, end, bg.rgb);
    hslDrift.push([hueGap(rgbToOklch(hsl.rgb)[2], h0), `${name} -> ${hexOf(hsl.rgb)}, legible ${ours.text}`]);

    // 4. Chroma reduction against the CSS path, as distance from the original.
    vsCss.push([ours.deltaE - deltaE2000(lab, rgbToLab(css.rgb)), `${name} -> ${ours.text}, CSS path ${hexOf(css.rgb)}`]);
  }
  const failRate = (100 * roundFails.reduce((a, b) => a + b, 0)) / count;
  console.log(`${darker ? 'darkening on' : 'lightening on'} ${bgHex}, ${count} colors`);
  console.log(`  boundary color rounded to hex fails again: ${failRate.toFixed(1)}%`);
  console.log(`  extra dE00, holding hue vs unconstrained: ${summary(extra)}`);
  console.log(`  hue drift in degrees, legible:            ${summary(okDrift)}`);
  console.log(`  hue drift in degrees, CSS gamut mapping:  ${summary(cssDrift)}`);
  console.log(`  hue drift in degrees, HSL lightness:      ${summary(hslDrift)}`);
  console.log(`  extra dE00, legible vs CSS gamut mapping: ${summary(vsCss)}`);
}

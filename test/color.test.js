import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ColorError, D50, D65, SRGB_TO_XYZ65, deltaEOK, displayRgb, formatColor, fromLinear, gamutMapOklch,
  hexOf, hslToRgb, hwbToRgb, inGamut, labToRgb, lchToRgb, mulVec, num, oklabToRgb, oklchToRgb,
  parseColor, reduceChroma, rgbToHsl, rgbToHwb, rgbToLab, rgbToLch, rgbToOklab, rgbToOklch, styleFor,
} from '../src/color.js';
import { NAMED_COLORS } from '../src/names.js';

const close = (actual, expected, tolerance, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((v, i) => {
    assert.ok(Math.abs(v - expected[i]) <= tolerance, `${message || ''} [${i}]: ${v} vs ${expected[i]}`);
  });
};

// Deterministic PRNG so property tests fail the same way every time.
function rng(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

test('hex in every length, with and without #, any case', () => {
  close(parseColor('#777').rgb, [119 / 255, 119 / 255, 119 / 255], 1e-12);
  close(parseColor('777').rgb, [119 / 255, 119 / 255, 119 / 255], 1e-12);
  close(parseColor('#1D3557').rgb, [0x1d / 255, 0x35 / 255, 0x57 / 255], 1e-12);
  assert.equal(parseColor('#f008').alpha, 0x88 / 255);
  assert.equal(parseColor('ff000080').alpha, 0x80 / 255);
  assert.equal(parseColor('#1D3557').style.upper, true);
  assert.equal(parseColor('#1d3557').style.upper, false);
});

test('hex of the wrong length is refused, with the digit count', () => {
  assert.throws(() => parseColor('#12345'), /needs 3, 4, 6 or 8 digits, not 5/);
  assert.throws(() => parseColor('#'), /not 0/);
  assert.throws(() => parseColor('1234567'), /not 7/);
  assert.throws(() => parseColor('#ggg'), ColorError);
});

test('all 148 CSS named colors, case-insensitive, and transparent', () => {
  assert.equal(Object.keys(NAMED_COLORS).length, 148);
  assert.equal(hexOf(parseColor('RebeccaPurple').rgb), '#663399');
  assert.equal(hexOf(parseColor('grey').rgb), hexOf(parseColor('gray').rgb));
  const t = parseColor('transparent');
  assert.equal(t.alpha, 0);
  assert.throws(() => parseColor('currentcolor'), /not a color/);
  assert.throws(() => parseColor('bluish'), /not a color: 'bluish'/);
});

test('rgb(): modern and legacy syntax, percentages, alpha, clamping, none', () => {
  close(parseColor('rgb(255 0 0)').rgb, [1, 0, 0], 1e-12);
  close(parseColor('rgb(255, 0, 0)').rgb, [1, 0, 0], 1e-12);
  close(parseColor('rgb(100% 50% 0%)').rgb, [1, 0.5, 0], 1e-12);
  assert.equal(parseColor('rgba(0, 0, 0, 0.54)').alpha, 0.54);
  assert.equal(parseColor('rgb(0 0 0 / 54%)').alpha, 0.54);
  assert.equal(parseColor('rgb(0 0 0 / 1.5)').alpha, 1);
  close(parseColor('rgb(300 -20 none)').rgb, [1, 0, 0], 1e-12);
  assert.equal(parseColor('RGB(0 0 0)').style.notation, 'rgb');
  assert.equal(parseColor('rgb(0, 0, 0)').style.legacy, true);
  assert.equal(parseColor('rgb(1e2 .5 +3)').rgb[0], 100 / 255);
});

test('hsl() and hwb(): angle units, wrapping, normalisation', () => {
  const ref = parseColor('hsl(120 100% 50%)').rgb;
  close(ref, [0, 1, 0], 1e-12);
  for (const hue of ['120deg', `${(2 * Math.PI) / 3}rad`, '133.3333333333grad', '0.333333333333turn', '480', '-240']) {
    close(parseColor(`hsl(${hue} 100% 50%)`).rgb, ref, 1e-9, hue);
  }
  close(parseColor('hsla(210, 50%, 40%, 0.5)').rgb, [0.2, 0.4, 0.6], 1e-12);
  close(parseColor('hsl(210 50 40)').rgb, [0.2, 0.4, 0.6], 1e-12);
  // hwb with whiteness + blackness over 100% is a gray in their ratio
  close(parseColor('hwb(90 60% 60%)').rgb, [0.5, 0.5, 0.5], 1e-12);
  close(parseColor('hwb(0 0% 0%)').rgb, [1, 0, 0], 1e-12);
});

test('lab(), lch(), oklab(), oklch() land where CSS says', () => {
  close(parseColor('oklch(0.628 0.2577 29.23)').rgb, [1, 0, 0], 2e-3);
  close(parseColor('oklch(62.8% 0.2577 29.23)').rgb, [1, 0, 0], 2e-3);
  close(parseColor('oklch(62.8% 64.425% 29.23deg)').rgb, [1, 0, 0], 2e-3);
  close(parseColor('lab(54.29 80.8 69.89)').rgb, [1, 0, 0], 1e-3);
  close(parseColor('lch(100 0 0)').rgb, [1, 1, 1], 1e-9);
  close(parseColor('oklab(1 0 0)').rgb, [1, 1, 1], 1e-9);
  close(parseColor('oklab(0 0 0)').rgb, [0, 0, 0], 1e-12);
  // lightness above 100% is clamped, as CSS does at parse time
  close(parseColor('oklch(150% 0 0)').rgb, [1, 1, 1], 1e-9);
});

test('malformed functions name what is wrong', () => {
  assert.throws(() => parseColor('rgb(1 2)'), /rgb\(\) needs 3 channels, got 2/);
  assert.throws(() => parseColor('rgb(1, 2, 3, 4, 5)'), /needs 3 channels and an optional alpha, got 5/);
  assert.throws(() => parseColor('oklch(0.5, 0.1, 30)'), /does not take commas/);
  assert.throws(() => parseColor('rgb(1, 2, 3 / 0.5)'), /cannot mix commas/);
  assert.throws(() => parseColor('rgb(1 2 3 / 0.5 / 1)'), /more than one '\/'/);
  assert.throws(() => parseColor('rgb(1 2 3 /)'), /one alpha value/);
  assert.throws(() => parseColor('rgb(1 2 red)'), /cannot read 'red'/);
  assert.throws(() => parseColor('hsl(50% 50% 50%)'), /hue cannot be a percentage/);
  assert.throws(() => parseColor('rgb(10deg 0 0)'), /unexpected angle/);
  assert.throws(() => parseColor('color(srgb 1 0 0)'), /unknown color function 'color\(\)'/);
  assert.throws(() => parseColor('   '), /empty color/);
});

test('derived matrices agree with the published constants', () => {
  // CSS derives its white points from chromaticities, so these are not the
  // ASTM tabulated values (0.95047, 1, 1.08883)
  close(D65, [0.95045592705, 1, 1.08905775076], 1e-10);
  close(D50, [0.96429567643, 1, 0.82510460251], 1e-10);
  close(SRGB_TO_XYZ65[1], [0.2126, 0.7152, 0.0722], 1e-4);
  close(mulVec(SRGB_TO_XYZ65, [1, 1, 1]), D65, 1e-12);
});

test("OKLab matches Ottosson's published XYZ table", () => {
  const xyzToRgb = (xyz) => {
    // invert SRGB_TO_XYZ65 by solving with Cramer's rule
    const m = SRGB_TO_XYZ65;
    const det = (a) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
      - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
      + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const d = det(m);
    return [0, 1, 2].map((col) => det(m.map((row, r) => row.map((v, c) => (c === col ? xyz[r] : v)))) / d).map(fromLinear);
  };
  close(rgbToOklab(xyzToRgb([0.95, 1, 1.089])), [1, 0, 0], 1e-3);
  close(rgbToOklab(xyzToRgb([1, 0, 0])), [0.45, 1.236, -0.019], 1e-3);
  close(rgbToOklab(xyzToRgb([0, 1, 0])), [0.922, -0.671, 0.263], 1e-3);
  close(rgbToOklab(xyzToRgb([0, 0, 1])), [0.153, -1.415, -0.449], 1e-3);
});

test('white and grays are neutral in OKLab and Lab', () => {
  close(rgbToOklab([1, 1, 1]), [1, 0, 0], 1e-7);
  close(rgbToLab([1, 1, 1]), [100, 0, 0], 1e-9);
  for (const v of [0.02, 0.2, 0.5, 0.9]) {
    const [, a, b] = rgbToLab([v, v, v]);
    assert.ok(Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9, `gray ${v}: ${a}, ${b}`);
  }
});

test('every conversion round-trips through sRGB to float precision', () => {
  const random = rng(42);
  const pairs = [
    [rgbToOklch, oklchToRgb], [rgbToOklab, oklabToRgb], [rgbToLch, lchToRgb],
    [rgbToLab, labToRgb], [rgbToHsl, hslToRgb], [rgbToHwb, hwbToRgb],
  ];
  for (let i = 0; i < 3000; i++) {
    const rgb = [random(), random(), random()];
    for (const [to, from] of pairs) close(from(to(rgb)), rgb, 1e-12, to.name);
  }
});

test('reduceChroma holds lightness and hue exactly and keeps as much chroma as fits', () => {
  const random = rng(7);
  for (let i = 0; i < 500; i++) {
    const lch = [0.05 + 0.9 * random(), 0.4 * random(), 360 * random()];
    const rgb = reduceChroma(lch);
    assert.ok(inGamut(rgb, 0));
    const [L, C, h] = rgbToOklch(rgb);
    assert.ok(Math.abs(L - lch[0]) < 1e-5, `lightness ${L} vs ${lch[0]}`);
    if (C > 1e-3) assert.ok(Math.abs(((h - lch[2] + 540) % 360) - 180) < 0.05, `hue ${h} vs ${lch[2]}`);
    if (C < lch[1] - 1e-6) assert.ok(!inGamut(oklchToRgb([L, C + 1e-3, lch[2]])), 'more chroma would have fit');
  }
});

test('CSS gamut mapping lands in gamut and within a JND of the chroma-reduced color', () => {
  const random = rng(9);
  for (let i = 0; i < 500; i++) {
    const lch = [0.05 + 0.9 * random(), 0.1 + 0.3 * random(), 360 * random()];
    const rgb = gamutMapOklch(lch);
    assert.ok(inGamut(rgb, 0));
    assert.ok(Math.abs(rgbToOklch(rgb)[0] - lch[0]) < 0.02);
  }
  close(gamutMapOklch([1.2, 0.3, 40]), [1, 1, 1], 0);
  close(gamutMapOklch([0, 0.3, 40]), [0, 0, 0], 0);
  // in gamut colors pass through untouched
  close(gamutMapOklch(rgbToOklch([0.2, 0.4, 0.6])), [0.2, 0.4, 0.6], 1e-12);
  const wide = parseColor('oklch(0.7 0.35 145)');
  assert.ok(!inGamut(wide.rgb));
  assert.ok(inGamut(displayRgb(wide), 0));
});

test('deltaEOK is Euclidean distance in OKLab', () => {
  assert.equal(deltaEOK([0.5, 0, 0], [0.5, 0.03, 0.04]), 0.05);
});

test('formatColor writes the notation it was given, alpha as typed', () => {
  const again = (text) => {
    const c = parseColor(text);
    return formatColor(displayRgb(c), c.alpha, styleFor(c.style));
  };
  assert.equal(again('#777'), '#777777');
  assert.equal(again('#ABCDEF'), '#ABCDEF');
  assert.equal(again('#00000080'), '#00000080');
  assert.equal(again('white'), '#ffffff');
  assert.equal(again('rgba(0, 0, 0, 0.54)'), 'rgba(0, 0, 0, 0.54)');
  assert.equal(again('rgb(0, 0, 0)'), 'rgb(0, 0, 0)');
  assert.equal(again('rgb(10 20 30 / 50%)'), 'rgb(10 20 30 / 50%)');
  assert.equal(again('hsl(210, 50%, 40%)'), 'hsl(210, 50%, 40%)');
  assert.equal(again('hsl(210 50% 40% / .5)'), 'hsl(210 50% 40% / .5)');
  assert.equal(again('hwb(180 10% 20%)'), 'hwb(180 10% 20%)');
  assert.equal(again('oklch(62.8% 0.2 29.23)'), 'oklch(62.8% 0.2 29.23)');
  assert.equal(again('oklch(0.5 0 0)'), 'oklch(0.5 0 0)');
  assert.equal(again('lab(50 20 -30)'), 'lab(50 20 -30)');
  assert.equal(again('lch(50 30 120)'), 'lch(50 30 120)');
  assert.equal(again('oklab(0.5 0.1 -0.1)'), 'oklab(0.5 0.1 -0.1)');
});

test('formatColor adds the a to legacy rgb()/hsl() when alpha appears', () => {
  const style = parseColor('rgb(0, 0, 0)').style;
  assert.equal(formatColor([0, 0, 0], 0.5, style), 'rgba(0, 0, 0, 0.5)');
});

test('--format styles: other notations, named colors come back as hex', () => {
  const c = parseColor('rgba(0, 0, 0, 50%)');
  assert.equal(formatColor([1, 0, 0], 0.5, styleFor(c.style, 'hex')), '#ff000080');
  assert.equal(formatColor([1, 0, 0], 0.5, styleFor(c.style, 'oklch')), 'oklch(0.628 0.2577 29.23 / 50%)');
  assert.equal(formatColor([1, 1, 1], 1, styleFor(parseColor('navy').style)), '#ffffff');
});

test('every printed notation reads back within one 8-bit step', () => {
  // hex and rgb() round to the nearest byte; the float notations print 1 to
  // 4 decimals, and oklab() at 4 decimals is the loosest at just under a step
  const random = rng(3);
  const step = 1 / 255;
  const tolerances = { hex: step / 2, rgb: step / 2, hsl: step, hwb: step, lab: step, lch: step, oklab: step, oklch: step };
  for (let i = 0; i < 2000; i++) {
    const rgb = [random(), random(), random()];
    for (const [notation, tol] of Object.entries(tolerances)) {
      const text = formatColor(rgb, 1, { notation });
      close(parseColor(text).rgb, rgb, tol, text);
    }
  }
});

test('num drops trailing zeros and never prints -0', () => {
  assert.equal(num(1.5, 3), '1.5');
  assert.equal(num(2, 3), '2');
  assert.equal(num(-0.00001, 2), '0');
  assert.equal(num(0.12345, 4), '0.1235');
});

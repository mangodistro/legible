// Parsing, conversion, gamut mapping and formatting for CSS colors.
//
// A parsed color is { rgb, alpha, style, text }:
//   rgb    gamma-encoded sRGB, nominally 0..1. Wide-gamut input (lab, lch,
//          oklab, oklch) can land outside that range; use displayRgb() to get
//          what a browser would actually paint.
//   alpha  0..1
//   style  how the color was written, so a suggestion can be printed back in
//          the same notation (see formatColor)
//   text   the input as given
import { NAMED_COLORS } from './names.js';

export class ColorError extends Error {}

// ---------------------------------------------------------------- matrices

function mul(a, b) {
  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
}

export function mulVec(m, v) {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const xyzFromChromaticity = ([x, y]) => [x / y, 1, (1 - x - y) / y];

// White points and the sRGB matrix are derived from their defining
// chromaticities instead of pasted as 16-digit constants.
export const D65 = xyzFromChromaticity([0.3127, 0.3290]);
export const D50 = xyzFromChromaticity([0.3457, 0.3585]);

function rgbToXyzMatrix(primaries, white) {
  const cols = primaries.map(xyzFromChromaticity);
  const P = [0, 1, 2].map((r) => cols.map((col) => col[r]));
  const S = mulVec(invert(P), white);
  return P.map((row) => row.map((v, j) => v * S[j]));
}

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

function bradford(from, to) {
  const src = mulVec(BRADFORD, from);
  const dst = mulVec(BRADFORD, to);
  const scale = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? dst[r] / src[r] : 0)));
  return mul(invert(BRADFORD), mul(scale, BRADFORD));
}

export const SRGB_TO_XYZ65 = rgbToXyzMatrix([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]], D65);
const SRGB_TO_XYZ50 = mul(bradford(D65, D50), SRGB_TO_XYZ65);
const XYZ50_TO_SRGB = invert(SRGB_TO_XYZ50);

// ------------------------------------------------------------- conversions

// The sRGB transfer function, extended through the origin so that
// out-of-gamut (negative) values survive a round trip.
export function toLinear(c) {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
}

export function fromLinear(c) {
  const a = Math.abs(c);
  return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055);
}

// OKLab, with the matrices CSS Color 4 recomputed from Björn Ottosson's.
// His original 10-digit ones put white at L = 0.9999999935, b = 3.7e-8,
// which is enough to print white on black as 20.99:1 once ratios are
// truncated; and his published inverses miss being exact inverses by up to
// 3.7e-8. These map D65 white to exactly (1, 0, 0), and the inverses are
// computed here, so round trips are exact to float noise.
const XYZ65_TO_LMS = [
  [0.8190224379967030, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const OKLAB_M1 = mul(XYZ65_TO_LMS, SRGB_TO_XYZ65);
const OKLAB_M2 = [
  [0.2104542683093140, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.4285922420485799, 0.4505937096174110],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_M1_INV = invert(OKLAB_M1);
const OKLAB_M2_INV = invert(OKLAB_M2);

export function rgbToOklab(rgb) {
  return mulVec(OKLAB_M2, mulVec(OKLAB_M1, rgb.map(toLinear)).map(Math.cbrt));
}

export function oklabToRgb(lab) {
  return mulVec(OKLAB_M1_INV, mulVec(OKLAB_M2_INV, lab).map((v) => v ** 3)).map(fromLinear);
}

const DEG = Math.PI / 180;

function toPolar([L, a, b]) {
  const C = Math.hypot(a, b);
  const h = Math.atan2(b, a) / DEG;
  return [L, C, h < 0 ? h + 360 : h];
}

function fromPolar([L, C, h]) {
  return [L, C * Math.cos(h * DEG), C * Math.sin(h * DEG)];
}

export const rgbToOklch = (rgb) => toPolar(rgbToOklab(rgb));
export const oklchToRgb = (lch) => oklabToRgb(fromPolar(lch));

// CIE Lab and LCH relative to D50, as CSS lab() and lch() are.
const LAB_E = 216 / 24389;
const LAB_K = 24389 / 27;

export function rgbToLab(rgb) {
  const xyz = mulVec(SRGB_TO_XYZ50, rgb.map(toLinear));
  const f = xyz.map((v, i) => {
    const t = v / D50[i];
    return t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116;
  });
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const xyz = [
    fx ** 3 > LAB_E ? fx ** 3 : (116 * fx - 16) / LAB_K,
    L > LAB_K * LAB_E ? fy ** 3 : L / LAB_K,
    fz ** 3 > LAB_E ? fz ** 3 : (116 * fz - 16) / LAB_K,
  ].map((v, i) => v * D50[i]);
  return mulVec(XYZ50_TO_SRGB, xyz).map(fromLinear);
}

export const rgbToLch = (rgb) => toPolar(rgbToLab(rgb));
export const lchToRgb = (lch) => labToRgb(fromPolar(lch));

export function hslToRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hwbToRgb([h, w, b]) {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  return hslToRgb([h, 1, 0.5]).map((c) => c * (1 - w - b) + w);
}

export function rgbToHwb(rgb) {
  return [rgbToHsl(rgb)[0], Math.min(...rgb), 1 - Math.max(...rgb)];
}

// ----------------------------------------------------------- gamut mapping

export function inGamut(rgb, tolerance = 1e-6) {
  return rgb.every((c) => c >= -tolerance && c <= 1 + tolerance);
}

const clip = (rgb) => rgb.map((c) => Math.min(1, Math.max(0, c)));

export function deltaEOK(lab1, lab2) {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

// The CSS Color 4 gamut mapping algorithm: hold OKLCH lightness and hue,
// bisect on chroma, and stop as soon as plain clipping would land within one
// just-noticeable difference (deltaEOK 0.02) of the unclipped color.
const JND = 0.02;
const EPSILON = 0.0001;

export function gamutMapOklch([L, C, h]) {
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  const origin = oklchToRgb([L, C, h]);
  if (inGamut(origin)) return clip(origin);
  let clipped = clip(origin);
  if (deltaEOK(rgbToOklab(clipped), fromPolar([L, C, h])) < JND) return clipped;
  let min = 0;
  let max = C;
  let minInGamut = true;
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2;
    const current = oklchToRgb([L, chroma, h]);
    if (minInGamut && inGamut(current)) {
      min = chroma;
      continue;
    }
    clipped = clip(current);
    const E = deltaEOK(rgbToOklab(clipped), fromPolar([L, chroma, h]));
    if (E < JND) {
      if (JND - E < EPSILON) return clipped;
      minInGamut = false;
      min = chroma;
    } else {
      max = chroma;
    }
  }
  return clipped;
}

// The most chroma that fits in sRGB at this OKLCH lightness and hue. Unlike
// gamutMapOklch this never clips, so lightness and hue hold exactly; the
// search path uses it because the CSS clip step bends hue by up to 5 degrees
// (scripts/compare-paths.js).
export function reduceChroma([L, C, h]) {
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  let rgb = oklchToRgb([L, C, h]);
  if (inGamut(rgb)) return clip(rgb);
  let lo = 0;
  let hi = C;
  rgb = oklchToRgb([L, 0, h]);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const candidate = oklchToRgb([L, mid, h]);
    if (inGamut(candidate)) {
      lo = mid;
      rgb = candidate;
    } else {
      hi = mid;
    }
  }
  return clip(rgb);
}

// The sRGB color CSS Color 4 says to paint: the color itself, or its
// gamut-mapped version when it lies outside sRGB. Alpha is left to callers.
export function displayRgb(color) {
  return inGamut(color.rgb) ? clip(color.rgb) : gamutMapOklch(rgbToOklch(color.rgb));
}

// ----------------------------------------------------------------- parsing

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|rad|grad|turn)?$/;
const ANGLE = { '': 1, deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };

function token(text, input) {
  if (text === 'none') return { kind: 'none', value: 0 };
  const m = NUMBER.exec(text);
  if (!m) throw new ColorError(`cannot read '${text}' in '${input}'`);
  const unit = m[2] || '';
  const kind = unit === '%' ? 'percent' : unit === '' ? 'number' : 'angle';
  return { kind, value: parseFloat(m[1]), unit, text };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hue(t, input) {
  if (t.kind === 'none') return 0;
  if (t.kind === 'percent') throw new ColorError(`a hue cannot be a percentage in '${input}'`);
  return t.value * ANGLE[t.unit];
}

// A channel that is a percentage or a plain number, scaled so that 100% and
// `full` plain units both map to `scale`.
function amount(t, full, scale, input) {
  if (t.kind === 'none') return 0;
  if (t.kind === 'angle') throw new ColorError(`unexpected angle '${t.text}' in '${input}'`);
  return t.kind === 'percent' ? (t.value / 100) * scale : (t.value / full) * scale;
}

function alphaOf(t, input) {
  if (!t) return { alpha: 1, alphaText: null, alphaPercent: false };
  if (t.kind === 'angle') throw new ColorError(`alpha cannot be an angle in '${input}'`);
  const alpha = clamp(t.kind === 'percent' ? t.value / 100 : t.value, 0, 1);
  return { alpha, alphaText: t.kind === 'none' ? null : t.text, alphaPercent: t.kind === 'percent' };
}

function parseHex(digits, input, upper) {
  if (![3, 4, 6, 8].includes(digits.length)) {
    throw new ColorError(`hex color '${input}' needs 3, 4, 6 or 8 digits, not ${digits.length}`);
  }
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join('') : digits;
  const bytes = full.match(/../g).map((p) => parseInt(p, 16));
  const hasAlpha = bytes.length === 4;
  return {
    rgb: bytes.slice(0, 3).map((v) => v / 255),
    alpha: hasAlpha ? bytes[3] / 255 : 1,
    style: { notation: 'hex', upper, hasAlpha },
  };
}

// Each color function, and the notation it is written back in.
const FUNCTIONS = {
  rgb: 'rgb', rgba: 'rgb', hsl: 'hsl', hsla: 'hsl', hwb: 'hwb',
  lab: 'lab', lch: 'lch', oklab: 'oklab', oklch: 'oklch',
};

function parseFunction(fn, body, input) {
  const notation = FUNCTIONS[fn];
  if (!notation) throw new ColorError(`unknown color function '${fn}()' in '${input}'`);
  const legacy = body.includes(',');
  let parts;
  let alphaToken;
  if (legacy) {
    if (notation !== 'rgb' && notation !== 'hsl') {
      throw new ColorError(`${fn}() does not take commas: '${input}'`);
    }
    if (body.includes('/')) throw new ColorError(`cannot mix commas and '/' in '${input}'`);
    parts = body.split(',').map((p) => p.trim());
    if (parts.some((p) => p === '' || /\s/.test(p))) {
      throw new ColorError(`malformed channel list in '${input}'`);
    }
    if (parts.length === 4) alphaToken = parts.pop();
  } else {
    const slash = body.split('/');
    if (slash.length > 2) throw new ColorError(`more than one '/' in '${input}'`);
    parts = slash[0].trim().split(/\s+/).filter(Boolean);
    if (slash.length === 2) {
      alphaToken = slash[1].trim();
      if (alphaToken === '' || /\s/.test(alphaToken)) {
        throw new ColorError(`expected one alpha value after '/' in '${input}'`);
      }
    }
  }
  if (parts.length !== 3) {
    throw new ColorError(`${fn}() needs 3 channels${legacy ? ' and an optional alpha' : ''}, got ${parts.length} in '${input}'`);
  }
  const [t1, t2, t3] = parts.map((p) => token(p, input));
  const { alpha, alphaText, alphaPercent } = alphaOf(alphaToken === undefined ? null : token(alphaToken, input), input);
  const style = { notation, fn, legacy, alphaText, alphaPercent, alphaValue: alpha, lightnessPercent: t1.kind === 'percent' };
  let rgb;
  switch (notation) {
    case 'rgb':
      rgb = [t1, t2, t3].map((t) => clamp(amount(t, 255, 1, input), 0, 1));
      break;
    case 'hsl':
      rgb = hslToRgb([hue(t1, input), clamp(amount(t2, 100, 1, input), 0, 1), clamp(amount(t3, 100, 1, input), 0, 1)]);
      break;
    case 'hwb':
      rgb = hwbToRgb([hue(t1, input), clamp(amount(t2, 100, 1, input), 0, 1), clamp(amount(t3, 100, 1, input), 0, 1)]);
      break;
    case 'lab':
      rgb = labToRgb([clamp(amount(t1, 100, 100, input), 0, 100), amount(t2, 125, 125, input), amount(t3, 125, 125, input)]);
      break;
    case 'lch':
      rgb = lchToRgb([clamp(amount(t1, 100, 100, input), 0, 100), Math.max(0, amount(t2, 150, 150, input)), hue(t3, input)]);
      break;
    case 'oklab':
      rgb = oklabToRgb([clamp(amount(t1, 1, 1, input), 0, 1), amount(t2, 0.4, 0.4, input), amount(t3, 0.4, 0.4, input)]);
      break;
    case 'oklch':
      rgb = oklchToRgb([clamp(amount(t1, 1, 1, input), 0, 1), Math.max(0, amount(t2, 0.4, 0.4, input)), hue(t3, input)]);
      break;
  }
  return { rgb, alpha, style };
}

export function parseColor(input) {
  const text = String(input).trim();
  if (text === '') throw new ColorError('empty color');
  const lower = text.toLowerCase();

  const hex = /^#([0-9a-f]*)$/i.exec(text);
  if (hex) return { ...parseHex(hex[1], text, /[A-F]/.test(hex[1])), text };
  // Bare hex, because an unquoted #777 starts a shell comment.
  if (/^[0-9a-f]+$/i.test(text) && [3, 4, 6, 8].includes(text.length)) {
    return { ...parseHex(text, text, /[A-F]/.test(text)), text };
  }

  const fn = /^([a-z]+)\((.*)\)$/s.exec(lower);
  if (fn) return { ...parseFunction(fn[1], fn[2].trim(), text), text };

  if (lower === 'transparent') {
    return { rgb: [0, 0, 0], alpha: 0, style: { notation: 'name' }, text };
  }
  if (Object.hasOwn(NAMED_COLORS, lower)) {
    return { ...parseHex(NAMED_COLORS[lower], text, false), style: { notation: 'name' }, text };
  }
  if (/^[0-9a-f]+$/i.test(text)) {
    throw new ColorError(`hex color '${text}' needs 3, 4, 6 or 8 digits, not ${text.length}`);
  }
  throw new ColorError(`not a color: '${text}'`);
}

// -------------------------------------------------------------- formatting

// Fixed decimals with trailing zeros dropped; never prints "-0".
export function num(v, decimals) {
  let s = v.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const byte = (c) => Math.round(clamp(c, 0, 1) * 255);
const hex2 = (v) => v.toString(16).padStart(2, '0');

// An unchanged alpha is written exactly as it was typed.
function alphaText(alpha, style) {
  if (style.alphaText && style.alphaValue === alpha) return style.alphaText;
  return style.alphaPercent ? `${num(alpha * 100, 1)}%` : num(alpha, 3);
}

// Hue is meaningless for grays; print 0 rather than float noise.
const hueText = (h, chroma, decimals) => (chroma < 1e-4 ? '0' : num(h, decimals));

export const NOTATIONS = ['hex', 'rgb', 'hsl', 'hwb', 'lab', 'lch', 'oklab', 'oklch'];

// The style to write a replacement in: the input's own style, or a plain
// default when --format asks for a different notation. Named colors come
// back as hex, since the replacement is rarely another named color.
export function styleFor(inputStyle, notation = 'same') {
  if (notation === 'same' || notation === inputStyle.notation) {
    return inputStyle.notation === 'name' ? { notation: 'hex' } : inputStyle;
  }
  return { notation, alphaPercent: Boolean(inputStyle.alphaPercent) };
}

// Write an in-gamut sRGB color in the notation described by `style`, which
// is normally the parsed style of the color being replaced: rgba(0, 0, 0, 0.5)
// comes back with commas and the same alpha spelling.
export function formatColor(rgb, alpha, style) {
  const notation = style.notation === 'name' ? 'hex' : style.notation;
  const fn = style.fn && FUNCTIONS[style.fn] === notation ? style.fn : notation;
  const showAlpha = alpha < 1 || Boolean(style.alphaText);
  const join = (channels) => {
    if (style.legacy && (notation === 'rgb' || notation === 'hsl')) {
      const name = showAlpha && !fn.endsWith('a') ? `${fn}a` : fn;
      return `${name}(${channels.join(', ')}${showAlpha ? `, ${alphaText(alpha, style)}` : ''})`;
    }
    return `${fn}(${channels.join(' ')}${showAlpha ? ` / ${alphaText(alpha, style)}` : ''})`;
  };
  switch (notation) {
    case 'hex': {
      const digits = rgb.map(byte).map(hex2).join('') + (alpha < 1 || style.hasAlpha ? hex2(byte(alpha)) : '');
      return `#${style.upper ? digits.toUpperCase() : digits}`;
    }
    case 'rgb':
      return join(rgb.map((c) => String(byte(c))));
    case 'hsl': {
      const [h, s, l] = rgbToHsl(rgb);
      return join([hueText(h, s, 1), `${num(s * 100, 1)}%`, `${num(l * 100, 1)}%`]);
    }
    case 'hwb': {
      const [h, w, b] = rgbToHwb(rgb);
      return join([hueText(h, 1 - w - b, 1), `${num(w * 100, 1)}%`, `${num(b * 100, 1)}%`]);
    }
    case 'lab': {
      const [L, a, b] = rgbToLab(rgb);
      return join([style.lightnessPercent ? `${num(L, 2)}%` : num(L, 2), num(a, 2), num(b, 2)]);
    }
    case 'lch': {
      const [L, C, h] = rgbToLch(rgb);
      return join([style.lightnessPercent ? `${num(L, 2)}%` : num(L, 2), num(C, 2), hueText(h, C / 100, 2)]);
    }
    case 'oklab': {
      const [L, a, b] = rgbToOklab(rgb);
      return join([style.lightnessPercent ? `${num(L * 100, 2)}%` : num(L, 4), num(a, 4), num(b, 4)]);
    }
    case 'oklch': {
      const [L, C, h] = rgbToOklch(rgb);
      return join([style.lightnessPercent ? `${num(L * 100, 2)}%` : num(L, 4), num(C, 4), hueText(h, C, 2)]);
    }
    default:
      throw new ColorError(`unknown notation '${notation}'`);
  }
}

export function hexOf(rgb) {
  return `#${rgb.map(byte).map(hex2).join('')}`;
}

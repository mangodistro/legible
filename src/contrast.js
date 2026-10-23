// WCAG 2 contrast, and the search for the nearest color that reaches a
// target ratio.
import {
  displayRgb, formatColor, parseColor, reduceChroma, rgbToLab, rgbToOklch, styleFor, toLinear,
} from './color.js';
import { deltaE2000 } from './deltae.js';

export const LEVELS = [
  { id: 'aa', ratio: 4.5, label: 'AA   normal text' },
  { id: 'aa-large', ratio: 3, label: 'AA   large text' },
  { id: 'aaa', ratio: 7, label: 'AAA  normal text' },
  { id: 'aaa-large', ratio: 4.5, label: 'AAA  large text' },
  { id: 'ui', ratio: 3, label: 'AA   UI components and graphics' },
];

// Relative luminance as WCAG defines it. The linearisation threshold is
// 0.04045; older WCAG text said 0.03928, and no 8-bit channel value falls
// between the two.
export function luminance([r, g, b]) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(y1, y2) {
  return (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);
}

// Browsers blend in gamma-encoded sRGB, so this does too.
export function composite(rgb, alpha, under) {
  return rgb.map((c, i) => alpha * c + (1 - alpha) * under[i]);
}

export function pairRatio(fgRgb, fgAlpha, bgRgb) {
  return contrastRatio(luminance(composite(fgRgb, fgAlpha, bgRgb)), luminance(bgRgb));
}

// Truncated, never rounded: WCAG thresholds are exact, and a pair at 4.499
// fails AA, so it must not print as 4.50.
export function formatRatio(ratio) {
  return `${(Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2)}:1`;
}

// The input as typed, with a '#' restored if it was given as bare hex.
export function canonicalText(color) {
  return color.style.notation === 'hex' && !color.text.startsWith('#') ? `#${color.text}` : color.text;
}

const STEP = 0.0005;

// Find the colors nearest to the moving one (fg or bg) that reach `target`
// against the other.
//
// The search moves along a single line: OKLCH lightness, with the original
// hue held and chroma kept where sRGB allows it, reduced where it does not.
// Bisection finds where that line crosses the target; then the
// candidate is printed in the output notation, parsed back, and measured
// again, stepping further along the line until the printed text itself
// passes. The exact boundary color rounds to a failing hex about half the
// time, so nothing is reported that was not re-measured.
//
// Returns { ratio, target, passes, candidates, best }. Each candidate is
// { kind, possible, text, rgb, alpha, ratio, deltaE } or, when nothing on
// that side can reach the target, { kind, possible: false, best } with the
// ratio at the far end (black, white, or full opacity).
export function suggest(fg, bg, { target, move = 'fg', notation = 'same', direction = 'auto' }) {
  if (bg.alpha < 1) throw new RangeError('the background must be opaque');
  const fgRgb = displayRgb(fg);
  const bgRgb = displayRgb(bg);
  const ratio = pairRatio(fgRgb, fg.alpha, bgRgb);
  const moving = move === 'fg' ? fg : bg;
  const style = styleFor(moving.style, notation);

  // What the eye sees of the moving color: the blend for a translucent
  // foreground, the color itself for the background.
  const seen = (rgb, alpha) => (move === 'fg' ? composite(rgb, alpha, bgRgb) : rgb);
  const ratioOf = (rgb, alpha = fg.alpha) => (move === 'fg' ? pairRatio(rgb, alpha, bgRgb) : pairRatio(fgRgb, fg.alpha, rgb));
  const originLab = rgbToLab(seen(displayRgb(moving), fg.alpha));
  const measure = (text) => {
    const back = parseColor(text);
    const rgb = displayRgb(back);
    return {
      text,
      rgb,
      alpha: back.alpha,
      ratio: ratioOf(rgb, back.alpha),
      deltaE: deltaE2000(originLab, rgbToLab(seen(rgb, back.alpha))),
    };
  };

  const [L0, C0, h0] = rgbToOklch(moving.rgb);
  const path = (L) => reduceChroma([L, C0, h0]);

  // Walk from lightness L toward `end` until the printed color passes.
  const realize = (L, end, kind) => {
    const dir = Math.sign(end - L) || 1;
    for (;;) {
      const got = measure(formatColor(path(L), moving.alpha, style));
      if (got.ratio >= target) return { kind, possible: true, ...got };
      if (L === end) return null;
      L = dir < 0 ? Math.max(end, L - STEP) : Math.min(end, L + STEP);
    }
  };

  const along = (end) => {
    const kind = end === 0 ? 'darker' : 'lighter';
    const best = ratioOf(path(end));
    if (best < target) return { kind, possible: false, best };
    let failing = L0;
    let passing = end;
    for (let i = 0; i < 50; i++) {
      const mid = (failing + passing) / 2;
      if (ratioOf(path(mid)) >= target) passing = mid;
      else failing = mid;
    }
    return realize(passing, end, kind) || { kind, possible: false, best };
  };

  // Keep the color, raise its alpha: only for a translucent foreground.
  const opaquer = () => {
    const rgb = fgRgb;
    const best = ratioOf(rgb, 1);
    if (best < target) return { kind: 'opacity', possible: false, best };
    let failing = fg.alpha;
    let passing = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (failing + passing) / 2;
      if (ratioOf(rgb, mid) >= target) passing = mid;
      else failing = mid;
    }
    const steps = style.notation === 'hex' ? 255 : 100;
    for (let k = Math.ceil(passing * steps - 1e-9); k <= steps; k++) {
      const got = measure(formatColor(rgb, k / steps, style));
      if (got.ratio >= target) return { kind: 'opacity', possible: true, ...got };
    }
    return { kind: 'opacity', possible: false, best };
  };

  const result = { ratio, target, passes: ratio >= target, move, candidates: [], best: null };
  if (result.passes) {
    if (notation === 'same') {
      result.best = { kind: 'unchanged', possible: true, ...measure(canonicalText(moving)) };
    } else {
      // Re-expressing a passing color can round it into a failing one, so
      // walk toward more contrast until the new spelling passes too.
      const other = move === 'fg' ? bgRgb : composite(fgRgb, fg.alpha, displayRgb(moving));
      const darker = luminance(seen(displayRgb(moving), fg.alpha)) < luminance(other);
      result.best = realize(L0, darker ? 0 : 1, 'unchanged');
    }
    return result;
  }

  if (direction !== 'lighter') result.candidates.push(along(0));
  if (direction !== 'darker') result.candidates.push(along(1));
  if (direction === 'auto' && move === 'fg' && fg.alpha < 1) result.candidates.push(opaquer());
  const possible = result.candidates.filter((c) => c.possible).sort((a, b) => a.deltaE - b.deltaE);
  result.best = possible[0] || null;
  return result;
}

// Contrast of every ordered pair of opaque colors.
export function grid(colors) {
  const rgbs = colors.map(displayRgb);
  return rgbs.map((a) => rgbs.map((b) => pairRatio(a, 1, b)));
}

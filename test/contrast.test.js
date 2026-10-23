import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTATIONS, displayRgb, formatColor, hexOf, parseColor, reduceChroma, rgbToOklch } from '../src/color.js';
import { canonicalText, composite, contrastRatio, formatRatio, grid, luminance, pairRatio, suggest } from '../src/contrast.js';

const ratioOf = (fg, bg) => {
  const f = parseColor(fg);
  const b = parseColor(bg);
  return pairRatio(displayRgb(f), f.alpha, displayRgb(b));
};

function rng(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

test('the familiar WCAG numbers', () => {
  assert.equal(ratioOf('black', 'white'), 21);
  assert.equal(ratioOf('white', 'white'), 1);
  assert.ok(Math.abs(ratioOf('#777', '#fff') - 4.478) < 1e-3);
  assert.ok(Math.abs(ratioOf('#767676', '#fff') - 4.542) < 1e-3);
  assert.equal(ratioOf('#777', '#fff'), ratioOf('#fff', '#777'));
  assert.equal(luminance([0, 0, 0]), 0);
  assert.equal(luminance([1, 1, 1]), 1);
  assert.equal(contrastRatio(0.2, 0.5), contrastRatio(0.5, 0.2));
});

test('the old 0.03928 threshold and the current 0.04045 agree on every byte', () => {
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const old = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const now = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    assert.equal(old, now, `byte ${i}`);
  }
});

test('ratios are truncated, so a failing pair never prints as passing', () => {
  assert.equal(formatRatio(4.4999999), '4.49:1');
  assert.equal(formatRatio(4.5), '4.50:1');
  assert.equal(formatRatio(21), '21.00:1');
  assert.equal(formatRatio(1), '1.00:1');
  // 4.53 * 100 is 452.99999999999994 in floating point
  assert.equal(formatRatio(4.53), '4.53:1');
  assert.equal(formatRatio(ratioOf('#777', '#fff')), '4.47:1');
});

test('compositing: alpha 0 is the background, alpha 1 the foreground', () => {
  assert.deepEqual(composite([0, 0, 0], 0, [1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(composite([0.2, 0.4, 0.6], 1, [1, 1, 1]), [0.2, 0.4, 0.6]);
  assert.deepEqual(composite([0, 0, 0], 0.5, [1, 0.5, 0]), [0.5, 0.25, 0]);
  assert.equal(hexOf(composite([0, 0, 0], 0.4, [1, 1, 1])), '#999999');
});

test('#777 on white becomes #767676, the lightest gray that passes', () => {
  const r = suggest(parseColor('777'), parseColor('white'), { target: 4.5 });
  assert.equal(r.passes, false);
  assert.equal(r.best.text, '#767676');
  assert.equal(r.best.kind, 'darker');
  const lighter = r.candidates.find((c) => c.kind === 'lighter');
  assert.equal(lighter.possible, false);
  assert.equal(lighter.best, 1);
});

test('the exact boundary color rounds back to a failing hex; the printed answer does not', () => {
  // The continuous gray that gives exactly 4.5:1 on white is 118.7/255,
  // which rounds to #777777 and fails. The search must not stop there.
  const fg = parseColor('#808080');
  const [L, C, h] = rgbToOklch(fg.rgb);
  let failing = L;
  let passing = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (failing + passing) / 2;
    if (pairRatio(reduceChroma([mid, C, h]), 1, [1, 1, 1]) >= 4.5) passing = mid;
    else failing = mid;
  }
  const rounded = hexOf(reduceChroma([passing, C, h]));
  assert.equal(rounded, '#777777');
  assert.ok(ratioOf(rounded, 'white') < 4.5);
  assert.equal(suggest(fg, parseColor('white'), { target: 4.5 }).best.text, '#767676');
});

test('gray answers are tight: one byte back toward the original fails', () => {
  for (const [bg, target] of [['white', 4.5], ['white', 7], ['#222', 4.5], ['black', 3], ['#f5f5f5', 4.5]]) {
    for (let v = 0; v < 256; v += 17) {
      const fg = parseColor(`rgb(${v} ${v} ${v})`);
      const r = suggest(fg, parseColor(bg), { target });
      if (r.passes || !r.best) continue;
      const got = parseColor(r.best.text).rgb.map((c) => Math.round(c * 255));
      assert.ok(got[0] === got[1] && got[1] === got[2], `${r.best.text} is not gray`);
      const back = got[0] + (r.best.kind === 'darker' ? 1 : -1);
      assert.ok(ratioOf(`rgb(${back} ${back} ${back})`, bg) < target, `rgb(${back}) on ${bg} also passes ${target}`);
    }
  }
});

test('a translucent foreground can be fixed by opacity when no lightness will do', () => {
  const r = suggest(parseColor('rgba(0, 0, 0, 0.4)'), parseColor('white'), { target: 4.5 });
  assert.equal(r.candidates.find((c) => c.kind === 'darker').possible, false);
  assert.equal(r.best.kind, 'opacity');
  assert.equal(r.best.text, 'rgba(0, 0, 0, 0.54)');
  assert.ok(ratioOf('rgba(0, 0, 0, 0.53)', 'white') < 4.5);
  // hex alpha moves in byte steps: 0x89 blends to gray 118 (#767676), 0x88
  // to gray 119 (#777777), which fails; percentages move in whole percent
  assert.equal(suggest(parseColor('#00000066'), parseColor('white'), { target: 4.5 }).best.text, '#00000089');
  assert.ok(ratioOf('#00000088', 'white') < 4.5);
  assert.equal(suggest(parseColor('rgb(0 0 0 / 40%)'), parseColor('white'), { target: 4.5 }).best.text, 'rgb(0 0 0 / 54%)');
});

test('a translucent foreground keeps its alpha when lightness is changed', () => {
  const r = suggest(parseColor('rgba(255, 0, 0, 0.9)'), parseColor('white'), { target: 4.5, direction: 'darker' });
  assert.equal(r.best.kind, 'darker');
  assert.match(r.best.text, /^rgba\(\d+, \d+, \d+, 0\.9\)$/);
  assert.ok(ratioOf(r.best.text, 'white') >= 4.5);
});

test('when neither direction can reach the target, both report their limits', () => {
  const r = suggest(parseColor('white'), parseColor('#777'), { target: 7 });
  assert.equal(r.best, null);
  const [darker, lighter] = r.candidates;
  assert.equal(darker.possible, false);
  assert.ok(Math.abs(darker.best - ratioOf('black', '#777')) < 1e-12);
  assert.equal(lighter.possible, false);
});

test('moving the background instead', () => {
  const r = suggest(parseColor('#777'), parseColor('white'), { target: 4.5, move: 'bg' });
  assert.equal(r.best.kind, 'darker');
  assert.ok(ratioOf('#777', r.best.text) >= 4.5);
  // the lighter side is already at white
  assert.equal(r.candidates.find((c) => c.kind === 'lighter').possible, false);
  assert.throws(() => suggest(parseColor('#777'), parseColor('#fff8'), { target: 4.5 }), /opaque/);
});

test('direction can be forced, and auto picks the smaller change', () => {
  // mid-gray on mid-gray: both sides work, darker is closer for this pair
  const fg = parseColor('#808080');
  const bg = parseColor('#888');
  const auto = suggest(fg, bg, { target: 3 });
  assert.equal(auto.candidates.length, 2);
  const sorted = auto.candidates.filter((c) => c.possible).sort((a, b) => a.deltaE - b.deltaE);
  assert.equal(auto.best, sorted[0]);
  const lighter = suggest(fg, bg, { target: 3, direction: 'lighter' });
  assert.deepEqual(lighter.candidates.map((c) => c.kind), ['lighter']);
  assert.ok(ratioOf(lighter.best.text, '#888') >= 3);
});

test('a pair that already passes comes back unchanged, as typed', () => {
  const r = suggest(parseColor('1d3557'), parseColor('white'), { target: 4.5 });
  assert.equal(r.passes, true);
  assert.equal(r.best.kind, 'unchanged');
  assert.equal(r.best.text, '#1d3557');
  assert.equal(suggest(parseColor('rgba(0,0,0,.9)'), parseColor('white'), { target: 4.5 }).best.text, 'rgba(0,0,0,.9)');
  // re-spelled in another notation, it still has to pass
  const oklch = suggest(parseColor('#767676'), parseColor('white'), { target: 4.5, notation: 'oklch' });
  assert.match(oklch.best.text, /^oklch\(/);
  assert.ok(ratioOf(oklch.best.text, 'white') >= 4.5);
});

test('canonicalText restores the # on bare hex only', () => {
  assert.equal(canonicalText(parseColor('777')), '#777');
  assert.equal(canonicalText(parseColor('#777')), '#777');
  assert.equal(canonicalText(parseColor('navy')), 'navy');
});

test('property: every suggestion, printed and read back, reaches the target', () => {
  const random = rng(2024);
  const targets = [3, 4.5, 7, 5.5];
  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const fgRgb = [random(), random(), random()];
    const bgRgb = [random(), random(), random()];
    const alpha = random() < 0.25 ? 0.3 + 0.7 * random() : 1;
    const notation = NOTATIONS[Math.floor(random() * NOTATIONS.length)];
    const fg = parseColor(formatColor(fgRgb, alpha, { notation }));
    const bg = parseColor(hexOf(bgRgb));
    const target = targets[i % targets.length];
    const move = i % 5 === 0 ? 'bg' : 'fg';
    const r = suggest(fg, bg, { target, move });
    for (const c of r.candidates) {
      if (!c.possible) continue;
      const fgText = move === 'fg' ? c.text : fg.text;
      const bgText = move === 'bg' ? c.text : bg.text;
      assert.ok(ratioOf(fgText, bgText) >= target, `${fgText} on ${bgText} misses ${target}`);
      assert.equal(parseColor(c.text).style.notation, (move === 'fg' ? fg : bg).style.notation);
      checked++;
    }
    if (r.best && !r.passes) {
      const least = Math.min(...r.candidates.filter((c) => c.possible).map((c) => c.deltaE));
      assert.equal(r.best.deltaE, least);
    }
  }
  assert.ok(checked > 300, `only ${checked} suggestions checked`);
});

test('property: hex answers keep the OKLCH hue of saturated colors to within rounding', () => {
  const random = rng(77);
  let checked = 0;
  for (let i = 0; i < 300; i++) {
    const rgb = [random(), random(), random()];
    const [, C, h] = rgbToOklch(rgb);
    if (C < 0.08) continue;
    for (const bg of ['white', '#121212']) {
      const r = suggest(parseColor(hexOf(rgb)), parseColor(bg), { target: 4.5 });
      if (r.passes || !r.best) continue;
      const [, C2, h2] = rgbToOklch(r.best.rgb);
      if (C2 < 0.05) continue;
      const drift = Math.abs(((h2 - h + 540) % 360) - 180);
      assert.ok(drift < 2.5, `${hexOf(rgb)} on ${bg} -> ${r.best.text}: hue moved ${drift.toFixed(2)} degrees`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('grid is symmetric with ones on the diagonal', () => {
  const colors = ['navy', 'gold', 'white', 'black', '#e63946'].map(parseColor);
  const m = grid(colors);
  m.forEach((row, i) => row.forEach((r, j) => {
    assert.equal(r, m[j][i]);
    if (i === j) assert.equal(r, 1);
  }));
  assert.equal(m[2][3], 21);
});

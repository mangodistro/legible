import { ColorError, NOTATIONS, displayRgb, hexOf, inGamut, parseColor } from './color.js';
import { LEVELS, canonicalText, composite, formatRatio, grid, suggest } from './contrast.js';

export const VERSION = '1.0.0';

export const HELP = `legible: check WCAG 2 contrast between two CSS colors, and find the
nearest color that passes when they don't.

Usage:
  legible [check] FG BG    the ratio, which WCAG levels pass, and the nearest
                           darker and lighter colors that reach the target
  legible fix FG BG        print only the nearest passing color
  legible grid COLOR...    the ratio of every pair in a palette

Colors are CSS: #rgb, #rrggbb, #rrggbbaa, bare hex (777, 1d3557), rgb(),
hsl(), hwb(), lab(), lch(), oklab(), oklch(), named colors, transparent.
Quote anything with '#', spaces or parentheses. A translucent foreground is
blended over the background the way a browser blends it; the background
must be opaque.

Options:
  -t, --target T     ratio to reach: aa (4.5, the default), aa-large (3),
                     aaa (7), aaa-large (4.5), ui (3), or a number like 5.5
  -m, --move fg|bg   which color to change (default fg)
  -d, --direction D  auto (default), darker or lighter
  -f, --format F     notation for suggestions: same (default: the notation
                     you typed), hex, rgb, hsl, hwb, lab, lch, oklab, oklch
      --json         print JSON
      --color        always show color samples
      --no-color     never show them (also NO_COLOR, or output not a terminal)
  -h, --help         show this help
  -V, --version      show the version

Exit status:
  0  check: the pair reaches the target; fix: a color was printed;
     grid: always, once every color has been read
  1  check: it does not; fix: no color on the search path reaches it
  2  bad arguments, or a color that cannot be read
`;

class UsageError extends Error {}

const TARGETS = { aa: 4.5, 'aa-large': 3, aaa: 7, 'aaa-large': 4.5, ui: 3 };
const TARGET_NAMES = {
  aa: 'AA normal text', 'aa-large': 'AA large text', aaa: 'AAA normal text',
  'aaa-large': 'AAA large text', ui: 'AA UI components',
};

function parseTarget(text) {
  const key = text.toLowerCase();
  if (Object.hasOwn(TARGETS, key)) return { ratio: TARGETS[key], name: TARGET_NAMES[key] };
  const m = /^(\d+(?:\.\d+)?|\.\d+)(?::1)?$/.exec(text);
  if (!m) throw new UsageError(`--target is aa, aa-large, aaa, aaa-large, ui or a ratio, not '${text}'`);
  const ratio = parseFloat(m[1]);
  if (ratio < 1 || ratio > 21) throw new UsageError(`a contrast ratio is between 1 and 21, not ${text}`);
  return { ratio, name: null };
}

const VALUED = {
  '-t': 'target', '--target': 'target', '-m': 'move', '--move': 'move',
  '-d': 'direction', '--direction': 'direction', '-f': 'format', '--format': 'format',
};
const CHOICES = {
  move: ['fg', 'bg'],
  direction: ['auto', 'darker', 'lighter'],
  format: ['same', ...NOTATIONS],
};

export function parseArgs(argv) {
  const opts = { target: 'aa', move: 'fg', direction: 'auto', format: 'same', json: false, color: null, help: false, version: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUED[name]) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      opts[VALUED[name]] = value;
      continue;
    }
    if (name !== arg) throw new UsageError(`${name} does not take a value`);
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-V' || arg === '--version') opts.version = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--color') opts.color = true;
    else if (arg === '--no-color') opts.color = false;
    else throw new UsageError(`unknown option ${arg}`);
  }
  for (const [key, allowed] of Object.entries(CHOICES)) {
    opts[key] = opts[key].toLowerCase();
    if (!allowed.includes(opts[key])) {
      throw new UsageError(`--${key} is one of ${allowed.join(', ')}, not '${opts[key]}'`);
    }
  }
  opts.target = parseTarget(opts.target);
  let command = 'check';
  if (['check', 'fix', 'grid'].includes(positional[0])) command = positional.shift();
  return { command, colors: positional, opts };
}

// ------------------------------------------------------------------ output

const byte = (c) => Math.round(c * 255);
const sgr = (rgb, layer) => `\x1b[${layer};2;${rgb.map(byte).join(';')}m`;
const RESET = '\x1b[0m';

function paint(text, fgRgb, bgRgb, on) {
  return on ? `${sgr(bgRgb, 48)}${sgr(fgRgb, 38)}${text}${RESET}` : text;
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const lpad = (s, n) => ' '.repeat(Math.max(0, n - s.length)) + s;
const pct = (alpha) => `${Number((alpha * 100).toFixed(1))}%`;

// What a color resolves to, when that is not obvious from how it was typed.
function resolved(color, shownRgb, blended) {
  const notes = [];
  if (!inGamut(color.rgb)) notes.push(`outside sRGB, mapped to ${hexOf(displayRgb(color))}`);
  if (blended) notes.push(`${pct(color.alpha)} opaque, shows as ${hexOf(blended)}`);
  if (notes.length) return notes.join('; ');
  const hex = hexOf(shownRgb);
  return canonicalText(color).toLowerCase() === hex ? '' : hex;
}

function describeTarget(target) {
  return target.name ? `${formatRatio(target.ratio)} (${target.name})` : formatRatio(target.ratio);
}

// The far end of a search direction, as words: where it gave up.
function endName(kind, alpha) {
  if (kind === 'opacity') return 'full opacity';
  const end = kind === 'darker' ? 'black' : 'white';
  return alpha < 1 ? `${end} at ${pct(alpha)}` : end;
}

function candidateLine(c, alpha, width, sample, mark) {
  const kind = pad(c.kind, 8);
  if (!c.possible) return `  ${kind} none: ${endName(c.kind, alpha)} gives ${formatRatio(c.best)}`;
  const dE = `dE00 ${lpad(c.deltaE.toFixed(2), 5)}`;
  return `  ${kind} ${pad(c.text, width)}  ${lpad(formatRatio(c.ratio), 7)}   ${dE}${sample ? `   ${sample}` : ''}${mark ? '   smallest change' : ''}`;
}

function runCheck(fg, bg, opts, out, colorOn) {
  const fgRgb = displayRgb(fg);
  const bgRgb = displayRgb(bg);
  const result = suggest(fg, bg, { target: opts.target.ratio, move: opts.move, notation: opts.format, direction: opts.direction });
  const shown = composite(fgRgb, fg.alpha, bgRgb);

  if (opts.json) {
    out(`${JSON.stringify(checkJson(fg, bg, shown, result, opts), null, 2)}\n`);
    return result.passes ? 0 : 1;
  }

  const fgText = canonicalText(fg);
  const bgText = canonicalText(bg);
  const width = Math.max(fgText.length, bgText.length) + 2;
  const lines = [
    `foreground  ${pad(fgText, width)}${resolved(fg, fgRgb, fg.alpha < 1 && shown)}`.trimEnd(),
    `background  ${pad(bgText, width)}${resolved(bg, bgRgb, null)}`.trimEnd(),
    `contrast    ${formatRatio(result.ratio)}${colorOn ? `   ${paint(' Sample text ', shown, bgRgb, true)}` : ''}`,
    '',
  ];
  for (const level of LEVELS) {
    lines.push(`  ${pad(level.label, 34)} ${lpad(formatRatio(level.ratio), 7)}  ${result.ratio >= level.ratio ? 'pass' : 'fail'}`);
  }
  lines.push('');
  if (result.passes) {
    lines.push(`passes ${describeTarget(opts.target)}`);
  } else {
    const who = opts.move === 'fg' ? 'foreground' : 'background';
    lines.push(`nearest ${who} reaching ${describeTarget(opts.target)}:`);
    const possible = result.candidates.filter((c) => c.possible);
    const width = Math.max(0, ...possible.map((c) => c.text.length));
    for (const c of result.candidates) {
      let sample = null;
      if (colorOn && c.possible) {
        sample = opts.move === 'fg'
          ? paint(' Sample text ', composite(c.rgb, c.alpha, bgRgb), bgRgb, true)
          : paint(' Sample text ', composite(fgRgb, fg.alpha, c.rgb), c.rgb, true);
      }
      const mark = possible.length > 1 && c === result.best;
      lines.push(candidateLine(c, opts.move === 'fg' ? fg.alpha : 1, width, sample, mark));
    }
    if (!result.best) {
      const other = opts.move === 'fg' ? 'background' : 'foreground';
      lines.push('', `no ${who} on this ${other} reaches it; try --move ${opts.move === 'fg' ? 'bg' : 'fg'} or a lower --target`);
    }
  }
  out(`${lines.join('\n')}\n`);
  return result.passes ? 0 : 1;
}

function colorJson(color, rgb) {
  return { input: color.text, hex: hexOf(rgb), alpha: color.alpha };
}

function checkJson(fg, bg, shown, result, opts) {
  const levels = Object.fromEntries(LEVELS.map((l) => [l.id, result.ratio >= l.ratio]));
  return {
    foreground: { ...colorJson(fg, displayRgb(fg)), shown: hexOf(shown) },
    background: colorJson(bg, displayRgb(bg)),
    ratio: result.ratio,
    target: opts.target.ratio,
    passes: result.passes,
    levels,
    move: opts.move,
    suggestions: result.candidates.map((c) => (c.possible
      ? { kind: c.kind, color: c.text, hex: hexOf(c.rgb), alpha: c.alpha, ratio: c.ratio, deltaE2000: c.deltaE }
      : { kind: c.kind, color: null, best: c.best })),
    best: result.best && !result.passes ? result.best.text : null,
  };
}

function runFix(fg, bg, opts, out, err) {
  const result = suggest(fg, bg, { target: opts.target.ratio, move: opts.move, notation: opts.format, direction: opts.direction });
  if (opts.json) {
    const best = result.best;
    out(`${JSON.stringify({
      color: best ? best.text : null,
      changed: Boolean(best) && !result.passes,
      kind: best ? best.kind : null,
      ratio: best ? best.ratio : result.ratio,
      deltaE2000: best ? best.deltaE : null,
      target: opts.target.ratio,
    }, null, 2)}\n`);
    return best ? 0 : 1;
  }
  if (!result.best) {
    const who = opts.move === 'fg' ? 'foreground' : 'background';
    const alpha = opts.move === 'fg' ? fg.alpha : 1;
    const ends = result.candidates.map((c) => `${endName(c.kind, alpha)} gives ${formatRatio(c.best)}`);
    err(`legible: no ${who} reaches ${describeTarget(opts.target)}: ${ends.join(', ')}\n`);
    return 1;
  }
  out(`${result.best.text}\n`);
  return 0;
}

function gridTag(ratio) {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'lg';
  return '';
}

function runGrid(colors, opts, out, colorOn) {
  const ratios = grid(colors);
  if (opts.json) {
    out(`${JSON.stringify({ colors: colors.map((c) => colorJson(c, displayRgb(c))), ratios }, null, 2)}\n`);
    return 0;
  }
  const rgbs = colors.map(displayRgb);
  const labels = colors.map((c, i) => `${i + 1}  ${canonicalText(c)}`);
  const width = Math.max(...labels.map((l) => l.length)) + 2;
  const cell = 11;
  const lines = [(pad('', width) + colors.map((_, j) => lpad(`${j + 1}`, 6) + ' '.repeat(cell - 6)).join('')).trimEnd()];
  ratios.forEach((row, i) => {
    let line = pad(labels[i], width);
    row.forEach((r, j) => {
      const text = i === j ? pad(lpad('-', 6), cell) : pad(`${lpad(formatRatio(r).slice(0, -2), 6)} ${gridTag(r)}`, cell);
      line += i === j || !colorOn ? text : paint(text, rgbs[i], rgbs[j], true);
    });
    lines.push(line.trimEnd());
  });
  lines.push('', 'AAA  7 or more: any text', 'AA   4.5 or more: normal text at AA, large text at AAA', 'lg   3 or more: large text and UI components at AA only');
  out(`${lines.join('\n')}\n`);
  return 0;
}

export function main(argv, { stdout, stderr, env = {}, isTTY = false }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(`legible: ${e.message}\nTry 'legible --help'.\n`);
    return 2;
  }
  const { command, colors, opts } = parsed;
  if (opts.help) {
    stdout(HELP);
    return 0;
  }
  if (opts.version) {
    stdout(`legible ${VERSION}\n`);
    return 0;
  }
  const colorOn = opts.color ?? (isTTY && !env.NO_COLOR);
  try {
    if (command === 'grid') {
      if (colors.length < 2) throw new UsageError('grid needs at least two colors');
    } else if (colors.length !== 2) {
      throw new UsageError(`${command} needs a foreground and a background color, got ${colors.length}`);
    }
    const parsedColors = colors.map(parseColor);
    if (command === 'grid') {
      const translucent = parsedColors.find((c) => c.alpha < 1);
      if (translucent) throw new ColorError(`grid colors must be opaque: '${translucent.text}' is not`);
      return runGrid(parsedColors, opts, stdout, colorOn);
    }
    const [fg, bg] = parsedColors;
    if (bg.alpha < 1) {
      throw new ColorError(`the background must be opaque: what shows through '${bg.text}' is unknown`);
    }
    if (command === 'fix') return runFix(fg, bg, opts, stdout, stderr);
    return runCheck(fg, bg, opts, stdout, colorOn);
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`legible: ${e.message}\nTry 'legible --help'.\n`);
      return 2;
    }
    if (e instanceof ColorError) {
      stderr(`legible: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

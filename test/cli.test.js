import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HELP, VERSION, main } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/legible.js', import.meta.url));

function run(args, { isTTY = false, env = {} } = {}) {
  let stdout = '';
  let stderr = '';
  const code = main(args, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; }, isTTY, env });
  return { code, stdout, stderr };
}

test('--help and --version print and exit 0', () => {
  assert.deepEqual(run(['--help']), { code: 0, stdout: HELP, stderr: '' });
  assert.equal(run(['-h']).stdout, HELP);
  assert.equal(run(['--version']).stdout, `legible ${VERSION}\n`);
  assert.match(HELP, /Exit status:/);
});

test('check: a failing pair exits 1 and names the nearest passing colors', () => {
  const r = run(['777', 'white']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^contrast {4}4\.47:1$/m);
  assert.match(r.stdout, /AA {3}normal text +4\.50:1 {2}fail/);
  assert.match(r.stdout, /AA {3}large text +3\.00:1 {2}pass/);
  assert.match(r.stdout, /darker +#767676 +4\.54:1 +dE00 +0\.40/);
  assert.match(r.stdout, /lighter +none: white gives 1\.00:1/);
  assert.equal(r.stderr, '');
});

test('check is the default command, and a passing pair exits 0', () => {
  const r = run(['check', '#1d3557', '#f1faee']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /passes 4\.50:1 \(AA normal text\)/);
  assert.equal(run(['#1d3557', '#f1faee']).stdout, r.stdout);
});

test('check: translucent and out-of-gamut colors say what they show as', () => {
  const r = run(['rgba(0, 0, 0, 0.4)', 'white']);
  assert.match(r.stdout, /40% opaque, shows as #999999/);
  assert.match(r.stdout, /darker +none: black at 40% gives 2\.84:1/);
  assert.match(r.stdout, /opacity +rgba\(0, 0, 0, 0\.54\) +4\.58:1/);
  assert.match(run(['oklch(0.7 0.35 145)', 'white']).stdout, /outside sRGB, mapped to #[0-9a-f]{6}/);
});

test('check: the smallest change is marked when several are possible', () => {
  const r = run(['#808080', '#888', '-t', '3']);
  assert.equal((r.stdout.match(/smallest change/g) || []).length, 1);
});

test('check: an impossible target says so and suggests what to change instead', () => {
  const r = run(['white', '#777', '--target', 'aaa']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /darker +none: black gives 4\.68:1/);
  assert.match(r.stdout, /try --move bg or a lower --target/);
});

test('fix prints only the color, so it can be captured', () => {
  assert.deepEqual(run(['fix', '777', 'white']), { code: 0, stdout: '#767676\n', stderr: '' });
  assert.equal(run(['fix', '#767676', 'white']).stdout, '#767676\n');
  assert.equal(run(['fix', '777', 'white', '--format', 'oklch']).stdout, 'oklch(0.5676 0 0)\n');
  assert.equal(run(['fix', 'rgba(0,0,0,.4)', 'white']).stdout, 'rgba(0, 0, 0, 0.54)\n');
  assert.equal(run(['fix', '777', 'white', '--move', 'bg', '--direction', 'darker']).code, 0);
});

test('fix: no passing color exits 1 with the reason on stderr', () => {
  const r = run(['fix', 'white', '#777', '-t', 'aaa']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'legible: no foreground reaches 7.00:1 (AAA normal text): black gives 4.68:1, white gives 4.47:1\n');
});

test('--json for check, fix and grid', () => {
  const check = JSON.parse(run(['--json', '777', 'white']).stdout);
  assert.equal(check.passes, false);
  assert.equal(check.best, '#767676');
  assert.equal(check.levels['aa-large'], true);
  assert.equal(check.suggestions[0].kind, 'darker');
  assert.equal(check.suggestions[1].color, null);
  assert.ok(Math.abs(check.ratio - 4.478) < 1e-3);
  const fix = JSON.parse(run(['fix', '--json', '777', 'white']).stdout);
  assert.equal(fix.color, '#767676');
  assert.equal(fix.changed, true);
  const unchanged = JSON.parse(run(['fix', '--json', '#1d3557', 'white']).stdout);
  assert.equal(unchanged.changed, false);
  const g = JSON.parse(run(['grid', '--json', 'black', 'white']).stdout);
  assert.deepEqual(g.ratios, [[1, 21], [21, 1]]);
  assert.equal(g.colors[1].hex, '#ffffff');
});

test('grid prints a matrix with level tags', () => {
  const r = run(['grid', 'navy', 'gold', 'white']);
  assert.equal(r.code, 0);
  const lines = r.stdout.split('\n');
  // navy on white is 16.0098: truncated, not rounded
  assert.match(lines[1], /^1 {2}navy +- +11\.41 AAA +16\.00 AAA$/);
  assert.match(lines[2], /^2 {2}gold +11\.41 AAA +- +1\.40$/);
  assert.match(r.stdout, /lg {3}3 or more/);
});

test('option forms: --opt=value, ratios with :1, case-insensitive choices', () => {
  assert.equal(run(['777', 'white', '--target=aaa']).code, 1);
  assert.match(run(['777', 'white', '-t', '4.4']).stdout, /passes 4\.40:1$/m);
  assert.match(run(['777', 'white', '-t', '4.4:1']).stdout, /passes 4\.40:1$/m);
  // hsl() is not rounded to bytes: the lightest one-decimal gray that passes
  assert.equal(run(['fix', '777', 'WHITE', '-f', 'HSL']).stdout, 'hsl(0 0% 46.5%)\n');
  assert.equal(run(['hsl(0 0% 46.6%)', 'white']).code, 1);
  assert.equal(run(['--', '777', 'white']).code, 1);
});

test('usage errors exit 2 with a message on stderr', () => {
  const cases = [
    [['fix'], /fix needs a foreground and a background color, got 0/],
    [['777', 'white', 'black'], /check needs a foreground and a background color, got 3/],
    [['grid', 'red'], /grid needs at least two colors/],
    [['777', 'white', '--frobnicate'], /unknown option --frobnicate/],
    [['777', 'white', '--target'], /--target needs a value/],
    [['777', 'white', '-t', '25'], /between 1 and 21/],
    [['777', 'white', '-t', 'gold'], /--target is aa, aa-large/],
    [['777', 'white', '--move', 'up'], /--move is one of fg, bg, not 'up'/],
    [['777', 'white', '--json=yes'], /--json does not take a value/],
    [['zzz', 'white'], /not a color: 'zzz'/],
    [['rgb(1 2)', 'white'], /rgb\(\) needs 3 channels, got 2/],
    [['777', '#fff8'], /the background must be opaque/],
    [['grid', '777', 'rgba(0, 0, 0, 0.5)'], /grid colors must be opaque/],
  ];
  for (const [args, message] of cases) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
  }
});

test('color samples: on for a terminal, off for pipes, NO_COLOR and --no-color', () => {
  const esc = /\x1b\[48;2;255;255;255m\x1b\[38;2;119;119;119m Sample text \x1b\[0m/;
  assert.match(run(['777', 'white'], { isTTY: true }).stdout, esc);
  assert.doesNotMatch(run(['777', 'white']).stdout, /\x1b/);
  assert.doesNotMatch(run(['777', 'white'], { isTTY: true, env: { NO_COLOR: '1' } }).stdout, /\x1b/);
  assert.doesNotMatch(run(['777', 'white', '--no-color'], { isTTY: true }).stdout, /\x1b/);
  assert.match(run(['777', 'white', '--color']).stdout, esc);
  // grid cells are painted in their own pair of colors
  assert.match(run(['grid', 'navy', 'gold', '--color']).stdout, /\x1b\[48;2;255;215;0m\x1b\[38;2;0;0;128m/);
});

test('the installed binary runs, with exit codes and streams intact', () => {
  const ok = spawnSync(process.execPath, [BIN, 'fix', '777', 'white'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '#767676\n');
  const fail = spawnSync(process.execPath, [BIN, '777', 'white'], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.doesNotMatch(fail.stdout, /\x1b/);
  const bad = spawnSync(process.execPath, [BIN, 'nope', 'white'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, "legible: not a color: 'nope'\n");
});

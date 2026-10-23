# legible

Check the WCAG 2 contrast ratio between two CSS colors and, when they fail,
find the nearest color that passes. It keeps the hue, writes the answer back
in the notation you typed, and re-measures that exact text before printing it.

```
$ legible 777 white
foreground  #777   #777777
background  white  #ffffff
contrast    4.47:1

  AA   normal text                    4.50:1  fail
  AA   large text                     3.00:1  pass
  AAA  normal text                    7.00:1  fail
  AAA  large text                     4.50:1  fail
  AA   UI components and graphics     3.00:1  pass

nearest foreground reaching 4.50:1 (AA normal text):
  darker   #767676   4.54:1   dE00  0.40
  lighter  none: white gives 1.00:1
```

In a terminal, the contrast line and each suggestion also get a sample of
text drawn in the real colors.

## Why

A contrast checker tells you that `#4a90e2` on white is 3.29:1, and then you
drag a lightness slider until the number turns green. That loop has two
faults. If the slider is HSL lightness, the hue wanders as you drag, because
HSL is not perceptual. And the green light is for the slider's exact
position: the hex you copy is rounded, and about half of all exact boundary
colors round to a hex that fails again.

legible walks a line that holds perceived hue, and measures the text it is
about to print. It is for the moment an audit flags a color and you want the
closest version of that color that passes, in a form you can paste back into
the stylesheet.

## Install

Needs Node 18 or later. There are no dependencies.

```
git clone https://github.com/mangodistro/legible.git
cd legible
npm install -g .
```

Or skip the install and run `node bin/legible.js`.

## Usage

```
legible [check] FG BG    the ratio, which WCAG levels pass, and the nearest
                         darker and lighter colors that reach the target
legible fix FG BG        print only the nearest passing color
legible grid COLOR...    the ratio of every pair in a palette
```

Colors are CSS: hex in all four lengths, `rgb()`, `hsl()`, `hwb()`, `lab()`,
`lch()`, `oklab()`, `oklch()`, the 148 named colors and `transparent`, in both
the comma and the space-separated syntax. An unquoted `#777` starts a shell
comment, so bare hex (`777`, `1d3557`) is accepted too. Anything with `#`,
spaces or parentheses needs quotes.

`--target` takes `aa` (4.5, the default), `aa-large` (3), `aaa` (7),
`aaa-large` (4.5), `ui` (3, for SC 1.4.11 non-text contrast) or a number.

### Dark backgrounds

```
$ legible '#4a90e2' '#1e1e1e' --target aaa
foreground  #4a90e2
background  #1e1e1e
contrast    5.06:1

  AA   normal text                    4.50:1  pass
  AA   large text                     3.00:1  pass
  AAA  normal text                    7.00:1  fail
  AAA  large text                     4.50:1  pass
  AA   UI components and graphics     3.00:1  pass

nearest foreground reaching 7.00:1 (AAA normal text):
  darker   none: black gives 1.25:1
  lighter  #65abff   7.00:1   dE00  8.44
```

`dE00` is the CIEDE2000 difference between what was on screen before and
after. The usual rule of thumb puts a just-noticeable difference at about 1.

### Answers in your notation

`fix` prints one color and nothing else, written the way the input was:

```
$ legible fix 'hsl(210 80% 60%)' white
hsl(208.8 69.7% 46.3%)
$ legible fix 'oklch(0.7 0.15 250)' white
oklch(0.568 0.15 250)
$ legible fix '#FF6B6B' white
#D34347
$ legible fix '#ff6b6b' white --format oklch
oklch(0.5896 0.1812 22.84)
```

Hex keeps its case, `rgba(0, 0, 0, .5)` keeps its commas and its alpha
spelling, and a percentage lightness in `oklch()` stays a percentage. The
`hsl()` answer has a different HSL hue from the input; the design notes say
why.

### Translucent text

A translucent foreground is blended over the background before anything is
measured. Changing lightness keeps the alpha, and when no lightness can work
at that alpha, raising the opacity is offered instead:

```
$ legible 'rgba(0, 0, 0, 0.4)' white
foreground  rgba(0, 0, 0, 0.4)  40% opaque, shows as #999999
background  white               #ffffff
contrast    2.84:1

  AA   normal text                    4.50:1  fail
  AA   large text                     3.00:1  fail
  AAA  normal text                    7.00:1  fail
  AAA  large text                     4.50:1  fail
  AA   UI components and graphics     3.00:1  fail

nearest foreground reaching 4.50:1 (AA normal text):
  darker   none: black at 40% gives 2.84:1
  lighter  none: white at 40% gives 1.00:1
  opacity  rgba(0, 0, 0, 0.54)   4.58:1   dE00 12.87
```

### Moving the background

```
$ legible '#f4b942' white --move bg
...
nearest background reaching 4.50:1 (AA normal text):
  darker   #505050   4.55:1   dE00 52.91
  lighter  none: white gives 1.76:1
```

`--direction darker` or `--direction lighter` restricts the search to one
side. Without it, `fix` and the `smallest change` mark pick whichever
candidate has the lowest `dE00`.

### Palettes

```
$ legible grid 1b2a41 3a7ca5 d9dcd6 f4b942 white
                 1          2          3          4          5
1  #1b2a41       -       3.16 lg   10.42 AAA   8.15 AAA  14.44 AAA
2  #3a7ca5    3.16 lg       -       3.29 lg    2.57       4.55 AA
3  #d9dcd6   10.42 AAA   3.29 lg       -       1.27       1.38
4  #f4b942    8.15 AAA   2.57       1.27          -       1.76
5  white     14.44 AAA   4.55 AA    1.38       1.76          -

AAA  7 or more: any text
AA   4.5 or more: normal text at AA, large text at AAA
lg   3 or more: large text and UI components at AA only
```

With `--color`, or in a terminal, each cell is drawn in its row color on its
column color.

### Scripts and CI

| exit | `check` | `fix` |
|---|---|---|
| 0 | the pair reaches the target | a color was printed (the input itself if it already passes) |
| 1 | it does not | no color on the search line reaches the target |
| 2 | bad arguments or an unreadable color | same |

```
$ legible fix white '#777' -t aaa; echo $?
legible: no foreground reaches 7.00:1 (AAA normal text): black gives 4.68:1, white gives 4.47:1
1
$ legible fix 777 white --json
{
  "color": "#767676",
  "changed": true,
  "kind": "darker",
  "ratio": 4.542224959605253,
  "deltaE2000": 0.3973884752153853,
  "target": 4.5
}
```

`check` and `grid` take `--json` as well.

## How the search works

1. Both colors are parsed. A color outside sRGB, such as `oklch(0.7 0.35 145)`,
   is gamut-mapped with the CSS Color 4 algorithm, since that is what the spec
   says gets painted. A translucent foreground is blended over the background
   in gamma-encoded sRGB, as browsers do.
2. The color being moved is converted to OKLCH. Its hue is held and its
   lightness walked toward black (darker) and toward white (lighter). At each
   lightness it keeps its chroma if sRGB can show it, and otherwise the most
   chroma that fits.
3. Each direction is bisected for the lightness where the ratio reaches the
   target. If black or white cannot reach it, that direction reports how far
   it got.
4. The candidate is printed in the output notation, parsed back by the same
   parser that reads input, and measured again. If rounding left it short of
   the target, the search steps further along the line and tries again.

## Design decisions

The measurements here come from `scripts/compare-paths.js`: 300 random colors
that fail 4.5:1 on white and are darkened, and 300 that fail on `#121212` and
are lightened. Grays are left out, since they have no hue to lose.

**Hue is held in OKLCH, not HSL.** OKLCH is built so that hue stays put while
lightness changes, and HSL is not. Walking HSL lightness moved the perceived
(OKLCH) hue by a median of 0.6° when darkening and 0.5° when lightening, but by
up to 11.3° and 14.0°. The worst darkening case is the pale cream `#fddeaf`.
HSL holds its 95% saturation, so darkening turns it into `#a96704`, a strong
orange-brown 11° away with nearly twice the chroma. legible gives `#8e7247`, a
muted tan with the original hue and chroma. Across both sets legible's answers
moved at most 1.95°, and all of that is rounding to 8 bits. The cost shows when
you type HSL. The answer keeps OKLCH hue, so its HSL numbers move:
`hsl(210 80% 60%)` comes back as `hsl(208.8 69.7% 46.3%)`. If your tokens are
one HSL hue at several lightnesses, the fix will not fit that scheme, even
though it looks closer to the original.

**The path reduces chroma instead of using CSS gamut mapping.** This was wrong
at first. The first version walked lightness through the CSS Color 4
gamut-mapping algorithm, because that is the standard way to bring an OKLCH
color into sRGB. That path moves hue, by up to 5.2° on the colors darkened on
white. The algorithm bisects on chroma, but it returns a clipped color as soon
as clipping lands within one just-noticeable difference (deltaEOK 0.02) of the
target, and clipping moves hue. For rendering that is a fair trade: it keeps
saturation, and nobody notices a few degrees on one color. For "this color,
darker" it is not. It darkened `#07a1d5`, a light cyan-blue, to `#007eb1`, 5.2°
toward blue, where legible now gives `#007faa`, 0.5° away. The search uses
plain chroma reduction instead: the most chroma that fits at that lightness and
hue, never clipped. The CSS algorithm still decides how an out-of-gamut input
is displayed. The expected cost was saturation, and it turned out small.
Measured as CIEDE2000 distance from the original, legible's answers are a
median 0.00 further than the CSS path's, at most 0.42, and sometimes closer.
Both sides of that comparison were checked to pass after rounding. An earlier
version of the script skipped that check for the CSS path, credited it with
colors that failed, and put the median at 0.15.

**Holding hue costs some distance, and that is accepted.** The nearest passing
color with no constraint at all was found by scanning all 16.7 million 8-bit
colors. The scan is pruned by a bound that cannot skip the answer: CIEDE2000's
cross term cannot make the chroma-and-hue part negative, so ΔE00 is at least
|ΔL| / 1.75. Darkening on white, legible's answer was a median 0.12 ΔE00
further than that color, and at most 0.52. Lightening on `#121212` has a longer
tail, with a median of 0.14 and a worst case of 3.64. That worst case is
`#0e07e5`, a saturated blue. legible gives `#3f72ff` at the same hue; the
unconstrained nearest is `#835fff`, 23° toward violet. By CIEDE2000, that turn
toward violet costs less than holding the hue does. HSL lightness drifts the
same way, to `#6d69fa`, and also lands closer than legible. legible gives up
that distance in order to return the color you asked about, only lighter.

**It prints, reads back, then measures.** The exact boundary color rounds to a
failing hex 48.7% of the time when darkening on white, and 46.7% when
lightening on `#121212`. `#777` is the plainest case: the gray that gives
exactly 4.5:1 on white is 118.66/255, and that rounds to `#777777` at 4.478:1.
So nothing comes straight from the continuous search. Every candidate goes
through the formatter, then the parser, then the ratio again, and a property
test runs that over 600 random pairs across all the notations. The cost is that
an answer can sit one byte past the continuous optimum. It never falls short
of the target.

**Ratios are truncated, not rounded.** WCAG's thresholds are minimums, so
4.499:1 fails 4.5:1. It prints as `4.49:1`, where a rounded `4.50:1` would read
as a pass. The cost is that some ratios show one hundredth lower than in tools
that round: `#777` on white is 4.478, shown as 4.47.

**It reports ΔE00 but searches in OKLab.** CIEDE2000 has a scale people
already read, where about 1 is a just-noticeable difference, so the number
needs no explanation. OKLab is what makes hue hold along the path. The cost is
two color models in one tool. CIEDE2000 is also the fiddliest formula in it, so
it is tested against all 34 pairs in Sharma, Wu and Dalal's published data.

**It uses the CSS Color 4 OKLab matrices, inverted at load time.** This was
also wrong at first. With Björn Ottosson's original 10-digit matrices, white
lands at L = 0.9999999935, and with truncation that printed white on black as
`20.99:1`. His published inverses also miss being exact inverses by up to
3.7e-8. CSS Color 4 recomputed the matrices so that white maps to exactly
(1, 0, 0). legible uses those and inverts them itself, so every conversion
round-trips to within 1e-13. The sRGB and Bradford matrices are derived from
their defining chromaticities instead of pasted in.

**A translucent background is refused.** Its contrast depends on whatever
shows through it, and that is not in the input. A translucent foreground is
fine, because the background behind it is known.

**There are no dependencies.** Color.js and culori both do conversions and
gamut mapping well. legible carries its own so that it runs on Node alone, with
nothing to install. The cost is about 550 lines of color math that have to be
right without leaning on anyone else's. The tests check them against
published reference data, Ottosson's XYZ to OKLab table and the 34 CIEDE2000
pairs, and not against another implementation.

## Limitations

- WCAG 2 contrast ratio only. APCA is not implemented.
- sRGB only. Wider-gamut colors are mapped into sRGB before measuring, and
  `color(display-p3 ...)` is not parsed.
- It does not know your font size. WCAG's "large text" is at least 18pt, or
  14pt bold, and which one applies is your call.
- One color moves, along one line. When neither direction reaches the target
  it says so and suggests `--move` or a lower target. It does not move both
  colors at once.

## Tests

```
npm test
```

There are 53 tests on `node:test`. They cover the published reference data,
round trips through every notation, parsing and its error messages, and
seeded property tests: every suggestion reads back and passes, gray answers
are tight to one byte, and hue holds to within rounding. They also check the
CLI's output and exit codes, including through the real binary.

`node scripts/compare-paths.js` reproduces every measurement in the design
notes. It takes about 20 minutes and 400 MB.

## License

MIT

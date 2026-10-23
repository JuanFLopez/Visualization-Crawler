# d3-viz-crawler

Feed it any D3 visualization. It opens the page in a headless browser, clicks and
hovers over everything a user could, and discovers the **automaton** of the
visualization: its states (what the page looks like) and its transitions (which
interaction leads where). It then gives you

- `transitions.json`: the transition table, a **regex** that describes every
  sequence of interactions the visualization allows, and a report of anything
  suspicious;
- `automaton.svg`: the same automaton as a diagram.

You can also give it the regex you *expect* the visualization to follow. It
compares the two and reports every difference as an **unexpected behavior**: the
series of events that reproduces it.

```
node run.js examples/sunburst-amplio
```

## Contents

1. [Install](#install)
2. [Quick start](#quick-start)
3. [Command line](#command-line)
4. [Configuration](#configuration)
5. [What it explores](#what-it-explores)
6. [Output](#output)
7. [Comparing against an expected regex](#comparing-against-an-expected-regex)
8. [Using it as a module](#using-it-as-a-module)
9. [Diagnosing a visualization that does not converge](#diagnosing-a-visualization-that-does-not-converge)
10. [How it works](#how-it-works)
11. [The examples](#the-examples)
12. [Known limits](#known-limits)

## Install

```
cd main
npm install
npx playwright install chromium     # the browser the crawler drives
```

Developed and tested on Node 24; Playwright 1.63 needs Node 20 or newer. On Linux, if `@sparticuz/chromium` is installed (it is a dependency), its
bundled Chromium is used, which is what makes it work on a server or a lambda.

## Quick start

```
node run.js examples/sunburst-amplio                      # crawl a visualization
node run.js examples/hover-menu --regexFile examples/hover-menu/esperado.txt
node run.js --from examples/sunburst-amplio               # re-analyze a previous output, no browser
```

A visualization is a **folder with an `index.html`**. The crawler serves the
folder from a local server (so `d3.json` and relative URLs work) and never needs
you to modify your D3 code. By default the results are written next to the page.
Use `--out <folder>` to write somewhere else.

## Command line

```
node run.js <folder-with-index.html> [options]       crawl the visualization
node run.js --from <transitions.json|folder> [...]   re-analyze a previous output, without crawling
```

| Option | Meaning |
| --- | --- |
| `--regex "<expr>"` | the expected regex (see [below](#comparing-against-an-expected-regex)) |
| `--regexFile <file>` | the same, read from a file (avoids escaping `\|` and `*` in the shell) |
| `--regexPrefixes` | compare against the *prefixes* of the regex (if it describes complete interactions) |
| `--diffLimit <n>` | counterexamples to show per direction (default 10) |
| `--maxRegexLength <n>` | omit a regex longer than `n` characters and report where it blows up (default 500000; `0` = no limit) |
| `--traceRegex` | log the state-elimination trace, step by step |
| `--out <folder>` | where to save `transitions.json` and `automaton.svg` (default: the source folder) |
| `--no-write` | do not write files |
| `--json` | print the result as JSON on stdout (the messages go to stderr) |
| `--settleMs <ms>` | a FIXED real-time pause after every click (default: virtual time, see [How it works](#how-it-works)) |
| `--discoverySettleMs <ms>` | pause before listing the candidates of a newly visited state |
| `--maxStates <n>` | cap on the states to discover |
| `--maxSteps <n>` | hard cap on total interactions |
| `--containerSelector <css>` | restrict detection and state to this container, e.g. `"#sb"` |
| `--include-links` | do not exclude `<a>` / `[href]` from automatic detection |
| `--no-hover` | do not probe hovers (clicks only) |
| `--maxDelegated <n>` | cap on the marks probed per delegated listener (default 50; `0` = do not probe delegated ones) |
| `-h`, `--help` | the help text |

**Exit code:** `0` ok (or the expected regex matched), `1` error, `2` the expected
regex differs from what was observed, or some click breaks the page.

## Configuration

Most visualizations need nothing. When one does, put a `config.js` next to its
`index.html`; it exports an object with crawler options:

```js
// my-viz/config.js
module.exports = {
  containerSelector: '#chart',        // only look inside this element
  backSelector: 'circle.up',          // an element that always goes "up one level" (fast mode)
  maxStates: 500,
};
```

| Option | Meaning |
| --- | --- |
| `containerSelector` | CSS selector: restrict detection and state to this container |
| `backSelector` | CSS selector of an element that goes "up one level" (a breadcrumb, a zoom-out target). Enables **fast mode**: the crawler walks between states through their common ancestor and never reloads the page. Without it the crawler assumes nothing: it replays known transitions and, when it has to, reloads the page and replays the whole path. |
| `clickableSelector`, `hoverableSelector` | what counts as clickable / hoverable (default: what the crawler's instrumentation marked) |
| `settleMs`, `discoverySettleMs` | fixed waits instead of virtual time |
| `maxStates`, `maxSteps` | limits |
| `hover` | `false` to probe clicks only |
| `maxDelegated` | cap on marks probed per delegated listener |

The command-line flags override `config.js`. A `config.js` may also export any
other option of `crawl()` (see `crawler.js`), for example `stateKeyFn`.

If your page defines `window.__testState` (any value that identifies what is on
screen, such as the id of the selected node), the crawler uses it instead of its
automatic DOM fingerprint. This is the escape hatch for pages the fingerprint
cannot describe, such as a canvas.

## What it explores

The crawler finds interactive elements by watching `addEventListener` (what D3's
`selection.on` uses) and then tries them one at a time.

- **Clicks** on every element with a `click` listener (or an `onclick`).
  Elements that are hidden, covered, or outside the visible area are skipped, so a
  click is only tried where a real user could do it. Clicks on a partly visible
  element are reported (`partiallyVisibleClicks`), because they make the graph dense.
- **Hovers**, as `Hover_<element>`. A hover becomes an action only if it changes
  something visible, even a highlight; its effect is recorded. Hovers are found
  through listeners, `onmouseover`-style properties and attributes, CSS `:hover`
  rules (the state is forced in the browser, no mouse is moved), pointer-move
  listeners (tried at the center and at the edge of the element, with a warning
  when the effect depends on where it is aimed), and listeners delegated on a
  container (tried on the D3 marks inside it).
  - A hover that does nothing visible is **not** an action; it is listed in
    `hovers.ignored` with the reason.
  - A hover that only highlights or shows something is a loop on its state. One
    that opens something (a menu) leads to another state, and its way back is
    `Unhover_<element>`.
  - A hover that breaks the page leads to `__ERROR__` and is reported.
  - The browser's native tooltip (`<title>`, `title=""`) is ignored on purpose:
    the browser draws it with no listener and no DOM change, so its effect cannot
    be observed. The `<title>` text is still used to *name* actions.
- **Errors.** If an interaction makes the page throw, the transition goes to the
  special state `__ERROR__` and is reported as an unexpected behavior, with the
  shortest path that reproduces it.

Action names: `Click_<name>`, `Hover_<name>`, `Unhover_<name>`. The name comes from
the element's `data-name`, its `<title>`, `aria-label`, text, or the D3 datum bound
to it. The same element has the same name in every state. If an element is called
something different in each state (a sunburst's center circle is re-bound on every
click), it is renamed after its tag, for example `Click_circle`.

State names: when the data is hierarchical the states are named by their place in
the hierarchy, `root > vis > operator`, and the diagram's columns are the levels.
Otherwise a state is named by the click path that discovered it.

## Output

### `transitions.json`

| Key | Contents |
| --- | --- |
| `initialState` | the state the page starts in |
| `transitions` | `{ state: { action: next state } }`; a click that breaks the page leads to `__ERROR__` |
| `regex` | `cycleCut`: complete interactions with the cycles cut (the one the diagram shows). `language` and `completeInteractions`: the exact regexes. `cycles`: how many transitions are tree / back / shortcut edges, and the shortcuts. Each has a `*Meaning` text. A regex that grows too large is `null`, with a notice and an `explosion` diagnosis. |
| `visibility`, `partiallyVisibleClicks` | clicks on partly visible elements, with the visible fraction |
| `hovers` | each hover action with its observed effect (`changes`, `persistent`, `reveals`, `hides`, `positional`), and `ignored` hovers |
| `comparison` | only with an expected regex: which of the four candidate automata it matched, and the differences |
| `issues` | the unexpected behaviors, each as a series of events: `kind` (`error`, `missing` or `unexpected`), `message`, `detail`, `sequence`, `events`, `failingStep` |

The regex is written over *actions*, not characters: tokens are separated by
spaces, `|` is union, `*` `+` `?` `{n,m}` repetition, `( )` grouping and `()` the
empty string. "Complete interactions" are the sequences that end back at the
initial state, and every sequence the page allows is a prefix of one of them.

### `automaton.svg`

A layered diagram, left to right. Columns are levels of the hierarchy (or clicks
from the initial state). Solid arrows go forward with their label next to the
target; dashed arrows go back (label under the source); light-blue arcs stay in
the same column; green arrows are hover actions; `__ERROR__` is red; the series of
events of the first unexpected behavior is drawn in red. Hover over a state or an
edge in a browser for its full detail. The text blocks under the diagram show the
cut regex, the hover summary and any unexpected behavior.

## Comparing against an expected regex

Pass the regex you believe describes the visualization:

```
node run.js examples/sunburst-grande --regexFile examples/sunburst-grande/esperado.txt
```

The `Click_` prefix is optional: `vis circle` means `Click_vis Click_circle`.
The expected regex is compared with **four** automata: the full one and the one
with cycles cut, each as every performable prefix and as complete interactions.
It passes if it matches exactly one of them. Otherwise the report names the
closest and lists the differences: sequences the visualization allows and the
regex does not (`unexpected`), and sequences the regex admits and the
visualization does not offer (`missing`). Symbols the crawler never saw are
reported too, since they are usually typos. Use `--regexPrefixes` when your regex
describes complete interactions only.

## Using it as a module

```js
const { run } = require('./run');

const result = await run({
  vizDir: 'examples/sunburst-amplio',   // or fromTransitions: 'path/to/transitions.json'
  regex: '((vis | util) circle)*',      // optional
  onLog: (msg) => console.log(msg),
  onProgress: (p) => {},                // { elapsedMs, state, actions, knownStates }
});
```

`run()` writes nothing to the console and never ends the process: it reports
through the callbacks, throws an `Error` on a problem, and returns the result
(`transitions`, `regex`, `comparison`, `issues`, `hovers`, `svg`, `stats`,
`files`). The options and the result are documented in `run.js`. `run.js` also
exports `validateRegex(src)` (to flag syntax errors while a user types) and
`parseArgs(argv)`.

## Diagnosing a visualization that does not converge

```
node diagnose.js <folder-with-index.html> [waitMs=500] [rounds=5] [--containerSelector <css>]
```

Phase 1 reloads the page without touching anything and compares the state
fingerprints; if they differ it prints the first attribute that changed (an
animation that never repeats exactly, or something random). Phase 2 clicks the
first candidate that changes something and measures how long the page takes to
settle, or tells you that it never does (a continuous animation such as
`d3-force`). In that case define `window.__testState` by hand, capturing only what
logically matters.

## How it works

```
run.js ── crawler.js ──────────────► raw tables ──► lib/labels.js ──► lib/report ──► transitions.json
 │         │  (headless Chromium)                     (state names)     (regexes, comparison,     automaton.svg
 │         ├─ lib/crawl/   Node side: explore, navigate, probe hovers     issues, diagram)
 │         └─ lib/page/ + instrument.js   run inside the page
 └─ (--from skips the crawl and starts at lib/report)
```

- **State.** `instrument.js` is injected before your code. It fingerprints the
  visible attributes of everything under `<svg>` (positions, sizes, colors,
  classes; numbers rounded; hidden or off-screen elements count only as hidden),
  and that hash is the state. Two reloads of the same page must give the same
  state, or the crawler stops and tells you to run `diagnose.js`.
- **Virtual time.** The page clock is replaced with a fake one and advanced until
  the animation ends, so a 750 ms D3 transition costs a few real milliseconds and
  the result does not depend on the speed of the machine. The same crawl gives
  the same output every time.
- **Exploration.** Depth-first: every new state is expanded the moment it is
  discovered. A state is never expanded twice, which is what makes the crawl
  finish even when the real graph has cycles (`--maxSteps` is the safety net).
- **From automaton to regex.** The observed automaton is turned into a regex by
  state elimination. In dense graphs this grows exponentially, so the report
  also builds the regex of the automaton with its *shortcuts* cut (jumps to
  another branch), which keeps the shape of the hierarchy.

### Module map

| File | Role |
| --- | --- |
| `run.js` | entry point: command line and `run()` API |
| `crawler.js` | `crawl()`: wires the exploration together |
| `diagnose.js` | the diagnosis tool above |
| `instrument.js` | injected into the page: finds listeners, fingerprints the state, snapshots effects |
| `lib/crawl/` | session (the page), navigator, expand, hoverProbe, graph, naming, settle, gestures (also forces CSS `:hover` through DevTools) |
| `lib/page/` | functions that run inside the page: actionability, discovery, pointer. The `window.__crawler*` contract between the two halves is documented in `lib/page/index.js`. |
| `lib/report/` | builds `transitions.json` and the diagram input |
| `lib/regex/`, `lib/automaton.js` | regex parser and compiler, state elimination, the DFA type |
| `lib/cycles.js`, `lib/diff.js`, `lib/issues.js` | cycle cutting, language comparison, unexpected behaviors |
| `lib/diagram/` | layout and SVG |
| `lib/hovers.js`, `lib/cssHover.js`, `lib/actions.js`, `lib/labels.js` | hover semantics, `:hover` rule parser, action names, state names |
| `lib/host.js`, `lib/constants.js`, `lib/util.js` | the local server and Chromium; shared constants; small helpers |

## The examples

All of them are built with D3 and ship `d3.min.js`. Each folder contains the
generated `transitions.json` and `automaton.svg`; `esperado.txt` is the expected
regex of the ones that have one.

| Folder | What it shows |
| --- | --- |
| `sunburst-amplio` | zoomable sunburst over real data (32 states) |
| `sunburst-pequeno` | a small cut of the same data with a hover outline on every arc (10 states, 21 hover actions) |
| `sunburst-grande` | a small hand-made sunburst with 4 levels, where two rings are always visible below the focus, so a grandchild can be clicked directly (a two-level shortcut). Its `esperado.txt` matches. |
| `sunburst-grande-roto` | a variant of it checked against the same regex, which no longer matches: exits with code 2 by design |
| `sunburst-titulo` | the smallest sunburst (a root, two branches, two children each: 3 states) |
| `zoomable-circlepack` | zoomable circle packing (32 states, 31 hover actions) |
| `circlepack-pequeno` | a small cut of it (10 states) |
| `icicle-d3` | zoomable icicle over real data (252 states); clicking its root breaks the page, so it reports an error (exit 2). Takes about 25 s. |
| `icicle-pequeno` | a 22-state cut of the same page, with the same error edge |
| `hover-menu` | a menu that opens on hover: `( Hover_menu ( Unhover_menu \| (optionA \| optionB) reset ) )*` |
| `hover-phantoms` | three real hovers mixed with decoys that must NOT become actions |
| `hover-css` | hover effects done with CSS `:hover` rules, with decoys |
| `hover-inline` | handlers set as properties / attributes (`onmouseover=...`) |
| `hover-delegated` | one listener on the `<svg>` that reads `event.target.__data__` |
| `hover-move` | a tooltip that follows the pointer and a crosshair: positional effects |

To regenerate every example (this is what the committed outputs come from):

```
cd main
for ex in circlepack-pequeno icicle-d3 icicle-pequeno sunburst-amplio sunburst-pequeno \
          sunburst-titulo zoomable-circlepack; do node run.js examples/$ex; done
for ex in hover-css hover-delegated hover-inline hover-menu hover-move hover-phantoms sunburst-grande; do
  node run.js examples/$ex --regexFile examples/$ex/esperado.txt
done
node run.js examples/sunburst-grande-roto --regexFile examples/sunburst-grande/esperado.txt
```

`icicle-d3`, `icicle-pequeno` and `sunburst-grande-roto` exit with code 2: that is
the expected result for them.

## Known limits

- Only real DOM is seen: a `<canvas>` visualization exposes no attributes to
  fingerprint. Define `window.__testState` by hand.
- Listeners on `window` / `document`, effects on pseudo-elements (`::after`),
  `:hover` rules from a stylesheet of another origin (the browser does not let them
  be read), and effects that do not go through the DOM are not seen.
- Interactions other than click and hover (wheel zoom, drag, brush, double-click)
  are not modeled.
- A continuous animation (a running force simulation) never settles; use
  `window.__testState` to describe only what logically matters.
- A transition with a long `.delay()` sleeps through `setTimeout` without asking
  for animation frames; pass a fixed `--settleMs` for those.
- `<a>` / `[href]` elements are excluded by default, because clicking one can
  navigate away and bring the crawl down. Use `--include-links` if your
  visualization really uses links as part of its interaction.

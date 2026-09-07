# layout-lens

Renders a page in headless Chromium and prints derived layout facts as text a coding agent can
reason about. Ships as a CLI and as an MCP server. The agent it serves can already read the CSS, so
this exists to tell it what the browser actually did.

## The two rules everything else follows from

**Describe, never judge.** The tool states what is rendered. It does not decide that something is
wrong. A hardcoded script that plays critic is wrong on the next page it has never seen, and the
model reading the output is better at that call than any threshold. Findings carry numbers and let
the reader decide.

**Rendered results, never source styles.** Never read a computed style to decide what to say. Decide
from geometry, from what is painted, from where the glyphs landed. Saying `position: absolute` tells
the agent nothing it could not grep. Saying the box ends 22px past its parent does.

A finding earns its place when it helps the model **and** can be measured correctly. Guesses are
cut. `page looks still loading` was removed for exactly this reason.

## Where things are

| File | What it holds |
| --- | --- |
| `src/inspectLayout.ts` | The walk, serialized into `page.evaluate`. Almost every measurement lives here. |
| `src/inspectPage.ts` | Browser launch, page loading, the per-run loop, summary, since-last-run, across-runs. |
| `src/legend.ts` | The syntax reference. This is the only spec. |
| `src/cli.ts` | Flags, friendly errors. |
| `src/mcp.ts` | Three tools over stdio: `inspect_layout`, `screenshot_layout`, `layout_legend`. |
| `src/screenshotPage.ts`, `src/targetUrl.ts` | Screenshots, and turning a target into a url. |
| `scripts/check.ts` | `npm test`. Planted fragments across the fixtures. |
| `scripts/score.ts` | `npm run score [suite]`. Scores a planted suite against its manifest. |

`src/legend.ts` is the single source of truth for the output format. There is no separate spec
document, on purpose: two copies drifted, and one resync found 43 of 51 lines stale. Change the
behaviour and the legend in the same edit.

## Verifying a change

Run all of it. A change that improves one page usually costs another.

```
npx tsc -p tsconfig.json
npm test
npm run score
npm run score -- adversarial2
npm run score -- adversarial3
npm run build
```

Then the fixtures at 1280x720, and the builder pages at their own viewports: player 1440x900,
tickets 390x844, manual 820x1180, orders 1024x768, checkout 390x844, rtl-dashboard 390x844.

Count `[!!:` lines across `fixtures/agent-*.html` and `fixtures/experiment-*.html` before and after.
Noise growth needs a reason.

For anything touching findings, also run a few real sites, which is where the false positives have
always come from: news.ycombinator.com, stripe.com, developer.mozilla.org, apple.com,
github.com/microsoft/playwright.

## The planted suites

Three of them, `fixtures/adversarial{,2,3}/`, 24 pages each. Half plant one real rendered defect,
half look broken while being correct. Each `manifest.json` entry gives the viewport, the scroll, the
expected finding, and for a clean page what must not be said.

They exist to find bugs, not to be a target. Never weaken a rule to move a number, and never add an
exception list to make a page pass.

Recall is what matters. Precision counts only a clean page saying something forbidden, because a
tool whose job is to describe everything true cannot be penalised for describing something true. The
old definition counted every unplanted finding as a false positive and read 0.53 on a suite where a
hand audit found exactly one untrue statement.

Some misses are the manifest being wrong, not the tool. Say which when you report.

## Settled, do not reopen

- The `[!!: ...]` tag stays, numbers and all. It was nearly removed once. The owner's call: those
  findings are the most valuable part.
- Titled tags, `px` never written, one term per axis, block and inline vocabulary rather than
  top/left.
- The legend is a tool the model calls once, not a banner on every run.
- An ancestor clips. It never covers.
- Sizes and offsets are the rendered ones, transforms applied.
- Animations, including scroll-driven ones, finish before anything is measured.

## Where the bugs have come from

Every one of these was real, and the shape repeats.

- Box geometry read as visual geometry. Transparent image padding counted as covering. A screen
  reader label 1px wide reported as truncated text. An `svg`'s internal coordinates read as page
  layout.
- Comparisons that pair the wrong things. Siblings matched by their order among same-named elements,
  so one extra class on a seat shifted every seat after it.
- An amount measured as how far something reached rather than how much of it is hidden.
- Findings on parts of the page that are not visible, because coverage was sampled before clipping.
- Right to left. `start` and `end` mirror, gap lists do not sort themselves, and the near edge flips.

When a finding looks wrong, take a screenshot with `--screenshot` and read it before changing
anything.

## Open

Every bug in `notes/static-review.md` is fixed, and its proof pages are still the fastest way to
check none of them come back. `notes/perf-design.md` still has the ranked passes nobody has touched
below the top few. `notes/coverage.md` is the printable-things matrix behind the note below.

- The suites are softer than their scores read. `scoreCleanPage` ignores `expect`, so a clean page's
  tag claims assert nothing, and the phrase match passes on enough words that an impossible
  expectation still scores a hit. Of 139 printable things, 29 can be produced by nothing at all and
  95 would break with no test noticing. The matrix is worth rebuilding before trusting a number.
- No suite runs in dark, at more than one width, or in right-to-left while scrolled. The manifest
  has no scheme field.

- The report is read by a model that acts on it, so anything a page can put into it is an attack
  surface. Quoted text and element ids are sanitized. Check any new place page content reaches the
  output the same way, and keep the two injection fixtures passing.
- `screenshot_layout` will render any local file and hand back the picture, which is an arbitrary
  read when the caller is a model that just read a web page. The CLI is fine, a human typed the
  path. The server should default to the working directory and http, with a flag to widen it.
- The run cache is a predictable name in the shared temp directory, written without `O_NOFOLLOW`.
  What it holds is checked on read, but the write can still follow a symlink someone planted.
- The sibling and cousin passes still scan every sibling for every element. A trivial page takes
  0.8s and eight hundred rows take 3.9s, which is fine, but the shape is still quadratic and a page
  with thousands of siblings will feel it.
- A finding that repeats identically down a whole list should collapse to one line. MDN prints one
  layout convention 110 times.
- Wrapped inline elements. A span across two lines has a union rect that is not real geometry.
- Ink start and end, the inline-axis twin of ink top and bottom.
- Pseudo elements. The rect is only trustworthy when they are absolutely positioned.
- Closed shadow roots are guessed at.

## House rules

Read, Edit, Write for file changes, never `sed` or a heredoc. Never commit unless asked, and never
add attribution or a co-author trailer. Verbose names, braces always, comments short and plain or
absent. If something needs a hack to work, stop and name the gap instead of building it.

# layout-lens output coverage matrix

Built by reading `src/inspectLayout.ts`, `src/inspectPage.ts`, `src/cli.ts`, `src/legend.ts`,
`scripts/check.ts`, `scripts/score.ts` and the three manifests. Nothing was run.

## How to read the status column

The scorer is weaker than it looks, and this changes every number below.

- `scoreCleanPage` in `scripts/score.ts:148` **ignores `entry.expect` completely**. It only matches
  `mustNotReport` phrases against lines that already carry `[!!:`. So every `must be tagged
  [bleed 20]`, `must read [pos: ...]`, `must carry [scroll: x ...]` written on a **clean** page is
  prose. It asserts nothing. Delete the tag from the code and all 24 clean pages still pass.
- `scoreBugPage` does match a `[`-prefixed phrase against the whole tag part, so a tag expectation on
  a **bug** page is real.
- `scripts/check.ts` asserts fragments on 6 fixtures only: `navbar.html`, `cards.html`, `modal.html`,
  `shadow.html`, `similar.html`, `broken.html`. The other 24 top-level fixtures (`agent-*.html`,
  `experiment-*.html`, `scheme.html`) are run with **zero** expected fragments. They only prove the
  tool does not throw and does not leak element text into summary names.

Status values:

- **A** — asserted. A check.ts fragment, a bug-page phrase, or a `mustNotReport` phrase pins it.
- **S** — smoke. Some fixture renders it, nothing checks it. It can silently disappear.
- **N** — none. No fixture in any suite can produce it at all.
- **A-neg** — only ever asserted as a thing that must *not* appear. The positive form is untested.

## Legend vs code disagreements

The legend is described in CLAUDE.md as the single source of truth. It is stale in six places.

| # | Code produces | Legend |
| --- | --- | --- |
| 1 | `page 1292 wide, viewport 1280, caused by div#renew-tip.tip` — a header finding (`inspectLayout.ts:2698`) | Not mentioned anywhere. The legend lists the first line's parts and never says the page can carry this finding. It is probably the single most common real-page finding. |
| 2 | `font "Inter" not loaded, using Arial` (`inspectLayout.ts:633`) | Not mentioned. `[text]` says "font used" and stops. |
| 3 | `contrast unknown, transparent text` (`inspectLayout.ts:655`) | Only `contrast unknown, image behind` is documented. |
| 4 | `, redirected to <url>` appended to the first line (`inspectPage.ts:562`) | Not mentioned. |
| 5 | `contrast ~4.2` — the `~` prefix for an approximate background (`inspectLayout.ts:642`) | Not mentioned. The legend explains `contrast unknown` but not the tilde. |
| 6 | `[not painted: visibility hidden]` (`inspectLayout.ts:2382`) | Legend gives only `[not painted: opacity 0]`. Reads as the only reason. |

Not a disagreement but worth noting: the legend says `[gaps]` shows "twelve of them at most, …" — the
cap is on the rendered list after run-collapsing (`capList` runs on the output of `collapseRuns`), so
`24 ×30` counts as one entry, not thirty.

## The matrix

### First line (12)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `viewport WxH, scroll N` | S | every run, asserted by nothing |
| `page WxH, painted to N` | S | every run, asserted by nothing |
| `, scroll locked by X` | S | adversarial `clean-05-modal-backdrop` — but the claim is in `expect` on a clean page, so unasserted |
| `, status N` | N | no suite loads over http |
| `, dpr N` | S | every run |
| `, ltr, start is left` | S | every run |
| `, rtl, start is right` | S | adversarial2 bug-01/bug-06/clean-09, adversarial3 bug-12/clean-12 |
| `, light` | S | every run |
| `, dark` | **N** | no manifest entry and no check.ts fixture sets `scheme` |
| `, redirected to <url>` | N | local files only |
| `server answered N` | N | no http |
| `page N wide, viewport M, caused by X` | S | produced by adversarial3 `bug-08-tooltip-off-viewport-end` (page 1292), asserted by nothing |

### Failure-only output (2)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `could not load <target>: <reason>` | N | — |
| `could not launch chromium, run: npx playwright install chromium` | N | — |

### Names and line shape (9)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `tag#id.class "first four words" WxH` | A | every check.ts fragment |
| `#id` in the name | A | check.ts, all manifests |
| `.class`, two max, 24 chars max | A (2 classes) / N (24-char cut) | no fixture has a class over 24 chars |
| `:nth-child(N)` suffix | A | check.ts `shadow.html` — `x-card:nth-child(1)` |
| generated run stripped (`Header__xm1jd` → `Header`) | **N** | no fixture has a mangled class or id |
| css-module class unwrapped (`_card_1b0yp_73` → `card`) | **N** | same |
| name dropped entirely (`sc-6cc20e4a-0` → nothing) | **N** | same |
| shadow-host previews its shadow tree's words | A | check.ts `shadow.html` — `x-card:nth-child(1) "Card Slotted title new"` |
| mixed text+element preview uses flat text | S | many fixtures |

### Collapse forms (5)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `a › b` wrapper collapse | S | many fixtures, asserted by nothing |
| `… ›` wrapper chain cap (over 3 links) | N | no fixture nests 5 single-child wrappers |
| `×N` identical siblings | S | produced widely, asserted by nothing |
| `×N similar` | A | check.ts `similar.html` — `×5 similar` |
| findings-only pruned tree | **N** | nothing passes `findingsOnly` |

### Tags (30)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `[offscreen]` | **N** | no fixture parks anything at -10000px |
| `[sr-only]` | S | adversarial `clean-08-sr-only-heading` — `expect` only, unasserted |
| `[oversized]` | **N** | no fixture is over 100000px on an axis |
| `[shadow root]` | S | `shadow.html` (the tag itself is not in the fragment list) |
| `[shadow root skipped]` | **N** | nothing passes `shadow: false` / `--no-shadow` |
| `[shadow root closed]` | A | check.ts `shadow.html` — `x-secret 420x40 [shadow root closed]` |
| `[shadow]` | S | `shadow.html` |
| `[slotted]` | S | `shadow.html` |
| `[renders: background]` | S | everywhere |
| `[renders: border-top, border-left]` per-side form | S | 51 fixtures use one-sided borders |
| `[renders: shadow]` | S | many |
| `[renders: image]` | S | 19 fixtures have an `<svg>`; only 3 have an `<img>` |
| `[renders: ..., contrast N with behind]` | **N** | needs a wordless box under 3.0 against its backdrop; no fixture builds one |
| `[scroll: x N in M]` | S | adversarial `clean-07-chip-scroller`, adversarial2 `clean-02-marquee` — both clean, unasserted |
| `[scroll: y N in M]` | S | many |
| `[scroll: ..., bar N]` | S | same |
| `[scroll: ..., K of T children out]` | S | adversarial clean-07 (`N of 12 children out`), adversarial2 clean-02 (`N of 10`) — both clean, unasserted |
| `[pad: N]` / `[pad: N M]` / `[pad: a b c d]` | S | everywhere; the 4-value form unverified |
| `[rotated N°]` | S | 7 `agent-*` / `experiment-*` fixtures, none asserted |
| `[scaled N]` | S | adversarial `clean-11-scaled-featured-plan` — clean, unasserted |
| `[bleed N]` | S | adversarial `clean-02-full-bleed-hero` (240), adversarial3 `clean-02-card-media-bleed` (20) — both clean, unasserted |
| `[stacked N]` | S | adversarial3 `clean-09-avatar-stack` — clean, unasserted |
| `[line: N inline children on one line]` | S | adversarial2 `clean-12-breadcrumb-separators` — clean, unasserted |
| `[not painted: opacity 0]` | S | `modal.html`, `agent-settings`, `agent-product`, `agent-music` |
| `[not painted: visibility hidden]` | S | `agent-chat.html` only |
| `[children skipped]` | S | unverified, no fixture designed for it |
| `[gaps: ...]` | S | everywhere |
| `[gaps across: ...]` | S | adversarial3 `clean-04-stepper` — clean, unasserted |
| `[text: ...]` | A | adversarial2 `bug-06` matches on the tag part |
| `[!!: ...]` | A | check.ts `similar.html` |

### `[pos]` terms (11)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `fills` | S | wrapper collapse depends on it |
| `fills-block` | S | adversarial3 `clean-10-progress-thirty` — clean, unasserted |
| `fills-inline` | S | many |
| `centered-block N` | A | adversarial2 `bug-01-rtl-accent-wrong-side` — `[pos: centered-block 8, end 3]` |
| `centered-inline N` | S | adversarial3 `clean-11-toast` — clean, unasserted |
| `top N` / `bottom N` | A | adversarial2 bug-05 `[pos: bottom 0, ...]` |
| `start N` / `end N` | A | adversarial2 bug-01 `end 3`, bug-05 `start 0` |
| negative offset (`end -2`, pokes out) | A | adversarial2 `bug-05-tab-underline-wide` |
| two-term `start 0, end N` | A | adversarial2 bug-05 |
| `... of viewport` | S | adversarial3 `clean-11-toast` — clean, unasserted |
| `fills viewport` | **N** | no fixture has a full-screen fixed element with no other pos terms |

### `[gaps]` internals (8)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `N ×K` run collapse | S | adversarial3 clean-04 `[gaps across: 16 ×3]` — clean, unasserted |
| `rows N` (grid axis title) | S | 26 fixtures use grid |
| `columns N` | S | same |
| `seen N, ...` | A | adversarial2 `bug-08-seen-gap-padding` — the finding is derived from the seen gaps |
| `…` twelve-entry cap | S | unverified |
| `N free before` | **N** | no fixture designed for it |
| `N free after` | A-neg | adversarial2 clean-01/clean-07, adversarial3 clean-10 forbid it; nothing asserts it |
| text run counted as a gap child | S | many |

### `[text]` internals (7)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `font size/lineHeight` | A | adversarial2 bug-06 tag phrase |
| `ink top N, ink bottom N` | A | adversarial2 bug-06 |
| `lines N` | S | adversarial3 bug-05 wraps to 4 lines; nothing asserts the term |
| `contrast N` | A | check.ts `navbar.html` |
| `contrast ~N` (approximate background) | **N** | needs a gradient or image background under text |
| `contrast unknown, transparent text` | S | 5 fixtures use `color: transparent` / `background-clip: text` |
| `contrast unknown, image behind` | **N** | needs an `<img>`/`<canvas>` painted under text; the 3 `<img>` fixtures do not do this |

### Findings (36)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `off-center-block N down/up` | A | adversarial bug-01, adversarial2 bug-07/bug-12, adversarial3 bug-06, check.ts navbar/cards |
| `off-center-inline N toward start/end` | A | adversarial bug-03, adversarial2 bug-02/bug-07, adversarial3 bug-06, check.ts cards |
| `off-center-inline N toward X, siblings A and B` | **N** | the middle-of-three clause is never asserted by any manifest |
| `text off-center-block N down/up` | A | adversarial bug-02, check.ts navbar/modal/broken |
| `font "X" not loaded, using Y` | **N** | every fixture asks for fonts macOS has |
| `contrast N under M, #ink on #bg` | A | adversarial bug-09, adversarial2 bug-09, check.ts navbar/shadow |
| `... on K text runs inside X` (editor grouping) | **N** | no fixture has monaco / cm-content / ProseMirror / contenteditable / role=textbox |
| `all covered by X` | S | adversarial3 bug-04 names it as the wrong answer |
| `top/bottom/left/right N covered by X` | A | adversarial2 `bug-11-sticky-sidebar-under-bar` — `top 8 covered by header.app-bar (overlay)` |
| `WxH covered by X` | S | adversarial2 clean-04 (`160x160`), adversarial3 clean-03 (`14x14`) — clean, unasserted |
| `(translucent)` suffix | S | adversarial clean-05 `expect` — unasserted |
| `(image)` suffix | **N** | needs a picture as the coverer; no fixture stacks an image over anything |
| `(overlay)` suffix | A | adversarial2 bug-11 |
| `text "words" N% hidden by X` | A | adversarial bug-06/bug-10, adversarial2 bug-03, check.ts modal |
| `text "words" hidden by X` (100%) | S | unverified |
| `control "words" N% hidden by X` | A | check.ts `modal.html` — `control "Dashboard" 29% hidden by header` |
| `control "words" hidden by X` (100%) | A | adversarial3 bug-01 and bug-04 |
| `clipped SIDE N by X` | A | adversarial bug-05, check.ts cards/broken |
| `scrolled out SIDE N by X` | A-neg | adversarial clean-07, adversarial2 clean-02 forbid it; the positive form is untested |
| `outside viewport left/right N` | A | adversarial3 `bug-08-tooltip-off-viewport-end` |
| `all clipped by X` / `by parent` | **N** | no fixture collapses a panel to nothing on an axis |
| `X hides N more elements` | **N** | needs one clipper with over 10 victims; no fixture designed for it |
| `empty painted box` | A-neg | forbidden 11 times across all three suites, asserted positively nowhere |
| `same as N above` | S | needs 4 identical findings in one tree; likely on an `agent-*` page, asserted nowhere |
| `text truncated N hidden at end, ellipsis` | A | check.ts cards/shadow/broken, adversarial bug-04 (`no ellipsis`), adversarial3 clean-05 |
| `content truncated N hidden at ...` | A-neg | adversarial3 bug-05 and clean-05 forbid it; positive form untested |
| `content overflows N at end/start/both` | A | adversarial3 `bug-09-cover-image-wider-than-card` (`at end`); `at start` and `at both` untested |
| block axis `hidden below` | S | produced by adversarial3 bug-05, but the manifest asks for the wrong words (see below) |
| block axis `hidden above` / `above and below` | **N** | — |
| `N free after, none in the sibling X` | A-neg | adversarial2 clean-01 forbids it; the positive form is untested |
| `uneven spacing, N between A and B, others M` | A | adversarial bug-08, adversarial2 bug-08 |
| `N free at end, on every row of this column` | S | `experiment-orders.html` is the page the code comment cites; asserted nowhere |
| `overlaps X` | A | check.ts `broken.html` — `overlaps div.a` |
| `overlaps X (overlay)` | S | adversarial3 clean-01 `expect` — unasserted |
| `top edge N lower/higher than X`, bare `N lower than X` | A | adversarial3 bug-03/bug-10, adversarial2 bug-06 |
| `start edge N further start/end than X` | A | adversarial bug-12, adversarial2 bug-10, adversarial3 bug-12 |
| `N wider/narrower/taller/shorter than X` | A | adversarial bug-07/bug-11, adversarial2 bug-04, adversarial3 bug-11 |
| counterpart naming `X in Y` | A | adversarial2 bug-06, adversarial3 bug-03/bug-12 |

### Summary block (8)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `findings: none` | S | probably some clean page; asserted nowhere |
| `findings: N on K kinds` | S | every run |
| `  <finding> ×N — a, b, c` | S | every run |
| `, …` element list cap (over 3) | S | many |
| range `N to M` | **N** | needs 2+ findings of one kind whose trailing numbers agree; no fixture designed for it |
| `<finding> and N more` | S | unverified |
| `#ink fails contrast on N backgrounds, M elements, worst R on #bg` | A | check.ts `similar.html` |
| `page` as the identifier for a header finding | **N** | needs a header finding, which only adversarial3 bug-08 produces, unasserted |

### since last run (5)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `since last run: first run` | S | first ever run of a fixture |
| `since last run: N gone, M new, K changed` | S | every repeat run |
| `- element: finding` | S | only on a real regression, asserted nowhere |
| `+ element: finding` | S | same |
| `~ element: changed, finding N to M` | S | same, and `mergeChangedNumbers` is the fiddliest formatter in the file |

Note: the store is keyed on `target|width|height|scheme|scroll|!shadow` and written to
`os.tmpdir()/layout-lens`. `npm test` and `npm run score` both write it, so the diff shown to a
human is against the previous test run, not the previous edit.

### across runs (6)

| Thing | Status | Exercised by |
| --- | --- | --- |
| `across viewports` heading | **N** | nothing passes `widths` |
| `across schemes` heading | **N** | nothing passes `schemes` |
| `across viewports and schemes` heading | **N** | — |
| `  390 only: X: finding` | **N** | — |
| `  all: N findings shared` | **N** | — |
| `viewport 390x844` / `viewport 390x844, dark` tree headings | **N** | — |

## Counts

- **139** distinct printable things.
- **44** asserted (A), **8** negative-only (A-neg), **58** smoke (S), **29** produced by nothing (N).
- Counting a hole as "no test would fail if it broke": **95 of 139** (S + A-neg + N).
- Counting a hole strictly as "nothing can even produce it": **29 of 139**.

## The holes, ranked

Ranked on how hard the thing is to compute, how easy it is to get silently wrong, and how often it
shows up on a real page.

1. **Both color schemes, and dark at all.** `scheme` is `'light'` for all 72 manifest pages and all
   30 check.ts fixtures, and `ManifestEntry` in `scripts/score.ts:12` has no field for it. Every
   contrast number, every `getPaintedBackground` walk and the whole `across schemes` block are dark-blind.
   *Page:* a settings panel whose `prefers-color-scheme: dark` block swaps a `#f4f5f7` surface for
   `#14171c` but leaves one helper line on `#7a7a7a`, so light reads 4.6 and dark reads 3.1. It needs
   a `scheme` field on the manifest and a `schemes` run that asserts `dark only: p.hint: contrast ...`.
2. **Several viewports (`--widths`) and the whole across-viewports block.** Six printable forms, the
   `getFindingKey` normalizer that strips numbers, percentages and quoted words, and the label
   composition in `inspectPage.ts:573` — none of it is reachable from either script.
   *Page:* a card grid that is fine at 1280 and pushes its price chip `outside viewport right 12` at
   390, run once with `widths: [390, 1280]`. The assertion is `390 only:` on that finding plus a
   nonzero `all: N findings shared`.
3. **The middle-of-three `off-center-inline ..., siblings A and B` rule.** The most guarded rule in
   the file — `isMiddleChild` needs one sibling each side, `isRowSpanningParent`, matching gaps, no
   text-run neighbour, not a table cell, over 8 and under a quarter of the parent. Every guard is a
   past false positive and none is pinned.
   *Page:* a header 900 wide holding exactly `a.logo` (140), `nav.main` (400) and `select.version`
   (200) flush to both edges with one fixed 80 gap, so the nav's centre lands 30 off the header's.
   A second row on the same page swaps the fixed gap for `justify-content: space-between` so nothing
   fires, and a third puts a run of words beside the middle child so nothing fires there either.
4. **A code editor container.** No fixture anywhere carries `monaco`, `cm-content`, `ProseMirror`,
   `contenteditable` or `role="textbox"`, so `recordEditorContrast`, the `on K text runs inside X`
   line, and the suppression of centering and alignment findings on every token are all dead code
   under test. This is the guard that keeps a real IDE page from printing thousands of lines.
   *Page:* a `div.monaco-editor` holding 40 `span` tokens on 12 absolutely positioned line divs, one
   token colour at `#6a6a6a` on `#ffffff`. Assert exactly one contrast finding, on the editor, reading
   `on 40 text runs inside div.monaco-editor`, and zero `off-center` findings inside it.
5. **`scrolled out` as a positive finding.** Only ever forbidden. The `scrolls ? 'scrolled out' :
   'clipped'` fork at `inspectLayout.ts:2456` decides between two words for the same measurement, and
   the "direct child of a scroll box says nothing, the box counts it" exemption sits right beside it.
   A swap of the two words passes every suite today.
   *Page:* a 400x300 `overflow-y: auto` panel holding a nested `div.group` which itself holds six
   rows, scrolled to the top so rows five and six sit below the panel edge. The rows are grandchildren,
   not direct children, so they must each say `scrolled out bottom N by div.panel`, never `clipped`.
6. **`empty painted box`.** Forbidden eleven times, asserted zero. Its logic carries five exemptions
   (picture, control, rendered content, backdrop over 90% of the viewport, knob on a bar) plus the
   `getPaintedSize` rule that a one-sided border paints a line and never a box.
   *Page:* an analytics page with a `div.ad-slot` 300x250 with a `#eef1f5` background and nothing
   inside it, beside a `div.col-rule` 1x600 with only `border-left`. Assert the finding on the slot
   and its absence on the rule.
7. **The header finding `page N wide, viewport M, caused by X`.** Produced today by adversarial3
   bug-08 and checked by nobody, and it is the finding a real page hands you most often — a stray
   horizontal scrollbar. The `page` identifier in the summary rides on the same path.
   *Page:* a dashboard at 1280 with one `table.wide` at `min-width: 1400px` inside a non-clipping
   wrapper. Assert `page 1400 wide, viewport 1280, caused by table.wide` on the first line and a
   `page:` row in the summary.
8. **Element naming: generated-run stripping and the `:nth-child` fallback.** No fixture has a single
   mangled class or id, so `generatedRunPattern`, `cssModulePattern` and `isUtilityClassName` — three
   regexes that rename *every element on the page* if they drift — are untested. A bad strip does not
   fail loudly, it quietly makes every identifier in every finding wrong.
   *Page:* one card whose markup carries `class="Header__xm1jd"`, `class="sc-6cc20e4a-0"`,
   `class="_card_1b0yp_73"`, `class="pt-0.5 col-start-4"` and a bare `<div>` among sibling divs.
   Assert the five identifiers come out `div.Header`, `div`, `div.card`, `div:nth-child(4)` and
   `div:nth-child(5)`.

Below the top eight, in order: `[oversized]` and `[offscreen]` (both N, both suppress whole families
of findings and both are one-line fixtures to write); the since-last-run `-`/`+`/`~` shapes;
`all clipped by X`; `X hides N more elements`; `(image)` and `contrast unknown, image behind` (the
three `<img>` fixtures never stack one over text); `N free before` and `N free after` positives;
`[shadow root skipped]` / `--no-shadow`; findings-only mode; block-axis `hidden above`; the summary
range `N to M`.

## The other direction: expectations the code cannot satisfy

### 1. A line clamp cannot say `hidden at end` — adversarial3 `bug-05-line-clamp-cuts-summary`

> `"expect": "p#review-hana.summary must report `text truncated 40 hidden at end, ellipsis`."`

and in the same entry:

> `"mustNotReport": "... `text truncated 40 hidden at end, no ellipsis` (the computed text-overflow is ellipsis) ..."`

A `-webkit-line-clamp` cut is block-axis overflow. It takes the branch at `inspectLayout.ts:2567`
(`hidesBlockOverflow`), which calls `describeBlockOverflow`, whose only three side strings are
`' above'`, `' below'` and `' above and below'` (`inspectLayout.ts:1152`). `at end` comes from
`describeInlineOverflow` and is unreachable here — the four text lines are all inside the box
horizontally. The real output is `text truncated 40 hidden below, ellipsis`.

The legend agrees with the code and not with the manifest: *"text truncated 118 hidden below … above
and below rather than start and end, a line cut off the bottom of a clamped paragraph did not run
past the end of anything."*

It passes anyway, which is the worse half of the problem. `isPhraseInFinding` strips the numbers and
needs 60% of the plain words: `text`, `truncated`, `hidden`, `ellipsis` all hit, `at` and `end` miss,
4/6 = 0.67, over the 0.6 floor. So the suite scores a HIT on a page whose expectation names an axis
the tool correctly refuses to use. Fixing the manifest to `hidden below` would turn the only
accidental test of the block-overflow path into a real one.

### 2. `baseline` is not a term the tool prints — adversarial2 `bug-06-rtl-label-baseline-high`

> `"expect": "... and its `[text: ... ink top, baseline]` sits 3 above the text of input#city.row-input"`

`describeText` builds its parts at `inspectLayout.ts:629`: `font size/lineHeight`, then
`ink top N, ink bottom N`, then optionally `lines N` and `contrast`. There is no `baseline` in the
tag. The word was replaced by `ink bottom` at some point and the manifest kept it. It still scores,
on `text` + `ink` + `top` = 3/4, and the entry's first phrase would have carried it regardless.

### 3. `control ""` is not a shape the code emits — adversarial3 `clean-01-floating-label-on-border`

> `"mustNotReport": "`control \"\" hidden by label.float-label` ..."`

At `inspectLayout.ts:1732`, `quotedText` is `''` when the element has no direct text, and the finding
comes out `control 40% hidden by X` with no quotes at all. An empty pair of quotes is never printed.
Harmless — it is a `mustNotReport` — but it means that clause can never match anything.

### 4. Clean-page `expect` claims that are prose, not tests

Not impossible, just unenforced, and easy to mistake for coverage when reading the manifests:
`[bleed 240]` (adversarial clean-02), `[bleed 20]` (adversarial3 clean-02), `[sr-only]` (adversarial
clean-08), `[scaled 1.05]` (adversarial clean-11), `[scroll: x ...]` and `N of 12 children out`
(adversarial clean-07), `N of 10 children out` (adversarial2 clean-02), `[line: 7 inline children on
one line]` (adversarial2 clean-12), `[gaps across: 16 ×3]` (adversarial3 clean-04), `[stacked 5]`
(adversarial3 clean-09), `[pos: fills-block, start 0, end 280]` (adversarial3 clean-10), `[pos:
bottom 24 of viewport, centered-inline 460 of viewport]` (adversarial3 clean-11), `[pos: ..., start
N, end 0]` (adversarial2 clean-05), `centered-block 14` (adversarial3 clean-12), `scroll locked by
div.modal` (adversarial clean-05).

Fourteen tag and position expectations, none of them checked. Moving `scoreCleanPage` to also match
`expect` phrases the way `scoreBugPage` does would convert all fourteen into real assertions and
would immediately cover `[bleed]`, `[sr-only]`, `[stacked]`, `[scroll]`, `[line:]`, `[scaled]`,
`[gaps across]`, `fills-block`, `of viewport` and the scroll-lock first line.

## Viewports, scrolls, directions and schemes across the three suites

| Suite | Viewports | Scrolls | Direction | Scheme |
| --- | --- | --- | --- | --- |
| adversarial | 1280x720 ×24 | 0 ×23, 300 ×1 (clean-06) | ltr ×24 | light ×24 |
| adversarial2 | 1280x720 ×17, 390x844 ×7 | 0 ×22, 400 ×2 (bug-03, bug-11) | ltr ×21, rtl ×3 (bug-01, bug-06, clean-09) | light ×24 |
| adversarial3 | 1280x720 ×20, 390x844 ×4 | 0 ×23, 400 ×1 (bug-07) | ltr ×22, rtl ×2 (bug-12, clean-12) | light ×24 |
| check.ts | 1280x720 ×26, 390x844 ×2, 820x1180 ×1, 1440x900 ×1 | 0 always | ltr, rtl in 4 unasserted fixtures | light ×30 |

Covered: 1280x720 and 390x844 with assertions; 820x1180 and 1440x900 only as unasserted smoke runs;
scroll 0, 300 and 400; ltr and rtl; light.

Reached by no suite at all:

- **Any dark run.** Zero pages in 102 rendered pages. `--scheme dark`, `--schemes light,dark` and the
  entire `across schemes` block have no coverage of any kind.
- **Any multi-viewport run.** `--widths` is never passed, so `across viewports` and the
  `viewport WxH` tree headings never render.
- **820x1180 with an assertion.** CLAUDE.md names it as a builder viewport and `check.ts` runs
  `experiment-wizard.html` there, but no fragment is checked and no manifest entry uses it. The
  tablet width is the one where a two-column layout collapses.
- **`scroll: 'bottom'`.** Supported by the CLI and `InspectPageOptions`, used by nothing. Every
  scrolled entry is a fixed number.
- **rtl at 390x844.** All five rtl pages are 1280x720. The mirroring bugs CLAUDE.md calls out —
  `start`/`end`, gap list order, the near edge flipping — are never seen at a phone width where a row
  wraps.
- **rtl while scrolled.** All five rtl pages are at scroll 0, so sticky, fixed-bar coverage and
  `scrolled out` are never measured in rtl.
- **rtl in dark.** Follows from the two above.
- **A scrolled 390x844 page.** All four scrolled entries are 1280x720, so `position: sticky` and a
  fixed bar are never tested at a phone width.
- **`--no-shadow`.** `shadow: false` is never passed, so `[shadow root skipped]` and the markup-child
  walk are untested.
- **http, any status, any redirect.** Everything is a local file, so `status N`, `server answered N`,
  `redirected to`, `could not load` and the retry path in `loadPage` are all unreachable.

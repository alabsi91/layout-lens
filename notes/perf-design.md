# layout-lens performance design

Read of `src/inspectLayout.ts` (2716 lines) and `src/inspectPage.ts` (599 lines) at 2026-09-07.
Line numbers are from that read; anchor on the function name, another agent is editing src.

Nothing here was measured. Every estimate is derived from operation counts times a stated
per-operation cost. Where the cost of a browser primitive matters I say which one and why.

Notation: `N` = elements on the page, `S` = children of one parent (800 for the row list),
`C` = laid-out children of one parent, `D` = tree depth, `G` = gaps in one axis of one parent.

---

## 1. Every pass that is worse than linear

### 1.1 `getAxisNeighbours` — O(S) per element, O(S²) per parent

`inspectLayout.ts:861-947`. Called once per element from `describePosition` (line 959), which
`describeElement` calls for every element with a parent (line 2371).

```ts
for (const node of getRenderedChildNodes(parent)) {
  ...
  const siblingStyle = getComputedStyle(node);
  if (siblingStyle.position === 'absolute' || siblingStyle.position === 'fixed') continue;
  const siblingRect = node.getBoundingClientRect();
  if (isFlat(siblingRect)) continue;
  siblings.push({ rect: siblingRect, name: getIdentifier(node), isTextRun: false });
}
```

Every child of the parent is visited for every child of the parent. Per visit: one
`getRenderedChildNodes` array build (amortised, see 1.7), one `getComputedStyle` + property read,
one `getBoundingClientRect`, and one **`getIdentifier`** — two regexes per class name plus a
possible `getNthChildSuffix`, which is itself another O(S) sibling scan (line 216-222).

The names are almost entirely wasted. `record` (line 897) only keeps `sibling.name` when the
sibling is nearer than the current nearest, so at most 4 of the S names are ever read.

### 1.2 The previous-sibling overlap scan — O(S²·D) per parent

`inspectLayout.ts:2393-2418`, inside `describeElement`.

```ts
for (const sibling of getRenderedChildren(parent)) {
  if (sibling === element) break;
  ...
  const siblingRect = sibling.getBoundingClientRect();
  if (isFlat(siblingRect) || isOffscreen(siblingRect) || !isPainted(sibling)) continue;
  if (!isOverlapping(rect, siblingRect)) continue;
```

Element `i` scans `i` earlier siblings, so `S²/2` pair visits per parent. Two things make each visit
expensive:

- `isPainted(sibling)` (line 1472) calls `getEffectiveOpacity` (line 1768), which walks the **whole
  ancestor chain** calling `getComputedStyle` on each one. That is O(D) style resolutions per pair.
- It runs **before** `isOverlapping`, the cheap numeric test that rejects essentially every pair on
  a vertical list. The expensive filter is evaluated first and the cheap one second.

Also `getRenderedChildren(parent)` is rebuilt from scratch on every element (1.7).

### 1.3 `findBarUnder` — O(S) per element, O(S²) per parent, and unconditional

`inspectLayout.ts:1836-1838`, called at line 2533 as `const isKnob = findBarUnder(element) !== null;`

```ts
function findBarUnder(element: Element): Element | null {
  return getRenderedSiblings(element).find((sibling) => isKnobOnBar(element, sibling)) ?? null;
}
```

`isKnobOnBar` (line 1824) reads `getComputedStyle(knob).position` **inside the predicate**, so the
same element's position is resolved once per sibling — S times per element, S² per parent. The
value is loop-invariant and is the guard that makes the answer `false` for every static element.

Worse, `isKnob` is computed eagerly on line 2533 even though it is only used as the last term of
the `if` on line 2535, whose earlier terms (`renders`, `!hasText`, …) already reject most elements.

### 1.4 `measureGaps` — 3·C² per axis, 6·C² per parent

`inspectLayout.ts:1322-1364`. Three separate O(C²) scans over the same pairs:

- lines 1324-1331: for each `before`, scan all children to find the nearest gap.
- lines 1333-1337: for each `before`, scan all children **again** to collect the ties.
- lines 1350-1353: for each child, `children.filter(...)` to find its band, allocating a C-element
  array per child, then `Math.min(...band.map(...))`.

`doShareBand` is called for the same ordered pair three times. Memoised at the parent through
`getChildLayout` (line 1252), so it runs once per parent — but the constant is 6C² and the third
pass allocates C arrays of length C.

### 1.5 `describeUnevenSpacing` — O(G²·log G), with a cliff

`inspectLayout.ts:1197-1230`.

```ts
for (let index = 0; index < seenGaps.length; index++) {
  const others = seenGaps.filter((_, otherIndex) => otherIndex !== index);
  const doOthersAgree = Math.max(...others) <= Math.min(...others) * 3;
  ...
  const median = getMedian(others);
```

Per index: two G-element `filter` allocations, two spread calls over G arguments, and up to two
`getMedian` calls, each of which does `[...values].sort()` — O(G log G). Total O(G² log G).

The cliff: the `isFixedGap` early return on line 1201 requires `Math.abs(firstBoxGap) > tolerance`.
A list whose rows sit **flush** (gap 0) is not a "fixed gap", so 800 flush rows run the full
799 × (2 filters + 2 sorts of 798) ≈ 17M operations and produce nothing. A list with a real gap of
16px returns on line 1202 in O(G).

### 1.6 `describeAlignment` cousin search — O(S) per element with the expensive predicate first

`inspectLayout.ts:2085-2099`.

```ts
const siblings = getRenderedChildren(ancestorParent);
const ancestorIndex = siblings.indexOf(ancestor);
const earlier = ancestorIndex < 0 ? [] : siblings.slice(0, ancestorIndex).reverse();
const candidate = earlier.find((node) => isInFlowSibling(node) && getShapeKey(node) === getShapeKey(ancestor));
```

`slice(0, i).reverse()` allocates and copies `i` elements twice, summing to S² copies per parent.
`isInFlowSibling` (line 1898 — `getComputedStyle` + `getBoundingClientRect` + `isPainted`'s ancestor
walk) is evaluated **before** the cheap string compare, and `getShapeKey(ancestor)` is recomputed
inside the predicate on every candidate. Usually the immediately previous sibling matches so the
scan is short, but a list of alternating shapes walks the whole prefix.

`findSameShapedSibling` (line 1929) and `findCounterpart` (line 1959) each call
`getRenderedSiblings` + `indexOf`, both O(S), and `describeAlignment` / `describeSlackMismatch`
call them up to 3 times per element.

### 1.7 `getRenderedChildren` / `getRenderedChildNodes` — O(S) allocation on every call

`inspectLayout.ts:122-142`. No memo. Every call spreads `childNodes` into a fresh array and filters
it. Callers, per element: `describeElement` (2310), `walk` (2623), `getRenderedSiblings` ×3-4,
`findBarUnder`, `getPaintedBounds`, `getPaintedSubtreeBox`, `getContentChildBoxes` (×4, see 1.9),
`getChildShapeSignature`, `getStackedChildCount`, `describeOneLine`, `hasTableChildren`,
`countChildrenOutOfView`, `hasRenderedContent`, `isClosedShadowHost`, `getDirectText`,
`getRenderedText`. Twenty-plus rebuilds per element, each O(S).

### 1.8 `parseColor` — a canvas readback per call, no memo on the color string

`inspectLayout.ts:469-476`. Every call does `fillRect` + **`getImageData(0,0,1,1)`**. Called from
`describeRenders` (677), `getPaintedSize` (710), `getPaintedBounds` (1008), `describeText` (638,
646, 660), `getContrastRatio` (549, twice per text element), `describeBackgroundContrast` (694),
`isTranslucent` (1635), `getPaintedBackground` (525, once per ancestor), `getGradientStops` (1554).
Roughly 10 calls per element, all on a handful of distinct strings (`rgba(0, 0, 0, 0)` dominates).

### 1.9 Recomputed pure results inside `describeElement`

- `getContentChildBoxes(element)` runs **4 times** per element: twice via
  `getPaintedContentOverflow` (line 1129) and twice directly (lines 2548, 2571). Each is O(C) with a
  `getBleed` per child, which itself resolves the parent's computed style and rect.
- `getTextLineRects(element)` (line 566) runs up to 5 times per element (`describeText`,
  `getPaintedBounds`, `getPaintedContentOverflow` ×2, `describeCoverage`, `getCellInk`), each
  building a `Range` per text child and calling `getClientRects()`.
- `getIdentifier`, `getShapeKey`, `getDirectText`, `getFlatText`, `isPainted`, `isInFlowSibling`,
  `getPaintedBackground`, `getVisibleBox` are all pure over a frozen DOM and none are memoised.

### 1.10 Coverage sampling — linear in N, but bounded by the viewport

`describeCoverage` (line 1670) builds 16 grid points + 4 edge points and calls
`document.elementsFromPoint` for each (line 1704), then walks `doesRenderedContain` per hit (O(D))
and `getCovererBranch` (O(D)).

It is **not** a scaling problem on a tall page, and this is worth stating because it looks like one:

```ts
const top = Math.max(visibleBox.top, 0);
const bottom = Math.min(visibleBox.bottom, window.innerHeight);
if (right - left < 2 || bottom - top < 2) return null;
```

For a row at y=5000 in a 720-tall viewport, `bottom - top` is negative and the function returns
before any hit test. Only elements intersecting the viewport are sampled — maybe 30 of 800 rows.
The waste that remains is `getVisibleBox` (line 356), which walks every ancestor with a
`getComputedStyle` + `getBoundingClientRect` **before** that cheap viewport test.

### 1.11 `getPaintedBackground` — O(D) ancestor walk with `findImageBehind` at each step

`inspectLayout.ts:520-542`, not memoised. Each level calls `findImageBehind` (line 508), which scans
every backdrop image doing `compareDocumentPosition` (O(D)) and `doesRenderedContain` (O(D)). So
O(D²·images) per text element on an image-heavy page.

### 1.12 `hasRenderedContent` — O(subtree) per element, evaluated too early

`inspectLayout.ts:723`, called at line 2535 **before** the two cheap numeric guards
`isBigEnoughToNotice` and `!isBackdrop` in the same `&&` chain.

### 1.13 `describeSinceLastRun` — O(gone × added) with a regex per comparison

`inspectPage.ts:387-414`.

```ts
const matchIndex = added.findIndex((addedLine) => getFindingShape(addedLine) === shape);
```

`getFindingShape` runs a regex on `addedLine` on every comparison. When a CSS edit changes many
findings at once, `gone` and `added` are both O(F) and this is O(F²) regex calls in Node.

### 1.14 `describeAcrossRuns` — O(F²) regex, only with `--widths` / `--schemes`

`inspectPage.ts:503`: `run.findingLines.find((line) => getFindingKey(line) === findingLine)`,
inside a loop over every distinct key. `getFindingKey` (3 regexes) is recomputed per comparison.

### 1.15 `formatReport` / `getSimilarKey` — O(N·D) string building

`inspectPage.ts:146-150`. `getInnerShape` and `getFindingsSignature` each walk the whole subtree,
and `getSimilarKey` is called on every node, so each node's shape string is rebuilt once per
ancestor. O(N·D) characters. Real but second-order; noted for completeness.

---

## 2. What dominates at 800 rows

Model: a container with S = 800 row elements, each row holding 2-3 children, so N ≈ 2400-3200,
D ≈ 6. Per-operation costs used below, Blink, layout clean: `getComputedStyle` + one property read
≈ 0.6µs (the cost is the CSSValue serialization, not the wrapper), a cached
`getBoundingClientRect` ≈ 0.3µs, a numeric compare on a DOMRect ≈ 20ns, a small regex ≈ 0.5µs,
`getImageData(1×1)` on a `willReadFrequently` canvas ≈ 2µs.

| pass | pair visits at S=800 | cost per visit | estimate |
|---|---|---|---|
| 1.2 overlap scan | 320,000 | 1 style + 1 rect + `isPainted` walk (≈6 styles) ≈ 4.5µs | **≈ 1.4 s** |
| 1.1 `getAxisNeighbours` | 640,000 | 1 style + 1 rect + `getIdentifier` ≈ 2.5µs | **≈ 1.6 s** |
| 1.3 `findBarUnder` | 640,000 | 2 parent lookups + 1 style ≈ 1.0µs | **≈ 0.6 s** |
| 1.7 child-array rebuilds | ≈ 3,200 calls × 1,600 nodes = 5.1M node visits | ≈ 60ns | ≈ 0.3 s |
| 1.4 `measureGaps` | 6 × 640,000 = 3.8M | ≈ 40ns | ≈ 0.15 s |
| 1.6 alignment scans | ≈ 1M copies + 3,200 O(S) scans | ≈ 60ns | ≈ 0.1 s |
| 1.5 `describeUnevenSpacing` | 0 or 17M | ≈ 30ns | 0 or ≈ 0.5 s |
| 1.8 `parseColor` | ≈ 24,000 | ≈ 2µs | ≈ 0.05 s |
| 1.10 coverage | ≈ 30 elements × 20 hit tests | ≈ 30µs | ≈ 0.02 s |

**The three sibling scans dominate: 1.1, 1.2 and 1.3 together are ≈ 3.6 s of an estimated ≈ 4.4 s
of super-linear work**, and the remaining ~9 s of the 14 s is the linear per-element work
(≈ 2,800 elements × the full `describeElement` body, which is on the order of 40-60 style
resolutions, 20 rect reads, 5 Range constructions and 10 canvas readbacks each ≈ 3 ms/element)
plus the 1.2 s floor plus JSON transport of the report tree.

Why 1.2 rather than 1.1 is the one to fix first even though 1.1 has twice the pair count: 1.2's
per-pair cost is dominated by an ancestor walk that is pure waste (the pair does not overlap), and
the fix is a two-line reorder. 1.1's fix is a small restructure.

Why coverage sampling is **not** the answer despite looking like the obvious suspect: the
viewport clamp at line 1674-1678 returns `null` for every element below the fold, so its cost is
tied to the viewport, not to the page. A 200-row page and an 800-row page do the same number of hit
tests. That matches the reported shape of the problem — 200 rows and 800 rows differ by 4× in
elements but the time grows faster than 4×, which is a squared term in the sibling count, not a
constant-per-element term.

---

## 3. The fixes, ordered by win over risk

Every fix in 3.1-3.6 is output-identical by construction. 3.7 onward are noted separately.

### Precondition for all memoisation

The DOM is mutated in exactly two places, both **before** any measurement:
`inspectLayout.ts:79-82` (pointer-events flips) and `89-102` (sticky position toggle and restore).
After line 102 nothing writes to the DOM or to a style, so every derived fact is frozen for the run.
**Any new memo must be declared after line 102 and no code may be added that mutates the DOM after
it.** Put a one-line comment saying so at the memo block.

Add one helper next to the existing hand-rolled memos (`paintedBoundsByElement` line 975,
`paintedSubtreeBoxByElement` 1056, `childLayoutByElement` 1248, `stackedChildCountByElement` 1799)
rather than six more Maps:

```ts
// Every fact below is read from a DOM that nothing changes after the sticky measurement above.
function memoizeByElement<T>(compute: (element: Element) => T): (element: Element) => T {
  const cache = new Map<Element, T>();
  return (element) => {
    if (cache.has(element)) return cache.get(element)!;
    const value = compute(element);
    cache.set(element, value);
    return value;
  };
}
```

`cache.has` rather than `=== undefined`, because `getPaintedBackground` and friends return `null`
legitimately. Leave the four existing Maps alone, they work.

---

### 3.1 Reorder the overlap scan and memoise `isPainted` — biggest win, two lines plus one memo

**File** `src/inspectLayout.ts`. **Functions** `describeElement` (lines 2393-2418),
`getEffectiveOpacity` (1768), `isPainted` (1472).

1. Move the cheap rejection first. In the loop body, replace

   ```ts
   if (isFlat(siblingRect) || isOffscreen(siblingRect) || !isPainted(sibling)) continue;
   if (!isOverlapping(rect, siblingRect)) continue;
   ```

   with

   ```ts
   if (isFlat(siblingRect) || !isOverlapping(rect, siblingRect)) continue;
   if (isOffscreen(siblingRect) || !isPainted(sibling)) continue;
   ```

   All four predicates are pure and combined with `&&`/`continue`, so order changes nothing but cost.

2. Wrap `getEffectiveOpacity` in `memoizeByElement`. It is called from `isPainted`, which is called
   from `walk` (2622), `describeElement` (2378), `isInFlowSibling` (1904), `describeCoverage` (1713),
   the overlap loop, the `backdropImages` filter (505) and `findScrollLockDialog` (2259).

3. Also hoist the two loop-invariant style reads out of the loop: `style.float`, `style.display` and
   `style.position` of `element` are already available as `style`; the per-sibling
   `getComputedStyle(sibling)` stays but see 3.3.

**Expected win** the ~320,000 ancestor walks become ~320,000 numeric compares. ≈ 1.3 s of the
14 s, and it also speeds up `isInFlowSibling` everywhere else.
**Risk** near zero. The only way to break it is if `isOverlapping` were not pure; it is
(`inspectLayout.ts:1783`, arithmetic on two Boxes).

---

### 3.2 Make `findBarUnder` return early for anything that is not out of flow

**File** `src/inspectLayout.ts`. **Functions** `findBarUnder` (1836), `isKnobOnBar` (1824),
`describeElement` (2533-2535).

```ts
function findBarUnder(element: Element): Element | null {
  const position = getComputedStyle(element).position;
  if (position !== 'absolute' && position !== 'fixed') return null;
  return getRenderedSiblings(element).find((sibling) => isKnobOnBar(element, sibling)) ?? null;
}
```

The check is exactly the one `isKnobOnBar` already makes on `knob` (line 1827-1828), hoisted out of
the loop. Leave `isKnobOnBar` as it is — `isDeliberateCoverer` (1889) calls it directly and needs
the guard to stay there.

Then move the `isKnob` computation into the condition so it is not paid at all when an earlier term
already rejects the element, and put `hasRenderedContent` (O(subtree)) after the cheap numbers:

```ts
if (renders && !paintsPicture && !isControl(element) && !hasText && isBigEnoughToNotice
    && !isBackdrop && !hasRenderedContent(element) && findBarUnder(element) === null) {
  findings.push('empty painted box');
}
```

**Expected win** ≈ 0.6 s at 800 rows, plus the removal of ~800 full child-array builds.
**Risk** near zero, both are hoists of an existing guard and a reorder of a pure `&&` chain.
A reviewer confirms by diffing the report of `fixtures/experiment-player.html` (slider knobs) and
`fixtures/experiment-orders.html` before and after — the `empty painted box` findings must be
byte-identical.

---

### 3.3 Memoise the per-element primitives

**File** `src/inspectLayout.ts`. Wrap each of these with `memoizeByElement`, keeping the same name
so no call site changes:

| function | line | called ≈ per element | why it is safe |
|---|---|---|---|
| `getRenderedChildNodes` | 122 | 20+ | pure over a frozen DOM |
| `getRenderedChildren` | 139 | 20+ | filters the above |
| `getIdentifier` | 224 | 1 + once per sibling visit | depends on tag/id/class/sibling order |
| `getShapeKey` | 1908 | 5+ | string ops on className |
| `isPainted` / `getEffectiveOpacity` | 1472 / 1768 | 10+ | see 3.1 |
| `isInFlowSibling` | 1898 | once per sibling visit | style + rect + isPainted |
| `getDirectText` | 177 | 8+ | walks childNodes |
| `getFlatText` | 280 | 2-4, each O(subtree) | walks the subtree with a style read per child |
| `getPaintedBackground` | 520 | 2, each O(D) with `findImageBehind` per level | pure |
| `getTextLineRects` | 566 | up to 5, each builds Ranges | pure |
| `getContentChildBoxes` | 1098 | 4 | pure |

Plus one keyed on the string rather than the element:

```ts
const colorByText = new Map<string, [number, number, number, number]>();
```
in `parseColor` (469) — a page has a handful of distinct color strings and each miss costs a
`getImageData`.

Memoising `getRenderedChildren` also removes the O(S) array rebuild inside `getRenderedSiblings`
(166), `getNthChildSuffix` (216), `findSameShapedSibling` (1929) and `findCounterpart` (1959)
without touching any of them.

**Watch for re-entrancy**: `getIdentifier` → `getNthChildSuffix` → `getRenderedSiblings` →
`getRenderedChildren`. That is a call into a *different, lower* memo, not a cycle. Do not build a
per-parent record that eagerly computes identifiers, that is where a cycle would come from.

**Expected win** ≈ 0.8-1.2 s at 800 rows and a broad cut on every page, most of it from
`getRenderedChildren`, `getIdentifier` and `isInFlowSibling`.
**Risk** low, but it is the change that would break if someone later adds a DOM write during the
walk. The comment in the precondition above is the guard. Confirm with `scripts/check.ts` over
`fixtures/` — every report must be byte-identical.

---

### 3.4 Stop building names in `getAxisNeighbours` for siblings nobody asks about

**File** `src/inspectLayout.ts`. **Function** `getAxisNeighbours` (861-947).

Change `Neighbour` from `{ rect, name, isTextRun }` to `{ rect, element, isTextRun }` (`element`
is `null` for a text run), keep the element in `axis.nearestBefore` / `axis.nearestAfter` as an
`Element | null`, and call `getIdentifier` once at the end of the function for the at most four
survivors:

```ts
type AxisNeighbours = {
  ...
  nearestBefore: string;   // stays a string in the type the callers read
  nearestAfter: string;
};
```

Simplest shape that keeps `AxisNeighbours` unchanged for `describeAxis`: build the axes with an
internal `nearestBeforeElement` / `nearestAfterElement`, and after the sibling loop set
`axis.nearestBefore = element ? getIdentifier(element) : 'text'`. Four calls per element instead of S.

**Expected win** with 3.3 already in place `getIdentifier` is memoised, so this is worth less than
it looks — the remaining S² cost is one map lookup and one rect read per pair, ≈ 0.05 s. Do it
anyway because it is small and it makes the pass O(S) in real work; skip it if 3.3 lands and the
profile no longer shows `getAxisNeighbours`.
**Risk** low. `getIdentifier(node)` is currently called for **every** in-flow sibling and after this
only for the nearest. It has no side effects, so no output changes.

---

### 3.5 Collapse the three scans in `measureGaps` into one

**File** `src/inspectLayout.ts`. **Function** `measureGaps` (1322-1364).

One pass over `after` per `before` that records both the nearest gap and every candidate, then a
filter:

```ts
for (const before of children) {
  const candidates: { after: LaidOutChild; gap: number }[] = [];
  let nearest = Infinity;
  for (const after of children) {
    if (after === before || !doShareBand(before, after, axis)) continue;
    const gap = getGapAlongAxis(before.rect, after.rect, axis);
    if (gap < -tolerance) continue;
    candidates.push({ after, gap });
    if (gap < nearest) nearest = gap;
  }
  if (nearest === Infinity) continue;
  for (const { after, gap } of candidates) {
    if (gap <= nearest + tolerance) pairs.push({ before, after, gap });
  }
}
```

Identical output: the second loop's predicate was `gap <= nearest + tolerance && gap >= -tolerance`,
and `candidates` already holds exactly the `gap >= -tolerance` entries that share a band.

For `bandStartByChild` (1349-1353), record the band minimum in the same first pass — the band of
`before` is `candidates` plus the children that share a band but start earlier, so it needs its own
membership test; the cheap version is to keep the third loop but drop the `filter` allocation:

```ts
for (const child of children) {
  let bandStart = inReadingOrder(child, acrossAxis);
  for (const other of children) {
    if (other !== child && !doShareBand(child, other, axis)) continue;
    bandStart = Math.min(bandStart, inReadingOrder(other, acrossAxis));
  }
  bandStartByChild.set(child, bandStart);
}
```

Same value, no C-element array per child, no spread.

**Expected win** ≈ 0.1 s at 800 rows and it removes 800 array allocations of 800 entries.
**Risk** low, but this is the one place where the rewrite could silently change a tie. Confirm on
`fixtures/agent-kanban.html` and `fixtures/experiment-calendar.html` (grids and wrapped rows) that
the `[gaps: …]` tags are byte-identical.

---

### 3.6 Cheap guard reorders, each one line

| where | change | why |
|---|---|---|
| `describeCoverage` (1670) | test `rect` against the viewport before calling `getVisibleBox` — `if (rect.bottom <= 0 \|\| rect.top >= innerHeight \|\| rect.right <= 0 \|\| rect.left >= innerWidth) return null;` | clipping only shrinks the box, so a rect already outside the viewport can never produce a visible box. Skips an O(D) style+rect ancestor walk for every below-the-fold element |
| `describeAlignment` (2092) | `getShapeKey(node) === shapeKeyOfAncestor && isInFlowSibling(node)`, with `shapeKeyOfAncestor` hoisted out of the predicate | string compare before a style+rect+ancestor walk |
| `getStackedChildCount` (1809) | hoist `getShapeKey(firstChild)` out of the `every` | recomputed C times |
| `describeElement` (2547-2571) | compute `getContentChildBoxes(element)` once into a local and pass it to both the overflow check and `getPaintedContentOverflow` | it runs 4 times; 3.3's memo also fixes this, pick one |
| `describeUnevenSpacing` (1201) | add `|| boxGaps.length >= 32` to the early return, or hoist the `others` computation to a running sum | see 3.9, this one changes output |

All except the last are pure reorders. **Expected win** ≈ 0.1-0.2 s combined, more on tall pages.

---

### 3.7 `describeSinceLastRun`: index by shape instead of scanning

**File** `src/inspectPage.ts`. **Function** `describeSinceLastRun` (387-414).

Replace the `added.findIndex(...)` scan with a `Map<string, string[]>` built once from `added`:

```ts
const addedByShape = new Map<string, string[]>();
for (const line of added) {
  const shape = getFindingShape(line);
  const list = addedByShape.get(shape) ?? [];
  list.push(line);
  addedByShape.set(shape, list);
}
```

Then per gone line, `shift()` off the bucket, and rebuild `added` at the end from what is left. The
current code pairs a gone line with the **first** matching added line in `added` order; a bucket
keyed by shape and consumed with `shift()` preserves that exactly, and the leftover `added` must be
re-derived in the original order (keep an index per line and sort the leftovers by it) to keep the
`+` lines in the same order.

**Expected win** nothing on a small page, seconds on a big page after a real CSS change, which is
exactly the case the tool exists for.
**Risk** medium-low — the ordering detail above is the whole risk. A reviewer confirms by running
the same page twice with an edit in between and diffing the `since last run` block against the old
build.

Same shape of fix for `describeAcrossRuns` (`inspectPage.ts:492-506`): build
`Map<key, findingLine>` in the same pass that fills `findingsByKey` instead of the
`run.findingLines.find(...)` rescan on line 503.

---

### 3.8 Not worth doing

- A spatial index for the overlap scan. After 3.1 the pair test is ~20ns; 320,000 of those is 6ms.
- Caching the `CSSStyleDeclaration` object from `getComputedStyle`. In Blink the object is cheap and
  live; the cost is the per-property CSSValue serialization, which a cached wrapper does not avoid.
  Memoising the *derived boolean* (3.3) is what actually removes the work.
- Batching `getBoundingClientRect`. Layout is clean throughout the walk, so the rects are already
  served from cache; the cost is the wrapper, and 3.3 removes the repeat calls that matter.

---

### 3.9 The one hot pass whose fix would change output

`describeUnevenSpacing` (1197). Capping it — "do not look for a broken rhythm in a list of more
than 32 gaps" — would lose the `uneven spacing, N between X and Y, others M` finding on long lists.

What would be lost: exactly one finding per parent per axis, and only on parents with 33+ gaps
where the gaps are *not* a fixed rhythm. The finding already requires `tightCount === 1` (line 1229),
so it is looking for a single odd gap among 800, which is the least likely case to be a real bug and
the most likely to be a wrapped row artifact.

How a reviewer confirms the trade: run `scripts/check.ts` over `fixtures/` and diff. Any
`uneven spacing` finding that disappears must be on a parent with 33+ gaps. If none disappears, the
cap costs nothing on any real page and only removes the 800-flush-rows cliff.

The output-preserving alternative, if the trade is refused: keep the loop but compute the median and
the min/max of `others` incrementally. `Math.max(...others)` and `Math.min(...others)` over
"everything but index i" are derivable from a single sorted copy of `seenGaps` plus the excluded
value, and `getMedian(others)` likewise from the sorted array by index arithmetic. That is O(G log G)
total, exact, and about 15 lines. Do this if the cap is refused.

---

## 4. Output size

### Why 800 rows still produce 115KB

The two existing mechanisms do not attack the bytes:

1. **`same as N above`** (`inspectPage.ts:94-100`) shortens the *finding text* on the line. The line
   still prints, and the line is dominated by the tags, not the finding. A typical line is
   `  li.row "Order 4182" 1180x44 [renders: background, border-bottom] [pad: 12 16] [pos: top 44, fills-inline] [text: Inter 14/20, ink top 3.5, ink bottom 4.5, contrast 12.6]` — about 160 bytes, of
   which the finding is 0.

2. **`×N similar`** (`formatReport`, 168-190) needs an exact match on `getSimilarKey` (146), which
   concatenates `shapeKey`, every tag except `[pos:]` and `[text:]`, `getTouchedEdges`, the
   `getInnerShape` of every child **and `getFindingsSignature` of the entire subtree**. One row with
   one extra child, or one row that fails contrast where its neighbour passes, or a row with a
   `[scroll:]` tag the others lack, splits the group. On a *varied* page — which is what the 115KB
   case is — almost every row lands in its own group of one. Groups of exactly 2 are also refused
   unless the rendered text is identical (line 183).

So the tree is one line per element with no ceiling, and the failure mode is precisely the page the
folding was written for.

### The fix: a byte budget that falls back to the mechanism that already exists

`keepLinesWithFindings` (`inspectPage.ts:199-223`) already prints every line carrying a finding plus
its ancestor path, and it is already exposed as `--findings`. It is honest by construction: every
finding still appears, and the summary above it already counts **every** finding, because
`collectFindings(root)` (227) walks the report tree, not the printed text.

**Change** in `inspectPage` (line 576-577):

```ts
const fullTree = formatReport(root, 0, new Map()).text;
const isOverBudget = !findingsOnly && fullTree.length > maxTreeBytes;
const tree = findingsOnly || isOverBudget ? keepLinesWithFindings(fullTree) : fullTree;
```

with `const maxTreeBytes = 40000;` next to `maxFindingRepeats` (line 48), and one line prepended to
the trimmed tree saying what happened and what it costs:

```
tree trimmed to lines with findings, 214 of 3180 lines, pass findings_only false with a smaller viewport or a selector to see all of it
```

Nothing is hidden that the summary does not carry: the summary lists every kind with its total count
and up to three identifiers; the trimmed tree carries every finding with its full ancestor path.
What is lost is the *context* of elements that are fine — the reader can no longer see that the row
above the broken one is 44 tall. That is a real loss and the trim line has to say so, which is why
it names the escape hatch.

**Second stage, if 40KB of findings-only lines is still too much** (a page with 3,000 findings):
group the folding in `formatReport` twice. First pass as today. Then re-group the children that
ended up in groups of one using a key that **drops `getFindingsSignature`** from `getSimilarKey`,
and for each such group print the members that carry findings plus one representative of the rest:

```
li.row "Order 4182" … [!!: contrast 3.1 under 4.5]
li.row "Order 4183" … ×612 similar, 0 with findings
```

That is honest — the count of hidden rows is stated, and the claim "0 with findings" is checkable
against the summary total. A reviewer confirms the trade by asserting that
`summarizeFindings`'s total is unchanged (it is computed off `entries`, never off the tree) and
that every identifier the summary names still appears in the tree.

**What not to do**: dropping the `[text: …]` tag from lines with no finding would halve the file,
and it is the one thing here that would hide information the summary does not carry — contrast
ratios and ink offsets for text that currently passes. Do not do it silently. If the bytes still
matter after the two stages above, make it an option with a default of on-in-trimmed-mode only.

---

## 5. The 1.2 s floor

Broken out of `inspectPage` (`inspectPage.ts:525-598`) and `loadPage` (425-442):

| stage | code | cost | cuttable |
|---|---|---|---|
| node boot + `import 'playwright'` + parsing 141KB of `inspectLayout.ts` | `src/cli.ts` imports | ≈ 200-350 ms | only by not starting a new process — i.e. the MCP server |
| `chromium.launch()` | line 537 | ≈ 250-400 ms | **yes for MCP**, no for a one-shot CLI |
| `browser.newPage()` | 547 | ≈ 30-60 ms | partly |
| `page.goto(url, { waitUntil: 'load' })` | 427 | ≈ 40-120 ms local, network otherwise | irreducible |
| `waitForLoadState('networkidle')` | 428 | **≈ 500 ms flat** | **yes** |
| `evaluate(scrollWindow)` + `evaluate(finishAnimations)` + `evaluate(fonts.ready)` | 554-556 | 3 CDP round trips ≈ 5-10 ms, plus real font loading when there is any | merge to one |
| `evaluate(inspectLayout)` | 558 | function source (141KB) shipped and compiled per call + the walk + JSON back | ≈ 20-40 ms on a trivial page |
| `browser.close()` | 597 | ≈ 50-100 ms, on the critical path in the `finally` | yes with a cached browser |

### 5.1 The 500 ms is the headline

Playwright's `networkidle` means "no network connections for at least 500 ms". `goto` already
waited for `load`; the lifecycle event then arrives 500 ms after the last request finished. **Every
run pays it, per viewport, per scheme.** A `--widths 390,820,1280` run pays it three times.

**Change** in `loadPage`, skip it when there is no network to settle:

```ts
const isLocalFile = url.startsWith('file:');
const response = await page.goto(url, { waitUntil: 'load', timeout });
if (!isLocalFile) await page.waitForLoadState('networkidle', { timeout: timeout * networkIdleShare }).catch(() => {});
```

A `file:` page with no subresources has nothing to go quiet. The comment above `loadPage` explains
why networkidle is bounded; extend it to say why a local file skips it. **Risk**: a local fixture
that fetches something over the network (none in `fixtures/`) would be measured a little early —
`load` has still fired, so its own subresources are done. Grep `fixtures/` for `fetch(`/`XMLHttpRequest`
before landing this.

Local fixtures are the agent's inner loop, so this alone takes the floor from ~1.2 s to ~0.7 s.

### 5.2 Keep the browser alive in the MCP server

`src/mcp.ts` calls `inspectPage` per request and `inspectPage` launches and closes a browser every
time (537, 597). The MCP process is long-lived. A module-level lazy singleton removes launch +
close from every call after the first:

```ts
let sharedBrowser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch();
  return sharedBrowser;
}
```

`inspectPage` then takes the browser from `getBrowser()` and closes only the *page*, not the
browser. The CLI path (`src/cli.ts`) exits after one call, so the process teardown closes it; add
nothing for that. Keep the existing `could not launch chromium` message on the launch failure.

**Risk** low, one caveat worth stating in the code: a crashed browser must be relaunched, hence the
`isConnected()` check, and pages must be closed in a `finally` so a failed run does not leak one.

**Expected win** ≈ 550 ms off every MCP call after the first, which is the call pattern the tool is
designed around.

### 5.3 One evaluate instead of three

Lines 554-556 are three CDP round trips. Merge:

```ts
await page.evaluate(settlePage, scroll);
```
where `settlePage` scrolls, finishes animations and returns `document.fonts.ready`. Saves 2 round
trips, ~5 ms. Free, do it while touching the file.

### 5.4 What is irreducible

`goto` + first layout + the walk + JSON transport. For a local fixture that is roughly
**120-180 ms**. Font readiness is real work when the page has webfonts and must stay.

### 5.5 The honest floor after the fixes

- **MCP, warm browser, local file**: ≈ 150-250 ms per call. (page create + goto + settle + walk +
  serialize; no launch, no close, no networkidle.)
- **MCP, warm browser, real URL**: 150 ms + the network, plus the 500 ms networkidle which stays.
- **CLI, cold process, local file**: ≈ 650-800 ms, and ~550 ms of that is node boot plus the
  Chromium launch. A one-shot CLI cannot get under that without a resident browser, which is a
  different product decision (a daemon) and not worth it — the CLI is for eyeballing, the MCP path
  is the one an agent runs after every CSS change.

---

## 6. Suggested landing order

1. **3.1** overlap reorder + `isPainted` memo — biggest win, two lines and one memo.
2. **3.2** `findBarUnder` guard + the `empty painted box` condition reorder — one function.
3. **5.1** skip `networkidle` for `file:` — 500 ms off every fixture run, one line.
4. **3.3** the memo layer — broad, needs the "no DOM writes after line 102" comment.
5. **5.2** shared browser in MCP — different file, independent of everything above.
6. **4** the tree byte budget — output change, wants a fixtures diff.
7. **3.5**, **3.6**, **3.4** — the remaining constant-factor work.
8. **3.7** `describeSinceLastRun` indexing — only bites on big pages, has the trickiest ordering.
9. **3.9** `describeUnevenSpacing` — decide the trade first, it is the only output loss in section 3.

After 1-5 the 800-row case should be dominated by the linear per-element work again, which is where
the next round would go: `describeElement` does on the order of 40-60 style resolutions per element,
and that is a different design problem — reading each computed style property once into a record
rather than nine functions each reaching for `getComputedStyle` again.

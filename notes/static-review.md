# layout-lens static review — proof pages

Read-only review of `src/inspectLayout.ts` (2780 lines at the time of reading, another agent was
editing so line numbers drift) and `src/inspectPage.ts`. Nothing was run. Every page below is the
smallest thing I could find that makes the named function state something untrue.

Default viewport assumed 1280x720 unless the page says otherwise.

---

## 1. `findScrollLockDialog` / `isPageScrollLocked` — "scroll locked by X" on a page that scrolls

`src/inspectLayout.ts`

```ts
const isPageScrollLocked = [document.documentElement, document.body].some((element) => {
  const style = getComputedStyle(element);
  return style.overflowX === 'hidden' || style.overflowY === 'hidden';
});
```

`body { overflow-x: hidden }` is one of the most copy-pasted rules on the web (kill the horizontal
scrollbar). It blocks nothing vertically. But it flips `isPageScrollLocked`, which then runs
`findScrollLockDialog`, whose whole candidate test is "out of flow, >= 100x100, above the fold,
z-index > 0, paints something". A cookie banner, a fixed sidebar, a sticky toolbar all pass. The
header then reads `scroll locked by div.bar`.

Second effect: `isLockClipper` nulls the clipping ancestor for everything clipped by body or html,
so real horizontal clipping by body goes unreported.

**Claims:** the page's scrolling is frozen, and `div.bar` is the dialog that froze it.
**Truth:** the page scrolls vertically, there is no dialog, and `div.bar` is a cookie banner.

```html
<!doctype html>
<html><head><style>
  body { overflow-x: hidden; margin: 0 }
  .bar { position: fixed; bottom: 0; left: 0; width: 100%; height: 120px; z-index: 50; background: #eee }
</style></head>
<body>
  <div style="height:3000px">tall page, scrolls fine</div>
  <div class="bar">we use cookies</div>
</body></html>
```

---

## 2. `isRtl` — read once from `<html>`, so `dir` on `<body>` or an app wrapper mirrors everything

`src/inspectLayout.ts`

```ts
const isRtl = getComputedStyle(document.documentElement).direction === 'rtl';
```

`direction` inherits downwards. It is never true that the root's direction is the direction of the
element being measured. `dir="rtl"` on `<body>`, or on the app wrapper div (MUI's documented RTL
setup), leaves `isRtl` false for the whole run. Every consumer flips: `describePosition`'s
start/end, `describeInlineOverflow`'s "at start"/"at end", `compareEdges`'s near edge and its
"further start"/"further end", `getGapAlongAxis`, `getCellInk`'s `freeAtEnd`, and the header's own
`ltr, start is left`.

The inner block sits flush against the right edge, which in RTL is the **start** edge.

**Claims:** `[pos: ..., end 0]`, and `ltr, start is left` on the first line.
**Truth:** `start 0, end 350`, on an RTL page.

```html
<!doctype html>
<html><body dir="rtl" style="margin:0">
  <div style="width:400px;height:100px;background:#eee">
    <div style="width:50px;height:50px;background:#333"></div>
  </div>
</body></html>
```

Same shape for overflow. Here the words spill off the **left**, which in RTL is the end:

```html
<!doctype html>
<html><body dir="rtl" style="margin:0">
  <div style="width:200px;overflow:hidden;white-space:nowrap;background:#eee">
    aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj
  </div>
</body></html>
```

Claims `text truncated N hidden at start`. Truth: hidden at the end.

---

## 3. Header `caused by X` — names an element that is clipped, so it causes nothing

`src/inspectLayout.ts`

```ts
const pageWidth = document.documentElement.scrollWidth;
if (pageWidth > window.innerWidth + tolerance) {
  let widest: Element | null = null;
  let widestRight = window.innerWidth;
  for (const element of document.body.querySelectorAll('*')) {
    const right = element.getBoundingClientRect().right;
    if (right > widestRight) { widestRight = right; widest = element; }
  }
  headerFindings.push(`page ${pageWidth} wide, viewport ${window.innerWidth}${widest ? `, caused by ${getIdentifier(widest)}` : ''}`);
}
```

It picks the largest `right` on the page. `getBoundingClientRect` is taken before clipping, so a
carousel track inside `overflow-x: hidden` (or `auto`) wins every time, and a clipped box
contributes nothing to `documentElement.scrollWidth`. Same for `position: fixed`, which is also
excluded from the document's scrollable overflow — an off-canvas drawer parked at `left: 100%` gets
named too. `getVisibleBox` exists in this file and is not used here.

**Claims:** `page 2000 wide, viewport 1280, caused by div.track`.
**Truth:** `div.track` is clipped and adds nothing. `div.wide` is the cause.

```html
<!doctype html>
<html><body style="margin:0">
  <div style="overflow-x:hidden;width:100%">
    <div class="track" style="width:5000px;height:20px;background:#ccc">clipped carousel track</div>
  </div>
  <div class="wide" style="width:2000px;height:20px;background:#f88">the real overflow</div>
</body></html>
```

Fixed variant, same claim:

```html
<!doctype html>
<html><body style="margin:0">
  <div class="drawer" style="position:fixed;top:0;left:100%;width:300px;height:400px;background:#ddd">menu</div>
  <div class="wide" style="width:1400px;height:20px;background:#f88">the real overflow</div>
</body></html>
```

---

## 4. `summarizeFindings` → `describeGroup` — `/N/g` eats a literal capital N out of a name

`src/inspectPage.ts`

```ts
const kind = maskQuotedText(finding).replace(valuePattern, 'N');
...
const rest = valueLists[0]!.slice(1);
let index = 0;
return kind.replace(/N/g, () => (index++ === 0 ? range : rest[index - 2] ?? ''));
```

`N` is used as a placeholder inside a string that still carries element identifiers, and class and
id names keep their case (`stripGeneratedRun` turns `_Nav_1kj7f_2` into `Nav`, styled-components'
`Nav___ED0bX` into `Nav`). The second `N` the regex finds is the one in `Nav`, and it is replaced
with `rest[0]`, which is `''` when the findings carry one number each.

Trace on the page below: two findings, `clipped right 60 by div.Nav` and `clipped right 90 by
div.Nav`. `kind` is `clipped right N by div.Nav`. Range `60 to 90`. Output:

**Claims:** `clipped right 60 to 90 by div.av ×2 — div.a, div.b`
**Truth:** the clipper is `div.Nav`. `div.av` is not on the page.

```html
<!doctype html>
<html><body style="margin:0">
  <div class="Nav" style="width:200px;height:120px;overflow:hidden;background:#eee">
    <section style="width:200px">
      <div class="a" style="width:260px;height:20px;background:#8cf">a</div>
      <div class="b" style="width:290px;height:20px;background:#fc8">b</div>
    </section>
  </div>
</body></html>
```

The grandparent wrapper is deliberate: when the clipper is the direct parent the finding says
`parent` and never names the element.

---

## 5. `isTranslucent` — a `background-image: url(...)` box is called a see-through tint

`src/inspectLayout.ts`

```ts
function isTranslucent(element: Element, coveredRect: DOMRect): boolean {
  if (getEffectiveOpacity(element) < 1) return true;
  const style = getComputedStyle(element);
  const paintsSolid = parseColor(style.backgroundColor)[3] >= 1 || imageTags.has(element.tagName) || hasBorder(style);
  return !paintsSolid && !isGradientCovering(element, style, coveredRect);
}
```

A `<div>` is not in `imageTags`, so a `background-image` never counts as solid, and
`getGradientStops` bails on anything containing `url(`. Every div whose only paint is a raster
background is therefore "translucent". In `describeCoverage` that is not cosmetic: `isTint`
suppresses the whole `text ... hidden by` / `control ... hidden by` branch.

The legend's words for this: *"(translucent) = X is see-through, a tint not a cover"* and *"a
translucent X gets neither this nor text hidden, a tint hides nothing"*.

**Claims:** `all covered by div.cover (translucent) (overlay)`, and no `control "Send" hidden by`.
**Truth:** the button is completely hidden under an opaque image.

Same bug for a gradient whose stops are in px rather than `%` —
`linear-gradient(rgb(0,0,0) 0px, rgb(0,0,0) 100px)` returns no stops and is called translucent too.

```html
<!doctype html>
<html><body style="margin:0;position:relative">
  <button style="position:absolute;top:20px;left:20px;width:120px;height:40px">Send</button>
  <div class="cover" style="position:absolute;top:0;left:0;width:200px;height:100px;
    background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==);
    background-size:cover"></div>
</body></html>
```

---

## 6. `getClippingAncestor` — an ancestor is treated as a clipper without checking the containing block

`src/inspectLayout.ts`

```ts
function getClippingAncestor(element: Element): Element | null {
  let current = getRenderedParent(element);
  while (current) {
    const style = getComputedStyle(current);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return current;
    current = getRenderedParent(current);
  }
  return null;
}
```

CSS 2.1 §11.1.1: an element's clipping region does not apply to a descendant whose containing block
is the viewport or an ancestor of that element. So `overflow: hidden` on a static, untransformed box
does not clip a `position: fixed` descendant at all, and clips an absolute one only when it is in
that descendant's containing-block chain. The walk checks neither. `getVisibleBox` and
`getScrollportBox` share the assumption.

The consequence is not one wrong number. `isFullyClipped` fires, the element gets `all clipped by
div.mask`, `context.skipChildren` is set, and the entire subtree disappears from the tree.

**Claims:** `all clipped by div.mask` and `[children skipped]`.
**Truth:** the modal renders at (300, 200) and every word in it is readable.

```html
<!doctype html>
<html><body style="margin:0">
  <div class="mask" style="width:200px;height:60px;overflow:hidden;background:#eee">
    <div class="modal" style="position:fixed;top:200px;left:300px;width:240px;height:160px;background:#fff;border:1px solid #333">
      <p>I am fully visible</p>
    </div>
  </div>
</body></html>
```

Absolute variant. The badge's containing block is the outer relative div, which is an ancestor of
`.mask`, so `.mask` does not clip it and it renders below the mask:

```html
<!doctype html>
<html><body style="margin:0">
  <div style="position:relative">
    <div class="mask" style="width:200px;height:60px;overflow:hidden;background:#eee">masked</div>
    <span class="badge" style="position:absolute;top:80px;left:0;background:#fc8">badge</span>
  </div>
</body></html>
```

(Move the `<span>` inside `.mask` to get the false `all clipped by div.mask`; kept outside here it
shows the rendered truth for comparison.)

---

## 7. `describeSinceLastRun` / `mergeChangedNumbers` — two different elements merged into one

`src/inspectPage.ts`

```ts
function getFindingShape(line: string): string {
  return replaceMeasurements(line, () => 'N');
}
```

The line being shaped is `${identifier}: ${finding}`, and the identifier carries numbers of its own:
`div:nth-child(3)`, `div.w-60`, `div.col-2`. Every one is treated as a measurement, so two findings
on two different elements match on shape, get paired as "1 changed", and `mergeChangedNumbers`
writes the identifier as a range.

Run the page, insert the `extra` div, run again.

**Claims:** `since last run: 0 gone, 0 new, 1 changed` /
`~ div:nth-child(2 to 3): changed, clipped right 60 by div.Nav`.
**Truth:** an element appeared and a different element now carries the same finding, unchanged.
`div:nth-child(2 to 3)` is not a thing.

```html
<!doctype html>
<html><body style="margin:0">
  <div class="Nav" style="width:200px;height:200px;overflow:hidden;background:#eee">
    <section style="width:200px">
      <!-- second run: add <div style="height:20px">extra</div> here -->
      <div style="height:20px">one</div>
      <div style="width:260px;height:20px;background:#8cf">wide</div>
    </section>
  </div>
</body></html>
```

---

## 8. `getPreviousRunPath` — the run cache is keyed on the raw target, not the resolved url

`src/inspectPage.ts`

```ts
const previousRunPath = getPreviousRunPath([target, viewport.width, viewport.height, runScheme, scroll, !shadow].join('|'));
```

`target` is the unresolved string the user typed. `getTargetUrl` resolves it against the cwd, and
`url` is right there in scope. Two different files both invoked as `layout-lens index.html` from
two directories share one cache file, and the second run's "since last run" is a diff of two
unrelated pages.

**Claims:** `since last run: 12 gone, 9 new` — i.e. an edit changed those findings.
**Truth:** nothing was edited. Two different pages were compared.

```
mkdir -p a b
printf '<div style="width:2000px;height:20px">wide</div>' > a/index.html
printf '<p>nothing wide here</p>'                        > b/index.html
(cd a && layout-lens index.html)   # first run
(cd b && layout-lens index.html)   # diffed against a/index.html
```

---

## 9. `getStackedChildCount` — only `margin-left` and `margin-top`, so an RTL avatar stack is not a stack

`src/inspectLayout.ts`

```ts
children.slice(1).every((child) => {
  const style = getComputedStyle(child);
  return parseFloat(style.marginLeft) < 0 || parseFloat(style.marginTop) < 0;
});
```

In RTL a row of overlapping avatars is pulled together with a negative `margin-right`
(`margin-inline-start` computes to `margin-right` there). The count comes out 0, so no
`[stacked 3]` tag, `isOneOfAStack` is false, and `isDeliberateCoverer` lets the overlap findings
through. Legend: *"sitting on each other is the design, so none of them overlaps, covers or hides
another."*

**Claims:** `overlaps span.av` on the second and third avatar.
**Truth:** they are one stack, drawn that way on purpose.

```html
<!doctype html>
<html dir="rtl"><body style="margin:0">
  <div class="stack" style="display:flex">
    <span class="av" style="width:40px;height:40px;border-radius:50%;background:#8cf"></span>
    <span class="av" style="width:40px;height:40px;border-radius:50%;background:#fc8;margin-right:-12px"></span>
    <span class="av" style="width:40px;height:40px;border-radius:50%;background:#8fc;margin-right:-12px"></span>
  </div>
</body></html>
```

---

## Tail — noted, not worth a proof page on their own

- `getContrastRatio` rounds to one decimal before `contrast < minimumContrast` compares it. A true
  4.46 prints `contrast 4.5` and raises no finding. Rounded value against an unrounded threshold,
  but the window is 0.05 wide.
- `getHiddenPercent` uses `coverer.getBoundingClientRect()`, the coverer's box before its own
  ancestors clip it. A coverer half hidden inside a scroll box reports more of the victim hidden
  than really is.
- `describeFindings` counts siblings that `formatReport` later folds away into `×N similar`, so
  `same as 7 above` can appear with two lines visible above it. The legend says "was already
  printed on N elements".
- The inline truncation branch uses `isClipping = style.overflowX !== 'visible'`, which includes
  `auto` and `scroll`. An `overflow-x: auto` box says `content truncated N hidden at end` for
  content the reader can scroll to. The block-axis branch next to it deliberately excludes scroll
  boxes.
- `getNthChildSuffix` returns `:nth-child(n)` counted over *rendered* children, so for slotted or
  shadow content the selector it prints does not select the element.

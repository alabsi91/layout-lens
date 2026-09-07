export type ElementReport = {
  label: string;
  /** `tag#id.class`, the name the label starts with, without the text preview and the size. */
  identifier: string;
  /** Tag plus first class. Consecutive siblings that share it are the same kind of thing. */
  shapeKey: string;
  tags: string[];
  /** The findings inside the `[!!: ...]` tag, unjoined. A finding can contain a comma itself. */
  findings: string[];
  children: ElementReport[];
};

export type LayoutReport = {
  header: string;
  /** The findings on the first line. They belong to the page, not to any element. */
  headerFindings: string[];
  root: ElementReport;
};

export type InspectOptions = {
  /** Walk open shadow roots and slotted content as the browser renders them. Default `true`. */
  walkShadowRoots: boolean;
  /** The status the server answered the page itself with. `null` when there was no response. */
  httpStatus: number | null;
};

/**
 * Runs inside the page. Everything it needs lives inside the function body
 * because Playwright serializes it as source text.
 */
export function inspectLayout({ walkShadowRoots, httpStatus }: InspectOptions): LayoutReport {
  const tolerance = 1;
  const nearlyCenteredThreshold = 8;
  const freeSpaceThreshold = 8;
  // A hole at the end of every row of a column has to be this wide before anyone sees it as a hole.
  const columnHoleThreshold = 48;
  const coverageSamplesPerAxis = 4;
  // How far inside an edge the extra coverage samples sit. A thin strip taken off it is then found.
  const edgeSampleInset = 1;
  const emptyBoxThreshold = 24;
  // Two painted areas this close in lightness are the same color to the eye. WCAG's number for
  // anything that is not text.
  const nonTextContrastMinimum = 3;
  const offscreenDistance = 10000;
  const maxSeenGapsShown = 12;
  const maxClipVictimsShown = 10;
  const dialogSizeThreshold = 100;
  const maxNameLength = 24;
  // A box this big is an editor sizing hack, not a layout anyone can see.
  const oversizedThreshold = 100000;
  // A box thinner than this on one axis is a bar: a slider track, a progress rail, a divider.
  const thinBarThreshold = 8;
  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'COLGROUP', 'COL']);
  const imageTags = new Set(['IMG', 'VIDEO', 'CANVAS', 'svg', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
  const controlTags = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']);
  // Direction is inherited, so it belongs to the box being measured, not to the page. Reading it
  // once from `html` left every start and end mirrored on a page that sets `dir` on the body or on
  // an app wrapper, which is how most frameworks do it.
  const isRtlIn = (element: Element) => getComputedStyle(element).direction === 'rtl';
  const isPageRtl = isRtlIn(document.body);
  const devicePixelRatio = window.devicePixelRatio;
  const canvasContext = document.createElement('canvas').getContext('2d');

  const findAllElements = (root: DocumentFragment | Document, found: HTMLElement[]): HTMLElement[] => {
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      found.push(element);
      if (element.shadowRoot) findAllElements(element.shadowRoot, found);
    }
    return found;
  };

  const allElements = findAllElements(document, []);

  // elementFromPoint skips pointer-events: none. A floating label or a custom chevron would then
  // read as covered by the input under it. Layout does not depend on pointer-events, and the page is
  // disposable. Turning them back on also puts decorative overlays into the hit stack. Remember
  // which ones were flipped. They can be covered, they never cover anything.
  const flippedPointerEvents = new WeakSet<Element>();
  const deadToPointer = allElements.filter((element) => getComputedStyle(element).pointerEvents === 'none');

  // Every one is read before any is changed. pointer-events inherits. Flipping a parent first would
  // make its children look like they were always hit-testable.
  for (const element of deadToPointer) {
    element.style.setProperty('pointer-events', 'auto', 'important');
    flippedPointerEvents.add(element);
  }

  // Where a sticky element was laid out, which is not where it is drawn. Neither its box nor its
  // offsetTop says. Both carry the offset scrolling gave it. Each one is put back in the flow for a
  // moment and measured. Nothing else on the page moves. A sticky element keeps its place in the
  // flow whether it is stuck or not.
  const laidOutRectBySticky = new Map<Element, DOMRect>();
  for (const element of allElements) {
    if (getComputedStyle(element).position !== 'sticky') continue;

    const inlinePosition = element.style.position;
    const inlinePriority = element.style.getPropertyPriority('position');
    element.style.setProperty('position', 'static', 'important');
    laidOutRectBySticky.set(element, element.getBoundingClientRect());

    if (inlinePosition) {
      element.style.setProperty('position', inlinePosition, inlinePriority);
    } else {
      element.style.removeProperty('position');
    }
  }

  type Box = { top: number; right: number; bottom: number; left: number };

  function round(value: number): number {
    return Math.round(value * 10) / 10;
  }

  function isZeroRect(rect: DOMRect): boolean {
    return rect.width === 0 && rect.height === 0;
  }

  // A slot with a box of its own stays in the tree. The usual one is display: contents and paints
  // nothing. What was put in it stands in its place.
  function isPassThroughSlot(node: Node): node is HTMLSlotElement {
    return node instanceof HTMLSlotElement && isZeroRect(node.getBoundingClientRect());
  }

  // What the element actually shows. A host shows its shadow root, never its own children, and a slot
  // shows what was put in it. Everything else shows its children.
  function getRenderedChildNodes(element: Element): Node[] {
    if (!walkShadowRoots) return [...element.childNodes];
    if (element instanceof HTMLSlotElement) return element.assignedNodes({ flatten: true });

    const nodes: Node[] = [];
    for (const node of (element.shadowRoot ?? element).childNodes) {
      if (isPassThroughSlot(node)) {
        nodes.push(...node.assignedNodes({ flatten: true }));
        continue;
      }
      nodes.push(node);
    }
    return nodes;
  }

  // An svg is a picture. What its shapes do inside it is drawing, not page layout. A chevron parked
  // at x -10 and clipped by a clip-path of its own reported the arrow overflowing its own button.
  function getRenderedChildren(element: Element): Element[] {
    if (element.tagName === 'svg') return [];
    return getRenderedChildNodes(element).filter((node): node is Element => node instanceof Element);
  }

  // Where the element is drawn, which is not where the markup put it. A shadow child sits inside the
  // host, and a slotted element sits where its slot is.
  function getRenderedParent(element: Element): Element | null {
    if (!walkShadowRoots) return element.parentElement;

    const slot = element.assignedSlot;
    if (slot) return isPassThroughSlot(slot) ? getRenderedParent(slot) : slot;

    const parent = element.parentNode;
    if (parent instanceof ShadowRoot) return parent.host;
    return element.parentElement;
  }

  function doesRenderedContain(outer: Element, inner: Element): boolean {
    let current: Element | null = inner;
    while (current) {
      if (current === outer) return true;
      current = getRenderedParent(current);
    }
    return false;
  }

  function getRenderedSiblings(element: Element): Element[] {
    const parent = getRenderedParent(element);
    return parent ? getRenderedChildren(parent) : [element];
  }

  // No size on one axis, and nothing of it is drawn. A flex spacer, a column collapsed to nothing.
  // Whatever is inside it is measured on its own lines instead.
  function isFlat(rect: DOMRect): boolean {
    return rect.width === 0 || rect.height === 0;
  }

  // Everything the page itself wrote passes through one of these two before it reaches a line. The
  // report is read by a model that acts on it, and a page that writes `" [!!: clipped] "` in a
  // paragraph was forging a finding on an element that has none.
  //
  // Words are shown as they are, so anything that could end the quotes or open a tag comes out.
  function sanitizeText(text: string): string {
    return text.replace(/[\p{C}\p{Z}]+/gu, ' ').replace(/["[\]›]/g, '').trim();
  }

  // A name is escaped for a selector, which already neutralizes every character that means
  // something in a line. What escaping leaves is what nobody can see: a newline in an id started a
  // second line at no indent, which reads as another element.
  function sanitizeName(name: string): string {
    return name.replace(/[\p{C}\p{Z}›]+/gu, '');
  }

  function getDirectText(element: Element): string {
    let text = '';
    for (const node of getRenderedChildNodes(element)) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // A run a bundler generated at the end of a name: Header__xm1jd, Nav___ED0bX, _R_3pb5udb_, and
  // styled-components' own sc-6cc20e4a-0. Letters and digits mixed together after a separator is not
  // a name anyone typed.
  const generatedRunPattern = /(?:^|-)sc-[0-9a-z]{6,}(?:-\d+)?$|[_-]{1,3}(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{4,}[_-]*$/;

  // A css modules class: the name a person wrote, wrapped in a hash and the line it came from.
  // _card_1b0yp_73 is card, _Layer_1kj7f_2 is Layer.
  const cssModulePattern = /^_([A-Za-z][A-Za-z0-9]*)_[a-z0-9]{4,}_\d+$/;

  // What is left of a name once the generated run is cut off. Empty when nothing readable remains.
  function stripGeneratedRun(name: string): string {
    const cssModuleName = name.match(cssModulePattern)?.[1];
    if (cssModuleName) return cssModuleName;

    const stripped = name.replace(generatedRunPattern, '');
    if (stripped === name) return name;

    // One letter left over is a leftover, not a name. div.a was never generated and keeps its name.
    const trimmed = stripped.replace(/^[_-]+|[_-]+$/g, '');
    return trimmed.length > 1 ? trimmed : '';
  }

  // A class or an id can hold anything, and border-gray-950/5 is not a selector as written. The
  // printed name is what someone pastes back into --element, so escape what a selector cannot take.
  // An ordinary name comes back unchanged. CSS.escape writes a leading digit as a hex escape ending
  // in a space, which would split the name into two words. The six digit form needs no space.
  function escapeName(name: string): string {
    return CSS.escape(name).replace(/\\([0-9a-f]{1,5}) /gi, (_match, hexDigits: string) => '\\' + hexDigits.padStart(6, '0'));
  }

  // A utility class says how the element is styled, never which element it is. pt-0.5, col-start-4,
  // size-8, md:flex.
  function isUtilityClassName(className: string): boolean {
    return className.length <= 12 && /\d|:/.test(className);
  }

  // Its place among its siblings, for an element whose name says nothing about which one it is.
  // Only when a sibling shares its tag. The one aside in a page is found by being the aside.
  // Empty when there is no twin, and the same element is then named the same way on every run.
  function getNthChildSuffix(element: Element): string {
    const siblings = getRenderedSiblings(element);
    const hasTwin = siblings.some((sibling) => sibling !== element && sibling.tagName === element.tagName);
    if (!hasTwin) return '';

    return `:nth-child(${siblings.indexOf(element) + 1})`;
  }

  // The id and the class names the element is known by, generated runs already off.
  function getNameParts(element: Element): { id: string; classNames: string[] } {
    const rawId = element.id ? sanitizeName(element.id) : '';
    const id = rawId ? stripGeneratedRun(rawId) : '';
    const rawClassNames = typeof element.className === 'string' ? element.className.trim() : '';
    const classNames = rawClassNames ? rawClassNames.split(/\s+/).map(sanitizeName).map(stripGeneratedRun).filter(Boolean) : [];
    return { id, classNames };
  }

  // `tag#id.class`, two classes at most, each name cut to `nameLength` characters.
  function getName(element: Element, nameLength: number): string {
    const { id, classNames } = getNameParts(element);
    let name = element.tagName.toLowerCase();
    if (id) {
      name += '#' + escapeName(id.slice(0, nameLength));
    }

    const shownClassNames = classNames.slice(0, 2);
    if (shownClassNames.length > 0) {
      name += '.' + shownClassNames.map((className) => escapeName(className.slice(0, nameLength))).join('.');
    }
    return name;
  }

  // How much of a long name to keep. Cutting at 24 can give two siblings the same name while they
  // are not the same element, and a finding then names the wrong one. Keep enough to tell them apart.
  function getDistinctNameLength(element: Element): number {
    const shortName = getName(element, maxNameLength);
    const fullName = getName(element, Infinity);
    if (shortName === fullName) return maxNameLength;

    const twins = getRenderedSiblings(element).filter((sibling) => {
      return sibling !== element && getName(sibling, maxNameLength) === shortName && getName(sibling, Infinity) !== fullName;
    });
    if (twins.length === 0) return maxNameLength;

    const longest = Math.max(fullName.length, ...twins.map((twin) => getName(twin, Infinity).length));
    let nameLength = maxNameLength;
    while (nameLength < longest && twins.some((twin) => getName(twin, nameLength) === getName(element, nameLength))) {
      nameLength++;
    }
    return nameLength;
  }

  const identifierByElement = new WeakMap<Element, string>();

  function getIdentifier(element: Element): string {
    const known = identifierByElement.get(element);
    if (known !== undefined) return known;

    let identifier = getName(element, getDistinctNameLength(element));

    // Nothing in the name says which element this is. Its place among its siblings does.
    const { id, classNames } = getNameParts(element);
    const isNamed = id.length > 0 || classNames.some((className) => !isUtilityClassName(className));
    if (!isNamed) {
      identifier += getNthChildSuffix(element);
    }

    identifierByElement.set(element, identifier);
    return identifier;
  }

  function getFirstWords(text: string): string {
    return sanitizeText(text).split(' ').filter(Boolean).slice(0, 4).join(' ');
  }

  function isControl(element: Element): boolean {
    return controlTags.has(element.tagName) || element.getAttribute('role') === 'button';
  }

  // ponytail: a guess, no API reports a closed shadow root. A custom element that draws a box with
  // nothing inside it to explain one is the only signal there is. Drop this if the DOM ever exposes them.
  function isClosedShadowHost(element: Element): boolean {
    if (element.shadowRoot || !element.tagName.includes('-')) return false;
    return getRenderedChildren(element).length === 0 && getDirectText(element).length === 0;
  }

  function getRenderedText(element: Element): string {
    let text = '';
    for (const node of getRenderedChildNodes(element)) {
      if (node instanceof Element) {
        if (skippedTags.has(node.tagName)) continue;
        // A block child starts on its own line. Its words never run into the ones before it.
        const isInline = getComputedStyle(node).display.startsWith('inline');
        text += isInline ? getRenderedText(node) : ` ${getRenderedText(node)} `;
        continue;
      }
      // Text only. Lit leaves a comment marker between every two nodes it rendered.
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
    }
    return text;
  }

  // Every word the element shows, whitespace squashed. A shadow host shows its shadow tree's words.
  function getFlatText(element: Element): string {
    return getRenderedText(element).replace(/\s+/g, ' ').trim();
  }

  function getLabel(element: Element): string {
    const rect = element.getBoundingClientRect();
    let label = getIdentifier(element);

    // A paragraph with code chips in it reads as gibberish from its own text alone. When the element
    // mixes text and elements, preview everything it shows instead.
    const ownText = getDirectText(element);
    const isMixed = ownText.length > 0 && getRenderedChildren(element).length > 0;
    // A shadow host has no words of its own. Its label would say nothing without the shadow tree's.
    const isShadowHost = ownText.length === 0 && walkShadowRoots && element.shadowRoot !== null;
    const preview = isMixed || isShadowHost ? getFlatText(element) : ownText;

    const words = getFirstWords(preview);
    if (words) {
      label += ` "${words}"`;
    }

    return `${label} ${round(rect.width)}x${round(rect.height)}`;
  }

  // Boxes below a rotated element are its tilted bounding box. Below a scaled one they are bigger
  // than their neighbours' for no layout reason. Say so once, on the element.
  function getTransformShape(style: CSSStyleDeclaration): { rotation: number; scale: number } {
    if (style.transform === 'none') return { rotation: 0, scale: 1 };
    const matrix = new DOMMatrix(style.transform);
    const rotation = Math.round(Math.atan2(matrix.b, matrix.a) * (180 / Math.PI) * 10) / 10;
    const scale = Math.round(Math.hypot(matrix.a, matrix.b) * 100) / 100;
    return { rotation, scale };
  }

  function describePadding(style: CSSStyleDeclaration): string | null {
    const values = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map((value) => round(parseFloat(value)));
    if (values.every((value) => value === 0)) return null;

    const [top, right, bottom, left] = values as [number, number, number, number];
    if (top === bottom && left === right) {
      return top === left ? `${top}` : `${top} ${left}`;
    }
    return values.join(' ');
  }

  function getInsetBox(element: Element, includePadding: boolean): Box {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const paddingFactor = includePadding ? 1 : 0;
    return {
      top: rect.top + parseFloat(style.borderTopWidth) + paddingFactor * parseFloat(style.paddingTop),
      right: rect.right - parseFloat(style.borderRightWidth) - paddingFactor * parseFloat(style.paddingRight),
      bottom: rect.bottom - parseFloat(style.borderBottomWidth) - paddingFactor * parseFloat(style.paddingBottom),
      left: rect.left + parseFloat(style.borderLeftWidth) + paddingFactor * parseFloat(style.paddingLeft),
    };
  }

  // The part of the first box that is inside the second. Null when they do not meet at all.
  function intersectBoxes(box: Box, clip: Box): Box | null {
    const top = Math.max(box.top, clip.top);
    const left = Math.max(box.left, clip.left);
    const right = Math.min(box.right, clip.right);
    const bottom = Math.min(box.bottom, clip.bottom);
    if (right <= left || bottom <= top) return null;
    return { top, right, bottom, left };
  }

  // What the element cuts off its own content. Null when it lets everything hang out.
  function getOwnClipBox(element: Element, style: CSSStyleDeclaration, rect: DOMRect): Box | null {
    if (style.overflowX === 'visible' && style.overflowY === 'visible') return null;
    if (isOversized(rect)) return null;
    return getInsetBox(element, false);
  }

  // The part of the element that survives every ancestor that clips. A row scrolled out of its
  // scroll box is not on screen. Nothing below the box covers it, and nothing of it is painted there.
  function getVisibleBox(element: Element, rect: DOMRect): Box | null {
    let box: Box | null = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
    let current = getRenderedParent(element);
    while (current && box) {
      const clipBox = getOwnClipBox(current, getComputedStyle(current), current.getBoundingClientRect());
      if (clipBox) box = intersectBoxes(box, clipBox);
      current = getRenderedParent(current);
    }
    return box;
  }

  // A box that holds a positioned element in place. An absolute element is placed against the
  // nearest positioned ancestor, and a fixed one against the window unless an ancestor is
  // transformed, which pins it to that ancestor instead.
  function holdsPositionedChild(style: CSSStyleDeclaration, forFixed: boolean): boolean {
    const isPinner = style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none' || style.willChange.includes('transform') || style.contain.includes('paint');
    if (forFixed) return isPinner;
    return style.position !== 'static' || isPinner;
  }

  // Where an element is placed from. Null means the window, which nothing on the page can clip.
  function getContainingBlock(element: Element, position: string): Element | null {
    if (position !== 'absolute' && position !== 'fixed') return getRenderedParent(element);

    let current = getRenderedParent(element);
    while (current) {
      if (holdsPositionedChild(getComputedStyle(current), position === 'fixed')) return current;
      current = getRenderedParent(current);
    }
    return null;
  }

  // Overflow only cuts what a box is laid out inside. An absolute element placed against something
  // higher up escapes an `overflow: hidden` box in between, and a fixed one escapes all of them.
  // Reading every ancestor as a clipper hid whole subtrees that were plainly on screen.
  function getClippingAncestor(element: Element): Element | null {
    let current = getContainingBlock(element, getComputedStyle(element).position);
    while (current) {
      const style = getComputedStyle(current);
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        return current;
      }
      // Up the chain of what holds what, not the markup. Everything inside a fixed panel escapes
      // the same boxes the panel escapes.
      current = getContainingBlock(current, style.position);
    }
    return null;
  }

  // left: -10000px and its cousins, the old way to hide something from the eye but not from a screen
  // reader. It is not laid out with the rest of the page and takes part in nothing. Measured from the
  // top left of the page, since a long page reaches far below the viewport by simply being long.
  function isOffscreen(rect: DOMRect): boolean {
    const pageLeft = rect.left + window.scrollX;
    const pageTop = rect.top + window.scrollY;
    return Math.abs(pageLeft) >= offscreenDistance || pageTop <= -offscreenDistance;
  }

  // A box a hundred thousand px across is how a code editor sizes its scrolling surface. Nothing about
  // it being clipped or outside the viewport is a layout fact, on it or against it.
  function isOversized(rect: DOMRect): boolean {
    return rect.width > oversizedThreshold || rect.height > oversizedThreshold;
  }

  // A code editor draws text runs, not UI. Whether they line up with each other is not a layout fact.
  function isEditorContainer(element: Element): boolean {
    const editable = element.getAttribute('contenteditable');
    if (element.getAttribute('role') === 'textbox' || (editable !== null && editable !== 'false')) return true;
    const classNames = typeof element.className === 'string' ? element.className : '';
    return /monaco|cm-content|ProseMirror/.test(classNames);
  }

  // The other way to hide a label from the eye only: a one pixel box, a box with no room inside it
  // that hides what pokes out, or a clip that leaves nothing. Apple's nav labels are 1px wide and 44
  // tall with overflow hidden, and the word the reader sees is drawn by the svg beside them.
  function isScreenReaderOnly(element: Element, rect: DOMRect, style: CSSStyleDeclaration): boolean {
    if (rect.width <= 1 && rect.height <= 1) return true;

    const isHidden = style.overflowX === 'hidden' || style.overflowY === 'hidden';
    if (!isHidden) return false;

    const clipsEverything = style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)' || style.clipPath === 'inset(50%)';
    if (clipsEverything) return true;

    const contentBox = getInsetBox(element, true);
    return contentBox.right - contentBox.left <= 1 || contentBox.bottom - contentBox.top <= 1;
  }

  // Where css places the element from: the viewport for a fixed one, the parent's padding box for an
  // absolute one, the parent's content box for everything else.
  function getPositioningBox(parent: Element, style: CSSStyleDeclaration): Box {
    if (style.position === 'fixed') return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    return getInsetBox(parent, style.position !== 'absolute');
  }

  // A hero image centered in its parent and wider than it runs edge to edge on purpose. The same
  // overhang on both sides is what makes it deliberate. Nothing about it pokes out by mistake.
  function getBleed(element: Element, rect: DOMRect): { block: number; inline: number } {
    const parent = getRenderedParent(element);
    if (!parent) return { block: 0, inline: 0 };

    // A box with no size on an axis is not something anything bleeds out of.
    const box = getPositioningBox(parent, getComputedStyle(element));
    const overhang = (near: number, far: number, parentSize: number) => {
      const isCenteredOverhang = near > tolerance && far > tolerance && Math.abs(near - far) <= tolerance;
      return isCenteredOverhang && parentSize > tolerance ? round((near + far) / 2) : 0;
    };
    return {
      block: overhang(box.top - rect.top, rect.bottom - box.bottom, box.bottom - box.top),
      inline: overhang(box.left - rect.left, rect.right - box.right, box.right - box.left),
    };
  }

  function getBorderSides(style: CSSStyleDeclaration): string[] {
    const sides = ['top', 'right', 'bottom', 'left'];
    return sides.filter((side) => {
      const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
      const borderStyle = style.getPropertyValue(`border-${side}-style`);
      return width > 0 && borderStyle !== 'none';
    });
  }

  function hasBorder(style: CSSStyleDeclaration): boolean {
    return getBorderSides(style).length > 0;
  }

  function describeBorder(style: CSSStyleDeclaration): string | null {
    const sides = getBorderSides(style);
    if (sides.length === 0) return null;
    if (sides.length === 4) return 'border';
    return sides.map((side) => `border-${side}`).join(', ');
  }

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });

  // Paint one pixel and read it back. Handles every syntax the browser does: oklch, color-mix, names.
  function parseColor(color: string): [number, number, number, number] {
    if (!colorContext) return [0, 0, 0, 0];
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = color;
    colorContext.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = colorContext.getImageData(0, 0, 1, 1).data;
    return [red, green, blue, alpha / 255];
  }

  function blendOnto(foreground: [number, number, number, number], background: [number, number, number]): [number, number, number] {
    const alpha = foreground[3];
    return [
      foreground[0] * alpha + background[0] * (1 - alpha),
      foreground[1] * alpha + background[1] * (1 - alpha),
      foreground[2] * alpha + background[2] * (1 - alpha),
    ];
  }

  function getLuminance([red, green, blue]: [number, number, number]): number {
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  }

  type PaintedBackground = { color: [number, number, number]; isApproximate: boolean };

  // A picture that covers the element and is painted below it. The background walk only looks at
  // ancestors. A photo written beside the text in the markup was missed, and the section color under
  // the photo was read as the background. White heading, white background, contrast 1.
  const backdropImageTags = new Set(['IMG', 'PICTURE', 'CANVAS', 'VIDEO']);

  // Found once, with their boxes. A page holds a handful of pictures and thousands of elements with
  // words in them.
  const backdropImages = allElements
    .filter((element) => backdropImageTags.has(element.tagName) && isPainted(element))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }));

  function findImageBehind(element: Element): Element | null {
    const rect = element.getBoundingClientRect();
    for (const image of backdropImages) {
      if (!contains(image.rect, rect)) continue;
      // Written before it, and painted under it. One that holds the element is not behind it. It is
      // the box the element lives in.
      const isEarlier = (element.compareDocumentPosition(image.element) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
      if (isEarlier && !doesRenderedContain(image.element, element)) return image.element;
    }
    return null;
  }

  function getPaintedBackground(element: Element): PaintedBackground | null {
    if (findImageBehind(element)) return null;

    let current: Element | null = element;
    while (current) {
      const style = getComputedStyle(current);
      const color = parseColor(style.backgroundColor);
      const hasImage = style.backgroundImage !== 'none';
      if (hasImage && color[3] === 0) return null;

      if (color[3] >= 1) return { color: [color[0], color[1], color[2]], isApproximate: hasImage };
      const parent = getRenderedParent(current);
      if (color[3] > 0) {
        // The page itself is white under the outermost box. A guess anywhere below a translucent
        // layer makes the color on top of it a guess too. Nothing is reported rather than white.
        const behind = parent ? getPaintedBackground(parent) : { color: [255, 255, 255] as [number, number, number], isApproximate: false };
        if (!behind) return null;
        return { color: blendOnto(color, behind.color), isApproximate: hasImage || behind.isApproximate };
      }
      current = parent;
    }
    return { color: [255, 255, 255], isApproximate: false };
  }

  function toHexColor([red, green, blue]: [number, number, number]): string {
    return '#' + [red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
  }

  function getContrastRatio(textColor: string, background: [number, number, number]): number {
    const foreground = blendOnto(parseColor(textColor), background);
    const lighter = Math.max(getLuminance(foreground), getLuminance(background));
    const darker = Math.min(getLuminance(foreground), getLuminance(background));
    return round((lighter + 0.05) / (darker + 0.05));
  }

  function getUsedFontFamily(style: CSSStyleDeclaration): { family: string; requested: string; isLoaded: boolean } {
    const families = style.fontFamily.split(',').map((family) => sanitizeText(family.trim().replace(/^["']|["']$/g, '')));
    const requested = families[0] ?? '';
    for (const family of families) {
      if (document.fonts.check(`${style.fontSize} "${family}"`)) {
        return { family, requested, isLoaded: family === requested };
      }
    }
    return { family: families[families.length - 1] ?? '', requested, isLoaded: false };
  }

  function getTextLineRects(element: Element): DOMRect[] {
    const rects: DOMRect[] = [];
    for (const node of getRenderedChildNodes(element)) {
      if (node.nodeType !== Node.TEXT_NODE || !(node.textContent ?? '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0) rects.push(rect);
      }
    }
    return rects;
  }

  type EditorContrast = { finding: string; ratio: number; runCount: number };

  // One grey on a thousand code tokens is one finding, and it belongs to the editor, not to the tokens.
  const editorContrastByContainer = new Map<Element, EditorContrast>();

  function recordEditorContrast(container: Element, ratio: number, finding: string): void {
    const group = editorContrastByContainer.get(container);
    if (!group) {
      editorContrastByContainer.set(container, { finding, ratio, runCount: 1 });
      return;
    }
    group.runCount++;
    if (ratio >= group.ratio) return;
    group.finding = finding;
    group.ratio = ratio;
  }

  function describeText(element: Element, rect: DOMRect, editorContainer: Element | null, findings: string[]): string | null {
    const text = getDirectText(element);
    if (!text || !canvasContext) return null;

    const style = getComputedStyle(element);
    const lineRects = getTextLineRects(element);
    if (lineRects.length === 0) return null;

    const lineTops = new Set(lineRects.map((lineRect) => Math.round(lineRect.top)));
    const lineCount = lineTops.size;
    const firstLine = lineRects[0]!;
    const lastLine = lineRects[lineRects.length - 1]!;

    const font = getUsedFontFamily(style);
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = style.lineHeight === 'normal' ? firstLine.height : parseFloat(style.lineHeight);

    // Cap height and baseline, not the actual glyphs. "none" and "Components" must measure the same.
    canvasContext.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px "${font.family}"`;
    const metrics = canvasContext.measureText('H');
    const fontHeight = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    const halfLeading = (firstLine.height - fontHeight) / 2;
    const firstBaseline = firstLine.top + halfLeading + metrics.fontBoundingBoxAscent;
    const lastBaseline = lastLine.top + halfLeading + metrics.fontBoundingBoxAscent;

    // Element children below the words push the box bottom far past the last line, and a baseline
    // measured to it says nothing. Measure against the lines themselves instead.
    const hasElementChildren = getRenderedChildren(element).length > 0;
    const textTop = hasElementChildren ? Math.min(...lineRects.map((lineRect) => lineRect.top)) : rect.top;
    const textBottom = hasElementChildren ? Math.max(...lineRects.map((lineRect) => lineRect.bottom)) : rect.bottom;
    const inkTop = firstBaseline - metrics.actualBoundingBoxAscent - textTop;
    const inkBottom = textBottom - lastBaseline;

    const parts = [`${font.family} ${round(fontSize)}/${round(lineHeight)}`, `ink top ${round(inkTop)}, ink bottom ${round(inkBottom)}`];
    if (lineCount > 1) parts.push(`lines ${lineCount}`);

    if (!font.isLoaded) {
      findings.push(`font "${font.requested}" not loaded, using ${font.family}`);
    }

    const textColor = style.webkitTextFillColor || style.color;
    const background = getPaintedBackground(element);
    if (background && parseColor(textColor)[3] > 0) {
      const contrast = getContrastRatio(textColor, background.color);
      const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && parseInt(style.fontWeight) >= 700);
      const minimumContrast = isLargeText ? 3 : 4.5;
      const shown = `${background.isApproximate ? '~' : ''}${contrast}`;
      parts.push(`contrast ${shown}`);
      if (contrast < minimumContrast && !background.isApproximate) {
        // The two colors the ratio came from. The fix then needs no second look at the css.
        const inkColor = toHexColor(blendOnto(parseColor(textColor), background.color));
        const contrastFinding = `contrast ${contrast} under ${minimumContrast}, ${inkColor} on ${toHexColor(background.color)}`;
        if (editorContainer) {
          recordEditorContrast(editorContainer, contrast, contrastFinding);
        } else {
          findings.push(contrastFinding);
        }
      }
    } else {
      parts.push(background ? 'contrast unknown, transparent text' : 'contrast unknown, image behind');
    }

    // ponytail: ink centering only judged on single-line elements that paint a box, everything else flags constantly.
    // Cap center sits about 0.1em above the line box center in every font. The tolerance scales with the size.
    const isBoxLike = parseColor(style.backgroundColor)[3] > 0 || hasBorder(style);
    // A table cell is as tall as the tallest cell in its row, and top or bottom alignment puts the
    // words against an edge on purpose. The middle of that box is not where anyone aimed them.
    const isAlignedToEdge = style.display === 'table-cell' && style.verticalAlign !== 'middle';
    const inkTolerance = Math.max(tolerance, fontSize * 0.12);
    if (lineCount === 1 && isBoxLike && !isAlignedToEdge) {
      const offCenterBy = (inkTop - inkBottom) / 2;
      if (Math.abs(offCenterBy) > inkTolerance && Math.abs(offCenterBy) <= nearlyCenteredThreshold) {
        findings.push(`text off-center-block ${round(Math.abs(offCenterBy))} ${offCenterBy > 0 ? 'down' : 'up'}`);
      }
    }

    return parts.join(', ');
  }

  function describeRenders(element: Element, style: CSSStyleDeclaration): string | null {
    const painted: string[] = [];
    if (parseColor(style.backgroundColor)[3] > 0 || style.backgroundImage !== 'none') painted.push('background');
    const border = describeBorder(style);
    if (border) painted.push(border);
    if (style.boxShadow !== 'none') painted.push('shadow');
    if (imageTags.has(element.tagName)) painted.push('image');

    return painted.length > 0 ? painted.join(', ') : null;
  }

  // How far the element's own background stands out from what is painted behind it. A seat marked
  // taken and a seat still free were the same grey to the eye at 1.4. Empty when it paints no
  // background of its own, or when a picture behind it makes the color a guess.
  //
  // Only for a box with no words anywhere inside it. The color is the whole message on a swatch, and
  // it is a tint behind the words on a table header or a button, which every page has plenty of.
  function describeBackgroundContrast(element: Element, style: CSSStyleDeclaration): string {
    if (style.backgroundImage !== 'none') return '';
    if (parseColor(style.backgroundColor)[3] === 0) return '';
    if (getFlatText(element).length > 0) return '';

    const parent = getRenderedParent(element);
    const behind = parent ? getPaintedBackground(parent) : null;
    if (!behind || behind.isApproximate) return '';

    const ratio = getContrastRatio(style.backgroundColor, behind.color);
    return ratio < nonTextContrastMinimum ? `, contrast ${ratio} with behind` : '';
  }

  // How big the painted area is, which is not how big the box is. A background, a shadow or four
  // borders fill the whole box. A border on one or two sides paints a line as thick as the border
  // and leaves the middle empty. A column rule 1 wide and 1200 tall is a line, never a box.
  function getPaintedSize(rect: DOMRect, style: CSSStyleDeclaration): { width: number; height: number } {
    const fillsWholeBox =
      parseColor(style.backgroundColor)[3] > 0 ||
      style.backgroundImage !== 'none' ||
      style.boxShadow !== 'none' ||
      getBorderSides(style).length === 4;
    if (fillsWholeBox) return { width: rect.width, height: rect.height };

    const widths = getBorderSides(style).map((side) => parseFloat(style.getPropertyValue(`border-${side}-width`)));
    const thickest = widths.length > 0 ? Math.max(...widths) : 0;
    return { width: Math.min(rect.width, thickest), height: Math.min(rect.height, thickest) };
  }

  // Anything the walk prints inside the element. A row or a body with no box of its own still shows
  // its cells. A table full of text is not empty.
  function hasRenderedContent(element: Element): boolean {
    for (const child of getRenderedChildren(element)) {
      if (skippedTags.has(child.tagName)) continue;
      if (!isFlat(child.getBoundingClientRect())) return true;
      if (hasRenderedContent(child)) return true;
    }
    return false;
  }

  function describeScroll(element: Element, style: CSSStyleDeclaration): string | null {
    const scrollValues = new Set(['auto', 'scroll']);
    const scrollsX = scrollValues.has(style.overflowX) && element.scrollWidth > element.clientWidth + tolerance;
    const scrollsY = scrollValues.has(style.overflowY) && element.scrollHeight > element.clientHeight + tolerance;
    if (!scrollsX && !scrollsY) return null;

    const horizontalBorders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalBorders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const barWidth = scrollsY
      ? (element as HTMLElement).offsetWidth - element.clientWidth - horizontalBorders
      : (element as HTMLElement).offsetHeight - element.clientHeight - verticalBorders;

    const axes: string[] = [];
    if (scrollsX) axes.push(`x ${round(element.scrollWidth)} in ${round(element.clientWidth)}`);
    if (scrollsY) axes.push(`y ${round(element.scrollHeight)} in ${round(element.clientHeight)}`);

    const parts = [axes.join(', '), `bar ${round(Math.max(0, barWidth))}`];
    const children = countChildrenOutOfView(element);
    if (children.out > 0) parts.push(`${children.out} of ${children.total} children out`);

    return parts.join(', ');
  }

  // A scroll box is meant to hold more than it shows. Its own children do not each report being out
  // of view. The count sits here instead.
  function countChildrenOutOfView(element: Element): { out: number; total: number } {
    const visibleBox = getInsetBox(element, false);
    let out = 0;
    let total = 0;
    for (const child of getRenderedChildren(element)) {
      if (skippedTags.has(child.tagName)) continue;
      const childRect = child.getBoundingClientRect();
      if (isFlat(childRect)) continue;
      total++;
      const isInside =
        childRect.top >= visibleBox.top - tolerance &&
        childRect.bottom <= visibleBox.bottom + tolerance &&
        childRect.left >= visibleBox.left - tolerance &&
        childRect.right <= visibleBox.right + tolerance;
      if (!isInside) out++;
    }
    return { out, total };
  }

  function describeAxis(nearName: string, farName: string, near: number, far: number, elementSize: number, axisName: string, neighbours: AxisNeighbours, isOutOfFlow: boolean, findings: string[]): string {
    const isStacked = neighbours.isStacked;
    const isFilling = Math.abs(near) <= tolerance && Math.abs(far) <= tolerance;
    if (isFilling) return `fills-${axisName}`;

    const offCenterBy = (near - far) / 2;
    // Centered means the two offsets agree. The tolerance belongs on the difference between them,
    // never on half of it: 9 above and 7 below is a 2px miss, and printing the mean called it 8 and 8.
    // The middle one of five stacked siblings is not "centered", it is third. Nearest edge instead.
    if (Math.abs(near - far) <= tolerance && !isStacked) {
      return `centered-${axisName} ${round((near + far) / 2)}`;
    }

    // A modal 20 off center in a 1280 viewport is still "meant to be centered". Scale with the parent.
    const parentSize = near + far + elementSize;
    const threshold = Math.max(nearlyCenteredThreshold, parentSize * 0.05);
    const touchesNear = Math.abs(near) <= tolerance;
    const touchesFar = Math.abs(far) <= tolerance;

    // Alone on its axis, touching one edge, a little slack at the other. Say both numbers. The slack is the fact.
    const slackLimit = parentSize * 0.25;
    if (!isStacked && touchesNear && Math.abs(far) <= slackLimit) return `${nearName} 0, ${farName} ${round(far)}`;
    if (!isStacked && touchesFar && Math.abs(near) <= slackLimit) return `${nearName} ${round(near)}, ${farName} 0`;

    // A close button 14 from the corner of a drawer was pinned there, not centered badly. Something
    // sitting closer to an edge than it is big was placed against that edge.
    const isCornerPinned = isOutOfFlow && Math.min(Math.abs(near), Math.abs(far)) < elementSize;

    const direction = offCenterBy > 0 ? (axisName === 'block' ? 'down' : 'toward end') : axisName === 'block' ? 'up' : 'toward start';
    const isOffCenter = Math.abs(offCenterBy) > tolerance && Math.abs(offCenterBy) <= threshold && !touchesNear && !touchesFar;
    const offCenterFinding = `off-center-${axisName} ${round(Math.abs(offCenterBy))} ${direction}`;

    if (!isStacked && !isCornerPinned && isOffCenter) {
      findings.push(offCenterFinding);
    }

    // The middle one of three, with the outer two flush against the parent's two edges. It was meant
    // to sit in the middle of the parent, and a row with a fixed gap puts it off center as soon as
    // the two sides come out different widths. Nothing said so while a sibling shared the axis.
    //
    // Across the page only. A stack grows downwards from the top and the middle of it sits wherever
    // the height above it left it. Nothing was ever centered there to go wrong.
    //
    // This is the opposite of the plain off-center rule above. There the element is centered and
    // nearly right, and a big miss means it was never meant to be centered. Under 8 nobody sees it.
    // Past a quarter of the parent the middle one is not near the middle at all, and the row was
    // laid out to some other plan. A chat column between a rail and a panel read 546.6 off center.
    //
    // The two gaps have to match as well. The three then sit against each other with one fixed gap
    // and the only thing that can push the middle one off center is the widths of the outer two. One
    // gap of 16 and another of 206 is a row packed against one edge, and nothing there was centered.
    //
    // A run of words on one side is not a row of three. A link in the middle of a sentence sits
    // where the words before it left it, and the middle of the paragraph is not a place anyone
    // aimed at. A link in a Wikipedia sentence read as 100.4 off center.
    const hasEvenGaps = Math.abs(neighbours.gapBefore - neighbours.gapAfter) <= tolerance;
    const hasElementsBothSides = !neighbours.isNearestBeforeTextRun && !neighbours.isNearestAfterTextRun;
    const isMiddleChild =
      axisName === 'inline' && neighbours.beforeCount === 1 && neighbours.afterCount === 1 && neighbours.isRowSpanningParent && hasEvenGaps && hasElementsBothSides;
    const middleChildLimit = parentSize * 0.25;
    const isMiddleChildOffCenter =
      Math.abs(offCenterBy) > nearlyCenteredThreshold && Math.abs(offCenterBy) <= middleChildLimit && !touchesNear && !touchesFar;
    if (isStacked && isMiddleChild && isMiddleChildOffCenter && neighbours.nearestBefore && neighbours.nearestAfter) {
      findings.push(`${offCenterFinding}, siblings ${neighbours.nearestBefore} and ${neighbours.nearestAfter}`);
    }

    return Math.abs(near) <= Math.abs(far) ? `${nearName} ${round(near)}` : `${farName} ${round(far)}`;
  }

  type AxisNeighbours = {
    /** Something sits before or after it on this axis. It was not placed on the axis by itself. */
    isStacked: boolean;
    beforeCount: number;
    afterCount: number;
    /** The nearest one on each side, in reading order. Empty when that side is empty. */
    nearestBefore: string;
    nearestAfter: string;
    /** That nearest one is a run of words rather than an element. */
    isNearestBeforeTextRun: boolean;
    isNearestAfterTextRun: boolean;
    /** Those two sit flush against the parent's two edges. The middle of the parent is then the middle of the row. */
    isRowSpanningParent: boolean;
    /** The space to the nearest sibling on each side. Infinity when that side is empty. */
    gapBefore: number;
    gapAfter: number;
  };

  function getAxisNeighbours(element: Element, rect: DOMRect): { block: AxisNeighbours; inline: AxisNeighbours } {
    const emptyAxis = (): AxisNeighbours => ({ isStacked: false, beforeCount: 0, afterCount: 0, nearestBefore: '', nearestAfter: '', isNearestBeforeTextRun: false, isNearestAfterTextRun: false, isRowSpanningParent: false, gapBefore: Infinity, gapAfter: Infinity });
    const axes = { block: emptyAxis(), inline: emptyAxis() };
    const parent = getRenderedParent(element);
    if (!parent) return axes;

    // An absolute or fixed element is placed against a box of its own. Nothing beside it pushed it
    // there. It is never the third of five, whatever the children around it do.
    const style = getComputedStyle(element);
    if (style.position === 'absolute' || style.position === 'fixed') return axes;

    // The words around an inline link are siblings too. A link in the middle of a sentence has text
    // before it and after it. It was never placed on that axis by itself.
    type Neighbour = { rect: DOMRect; name: string; isTextRun: boolean };
    const siblings: Neighbour[] = [];
    for (const node of getRenderedChildNodes(parent)) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const textRect = range.getBoundingClientRect();
        if (!isZeroRect(textRect)) siblings.push({ rect: textRect, name: 'text', isTextRun: true });
        continue;
      }
      if (!(node instanceof Element) || node === element || skippedTags.has(node.tagName)) continue;
      const siblingStyle = getComputedStyle(node);
      if (siblingStyle.position === 'absolute' || siblingStyle.position === 'fixed') continue;
      const siblingRect = node.getBoundingClientRect();
      if (isFlat(siblingRect)) continue;
      siblings.push({ rect: siblingRect, name: getIdentifier(node), isTextRun: false });
    }

    // The nearest one on each side. The finding can then name what the element sits between, and
    // how far that one is from the parent's own edge on the far side of it.
    const contentBox = getInsetBox(parent, true);
    const nearest = { blockBefore: Infinity, blockAfter: Infinity, inlineBefore: Infinity, inlineAfter: Infinity };
    const outerGaps = { blockBefore: Infinity, blockAfter: Infinity, inlineBefore: Infinity, inlineAfter: Infinity };
    const record = (axis: AxisNeighbours, side: 'Before' | 'After', key: 'block' | 'inline', sibling: Neighbour, distance: number, outerGap: number) => {
      if (side === 'Before') axis.beforeCount++;
      else axis.afterCount++;
      axis.isStacked = true;

      const sideKey = `${key}${side}` as keyof typeof nearest;
      if (distance >= nearest[sideKey]) return;
      nearest[sideKey] = distance;
      outerGaps[sideKey] = outerGap;
      if (side === 'Before') {
        axis.nearestBefore = sibling.name;
        axis.isNearestBeforeTextRun = sibling.isTextRun;
        axis.gapBefore = distance;
      } else {
        axis.nearestAfter = sibling.name;
        axis.isNearestAfterTextRun = sibling.isTextRun;
        axis.gapAfter = distance;
      }
    };

    for (const sibling of siblings) {
      const siblingRect = sibling.rect;
      if (siblingRect.bottom <= rect.top + tolerance) {
        record(axes.block, 'Before', 'block', sibling, rect.top - siblingRect.bottom, siblingRect.top - contentBox.top);
      }
      if (siblingRect.top >= rect.bottom - tolerance) {
        record(axes.block, 'After', 'block', sibling, siblingRect.top - rect.bottom, contentBox.bottom - siblingRect.bottom);
      }

      const startGap = siblingRect.left - contentBox.left;
      const endGap = contentBox.right - siblingRect.right;
      if (siblingRect.right <= rect.left + tolerance) {
        const side = isRtlIn(parent) ? 'After' : 'Before';
        record(axes.inline, side, 'inline', sibling, rect.left - siblingRect.right, startGap);
      }
      if (siblingRect.left >= rect.right - tolerance) {
        const side = isRtlIn(parent) ? 'Before' : 'After';
        record(axes.inline, side, 'inline', sibling, siblingRect.left - rect.right, endGap);
      }
    }

    // A row packed against one edge with slack at the other was never centered on anything. The one
    // in the middle of it is where the ones beside it left it. A row that reaches both edges was.
    //
    // A table row is never one of those. A table sizes every column to the widest thing in it. The
    // middle cell sits where the columns left it, and the middle of the row is not a place anyone aimed at.
    const isTableCell = style.display === 'table-cell';
    axes.block.isRowSpanningParent = !isTableCell && Math.abs(outerGaps.blockBefore) <= tolerance && Math.abs(outerGaps.blockAfter) <= tolerance;
    axes.inline.isRowSpanningParent = !isTableCell && Math.abs(outerGaps.inlineBefore) <= tolerance && Math.abs(outerGaps.inlineAfter) <= tolerance;
    return axes;
  }

  // A fixed element is laid out against the viewport, not its DOM parent.
  function describePosition(element: Element, rect: DOMRect, parent: Element, style: CSSStyleDeclaration, findings: string[]): string {
    const contentBox = getPositioningBox(parent, style);
    const top = rect.top - contentBox.top;
    const bottom = contentBox.bottom - rect.bottom;
    const isRtl = isRtlIn(parent);
    const start = isRtl ? contentBox.right - rect.right : rect.left - contentBox.left;
    const end = isRtl ? rect.left - contentBox.left : contentBox.right - rect.right;

    // What sits before and after it on each axis. Something stacked between siblings was not placed
    // in the middle of the parent, unless it has as many siblings on one side as on the other.
    const neighbours = getAxisNeighbours(element, rect);
    const isOutOfFlow = style.position === 'absolute' || style.position === 'fixed';
    const block = describeAxis('top', 'bottom', top, bottom, rect.height, 'block', neighbours.block, isOutOfFlow, findings);
    const inline = describeAxis('start', 'end', start, end, rect.width, 'inline', neighbours.inline, isOutOfFlow, findings);

    // A fixed element is placed against the viewport, not against anything on the page. Without
    // this, bottom 0 on a bar reads as the bottom of whatever holds it.
    if (style.position === 'fixed') {
      if (block === 'fills-block' && inline === 'fills-inline') return 'fills viewport';
      return `${block} of viewport, ${inline} of viewport`;
    }

    if (block === 'fills-block' && inline === 'fills-inline') return 'fills';
    return `${block}, ${inline}`;
  }

  const paintedBoundsByElement = new Map<Element, Box | null>();

  // Hidden from the eye and kept for a screen reader. None of it is ink. Its box is a pixel but the
  // words inside it are laid out at full size, and a range around them reports where they would have
  // been. Apple's "Apple Card" label added 92px of invisible text to the heading above it.
  function isHiddenFromEye(element: Element, rect: DOMRect): boolean {
    return isOffscreen(rect) || isScreenReaderOnly(element, rect, getComputedStyle(element));
  }

  // Where the ink actually is. An element that paints something contributes its whole box. The
  // border edge is where the eye stops. Text contributes the lines, not the box around them.
  // Descendants are merged in, and a padded wrapper with no background of its own reports what sits
  // inside it.
  function getPaintedBounds(element: Element): Box | null {
    const cached = paintedBoundsByElement.get(element);
    if (cached !== undefined) return cached;

    let bounds: Box | null = null;
    const merge = (box: Box) => {
      if (box.right <= box.left && box.bottom <= box.top) return;
      bounds = bounds === null ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left } : {
        top: Math.min(bounds.top, box.top),
        right: Math.max(bounds.right, box.right),
        bottom: Math.max(bounds.bottom, box.bottom),
        left: Math.min(bounds.left, box.left),
      };
    };

    const rect = element.getBoundingClientRect();
    if (!skippedTags.has(element.tagName) && isPainted(element) && !isHiddenFromEye(element, rect)) {
      const style = getComputedStyle(element);
      const borderSides = getBorderSides(style);
      const fillsWholeBox =
        parseColor(style.backgroundColor)[3] > 0 ||
        style.backgroundImage !== 'none' ||
        style.boxShadow !== 'none' ||
        imageTags.has(element.tagName) ||
        borderSides.length === 4;

      // An editor's scrolling surface is a hundred thousand px of nothing. What is inside it is the ink.
      if (!isOversized(rect)) {
        if (fillsWholeBox) {
          merge(rect);
        } else {
          // A border on one side paints that edge and nothing else. The middle of the box is empty.
          for (const side of borderSides) {
            const width = parseFloat(style.getPropertyValue(`border-${side}-width`));
            if (side === 'top') merge({ top: rect.top, right: rect.right, bottom: rect.top + width, left: rect.left });
            if (side === 'bottom') merge({ top: rect.bottom - width, right: rect.right, bottom: rect.bottom, left: rect.left });
            if (side === 'left') merge({ top: rect.top, right: rect.left + width, bottom: rect.bottom, left: rect.left });
            if (side === 'right') merge({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.right - width });
          }
        }
      }

      // Everything it draws inside itself stops at its own edge when it clips. A table 816 tall in a
      // 420 tall scroll box paints 420 of ink, not 816.
      const ownClipBox = getOwnClipBox(element, style, rect);
      const mergeInside = (box: Box) => {
        const visible = ownClipBox ? intersectBoxes(box, ownClipBox) : box;
        if (visible) merge(visible);
      };

      for (const lineRect of getTextLineRects(element)) mergeInside(lineRect);
      for (const child of getRenderedChildren(element)) {
        const childBounds = getPaintedBounds(child);
        if (childBounds) mergeInside(childBounds);
      }
    }

    paintedBoundsByElement.set(element, bounds);
    return bounds;
  }

  // Placed against a box of its own. Nothing that holds it laid it out. A badge pinned past the
  // corner of a card is not the card's content, and neither is a tooltip hanging out of one.
  function isPlacedOutOfFlow(element: Element): boolean {
    const position = getComputedStyle(element).position;
    return position === 'absolute' || position === 'fixed';
  }

  const paintedSubtreeBoxByElement = new Map<Element, Box | null>();

  // The box around the element and everything it lays out under it that is drawn. A subtree that is
  // hidden, parked offscreen, bleeding on purpose or placed out of the flow is left out. Null when
  // nothing of it shows. A tooltip hanging out of a card is placed against a box of its own, and the
  // page around the card was reporting the tooltip as content that overflowed it.
  function getPaintedSubtreeBox(element: Element): Box | null {
    const cached = paintedSubtreeBoxByElement.get(element);
    if (cached !== undefined) return cached;

    const rect = element.getBoundingClientRect();
    let box: Box | null = null;
    if (!skippedTags.has(element.tagName) && isPainted(element) && !isHiddenFromEye(element, rect)) {
      if (!isFlat(rect)) box = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };

      // A child cut off by this element stops at this element's edge. A code line 959 wide in a
      // scroll box 498 wide is 498 of drawn content, and nothing above it overflows because of it.
      const ownClipBox = getOwnClipBox(element, getComputedStyle(element), rect);

      for (const child of getRenderedChildren(element)) {
        const childRect = child.getBoundingClientRect();
        if (isOversized(childRect) || getBleed(child, childRect).inline > 0) continue;
        if (isPlacedOutOfFlow(child)) continue;
        const rawChildBox = getPaintedSubtreeBox(child);
        const childBox = rawChildBox && ownClipBox ? intersectBoxes(rawChildBox, ownClipBox) : rawChildBox;
        if (!childBox) continue;
        box = box === null ? childBox : {
          top: Math.min(box.top, childBox.top),
          right: Math.max(box.right, childBox.right),
          bottom: Math.max(box.bottom, childBox.bottom),
          left: Math.min(box.left, childBox.left),
        };
      }
    }

    paintedSubtreeBoxByElement.set(element, box);
    return box;
  }

  // What the element draws inside itself: the boxes of the children it lays out. An absolute or
  // fixed child is placed against the padding box on its own, and its own line says where it landed.
  // It is not this element's content.
  function getContentChildBoxes(element: Element): Box[] {
    const boxes: Box[] = [];
    for (const child of getRenderedChildren(element)) {
      const childRect = child.getBoundingClientRect();
      if (isOversized(childRect) || getBleed(child, childRect).inline > 0) continue;
      if (isPlacedOutOfFlow(child)) continue;

      const childBox = getPaintedSubtreeBox(child);
      if (childBox) boxes.push(childBox);
    }
    return boxes;
  }

  /** How far the drawn content pokes past a box on one axis, each side on its own. */
  type ContentOverflow = { pastNear: number; pastFar: number };

  /** How far it pokes out and on which side, in reading order. */
  type OverflowSide = { amount: number; side: string };

  // How far the drawn content pokes past the given box, on one axis. Only the element's own text
  // lines and the children it lays out are measured. A hidden dropdown reached 962 past the end of
  // its row and nothing was wrong with the row. scrollWidth counts a pseudo element and an absolute
  // descendant, which are not the content this box lays out. The tail on a speech bubble is not the
  // bubble overflowing.
  function getPaintedContentOverflow(element: Element, box: Box, axis: 'block' | 'inline'): ContentOverflow {
    const isBlock = axis === 'block';
    const boxNear = isBlock ? box.top : box.left;
    const boxFar = isBlock ? box.bottom : box.right;

    let near = boxNear;
    let far = boxFar;
    for (const childBox of [...getContentChildBoxes(element), ...getTextLineRects(element)]) {
      near = Math.min(near, isBlock ? childBox.top : childBox.left);
      far = Math.max(far, isBlock ? childBox.bottom : childBox.right);
    }

    return { pastNear: boxNear - near, pastFar: far - boxFar };
  }

  // Which side it went out of, in reading order. Null when it stays inside. A side under the
  // tolerance is not spilling, and its number belongs to it rather than to the other side. A header
  // written top to bottom pokes out 2 at one side and 0.2 at the other, and 2.2 at start is a number
  // nothing on the page has.
  function describeInlineOverflow({ pastNear, pastFar }: ContentOverflow, box: Element): OverflowSide | null {
    const isRtl = isRtlIn(box);
    const atStart = isRtl ? pastFar : pastNear;
    const atEnd = isRtl ? pastNear : pastFar;
    if (atStart > tolerance && atEnd > tolerance) return { amount: round(atStart + atEnd), side: ' at both' };
    if (atStart > tolerance) return { amount: round(atStart), side: ' at start' };
    if (atEnd > tolerance) return { amount: round(atEnd), side: ' at end' };
    return null;
  }

  // Above and below, never start and end. A line cut off the bottom of a clamped paragraph did not
  // run past the end of anything, and the reader should not have to work out which axis was meant.
  function describeBlockOverflow({ pastNear, pastFar }: ContentOverflow): OverflowSide | null {
    if (pastNear > tolerance && pastFar > tolerance) return { amount: round(pastNear + pastFar), side: ' above and below' };
    if (pastNear > tolerance) return { amount: round(pastNear), side: ' above' };
    if (pastFar > tolerance) return { amount: round(pastFar), side: ' below' };
    return null;
  }

  function collapseRuns(values: number[]): string {
    const runs: string[] = [];
    let runValue = round(values[0]!);
    let runLength = 0;
    for (const value of values) {
      if (round(value) === runValue) {
        runLength++;
        continue;
      }
      runs.push(runLength > 1 ? `${runValue} ×${runLength}` : `${runValue}`);
      runValue = round(value);
      runLength = 1;
    }
    runs.push(runLength > 1 ? `${runValue} ×${runLength}` : `${runValue}`);
    return runs.join(', ');
  }

  // A list of a hundred numbers is not read by anyone. Say the first twelve and stop.
  function capList(list: string): string {
    const entries = list.split(', ');
    if (entries.length <= maxSeenGapsShown) return list;
    return entries.slice(0, maxSeenGapsShown).join(', ') + ', …';
  }

  function getMedian(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle]!;
    return (sorted[middle - 1]! + sorted[middle]!) / 2;
  }

  // One gap much tighter than the rhythm of the others, along one axis. Judged on what is painted.
  // Children whose boxes touch are spaced by the padding inside them, and their boxes say nothing
  // about it. Nothing is said when the box gaps are as tight, the gaps list already shows it.
  //
  // Two things make it noise instead. Every box gap the same and not zero is a fixed gap. The
  // spacing is even, and what is left between the painted areas is how wide the words came out. More
  // than one gap breaking the rhythm is two rhythms mixed together, not one gap gone wrong.
  function describeUnevenSpacing({ gaps: boxGaps, seenGaps, gapPairs }: GapList): { text: string; ratio: number } | null {
    if (seenGaps.length < 3) return null;

    const firstBoxGap = boxGaps[0]!;
    const isFixedGap = Math.abs(firstBoxGap) > tolerance && boxGaps.every((gap) => Math.abs(gap - firstBoxGap) <= tolerance);
    if (isFixedGap) return null;

    const isTooTight = (gap: number, median: number) => median > tolerance && gap < median / 2;
    let tightest: { text: string; ratio: number } | null = null;
    let tightCount = 0;

    for (let index = 0; index < seenGaps.length; index++) {
      const others = seenGaps.filter((_, otherIndex) => otherIndex !== index);
      // The others have to be a rhythm before one gap can break it. 10, 10, 72 has no normal in it.
      const doOthersAgree = Math.max(...others) <= Math.min(...others) * 3;
      if (!doOthersAgree) continue;

      const median = getMedian(others);
      const gap = seenGaps[index]!;
      // A negative gap means the two painted areas overlap. That is not spacing, and overlaps says it.
      if (gap < 0 || !isTooTight(gap, median)) continue;

      tightCount++;
      const boxMedian = getMedian(boxGaps.filter((_, otherIndex) => otherIndex !== index));
      if (isTooTight(boxGaps[index]!, boxMedian)) continue;

      const ratio = gap / median;
      if (tightest && ratio >= tightest.ratio) continue;
      const [before, after] = gapPairs[index]!;
      tightest = { text: `uneven spacing, ${round(gap)} between ${before} and ${after}, others ${round(median)}`, ratio };
    }

    return tightCount === 1 ? tightest : null;
  }

  type GapList = { gaps: number[]; seenGaps: number[]; gapPairs: [string, string][] };

  type ChildLayout = {
    /** Down the page: between the children of a stack, or between the rows of a grid. */
    rowGaps: GapList;
    /** Across the page: between children sitting side by side in the same row. */
    columnGaps: GapList;
    /** The children sit in more than one row and more than one column. */
    isGrid: boolean;
    isVerticalStack: boolean;
    freeBefore: number;
    freeAfter: number;
  };

  type LaidOutChild = { rect: DOMRect; paintedBounds: Box; name: string };

  const childLayoutByElement = new Map<Element, ChildLayout | null>();

  // How the in-flow children sit inside the element: the gaps between them, whether they stack or
  // sit side by side, and the room left over above the first and below the last.
  function getChildLayout(element: Element): ChildLayout | null {
    const cached = childLayoutByElement.get(element);
    if (cached !== undefined) return cached;

    const layout = measureChildLayout(element);
    childLayoutByElement.set(element, layout);
    return layout;
  }

  function measureChildLayout(element: Element): ChildLayout | null {
    if (element.tagName === 'svg') return null;

    // Text nodes take room between children too. Ignore whatever the tree walk ignores. Ignore
    // sticky children too, they are drawn away from where they were laid out.
    const outOfFlow = new Set(['absolute', 'fixed', 'sticky']);
    const children: LaidOutChild[] = [];
    for (const node of getRenderedChildNodes(element)) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (isZeroRect(rect)) continue;
        children.push({ rect, paintedBounds: rect, name: 'text' });
        continue;
      }
      if (!(node instanceof Element) || skippedTags.has(node.tagName)) continue;
      if (outOfFlow.has(getComputedStyle(node).position)) continue;
      const rect = node.getBoundingClientRect();
      if (isFlat(rect) || isOffscreen(rect)) continue;
      children.push({ rect, paintedBounds: getPaintedBounds(node) ?? rect, name: getIdentifier(node) });
    }
    if (children.length === 0) return null;

    const isRtl = isRtlIn(element);
    const rowGaps = measureGaps(children, 'block', isRtl);
    const columnGaps = measureGaps(children, 'inline', isRtl);
    const isVerticalStack = columnGaps.gaps.length === 0;
    // Children in more than one row and more than one column. A grid, or a flex row that wrapped.
    const isGrid = rowGaps.gaps.length > 0 && columnGaps.gaps.length > 0;

    // Room left over inside a vertical stack, before the first child and after the last. Says where
    // justify-content or a short list put the slack. 258 free after a nav packed at the top is a fact.
    // Rows are left alone. Slack after the last item in a row is every left-aligned row on the web.
    let freeBefore = 0;
    let freeAfter = 0;
    if (isVerticalStack && children.length >= 2 && getRenderedChildren(element).length >= 2) {
      const contentBox = getInsetBox(element, true);
      freeBefore = Math.min(...children.map((child) => child.rect.top)) - contentBox.top;
      freeAfter = contentBox.bottom - Math.max(...children.map((child) => child.rect.bottom));
    }

    return { rowGaps, columnGaps, isGrid, isVerticalStack, freeBefore, freeAfter };
  }

  // Whether the two children share a band across the other axis. One can then sit next to the other
  // on this one. The last cell of a grid row and the first of the next share no band, and the
  // distance between them is not a gap. MDN's four column footer reported 97 there and called it spacing.
  function doShareBand(a: LaidOutChild, b: LaidOutChild, axis: 'block' | 'inline'): boolean {
    if (axis === 'block') return a.rect.left < b.rect.right - tolerance && b.rect.left < a.rect.right - tolerance;
    return a.rect.top < b.rect.bottom - tolerance && b.rect.top < a.rect.bottom - tolerance;
  }

  // How far after `a` the child `b` starts, along the axis. Negative when b starts before a ends.
  function getGapAlongAxis(a: Box, b: Box, axis: 'block' | 'inline', isRtl: boolean): number {
    if (axis === 'block') return b.top - a.bottom;
    return isRtl ? a.left - b.right : b.left - a.right;
  }

  // The gaps between neighbours along one axis. A child's neighbour is the nearest one that shares a
  // band with it and starts after it ends, with nothing in between. Ties keep every neighbour. A
  // tall column next to two boxes at the same distance has two of them.
  function measureGaps(children: LaidOutChild[], axis: 'block' | 'inline', isRtl: boolean): GapList {
    const pairs: { before: LaidOutChild; after: LaidOutChild; gap: number }[] = [];
    for (const before of children) {
      let nearest = Infinity;
      for (const after of children) {
        if (after === before || !doShareBand(before, after, axis)) continue;
        const gap = getGapAlongAxis(before.rect, after.rect, axis, isRtl);
        if (gap >= -tolerance && gap < nearest) nearest = gap;
      }
      if (nearest === Infinity) continue;

      for (const after of children) {
        if (after === before || !doShareBand(before, after, axis)) continue;
        const gap = getGapAlongAxis(before.rect, after.rect, axis, isRtl);
        if (gap <= nearest + tolerance && gap >= -tolerance) pairs.push({ before, after, gap });
      }
    }

    // In reading order. The list runs the way the eye does, down the page on the block axis and
    // start to end on the inline one, which is right to left on an rtl page.
    const inReadingOrder = (child: LaidOutChild, onAxis: 'block' | 'inline') => (onAxis === 'block' ? child.rect.top : isRtl ? -child.rect.right : child.rect.left);
    const acrossAxis = axis === 'block' ? 'inline' : 'block';

    // Which row a pair sits in, which comes before where it sits inside that row. A row is where the
    // children sharing a band with this one start. Two children of one row have different tops as
    // soon as the row centers them, and ordering on the raw top put a row label behind every seat
    // beside it. On an rtl page the first gap in the list was the last one on screen.
    const bandStartByChild = new Map<LaidOutChild, number>();
    for (const child of children) {
      const band = children.filter((other) => other === child || doShareBand(child, other, axis));
      bandStartByChild.set(child, Math.min(...band.map((other) => inReadingOrder(other, acrossAxis))));
    }

    pairs.sort((a, b) => bandStartByChild.get(a.before)! - bandStartByChild.get(b.before)! || inReadingOrder(a.before, axis) - inReadingOrder(b.before, axis));

    const list: GapList = { gaps: [], seenGaps: [], gapPairs: [] };
    for (const { before, after, gap } of pairs) {
      list.gaps.push(gap);
      list.seenGaps.push(getGapAlongAxis(before.paintedBounds, after.paintedBounds, axis, isRtl));
      list.gapPairs.push([before.name, after.name]);
    }
    return list;
  }

  // One axis of gaps, and the same gaps between what the children paint when the two differ. A grid
  // titles each axis. A plain stack or a plain row has only one and needs no title.
  function describeGapList(list: GapList, title: string, parts: string[]): void {
    if (list.gaps.length === 0) return;

    const isEveryGapZero = list.gaps.every((gap) => Math.abs(gap) <= tolerance);
    const isSeenDifferent = list.seenGaps.some((seenGap, index) => Math.abs(seenGap - list.gaps[index]!) > tolerance);
    // A negative seen gap is two painted areas on top of each other. That is not spacing, and overlaps
    // is the finding for it.
    const spacedSeenGaps = list.seenGaps.filter((seenGap) => seenGap > -tolerance);

    if (!isEveryGapZero || isSeenDifferent) parts.push(`${title}${capList(collapseRuns(list.gaps))}`);
    if (isSeenDifferent && spacedSeenGaps.length > 0) parts.push(`seen ${title}${capList(collapseRuns(spacedSeenGaps))}`);
  }

  // A table sizes each column to the widest thing in it and each row to the tallest. Nobody spaced
  // the cells. How far apart they came out says nothing.
  function hasTableChildren(element: Element): boolean {
    return getRenderedChildren(element).some((child) => child.tagName === 'TD' || child.tagName === 'TH' || child.tagName === 'TR');
  }

  // Children side by side get a different title. A row is never read as a stack. Children in more
  // than one row and more than one column get both axes, named.
  function describeGaps(element: Element, findings: string[]): string | null {
    const layout = getChildLayout(element);
    if (!layout) return null;

    const { rowGaps, columnGaps, isGrid, isVerticalStack, freeBefore, freeAfter } = layout;

    // One per element, the tightest of the two axes. A grid stretches every cell to the track, and
    // the content inside them is ragged. What a cell paints says nothing about how it was spaced. A
    // table sizes its columns to the words in them, which is the same story.
    const isSpacingMeaningful = !isGrid && !hasTableChildren(element);
    const unevenFindings = isSpacingMeaningful ? [describeUnevenSpacing(rowGaps), describeUnevenSpacing(columnGaps)].filter((finding) => finding !== null) : [];
    const tightest = unevenFindings.sort((a, b) => a.ratio - b.ratio)[0];
    if (tightest) findings.push(tightest.text);

    const parts: string[] = [];
    describeGapList(rowGaps, isGrid ? 'rows ' : '', parts);
    describeGapList(columnGaps, isGrid ? 'columns ' : '', parts);
    if (freeBefore > freeSpaceThreshold) parts.push(`${round(freeBefore)} free before`);
    if (freeAfter > freeSpaceThreshold) parts.push(`${round(freeAfter)} free after`);
    if (parts.length === 0) return null;

    return `[gaps${isVerticalStack || isGrid ? '' : ' across'}: ${parts.join(', ')}]`;
  }

  // Inline children run along one line unless something stops them. Two labels meant to sit one
  // above the other end up side by side and nothing else in the output says so. Flex and grid
  // parents place their children on purpose. They are left alone.
  function describeOneLine(element: Element, style: CSSStyleDeclaration): string | null {
    if (element.tagName === 'svg') return null;
    if (style.display.includes('flex') || style.display.includes('grid')) return null;
    // Words of its own make it a sentence. The elements in it are pieces of the text, not blocks.
    if (getDirectText(element).length > 0) return null;

    const childRects: DOMRect[] = [];
    for (const child of getRenderedChildren(element)) {
      if (skippedTags.has(child.tagName)) continue;
      const childDisplay = getComputedStyle(child).display;
      if (childDisplay !== 'inline' && childDisplay !== 'inline-block') return null;
      const childRect = child.getBoundingClientRect();
      if (!isFlat(childRect)) childRects.push(childRect);
    }
    if (childRects.length < 2) return null;

    const firstTop = childRects[0]!.top;
    const isOneRow = childRects.every((childRect) => Math.abs(childRect.top - firstTop) <= tolerance);
    if (!isOneRow) return null;

    // A wrapped run of chips is taller than one line. The element itself has to fit on one.
    const tallestChild = Math.max(...childRects.map((childRect) => childRect.height));
    const lineHeight = style.lineHeight === 'normal' ? tallestChild : parseFloat(style.lineHeight);
    const contentBox = getInsetBox(element, true);
    if (contentBox.bottom - contentBox.top > lineHeight + tolerance) return null;

    return `${childRects.length} inline children on one line`;
  }

  function getOverflows(rect: DOMRect, bounds: Box): [string, number][] {
    return [
      ['top', bounds.top - rect.top],
      ['right', rect.right - bounds.right],
      ['bottom', rect.bottom - bounds.bottom],
      ['left', bounds.left - rect.left],
    ];
  }

  // Only the part that pokes out further than the parent already does. The parent line said the rest.
  // The number is how many px of the element cannot be seen on that side. How far its far edge
  // reaches past the boundary is larger than the element itself once it sits fully outside, and
  // then all of it is hidden.
  function describeOutside(rect: DOMRect, parentRect: DOMRect | null, bounds: Box, prefix: string, sides: Set<string>): string[] {
    const findings: string[] = [];
    const parentOverflows = parentRect ? getOverflows(parentRect, bounds) : [];
    for (const [side, amount] of getOverflows(rect, bounds)) {
      if (!sides.has(side)) continue;
      const parentAmount = parentOverflows.find(([parentSide]) => parentSide === side)?.[1] ?? 0;
      if (amount <= tolerance || amount <= parentAmount + tolerance) continue;

      const elementSize = side === 'top' || side === 'bottom' ? rect.height : rect.width;
      findings.push(`${prefix} ${side} ${round(Math.min(amount, elementSize))}`);
    }
    return findings;
  }

  function isPainted(element: Element): boolean {
    return getComputedStyle(element).visibility !== 'hidden' && getEffectiveOpacity(element) > 0;
  }

  type Coverage = {
    findings: string[];
    /** Coverers this element printed as an area line. Nothing under it prints that line again. */
    namedCoverers: Set<Element>;
    /** Coverers that take the whole element. Everything inside it is under them too. */
    totalCoverers: Set<Element>;
  };

  // A see-through wrapper hides nothing. Only something that paints or holds text can be on top.
  function doesPaintOrHoldText(element: Element): boolean {
    return describeRenders(element, getComputedStyle(element)) !== null || getDirectText(element).length > 0;
  }

  // The hit is often deep inside whatever covers us. Name the highest ancestor whose box still holds
  // the point. A dropdown hanging out of its header is then named, not the header. Ancestors that
  // paint nothing are skipped.
  function getCovererBranch(hit: Element, element: Element, x: number, y: number): Element | null {
    if (!doesPaintOrHoldText(hit)) return null;

    let branchRoot = hit;
    let current = getRenderedParent(hit);
    while (current && !doesRenderedContain(current, element)) {
      const box = current.getBoundingClientRect();
      const holdsPoint = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (holdsPoint && doesPaintOrHoldText(current)) branchRoot = current;
      current = getRenderedParent(current);
    }
    return branchRoot;
  }

  // Something lifted out of the flow and drawn above the page was meant to sit on top. The reader can
  // skip a finding that says so.
  function isOverlay(element: Element): boolean {
    const style = getComputedStyle(element);
    if (style.position !== 'absolute' && style.position !== 'fixed') return false;
    return style.boxShadow !== 'none' || Number(style.zIndex) > 0;
  }

  function getIntersectionArea(rect: DOMRect, other: DOMRect): number {
    const width = Math.min(rect.right, other.right) - Math.max(rect.left, other.left);
    const height = Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  // How much of the given area the coverer sits on. A box can be covered while every word still
  // shows. The text lines are measured, not the box around them.
  function getHiddenPercent(rects: DOMRect[], coverer: Element): number {
    const covererRect = coverer.getBoundingClientRect();
    let total = 0;
    let hidden = 0;
    for (const rect of rects) {
      total += rect.width * rect.height;
      hidden += getIntersectionArea(rect, covererRect);
    }
    if (total === 0) return 0;
    return Math.round((hidden / total) * 100);
  }

  // A picture's transparent parts cannot be told apart from its opaque ones. Reading the alpha means
  // drawing it into a canvas, and a cross-origin image taints the canvas. So a picture never claims
  // to hide words or a control. It says the boxes overlap and leaves the reader to look. Shoelace's
  // logo was reported as hiding a version number that is fully legible beside it.
  function isPicture(element: Element): boolean {
    return imageTags.has(element.tagName);
  }

  /** One color stop of a gradient: how far along it it sits, from 0 to 1, and how opaque it is. */
  type GradientStop = { position: number; alpha: number };

  // The color stops of a css gradient, in order. Empty when the background image is not a gradient
  // this can read: a picture, a color syntax with no rgb in it, or a stop placed in px.
  function getGradientStops(image: string): GradientStop[] {
    if (!image.includes('-gradient(') || image.includes('url(')) return [];

    const stops: { position: number | null; alpha: number }[] = [];
    for (const match of image.matchAll(/(rgba?\([^)]*\))([^,)]*)/g)) {
      const positionText = match[2]!.trim();
      if (positionText && !/^\d+(?:\.\d+)?%$/.test(positionText)) return [];
      stops.push({ position: positionText ? parseFloat(positionText) / 100 : null, alpha: parseColor(match[1]!)[3] });
    }
    if (stops.length < 2) return [];

    // A stop with no position of its own sits evenly between the ones that have.
    stops[0]!.position ??= 0;
    stops[stops.length - 1]!.position ??= 1;
    for (let index = 1; index < stops.length - 1; index++) {
      if (stops[index]!.position !== null) continue;
      let nextPlaced = index;
      while (stops[nextPlaced]!.position === null) nextPlaced++;
      const before = stops[index - 1]!.position!;
      stops[index]!.position = before + (stops[nextPlaced]!.position! - before) / (nextPlaced - index + 1);
    }
    return stops as GradientStop[];
  }

  const gradientAngleBySide: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

  // Which axis a linear gradient runs along, and whether it runs backwards along it. Null unless it
  // runs straight up, down, left or right. An angled one needs the corner math and nothing needs it.
  function getGradientDirection(image: string): { axis: 'block' | 'inline'; isReversed: boolean } | null {
    if (!image.startsWith('linear-gradient(')) return null;

    const degrees = image.match(/^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg/)?.[1];
    const side = image.match(/^linear-gradient\(\s*to (top|bottom|left|right)\s*,/)?.[1];
    // The browser leaves the direction out when it is the default, which runs down the box.
    const angle = degrees === undefined ? (side ? gradientAngleBySide[side]! : 180) : parseFloat(degrees);
    const turned = ((angle % 360) + 360) % 360;
    if (turned % 90 !== 0) return null;

    return { axis: turned % 180 === 0 ? 'block' : 'inline', isReversed: turned === 0 || turned === 270 };
  }

  function getGradientAlphaAt(stops: GradientStop[], position: number): number {
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (position <= first.position) return first.alpha;
    if (position >= last.position) return last.alpha;

    for (let index = 1; index < stops.length; index++) {
      const before = stops[index - 1]!;
      const after = stops[index]!;
      if (position > after.position) continue;
      const span = after.position - before.position;
      if (span <= 0) return after.alpha;
      return before.alpha + ((after.alpha - before.alpha) * (position - before.position)) / span;
    }
    return last.alpha;
  }

  // Whether the element's gradient is solid everywhere it meets the box under it. A scrim fading
  // from clear to a solid color is a tint over the top of a hero and a cover over the bottom of it.
  // The band where the two boxes actually meet is what decides it.
  function isGradientCovering(element: Element, style: CSSStyleDeclaration, coveredRect: DOMRect): boolean {
    const stops = getGradientStops(style.backgroundImage);
    if (stops.length === 0) return false;
    // Opaque at every stop. It covers whichever way it runs and whatever part of it meets the box.
    if (stops.every((stop) => stop.alpha >= 1)) return true;

    const direction = getGradientDirection(style.backgroundImage);
    if (!direction) return false;

    const rect = element.getBoundingClientRect();
    const overlap = intersectBoxes(rect, coveredRect);
    const size = direction.axis === 'block' ? rect.height : rect.width;
    if (!overlap || size <= 0) return false;

    const near = (direction.axis === 'block' ? overlap.top - rect.top : overlap.left - rect.left) / size;
    const far = (direction.axis === 'block' ? overlap.bottom - rect.top : overlap.right - rect.left) / size;
    const from = direction.isReversed ? 1 - far : near;
    const to = direction.isReversed ? 1 - near : far;

    const insideBand = stops.map((stop) => stop.position).filter((position) => position > from && position < to);
    return [from, to, ...insideBand].every((position) => getGradientAlphaAt(stops, position) >= 1);
  }

  function isTranslucent(element: Element, coveredRect: DOMRect): boolean {
    if (getEffectiveOpacity(element) < 1) return true;

    const style = getComputedStyle(element);
    // A picture painted as a background hides whatever is under it. Its transparency cannot be
    // measured, so calling it a tint suppressed the `hidden by` line on things it fully covered.
    const paintsPicture = style.backgroundImage.includes('url(');
    const paintsSolid = parseColor(style.backgroundColor)[3] >= 1 || imageTags.has(element.tagName) || paintsPicture || hasBorder(style);
    return !paintsSolid && !isGradientCovering(element, style, coveredRect);
  }

  // Say which part is hidden. A strip off one side when the coverer spans the element, a patch otherwise.
  function describeCoveredArea(rect: DOMRect, coverer: Element): string {
    const covererRect = coverer.getBoundingClientRect();
    const left = Math.max(rect.left, covererRect.left);
    const right = Math.min(rect.right, covererRect.right);
    const top = Math.max(rect.top, covererRect.top);
    const bottom = Math.min(rect.bottom, covererRect.bottom);
    const spansWidth = left <= rect.left + tolerance && right >= rect.right - tolerance;
    const spansHeight = top <= rect.top + tolerance && bottom >= rect.bottom - tolerance;

    if (spansWidth && spansHeight) return 'all';
    if (spansWidth && top <= rect.top + tolerance) return `top ${round(bottom - rect.top)}`;
    if (spansWidth && bottom >= rect.bottom - tolerance) return `bottom ${round(rect.bottom - top)}`;
    if (spansHeight && left <= rect.left + tolerance) return `left ${round(right - rect.left)}`;
    if (spansHeight && right >= rect.right - tolerance) return `right ${round(rect.right - left)}`;
    return `${round(right - left)}x${round(bottom - top)}`;
  }

  // Only what is left of the rects after the clip. A word scrolled out of its box is not on screen
  // for anything to hide.
  function clipRects(rects: DOMRect[], clip: Box): DOMRect[] {
    const clipped: DOMRect[] = [];
    for (const rect of rects) {
      const visible = intersectBoxes(rect, clip);
      if (visible) clipped.push(new DOMRect(visible.left, visible.top, visible.right - visible.left, visible.bottom - visible.top));
    }
    return clipped;
  }

  // Coverers an ancestor already reported are skipped. The parent line said it. Clipping comes
  // first. Only the part of the element that every ancestor still shows can be covered by anything.
  function describeCoverage(element: Element, rect: DOMRect, alreadyReported: Set<Element>): Coverage | null {
    const visibleBox = getVisibleBox(element, rect);
    if (!visibleBox) return null;

    const left = Math.max(visibleBox.left, 0);
    const top = Math.max(visibleBox.top, 0);
    const right = Math.min(visibleBox.right, window.innerWidth);
    const bottom = Math.min(visibleBox.bottom, window.innerHeight);
    if (right - left < 2 || bottom - top < 2) return null;

    const visibleRect = new DOMRect(left, top, right - left, bottom - top);

    const samplePoints: [number, number][] = [];
    for (let row = 0; row < coverageSamplesPerAxis; row++) {
      for (let column = 0; column < coverageSamplesPerAxis; column++) {
        samplePoints.push([
          left + ((column + 0.5) / coverageSamplesPerAxis) * (right - left),
          top + ((row + 0.5) / coverageSamplesPerAxis) * (bottom - top),
        ]);
      }
    }

    // A bar taking the top 8 of a 170 tall panel falls between the rows of the grid and nothing sees
    // it. A strip off one edge is what a fixed bar does. Every edge is sampled as well.
    const middleX = (left + right) / 2;
    const middleY = (top + bottom) / 2;
    samplePoints.push([middleX, top + edgeSampleInset], [middleX, bottom - edgeSampleInset]);
    samplePoints.push([left + edgeSampleInset, middleY], [right - edgeSampleInset, middleY]);

    const countsByBranch = new Map<Element, number>();
    for (const [x, y] of samplePoints) {
      // The whole stack above the element, not just the top. A menu under a modal backdrop still covers.
      const branchesAtPoint = new Set<Element>();
      let isPointOnElement = false;
      for (const rawHit of document.elementsFromPoint(x, y)) {
        const hit = rawHit.closest('svg') ?? rawHit;
        // Reaching the element or one of its ancestors means everything after is painted below it.
        if (hit === element || doesRenderedContain(element, hit)) {
          isPointOnElement = true;
          break;
        }
        // An ancestor was hit but the element was not. Nothing below this is on top of it either.
        if (doesRenderedContain(hit, element)) break;
        if (flippedPointerEvents.has(hit) || !isPainted(hit)) continue;
        const branch = getCovererBranch(hit, element, x, y);
        if (branch) branchesAtPoint.add(branch);
      }
      // The element is nowhere in the stack, and the point is not on it. A round button has corners
      // like this. Whatever shows there was never hidden by anything.
      if (!isPointOnElement) continue;

      for (const branch of branchesAtPoint) {
        countsByBranch.set(branch, (countsByBranch.get(branch) ?? 0) + 1);
      }
    }
    if (countsByBranch.size === 0) return null;

    // Words and controls are what a reader loses. They are reported wherever they are, even when an
    // ancestor already named the same coverer.
    const ownText = getDirectText(element);
    const textRects = ownText ? clipRects(getTextLineRects(element), visibleRect) : [];
    const isSubjectControl = isControl(element);
    const quotedText = ownText ? ` "${getFirstWords(ownText)}"` : '';

    const findings: string[] = [];
    const namedCoverers = new Set<Element>();
    const totalCoverers = new Set<Element>();
    for (const [branch] of [...countsByBranch].sort((a, b) => b[1] - a[1])) {
      if (isDeliberateCoverer(branch, element)) continue;
      const isTint = isTranslucent(branch, visibleRect);
      const suffix = (isTint ? ' (translucent)' : isPicture(branch) ? ' (image)' : '') + (isOverlay(branch) ? ' (overlay)' : '');
      const area = describeCoveredArea(visibleRect, branch);
      // Whether it takes everything of this element that is on screen. A page wrapper taller than
      // the viewport keeps the part below the fold, and nothing there is visible to be covered.
      const covererRect = branch.getBoundingClientRect();
      const takesEverythingSeen =
        covererRect.left <= left + tolerance &&
        covererRect.right >= right - tolerance &&
        covererRect.top <= top + tolerance &&
        covererRect.bottom >= bottom - tolerance;
      if (takesEverythingSeen) totalCoverers.add(branch);

      // A tint leaves every word readable and every button clickable. It stays a box finding. So
      // does a picture, which may be transparent everywhere the words are.
      if (!isTint && !isPicture(branch) && (isSubjectControl || textRects.length > 0)) {
        const subject = isSubjectControl ? `control${quotedText}` : `text${quotedText}`;
        const percent = isSubjectControl ? getHiddenPercent([visibleRect], branch) : getHiddenPercent(textRects, branch);
        // None of the words are under it, only the box is. That is still worth a line: a sticky head
        // parked 24px into the first row of its table leaves every word of it readable.
        if (percent > 0) {
          findings.push(`${subject} ${percent >= 100 ? '' : `${percent}% `}hidden by ${getIdentifier(branch)}${suffix}`);
          continue;
        }
      }

      if (alreadyReported.has(branch)) continue;
      namedCoverers.add(branch);
      findings.push(`${area} covered by ${getIdentifier(branch)}${suffix}`);
    }
    return { findings, namedCoverers, totalCoverers };
  }

  function getEffectiveOpacity(element: Element): number {
    let opacity = 1;
    let current: Element | null = element;
    while (current) {
      opacity *= parseFloat(getComputedStyle(current).opacity);
      current = getRenderedParent(current);
    }
    return opacity;
  }

  function contains(outer: Box, inner: Box): boolean {
    return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
  }

  // Partial overlap only. One box inside another is layering, and "covered by" says who is on top.
  function isOverlapping(a: Box, b: Box): boolean {
    const horizontal = a.left < b.right - tolerance && b.left < a.right - tolerance;
    const vertical = a.top < b.bottom - tolerance && b.top < a.bottom - tolerance;
    return horizontal && vertical && !contains(a, b) && !contains(b, a);
  }

  // What of the element is actually drawn. Something that paints fills its box, and the box is what
  // it shows. Something that paints nothing shows only its words and its children. A line box is
  // taller than the letters in it, because line height leaves air above and below them. Null when
  // nothing of it is drawn at all. Apple's headline and the line under it have touching boxes and
  // clear air between the glyphs.
  function getDrawnBounds(element: Element, style: CSSStyleDeclaration): Box | null {
    if (describeRenders(element, style) !== null) return element.getBoundingClientRect();
    return getPaintedBounds(element);
  }

  const stackedChildCountByElement = new Map<Element, number>();

  // Same-shaped children pulled onto each other by a negative margin: a row of avatars, a pile of
  // cards. Each one sitting on the one before it is the design. 0 when the element is not a stack.
  function getStackedChildCount(element: Element): number {
    const cached = stackedChildCountByElement.get(element);
    if (cached !== undefined) return cached;

    const children = getRenderedChildren(element).filter(isInFlowSibling);
    const firstChild = children[0];
    const isOneShape = firstChild !== undefined && children.length >= 2 && children.every((child) => getShapeKey(child) === getShapeKey(firstChild));
    const isPulledTogether =
      isOneShape &&
      children.slice(1).every((child) => {
        const style = getComputedStyle(child);
        // Either side pulls. A right-to-left avatar stack uses a negative margin-right, which is
        // what `margin-inline-start` computes to there, and reading only the left missed it.
        const margins = [style.marginLeft, style.marginRight, style.marginTop, style.marginBottom];
        return margins.some((margin) => parseFloat(margin) < 0);
      });

    const count = isPulledTogether ? children.length : 0;
    stackedChildCountByElement.set(element, count);
    return count;
  }

  // A knob on a bar: something lifted out of the flow sitting on a sibling a few px thick. A slider
  // thumb on its track, or on the fill drawn behind it, which is a second bar under the same knob.
  function isKnobOnBar(knob: Element, bar: Element): boolean {
    if (knob === bar || getRenderedParent(knob) !== getRenderedParent(bar)) return false;

    const position = getComputedStyle(knob).position;
    if (position !== 'absolute' && position !== 'fixed') return false;

    const barRect = bar.getBoundingClientRect();
    const isBar = barRect.height < thinBarThreshold || barRect.width < thinBarThreshold;
    return isBar && getIntersectionArea(knob.getBoundingClientRect(), barRect) > 0;
  }

  // Any bar this element is a knob on. A knob is empty because that is what a knob is.
  function findBarUnder(element: Element): Element | null {
    return getRenderedSiblings(element).find((sibling) => isKnobOnBar(element, sibling)) ?? null;
  }

  // One of a row of overlapping avatars. Sitting on the one before it is the design.
  function isOneOfAStack(above: Element, below: Element): boolean {
    const parent = getRenderedParent(above);
    if (!parent) return false;
    return getStackedChildCount(parent) > 0 && getRenderedParent(below) === parent;
  }

  // What the sticky element sticks inside: the nearest ancestor that cuts its content off, or the
  // viewport when nothing does. A column pinned to the right of a table sticks inside the box that
  // scrolls the table sideways, not inside the screen.
  function getScrollportBox(element: Element): Box {
    const scroller = getClippingAncestor(element);
    if (scroller) return getInsetBox(scroller, false);
    return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  }

  // Whether scrolling actually pushed the sticky element off its place. Where it was laid out has to
  // be off the edge of what it sticks inside before it had any reason to move. One laid out fully
  // inside it never had to, and it is carrying nothing.
  function isStuckAwayFromItsPlace(element: Element): boolean {
    const laidOut = laidOutRectBySticky.get(element);
    if (!laidOut) return false;

    const scrollport = getScrollportBox(element);
    return (
      laidOut.top < scrollport.top - tolerance ||
      laidOut.bottom > scrollport.bottom + tolerance ||
      laidOut.left < scrollport.left - tolerance ||
      laidOut.right > scrollport.right + tolerance
    );
  }

  // A sticky head is drawn away from where it was laid out, over the rows beside it. What it covers
  // outside the box it scrolls in is still covered.
  function isStickyOverItsOwnBox(above: Element, below: Element): boolean {
    const parent = getRenderedParent(above);
    if (!parent) return false;
    return getComputedStyle(above).position === 'sticky' && below !== above && doesRenderedContain(parent, below);
  }

  // Drawn over its neighbours on purpose. Neither is a collision. Neither is an overlap.
  function isPlacedOverSibling(above: Element, below: Element): boolean {
    return isOneOfAStack(above, below) || isStickyOverItsOwnBox(above, below);
  }

  // The same, plus the knob. None of them hides what is under it. That is what they are for. A
  // sticky element is the exception. While its laid-out place is still fully on screen it never had
  // to move, and an offset pushed it off that place rather than scrolling. A table head with a top
  // of 64 left over from a deleted nav bar parked itself on the first row of its own table.
  function isDeliberateCoverer(coverer: Element, victim: Element): boolean {
    if (isKnobOnBar(coverer, victim) || isOneOfAStack(coverer, victim)) return true;
    return isStickyOverItsOwnBox(coverer, victim) && isStuckAwayFromItsPlace(coverer);
  }

  const alignmentThreshold = 24;
  const sizeMismatchThreshold = 8;
  const slackMismatchThreshold = 24;

  function isInFlowSibling(sibling: Element): boolean {
    if (skippedTags.has(sibling.tagName)) return false;
    const position = getComputedStyle(sibling).position;
    if (position === 'absolute' || position === 'fixed') return false;

    const rect = sibling.getBoundingClientRect();
    return !isFlat(rect) && !isOffscreen(rect) && isPainted(sibling);
  }

  // Tag plus first class. article.card.c2 and article.card.c3 are the same kind of thing.
  function getShapeKey(element: Element): string {
    const classNames = typeof element.className === 'string' ? element.className.trim().split(/\s+/) : [];
    return element.tagName.toLowerCase() + (classNames[0] ? '.' + classNames[0] : '');
  }

  // Every class the element carries, in a fixed order so two elements can be compared by it.
  function getSortedClassNames(element: Element): string {
    const raw = typeof element.className === 'string' ? element.className.trim() : '';
    return raw ? raw.split(/\s+/).sort().join(' ') : '';
  }

  // The shapes of the element children, in order. A textarea block and a radio-card block can share a
  // class name and still be two different things, and two different things have no size to match.
  function getChildShapeSignature(element: Element): string {
    return getRenderedChildren(element)
      .filter((child) => !skippedTags.has(child.tagName))
      .map(getShapeKey)
      .join(' > ');
  }

  // The first sibling on that side with a box, if it is the same kind of thing.
  function findSameShapedSibling(element: Element, direction: 'previous' | 'next'): Element | null {
    const siblings = getRenderedSiblings(element);
    const ownIndex = siblings.indexOf(element);
    if (ownIndex < 0) return null;

    const step = direction === 'previous' ? -1 : 1;
    let index = ownIndex + step;
    while (siblings[index] && !isInFlowSibling(siblings[index]!)) {
      index += step;
    }
    const sibling = siblings[index];
    if (!sibling || getShapeKey(sibling) !== getShapeKey(element)) return null;
    return sibling;
  }

  // A transformed neighbour is not laid out where it is drawn. Nothing lines up with it by design.
  function isTransformedWithin(element: Element, top: Element): boolean {
    let current: Element | null = element;
    while (current) {
      const shape = getTransformShape(getComputedStyle(current));
      if (shape.rotation !== 0 || shape.scale !== 1) return true;
      if (current === top) return false;
      current = getRenderedParent(current);
    }
    return false;
  }

  // The child at the same place in the row next door. Pairing by order among the same-named children
  // instead shifts every later one by a place as soon as one child of a row is named differently, and
  // a seat grid with one taken seat in it printed seven misalignments that were not there.
  function findCounterpart(container: Element, element: Element): Element | null {
    const index = getRenderedSiblings(element).indexOf(element);
    const candidate = index < 0 ? undefined : getRenderedChildren(container)[index];
    if (!candidate || getShapeKey(candidate) !== getShapeKey(element) || !isInFlowSibling(candidate)) return null;
    return candidate;
  }

  // "Close but not equal" edges. 8 off reads as a mistake, 40 off reads as a design.
  // Same size on the axis gets one line for the whole box. Different sizes get only the near edge.
  // The far one just follows the content, and a short link ending before a long one is no mistake.
  function compareEdges(rect: DOMRect, otherElement: Element, other: DOMRect, axis: 'block' | 'inline', otherName: string, findings: string[]): void {
    const isRtl = isRtlIn(otherElement);
    const isBlock = axis === 'block';
    const nearEdge = isBlock ? 'top' : isRtl ? 'right' : 'left';
    const farEdge = isBlock ? 'bottom' : isRtl ? 'left' : 'right';
    const sizeKey = isBlock ? 'height' : 'width';
    const isSameSize = Math.abs(rect[sizeKey] - other[sizeKey]) <= tolerance;

    const describe = (difference: number) => {
      if (isBlock) return difference > 0 ? 'lower' : 'higher';
      // In rtl the near edge is the right one. A bigger number there sits nearer the start.
      const isTowardEnd = isRtl ? difference < 0 : difference > 0;
      return isTowardEnd ? 'further end' : 'further start';
    };
    const isNotable = (difference: number) => Math.abs(difference) > tolerance && Math.abs(difference) <= alignmentThreshold;

    const nearDifference = rect[nearEdge] - other[nearEdge];
    if (!isNotable(nearDifference)) return;

    // Both boxes end on the same far edge, and they are aligned on it. Right-aligned text of two
    // different lengths starts in two places and that is not a mistake.
    if (Math.abs(rect[farEdge] - other[farEdge]) <= tolerance) return;

    // The one we are compared with is already out of line with the one before it, by the same amount
    // the other way. It is the odd one in the run, and it said so on its own line. Four inputs where
    // the third is 3 off make one finding on the third, not one on the third and one on the fourth.
    const mirrored = `${round(Math.abs(nearDifference))} ${describe(-nearDifference)} than `;
    const otherFindings = reportByElement.get(otherElement)?.findings ?? [];
    if (otherFindings.some((finding) => finding.includes(mirrored))) return;

    const edgeName = isSameSize ? '' : `${isBlock ? nearEdge : 'start'} edge `;
    findings.push(`${edgeName}${round(Math.abs(nearDifference))} ${describe(nearDifference)} than ${otherName}`);
  }

  // Two boxes sized by their own words are as long as their words. "Default" and "Primary" are
  // different words, and the two buttons are different widths on purpose. Only boxes sized by css,
  // showing the same words and holding the same kind of thing can be compared.
  function isSizeComparable(element: Element, other: Element): boolean {
    // Two pictures cannot be told apart. What a logo is a picture of decides how wide it comes out.
    // Visa's mark is 3 narrower than Mastercard's beside it and neither is a mistake.
    if (isPicture(element) || isPicture(other)) return false;
    if (getDirectText(element).length > 0 || getDirectText(other).length > 0) return false;
    if (getFlatText(element) !== getFlatText(other)) return false;
    // Every class, not just the first one. button.control.control-main is the play button in the
    // middle of a transport bar and it is bigger than the skip buttons on purpose.
    if (getSortedClassNames(element) !== getSortedClassNames(other)) return false;
    return getChildShapeSignature(element) === getChildShapeSignature(other);
  }

  // A box stretched across its parent's content box is that size because the parent is. How it
  // compares with the one next door is the parent's fact, not its own.
  function isStretchedToParent(element: Element, rect: DOMRect, axis: 'width' | 'height'): boolean {
    const parent = getRenderedParent(element);
    if (!parent) return false;

    const box = getPositioningBox(parent, getComputedStyle(element));
    const parentSize = axis === 'width' ? box.right - box.left : box.bottom - box.top;
    return Math.abs(rect[axis] - parentSize) <= tolerance;
  }

  // Two things of the same kind, almost the same size. 2 off is a mistake, 40 off is a design.
  function compareSizes(element: Element, rect: DOMRect, other: DOMRect, otherName: string, findings: string[]): void {
    const compare = (axis: 'width' | 'height', bigger: string, smaller: string) => {
      const difference = rect[axis] - other[axis];
      if (Math.abs(difference) <= tolerance || Math.abs(difference) > sizeMismatchThreshold) return;
      if (isStretchedToParent(element, rect, axis)) return;
      findings.push(`${round(Math.abs(difference))} ${difference > 0 ? bigger : smaller} than ${otherName}`);
    };
    compare('width', 'wider', 'narrower');
    compare('height', 'taller', 'shorter');
  }

  // A column stretched to match the one beside it while its content did not follow. Said on the one
  // with the room left over, and checked against the sibling on either side.
  function describeSlackMismatch(element: Element, rect: DOMRect, findings: string[]): void {
    const ownSlack = getChildLayout(element)?.freeAfter ?? 0;
    if (ownSlack <= slackMismatchThreshold) return;

    for (const direction of ['previous', 'next'] as const) {
      const sibling = findSameShapedSibling(element, direction);
      if (!sibling) continue;

      const siblingRect = sibling.getBoundingClientRect();
      const isSideBySide = siblingRect.right <= rect.left + tolerance || siblingRect.left >= rect.right - tolerance;
      if (!isSideBySide) continue;
      if ((getChildLayout(sibling)?.freeAfter ?? 0) >= freeSpaceThreshold) continue;

      findings.push(`${round(ownSlack)} free after, none in the sibling ${getIdentifier(sibling)}`);
      return;
    }
  }

  // Same-looking things next to each other should line up: the previous sibling, and the matching child
  // of the parent's previous sibling (a button in the card next door, an icon in the next column).
  function describeAlignment(element: Element, rect: DOMRect, findings: string[]): void {
    const isRtl = isRtlIn(element);
    const parent = getRenderedParent(element);
    if (!parent) return;

    describeSlackMismatch(element, rect, findings);

    const previousSibling = findSameShapedSibling(element, 'previous');
    if (previousSibling && !isTransformedWithin(previousSibling, previousSibling)) {
      const siblingRect = previousSibling.getBoundingClientRect();
      const isSideBySide = siblingRect.right <= rect.left + tolerance || siblingRect.left >= rect.right - tolerance;
      const isStacked = siblingRect.bottom <= rect.top + tolerance || siblingRect.top >= rect.bottom - tolerance;
      const hasCenteringFinding = findings.some((finding) => finding.startsWith('off-center-block'));
      const siblingName = getIdentifier(previousSibling);
      if (isSideBySide && !hasCenteringFinding) compareEdges(rect, previousSibling, siblingRect, 'block', siblingName, findings);
      if (isStacked && !isSideBySide) compareEdges(rect, previousSibling, siblingRect, 'inline', siblingName, findings);
      if (isSizeComparable(element, previousSibling)) compareSizes(element, rect, siblingRect, siblingName, findings);
    }

    // Walk up until an ancestor has a same-named earlier sibling (the card next door), then follow
    // the same path down inside it. card › price row › strong finds the strong in the previous card.
    const path: Element[] = [element];
    let ancestor: Element = parent;
    let uncle: Element | null = null;
    for (let depth = 0; depth < 2; depth++) {
      const ancestorParent = getRenderedParent(ancestor);
      if (!ancestorParent) break;

      const siblings = getRenderedChildren(ancestorParent);
      const ancestorIndex = siblings.indexOf(ancestor);
      const earlier = ancestorIndex < 0 ? [] : siblings.slice(0, ancestorIndex).reverse();
      const candidate = earlier.find((node) => isInFlowSibling(node) && getShapeKey(node) === getShapeKey(ancestor));
      if (candidate) {
        uncle = candidate;
        break;
      }
      path.push(ancestor);
      ancestor = ancestorParent;
    }
    if (!uncle) return;

    let counterpart: Element | null = uncle;
    let parentCounterpart: Element = uncle;
    for (const step of [...path].reverse()) {
      if (!counterpart) break;
      parentCounterpart = counterpart;
      counterpart = findCounterpart(counterpart, step);
    }
    if (!counterpart || isTransformedWithin(counterpart, uncle)) return;

    const ancestorRect = ancestor.getBoundingClientRect();
    const uncleRect = uncle.getBoundingClientRect();
    const sideBySide = uncleRect.right <= ancestorRect.left + tolerance || uncleRect.left >= ancestorRect.right - tolerance;
    const axis = sideBySide ? 'block' : 'inline';

    const counterpartRect = counterpart.getBoundingClientRect();
    const counterpartName = `${getIdentifier(counterpart)} in ${getIdentifier(uncle)}`;

    // The thumbnail in the card next door is the same thing as this one. A size that nearly matches
    // is the same mistake as one that nearly matches beside it. Where the two sit does not come into
    // it, and this is checked before the edges are.
    if (isSizeComparable(element, counterpart)) compareSizes(element, rect, counterpartRect, counterpartName, findings);

    // The parent is shifted by the same amount, not this child. The parent's own line says it.
    const nearEdge = axis === 'block' ? 'top' : isRtl ? 'right' : 'left';
    const ownDifference = rect[nearEdge] - counterpartRect[nearEdge];
    const parentDifference = parent.getBoundingClientRect()[nearEdge] - parentCounterpart.getBoundingClientRect()[nearEdge];
    if (Math.abs(ownDifference - parentDifference) <= tolerance) return;

    compareEdges(rect, counterpart, counterpartRect, axis, counterpartName, findings);
  }

  // How much room is left at the end of a cell after the last thing anyone can see in it, and how
  // wide that ink came out. Measured on the ink, not on the boxes. A block child fills the cell
  // whatever its words come out to, and the hole is between the words and the edge. Null when the
  // cell shows nothing.
  function getCellInk(cell: Element): { freeAtEnd: number; width: number } | null {
    const isRtl = isRtlIn(cell);
    const contentBox = getInsetBox(cell, true);
    const boxes: Box[] = [...getTextLineRects(cell)];
    for (const child of getRenderedChildren(cell)) {
      const childBounds = getPaintedBounds(child);
      if (childBounds) boxes.push(childBounds);
    }
    if (boxes.length === 0) return null;

    const starts = boxes.map((box) => box.left);
    const ends = boxes.map((box) => box.right);
    const width = Math.max(...ends) - Math.min(...starts);
    const freeAtEnd = isRtl ? Math.min(...starts) - contentBox.left : contentBox.right - Math.max(...ends);
    return { freeAtEnd, width };
  }

  // The cells at the same place in every row. A table with a row that holds a different number of
  // cells has a merged cell somewhere in it and no columns worth lining up.
  function getTableColumns(table: HTMLTableElement): Element[][] {
    const rows = [...table.rows].filter((row) => isInFlowSibling(row));
    const cellCount = rows[0]?.cells.length ?? 0;
    if (rows.length < 2 || cellCount === 0) return [];
    if (rows.some((row) => row.cells.length !== cellCount)) return [];

    const columns: Element[][] = [];
    for (let index = 0; index < cellCount; index++) {
      columns.push(rows.map((row) => row.cells[index]!));
    }
    return columns;
  }

  // A grid column: the children that start at the same place across the rows. The track is the column
  // whatever the markup calls them.
  function getGridColumns(element: Element): Element[][] {
    if (!getChildLayout(element)?.isGrid) return [];

    const columnsByStart = new Map<number, Element[]>();
    for (const child of getRenderedChildren(element)) {
      if (skippedTags.has(child.tagName) || !isInFlowSibling(child)) continue;
      const start = Math.round(child.getBoundingClientRect().left);
      const column = columnsByStart.get(start) ?? [];
      column.push(child);
      columnsByStart.set(start, column);
    }
    return [...columnsByStart.values()].filter((column) => column.length >= 2);
  }

  // A column every row of which stops well short of its own end. An orders table gave its customer
  // column 572 and nothing else in the output said so. Measured, not judged. The column may be that
  // wide on purpose.
  //
  // The hole has to be wider than the widest thing in the column. The column is then more empty than
  // full. Every auto-width column leaves the shorter rows some room, and 30 of slack behind a table
  // header is what a table looks like, not a hole.
  function reportColumnHoles(element: Element): void {
    const columns = element instanceof HTMLTableElement ? getTableColumns(element) : getGridColumns(element);
    for (const cells of columns) {
      const inks: { freeAtEnd: number; width: number }[] = [];
      for (const cell of cells) {
        const ink = getCellInk(cell);
        if (ink) inks.push(ink);
      }
      // One cell showing nothing at all is a column with nothing to measure across every row.
      if (inks.length !== cells.length) continue;

      const smallestFree = Math.min(...inks.map((ink) => ink.freeAtEnd));
      const widestInk = Math.max(...inks.map((ink) => ink.width));
      if (smallestFree < columnHoleThreshold || smallestFree < widestInk) continue;

      const firstReport = reportByElement.get(cells[0]!);
      if (firstReport) firstReport.findings.push(`${round(smallestFree)} free at end, on every row of this column`);
    }
  }

  // The element says it is a dialog itself.
  function isDialogLike(element: Element): boolean {
    if (element.tagName === 'DIALOG' || element.getAttribute('aria-modal') === 'true') return true;
    const role = element.getAttribute('role');
    return role === 'dialog' || role === 'alertdialog';
  }

  // The page behind is frozen with overflow: hidden, either by a dialog or by an app that never
  // scrolls. Everything below the fold is then clipped by body or html, which is the freeze working,
  // not a page full of bugs.
  // Sideways hiding is not a freeze. `body { overflow-x: hidden }` is one of the most copied rules
  // on the web and it kills the horizontal scrollbar, nothing else. A freeze also needs somewhere
  // to scroll to, so the page has to be taller than the window before this means anything.
  const isPageScrollLocked =
    document.documentElement.scrollHeight > window.innerHeight + tolerance &&
    [document.documentElement, document.body].some((element) => {
      const overflow = getComputedStyle(element).overflowY;
      return overflow === 'hidden' || overflow === 'clip';
    });

  // Which dialog froze it, when one did. Only for the first line. The clipping is suppressed either way.
  function findScrollLockDialog(): Element | null {
    if (!isPageScrollLocked) return null;

    // A dialog is a big thing above the fold, out of the flow, drawing something, and lifted above the
    // page with a z-index. A sticky sidebar is out of the flow too and sits below the dialog.
    // A dialog often paints nothing itself. Its overlay and its panel do, and the subtree is what counts.
    // It also leaves room around itself. A box the size of the screen at the bottom of the stack is a
    // layer the app draws its own chrome in, and it is there whether a dialog is open or not.
    // An element that says it is a dialog is taken at its word, whatever its size and its z-index.
    let dialog: Element | null = null;
    let highestLayer = -Infinity;
    const search = (element: Element) => {
      for (const child of getRenderedChildren(element)) {
        if (skippedTags.has(child.tagName)) continue;

        const style = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        // A dialog leaves room around itself. Something the size of the screen is the layer an app
        // draws its own chrome in, unless it says outright that it is a dialog.
        const coversViewport = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
        const isDialog = isDialogLike(child);
        const rawLayer = Number(style.zIndex);
        const layer = Number.isFinite(rawLayer) ? rawLayer : 0;

        const isCandidate =
          (style.position === 'fixed' || style.position === 'absolute') &&
          rect.width >= dialogSizeThreshold &&
          rect.height >= dialogSizeThreshold &&
          rect.top < window.innerHeight &&
          (!coversViewport || isDialog) &&
          (layer > 0 || isDialog) &&
          !isOffscreen(rect) &&
          isPainted(child) &&
          getPaintedBounds(child) !== null;

        // Strictly higher. The outermost of a stack of equals is the one named.
        if (isCandidate && layer > highestLayer) {
          highestLayer = layer;
          dialog = child;
        }
        search(child);
      }
    };
    search(document.body);
    return dialog;
  }

  const scrollLockDialog = findScrollLockDialog();

  // One clipper hiding forty elements is one bug. Each victim's own line is printed up to a limit,
  // then the clipper says how many more it took.
  const clipVictimCountByClipper = new Map<Element, number>();
  const reportByElement = new Map<Element, ElementReport>();

  // Two shapes that overlap each other in both directions are one fact. A resizer between two panes
  // overlaps the pane before it, and the pane after it overlaps the resizer, and both lines read the
  // same backwards. The first one printed keeps it.
  const seenOverlapPairs = new Set<string>();

  type WalkContext = {
    rect: DOMRect | null;
    /**
     * The nearest ancestor that printed a clip finding of its own. Only what pokes out further than
     * that one does is worth saying again, and an ancestor that said nothing suppresses nothing.
     */
    clipReporterRect: DOMRect | null;
    coverers: Set<Element>;
    isRotated: boolean;
    isScaled: boolean;
    skipChildren: boolean;
    editorContainer: Element | null;
  };

  function isFullyOutside(rect: DOMRect, box: Box): boolean {
    return rect.bottom <= box.top + tolerance || rect.top >= box.bottom - tolerance || rect.right <= box.left + tolerance || rect.left >= box.right - tolerance;
  }

  function describeElement(element: Element, parentContext: WalkContext): { report: ElementReport | null; context: WalkContext } {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const findings: string[] = [];
    const tags: string[] = [];
    const hasText = getDirectText(element).length > 0;
    const renderedChildren = getRenderedChildren(element);
    const context: WalkContext = {
      rect,
      clipReporterRect: parentContext.clipReporterRect,
      coverers: new Set(),
      isRotated: parentContext.isRotated,
      isScaled: parentContext.isScaled,
      skipChildren: false,
      // The outermost editor wins. Monaco names half its own wrappers monaco too.
      editorContainer: parentContext.editorContainer ?? (isEditorContainer(element) ? element : null),
    };
    const shapeKey = getShapeKey(element);
    const identifier = getIdentifier(element);
    const isInsideEditor = parentContext.editorContainer !== null;
    const isOversizedBox = isOversized(rect);

    // Hidden from the eye and kept for a screen reader. Nothing about the box is worth a number, and
    // whatever is inside it is hidden with it.
    if (isOffscreen(rect) || isScreenReaderOnly(element, rect, style)) {
      context.skipChildren = true;
      const hiddenTag = isOffscreen(rect) ? '[offscreen]' : '[sr-only]';
      return { report: { label: getLabel(element), identifier, shapeKey, tags: [hiddenTag], findings: [], children: [] }, context };
    }

    // An editor sizes its scrolling surface in the hundreds of thousands. Say so and measure nothing
    // about the edges of it. Its children are walked as usual.
    if (isOversizedBox) tags.push('[oversized]');

    // Where the element sits in the rendered tree, said before anything about the box. The reader
    // then knows which tree the numbers below came from.
    if (element.shadowRoot) {
      tags.push(walkShadowRoots ? '[shadow root]' : '[shadow root skipped]');
    } else if (isClosedShadowHost(element)) {
      tags.push('[shadow root closed]');
    }
    if (walkShadowRoots) {
      if (element.getRootNode() instanceof ShadowRoot) tags.push('[shadow]');
      if (element.assignedSlot) tags.push('[slotted]');
    }

    const renders = describeRenders(element, style);
    if (renders) tags.push(`[renders: ${renders}${describeBackgroundContrast(element, style)}]`);

    const scroll = describeScroll(element, style);
    if (scroll) tags.push(`[scroll: ${scroll}]`);

    const padding = describePadding(style);
    if (padding && (renderedChildren.length > 0 || hasText)) tags.push(`[pad: ${padding}]`);

    const transformShape = getTransformShape(style);
    if (transformShape.rotation !== 0) {
      tags.push(`[rotated ${transformShape.rotation}°]`);
      context.isRotated = true;
    }
    if (transformShape.scale !== 1) {
      tags.push(`[scaled ${transformShape.scale}]`);
      context.isScaled = true;
    }

    const parent = getRenderedParent(element);
    if (parent) {
      tags.push(`[pos: ${describePosition(element, rect, parent, style, findings)}]`);
    }

    const bleed = isOversizedBox ? { block: 0, inline: 0 } : getBleed(element, rect);
    const bleedOverhang = Math.max(bleed.block, bleed.inline);
    if (bleedOverhang > 0) tags.push(`[bleed ${bleedOverhang}]`);

    if (!isPainted(element)) {
      // A hidden bare input behind a custom checkbox is not layout. Only mention what would have shown.
      const wouldShow = hasText || renderedChildren.length > 0 || imageTags.has(element.tagName);
      if (!wouldShow) return { report: null, context };
      const reason = style.visibility === 'hidden' ? 'visibility hidden' : 'opacity 0';
      tags.push(`[not painted: ${reason}]`);
      return { report: { label: getLabel(element), identifier, shapeKey, tags, findings: [], children: [] }, context };
    }

    // Reported once, on the later sibling. The earlier one is named here. An out-of-flow element was
    // put on top on purpose, and its overlap is marked as one. A float and an inline box are meant
    // to share a line with what is around them. Neither of them overlaps anything.
    const isPlacedInLine = style.float !== 'none' || style.display === 'inline';
    // A fixed element is pinned to the viewport and the page runs under it as it scrolls. That is
    // not two boxes colliding, and what it hides is on its victims' own lines as covered by.
    if (parent && !isPlacedInLine && !isInsideEditor && style.position !== 'fixed') {
      const overlay = style.position === 'absolute' ? ' (overlay)' : '';
      for (const sibling of getRenderedChildren(parent)) {
        if (sibling === element) break;
        if (skippedTags.has(sibling.tagName)) continue;
        const siblingStyle = getComputedStyle(sibling);
        if (siblingStyle.float !== 'none' || siblingStyle.display === 'inline') continue;
        if (siblingStyle.position === 'fixed') continue;
        const siblingRect = sibling.getBoundingClientRect();
        if (isFlat(siblingRect) || isOffscreen(siblingRect) || !isPainted(sibling)) continue;
        if (!isOverlapping(rect, siblingRect)) continue;
        if (isPlacedOverSibling(element, sibling) || isPlacedOverSibling(sibling, element)) continue;

        // Two boxes crossing is not two things colliding. What each one draws is.
        const drawn = getDrawnBounds(element, style);
        const siblingDrawn = getDrawnBounds(sibling, siblingStyle);
        if (!drawn || !siblingDrawn || !isOverlapping(drawn, siblingDrawn)) continue;

        const siblingIdentifier = getIdentifier(sibling);
        if (seenOverlapPairs.has(`${siblingIdentifier}|${identifier}`)) continue;
        // The sibling already says this one is on top of it. Saying it again from up here adds nothing.
        const siblingReport = reportByElement.get(sibling);
        if (siblingReport?.findings.some((finding) => finding.includes(` by ${identifier}`))) continue;
        seenOverlapPairs.add(`${identifier}|${siblingIdentifier}`);
        findings.push(`overlaps ${siblingIdentifier}${overlay}`);
      }
    }

    const stackedChildCount = getStackedChildCount(element);
    if (stackedChildCount > 0) tags.push(`[stacked ${stackedChildCount}]`);

    const gaps = describeGaps(element, findings);
    if (gaps) tags.push(gaps);

    const oneLine = describeOneLine(element, style);
    if (oneLine) tags.push(`[line: ${oneLine}]`);

    const text = describeText(element, rect, context.editorContainer, findings);
    if (text) tags.push(`[text: ${text}]`);

    // A full-bleed element pokes out of its parent by design. Nothing it does on that axis is news.
    const clipSides = new Set(['top', 'right', 'bottom', 'left']);
    if (bleed.inline > 0) {
      clipSides.delete('left');
      clipSides.delete('right');
    }
    if (bleed.block > 0) {
      clipSides.delete('top');
      clipSides.delete('bottom');
    }

    // Under a scroll lock the page content hangs out of a body that was frozen to the viewport. The
    // lock is reported once on the first line. Nothing here reports it again.
    const nearestClippingAncestor = getClippingAncestor(element);
    const isLockClipper = isPageScrollLocked && (nearestClippingAncestor === document.body || nearestClippingAncestor === document.documentElement);
    // An editor's scrolling surface is a hundred thousand px across. Being cut by it, or being it, is
    // not something anyone can see.
    const isOversizedPair = isOversizedBox || (nearestClippingAncestor !== null && isOversized(nearestClippingAncestor.getBoundingClientRect()));
    const clippingAncestor = isLockClipper || isOversizedPair ? null : nearestClippingAncestor;

    if (clippingAncestor) {
      const reporterRect = clippingAncestor === parent ? null : parentContext.clipReporterRect;
      const scrolls = describeScroll(clippingAncestor, getComputedStyle(clippingAncestor)) !== null;
      const verb = scrolls ? 'scrolled out' : 'clipped';
      const clipBox = getInsetBox(clippingAncestor, false);
      const clipperName = clippingAncestor === parent ? 'parent' : getIdentifier(clippingAncestor);
      // A direct child of a scroll box is counted on the parent's line instead. A row of ten chips is
      // one fact there, not ten findings here.
      const isCountedByParent = scrolls && clippingAncestor === parent;

      // The whole element is cut away on one axis, a collapsed panel still holding its content. The
      // fact is that none of it shows, not which side it went out of. Something scrolled out of view
      // is still reachable, and it keeps its numbers.
      const clipOverflows = getOverflows(rect, clipBox);
      const hiddenOn = (side: string) => Math.max(0, clipOverflows.find(([clipSide]) => clipSide === side)?.[1] ?? 0);
      const isHiddenOnAxis = (near: string, far: string, size: number) => size > tolerance && hiddenOn(near) + hiddenOn(far) >= size - tolerance;
      const isFullyClipped = !scrolls && (isHiddenOnAxis('top', 'bottom', rect.height) || isHiddenOnAxis('left', 'right', rect.width));

      if (!isCountedByParent) {
        const clipperSuffix = clippingAncestor === parent ? '' : ` by ${clipperName}`;
        // An ancestor cuts the element away. It never paints on top of it. "covered" and "hidden by"
        // are what another element does, and a clip that takes all of it says clipped.
        const clipFindings = isFullyClipped
          ? [`all clipped by ${clipperName}`]
          : describeOutside(rect, reporterRect, clipBox, verb, clipSides).map((finding) => finding + clipperSuffix);

        if (clipFindings.length > 0) {
          const victimCount = (clipVictimCountByClipper.get(clippingAncestor) ?? 0) + 1;
          clipVictimCountByClipper.set(clippingAncestor, victimCount);
          if (victimCount <= maxClipVictimsShown) findings.push(...clipFindings);
          // What is under this line only has to say what pokes out further than this line already did.
          context.clipReporterRect = rect;
        }
      }

      // Nothing of it shows. One line is enough. The children would only repeat it.
      if (isFullyClipped || isFullyOutside(rect, clipBox)) {
        context.skipChildren = true;
        if (renderedChildren.length > 0 && !isCountedByParent) tags.push('[children skipped]');
      }
    }

    // Pages scroll. Only sideways overflow is a bug, and only when no ancestor already hides it.
    const viewport = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
    const clipBox = clippingAncestor ? getInsetBox(clippingAncestor, false) : null;
    const viewportSides = new Set<string>();
    if ((!clipBox || clipBox.left < viewport.left) && clipSides.has('left')) viewportSides.add('left');
    if ((!clipBox || clipBox.right > viewport.right) && clipSides.has('right')) viewportSides.add('right');
    if (!isOversizedBox) {
      findings.push(...describeOutside(rect, parentContext.rect, viewport, 'outside viewport', viewportSides));
    }

    // A container that paints nothing and holds no text of its own shows nothing that could be hidden.
    // Its painted children report the same coverer on their own lines. Keep the coverers so they dedupe.
    const coverage = describeCoverage(element, rect, parentContext.coverers);
    if (coverage) {
      const paintsSomething = renders !== null || hasText;
      if (paintsSomething) findings.push(...coverage.findings);

      // What is passed down is what a reader has already been told. A wrapper that shows nothing
      // told them nothing. It only silences the children a coverer takes along with the whole of
      // it. A bar over the top strip of a wrapper still leaves the panel inside it to say so.
      const inheritedAndTotal = [...parentContext.coverers, ...coverage.totalCoverers];
      context.coverers = new Set(paintsSomething ? [...inheritedAndTotal, ...coverage.namedCoverers] : inheritedAndTotal);
    }

    // It draws a box and there is nothing in it. An ad slot that never filled, a band left behind by a
    // section that was removed. A bar or a track is thinner than this on one axis, which is the point.
    const paintsPicture = style.backgroundImage !== 'none' || imageTags.has(element.tagName);
    // A border on one side paints a line as thick as the border, not a box. A rule between two
    // columns is a line by design, and MDN drew 80 of them.
    const paintedSize = getPaintedSize(rect, style);
    const isBigEnoughToNotice = paintedSize.width >= emptyBoxThreshold && paintedSize.height >= emptyBoxThreshold;

    // A dimmer behind a dialog covers the screen and holds nothing. That is what it is for.
    const viewportArea = window.innerWidth * window.innerHeight;
    const isOutOfFlow = style.position === 'absolute' || style.position === 'fixed';
    const isBackdrop = isOutOfFlow && getIntersectionArea(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight)) >= viewportArea * 0.9;

    // A knob on a bar is empty because it is a knob.
    const isKnob = findBarUnder(element) !== null;

    if (renders && !paintsPicture && !isControl(element) && !hasText && !hasRenderedContent(element) && isBigEnoughToNotice && !isBackdrop && !isKnob) {
      findings.push('empty painted box');
    }

    // Reported once, at the cause. A child that pokes out says so on its own line. Only what is
    // drawn counts. A hidden dropdown reaching past the end of a row is not the row overflowing.
    if (element.clientWidth > 0 && bleed.inline === 0 && !isOversizedBox) {
      // Something clipped stops at the padding box, and that is how much of it cannot be seen. When
      // nothing is cut off, the content box is what the children were laid out to fit in, and a
      // child ending past it eats into the padding.
      const isClipping = style.overflowX !== 'visible';
      const contentBox = getInsetBox(element, !isClipping);
      const overflow = describeInlineOverflow(getPaintedContentOverflow(element, contentBox, 'inline'), element);
      const isChildPokingOut = getContentChildBoxes(element).some((childBox) => {
        return childBox.right > contentBox.right + tolerance || childBox.left < contentBox.left - tolerance;
      });
      if (overflow) {
        const subject = hasText ? 'text' : 'content';
        if (!isClipping) {
          findings.push(`${subject} overflows ${overflow.amount}${overflow.side}`);
        } else if (hasText || !isChildPokingOut) {
          // Whether the cut was meant to look like one. Without an ellipsis the words just stop.
          const intent = hasText ? (style.textOverflow === 'ellipsis' ? ', ellipsis' : ', no ellipsis') : '';
          findings.push(`${subject} truncated ${overflow.amount} hidden${overflow.side}${intent}`);
        }
      }
    }

    // The same down the page, but only for a box that hides what pokes out of the bottom of it. A
    // box that lets it through shows it, and a box takes its height from what is in it unless
    // someone fixed the height. There is nothing to say in either case, and a scroll box keeps it
    // reachable. A review paragraph clamped to two lines hid half of itself and no line said so.
    const hidesBlockOverflow = style.overflowY === 'hidden' || style.overflowY === 'clip';
    if (element.clientHeight > 0 && bleed.block === 0 && !isOversizedBox && hidesBlockOverflow) {
      const paddingBox = getInsetBox(element, false);
      const overflow = describeBlockOverflow(getPaintedContentOverflow(element, paddingBox, 'block'));
      const isChildPokingOut = getContentChildBoxes(element).some((childBox) => {
        return childBox.bottom > paddingBox.bottom + tolerance || childBox.top < paddingBox.top - tolerance;
      });
      if (overflow && (hasText || !isChildPokingOut)) {
        const subject = hasText ? 'text' : 'content';
        const intent = hasText ? (style.textOverflow === 'ellipsis' ? ', ellipsis' : ', no ellipsis') : '';
        findings.push(`${subject} truncated ${overflow.amount} hidden${overflow.side}${intent}`);
      }
    }

    // An inline box sits where the words around it left room. Two code chips in two paragraphs never
    // formed a column. There is nothing for them to be out of line with.
    if (style.display !== 'inline' && !isInsideEditor) describeAlignment(element, rect, findings);

    // Inside a rotated element the boxes are inflated bounding boxes. Centering, overlap and coverage math on them is fiction.
    const isBoxFinding = (finding: string) => /^(off-center|text off-center|overlaps|.* edge )/.test(finding) || / (covered|hidden) by /.test(finding);
    const isAlignmentFinding = (finding: string) => / than /.test(finding);
    // A token in a code editor sits where the words before it left room. It was never placed.
    const isCenteringFinding = (finding: string) => /^(off-center|text off-center)/.test(finding);
    const keptFindings = findings.filter((finding) => {
      if (context.isRotated && isBoxFinding(finding)) return false;
      if (context.isScaled && isAlignmentFinding(finding)) return false;
      if (isInsideEditor && isCenteringFinding(finding)) return false;
      // A sticky element sits where scrolling left it, not where its parent placed it. Off center
      // against the parent means nothing there. Its own ink is still measured against its own box.
      if (style.position === 'sticky' && finding.startsWith('off-center-')) return false;
      // body is placed by html, which is the page itself. There is nothing for it to be centered in.
      if (element === document.body && isCenteringFinding(finding)) return false;
      return true;
    });
    return { report: { label: getLabel(element), identifier, shapeKey, tags, findings: keptFindings, children: [] }, context };
  }

  function walk(element: Element, parentReport: ElementReport, parentContext: WalkContext): void {
    if (skippedTags.has(element.tagName)) return;

    const rect = element.getBoundingClientRect();
    // A box with no size on one axis shows nothing of itself. It gets no line and its children are
    // printed in its place. A scroll box is the exception, its whole point is what it holds.
    const hasBox = !isFlat(rect) || describeScroll(element, getComputedStyle(element)) !== null;
    let report = parentReport;
    let context = parentContext;
    if (hasBox) {
      const described = describeElement(element, parentContext);
      if (!described.report) return;
      report = described.report;
      context = described.context;
      reportByElement.set(element, report);
      parentReport.children.push(report);
    }

    if (!isPainted(element) || context.skipChildren) return;
    for (const child of getRenderedChildren(element)) {
      walk(child, report, context);
    }
  }

  const coveredByPattern = / covered by (.+)$/;
  const lostToCovererPattern = /^(?:text|control)\b.* hidden by (.+)$/;

  // One coverer is named once down a branch. The lines under it that lose words or a control say
  // which words and how much of them. The box above them does not repeat the same coverer as a
  // patch of area. A card said 358x84 covered by div.bottombar and its three children said the same
  // bar hides their words. Returns the coverers reported under this element, its own included.
  function dropRepeatedCoverage(report: ElementReport): Set<string> {
    const covererNamesBelow = new Set<string>();
    for (const child of report.children) {
      for (const covererName of dropRepeatedCoverage(child)) covererNamesBelow.add(covererName);
    }

    report.findings = report.findings.filter((finding) => {
      const covererName = finding.match(coveredByPattern)?.[1];
      return covererName === undefined || !covererNamesBelow.has(covererName);
    });

    for (const finding of report.findings) {
      const covererName = finding.match(lostToCovererPattern)?.[1];
      if (covererName) covererNamesBelow.add(covererName);
    }
    return covererNamesBelow;
  }

  const root: ElementReport = { label: '', identifier: '', shapeKey: '', tags: [], findings: [], children: [] };
  walk(document.body, root, { rect: null, clipReporterRect: null, coverers: new Set(), isRotated: false, isScaled: false, skipChildren: false, editorContainer: null });
  dropRepeatedCoverage(root);

  // Once the whole tree is measured. A column is then compared across every row that was printed.
  for (const element of [...reportByElement.keys()]) {
    reportColumnHoles(element);
  }

  // Said on the clipper once the walk knows how many it took. The count is the whole page's.
  for (const [clipper, victimCount] of clipVictimCountByClipper) {
    if (victimCount <= maxClipVictimsShown) continue;
    const clipperReport = reportByElement.get(clipper);
    if (clipperReport) clipperReport.findings.push(`${getIdentifier(clipper)} hides ${victimCount - maxClipVictimsShown} more elements`);
  }

  // One grey on every token in the editor is one finding, said on the editor.
  for (const [container, group] of editorContrastByContainer) {
    const containerReport = reportByElement.get(container);
    const runs = `${group.runCount} text run${group.runCount === 1 ? '' : 's'}`;
    if (containerReport) containerReport.findings.push(`${group.finding} on ${runs} inside ${getIdentifier(container)}`);
  }

  const headerFindings: string[] = [];

  // A page that answered with an error is a block page or a 404, whatever it looks like. Nothing
  // measured on it is the layout anyone was after.
  const isErrorStatus = httpStatus !== null && (httpStatus < 200 || httpStatus > 299);
  if (isErrorStatus) headerFindings.push(`server answered ${httpStatus}`);

  // How far down the page anything is actually drawn. A page 4000 tall that paints to 200 is a shell.
  const paintedBounds = getPaintedBounds(document.body);
  const paintedTo = round(Math.max(0, (paintedBounds?.bottom ?? 0) + window.scrollY));

  const pageWidth = document.documentElement.scrollWidth;
  if (pageWidth > window.innerWidth + tolerance) {
    // Only something that actually widens the page. A carousel track inside `overflow: hidden` is
    // the widest box on the page and adds nothing to scroll, and a fixed drawer parked off screen
    // is out of the document's overflow entirely. Both used to get the blame.
    let widest: Element | null = null;
    let widestRight = window.innerWidth;
    for (const element of document.body.querySelectorAll('*')) {
      if (getComputedStyle(element).position === 'fixed') continue;
      if (getClippingAncestor(element)) continue;

      const right = element.getBoundingClientRect().right;
      if (right > widestRight) {
        widestRight = right;
        widest = element;
      }
    }
    headerFindings.push(`page ${pageWidth} wide, viewport ${window.innerWidth}${widest ? `, caused by ${getIdentifier(widest)}` : ''}`);
  }

  const pageHeight = document.documentElement.scrollHeight;
  const scrollLock = scrollLockDialog ? `, scroll locked by ${getIdentifier(scrollLockDialog)}` : '';
  const status = isErrorStatus ? `, status ${httpStatus}` : '';

  const pageSize = `page ${pageWidth}x${pageHeight}, painted to ${paintedTo}`;
  const viewportSize = `viewport ${window.innerWidth}x${window.innerHeight}, scroll ${round(window.scrollY)}`;
  // Which physical side start is on. Nothing then has to remember what rtl does to the inline axis.
  const direction = isPageRtl ? 'rtl, start is right' : 'ltr, start is left';
  // What the page itself answers. A dark mode measured in light then shows on the first line.
  const colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  let header = `${viewportSize}, ${pageSize}${scrollLock}${status}, dpr ${devicePixelRatio}, ${direction}, ${colorScheme}`;
  if (headerFindings.length > 0) header += ` [!!: ${headerFindings.join(', ')}]`;

  return { header, headerFindings, root: root.children[0]! };
}

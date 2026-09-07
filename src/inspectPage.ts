import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';

import type { ElementReport } from './inspectLayout.ts';
import { inspectLayout } from './inspectLayout.ts';
import { getTargetUrl } from './targetUrl.ts';

/** The color scheme the page is rendered in. This is what `prefers-color-scheme` answers. */
export type ColorScheme = 'light' | 'dark';

export type InspectPageOptions = {
  /** A url, or a path to a local file. */
  target: string;
  /** Viewport width in px. Default 1280. */
  width?: number;
  /** Viewport height in px. Default 720. */
  height?: number;
  /**
   * Measure the page once at each of these viewports and compare them. A number is a width, a
   * `390x844` string is a width and a height. A width on its own gets 844 at 390, 1180 at 820 and
   * 720 at 1280, and `height` anywhere else. When this is set, `width` is ignored.
   */
  widths?: (number | string)[];
  /** The color scheme the page is rendered in. Default 'light'. */
  scheme?: ColorScheme;
  /** Measure the page once in each of these color schemes and compare them. When set, `scheme` is ignored. */
  schemes?: ColorScheme[];
  /** How far down to scroll the page before measuring. Default 0. */
  scroll?: number | 'bottom';
  /** Walk open shadow roots instead of the markup children. Default true. */
  shadow?: boolean;
  /** Print only the lines that carry a finding, with their ancestors. Default false. */
  findingsOnly?: boolean;
  /** Write the rendered color of what each element paints, as hex. Default false. */
  colors?: boolean;
  /** Print only the elements matching this css selector, with the path down to each one. */
  selector?: string;
  /** With `selector`, print what is inside the matched elements too. Default true. */
  withChildren?: boolean;
  /** How long to wait for the page to load, in ms. Default 30000. */
  timeout?: number;
};

/** Every failure result starts with this, `could not load` or `could not launch`. The CLI exits 2 when it sees it. */
export const loadFailurePrefix = 'could not ';

type FormattedReport = { text: string; similarKey: string };

/** How many elements print the same finding before the rest say `same as N above`. */
const maxFindingRepeats = 3;

/** How many wrappers a `a › b › c` chain shows before the rest become `…`. */
const maxWrapperLinks = 3;

function getSize(label: string): string {
  return label.match(/ (\d+(?:\.\d+)?x\d+(?:\.\d+)?)$/)?.[1] ?? '';
}

// A wrapper that paints nothing around one child of the same size is one thing, not two.
// li › span › svg 26x26 instead of three lines.
function collapseWrappers(report: ElementReport): ElementReport {
  const onlyChild = report.children.length === 1 ? report.children[0]! : null;
  const paintsNothing = !report.tags.some((tag) => tag.startsWith('[renders:') || tag.startsWith('[text:'));
  const isPlainWrapper = paintsNothing && report.findings.length === 0;
  if (!onlyChild || !isPlainWrapper) return report;

  const childFills = onlyChild.tags.includes('[pos: fills]');
  if (!childFills || getSize(report.label) !== getSize(onlyChild.label)) return report;

  const wrapperName = report.label.replace(/ \d+(?:\.\d+)?x\d+(?:\.\d+)?$/, '');
  const positionTag = report.tags.find((tag) => tag.startsWith('[pos:'));
  const isBeforePosition = (tag: string) => /^\[(renders|scroll|pad):/.test(tag);
  const childTagsBefore = onlyChild.tags.filter(isBeforePosition);
  const childTagsAfter = onlyChild.tags.filter((tag) => !isBeforePosition(tag) && !tag.startsWith('[pos:'));
  const merged: ElementReport = {
    label: `${wrapperName} › ${onlyChild.label}`,
    // The findings on the merged line are the child's. The name they answer to is the child's too.
    identifier: onlyChild.identifier,
    shapeKey: report.shapeKey,
    tags: [...childTagsBefore, ...(positionTag ? [positionTag] : []), ...childTagsAfter],
    findings: onlyChild.findings,
    children: onlyChild.children,
  };
  return collapseWrappers(merged);
}

// Ten wrappers deep the chain says nothing the first few did not. Keep the ends, drop the middle.
function capWrapperChain(label: string): string {
  const links = label.split(' › ');
  if (links.length <= maxWrapperLinks + 1) return label;
  return [...links.slice(0, maxWrapperLinks), '…', links[links.length - 1]].join(' › ');
}

// The same finding with the same numbers on a hundred elements is one bug. The summary counts them
// all. The tree shows a few, then says how many came before.
function describeFindings(findings: string[], countsByFinding: Map<string, number>): string[] {
  return findings.map((finding) => {
    const seen = (countsByFinding.get(finding) ?? 0) + 1;
    countsByFinding.set(finding, seen);
    return seen > maxFindingRepeats ? `same as ${seen - 1} above` : finding;
  });
}

// What a row holds, all the way down. Each child's kind and which edges it sits against, with the
// numbers left out. A row with longer words centers its icon at a different offset and is the same
// row. A row with its rail on the other edge is not.
function getInnerShape(report: ElementReport): string {
  const position = report.tags.find((tag) => tag.startsWith('[pos:'))?.replace(/-?\d+(?:\.\d+)?/g, '') ?? '';
  return [report.shapeKey, position, ...report.children.map(getInnerShape)].join(' ');
}

// A finding stripped down to what it says. Two rows failing the same way then match. The words the
// element shows go, the elements it names go, and every number is rounded to whole px. A row 3.4
// off center and a row 3.5 off center are the same bug.
function getFindingKind(finding: string): string {
  return finding
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b[a-z][a-z0-9]*(?:#[\w-]+|\.[^\s,]+|:nth-child\(\d+\))+/g, 'X')
    .replace(/-?\d+(?:\.\d+)?/g, (value) => String(Math.round(Number(value))));
}

// Everything wrong under a line, its own findings first. Two siblings that carry the same list are
// one bug seen twice, and Hacker News printed the same contrast failure on 269 rows.
function getFindingsSignature(report: ElementReport): string {
  return [report.findings.map(getFindingKind).join(', '), ...report.children.map(getFindingsSignature)].join(' | ');
}

const inlineAxisTerms = new Set(['fills', 'fills-inline', 'centered-inline', 'start', 'end']);

// Which edges of the parent the element sits flush against across the page, read from its `[pos]`
// tag. The offsets themselves are left out. Two rows of a list sit at different offsets and are
// still the same row, and a row flush with an edge that the others miss was put somewhere else. The
// last row of a wrapped cloud, packed to the start where every row above it is centered, was folded
// away behind the first chip. Down the page is left out. The first and the last of a stack touch
// the parent's two edges by being first and last, and splitting them off printed every list twice.
function getTouchedEdges(report: ElementReport): string {
  const position = report.tags.find((tag) => tag.startsWith('[pos:'));
  if (!position) return '';

  const terms = position.replace(/^\[pos: /, '').replace(/\]$/, '').replace(/ of viewport/g, '').split(', ');
  const acrossThePage = terms.filter((term) => inlineAxisTerms.has(term.split(' ')[0] ?? ''));
  return acrossThePage.filter((term) => term.startsWith('fills') || / -?0$/.test(term)).join(' ');
}

// What makes two siblings the same row of a list: the same kind of element, painting the same things,
// holding the same kinds of children in the same places, sitting against the same edges of the parent,
// and going wrong in the same way. Their text, their size and their offsets are what differs.
function getSimilarKey(report: ElementReport): string {
  const tags = report.tags.filter((tag) => !tag.startsWith('[pos:') && !tag.startsWith('[text:'));
  const childShapes = report.children.map(getInnerShape).join(' > ');
  return [report.shapeKey, ...tags, getTouchedEdges(report), childShapes, getFindingsSignature(report)].join(' ');
}

// Siblings that repeat, like the rows of a list, print once with a count. Two rows are the same row
// when they share a shape and the same findings and differ only in their words, their size and
// where they sit. Only the first one's subtree is printed. A row that goes wrong differently stays.
function formatReport(rawReport: ElementReport, depth: number, countsByFinding: Map<string, number>): FormattedReport {
  const report = collapseWrappers(rawReport);
  const indent = '  '.repeat(depth);
  const shownFindings = describeFindings(report.findings, countsByFinding);
  const findingsTag = shownFindings.length > 0 ? [`[!!: ${shownFindings.join(', ')}]`] : [];
  const skippedTag = report.tags.filter((tag) => tag === '[children skipped]');
  const otherTags = report.tags.filter((tag) => tag !== '[children skipped]');
  const line = indent + [capWrapperChain(report.label), ...otherTags, ...findingsTag, ...skippedTag].join(' ');

  type SiblingGroup = { indexes: number[]; firstText: string; isEveryOneIdentical: boolean };
  const childTexts: (string | null)[] = [];
  const groupsByKey = new Map<string, SiblingGroup>();

  for (const child of report.children) {
    const formatted = formatReport(child, depth + 1, countsByFinding);
    childTexts.push(formatted.text);

    const group = groupsByKey.get(formatted.similarKey);
    if (!group) {
      groupsByKey.set(formatted.similarKey, { indexes: [childTexts.length - 1], firstText: formatted.text, isEveryOneIdentical: true });
      continue;
    }
    group.indexes.push(childTexts.length - 1);
    group.isEveryOneIdentical = group.isEveryOneIdentical && formatted.text === group.firstText;
  }

  for (const group of groupsByKey.values()) {
    // Two rows that only look alike print in full. "×1 similar" hides a row and says nothing.
    const isWorthFolding = group.indexes.length > 2 || (group.indexes.length === 2 && group.isEveryOneIdentical);
    if (!isWorthFolding) continue;

    const count = group.isEveryOneIdentical ? ` ×${group.indexes.length}` : ` ×${group.indexes.length - 1} similar`;
    const [firstIndex, ...foldedIndexes] = group.indexes as [number, ...number[]];
    childTexts[firstIndex] = childTexts[firstIndex]!.replace(/\n|$/, `${count}$&`);
    for (const index of foldedIndexes) childTexts[index] = null;
  }

  const shownChildTexts = childTexts.filter((childText): childText is string => childText !== null);
  const text = [line, ...shownChildTexts].join('\n');
  return { text, similarKey: getSimilarKey(report) };
}

// Findings mode. Keep the lines that have a finding and the lines above them in the tree. The path
// down to each one then still reads. An ancestor is printed once, as its name only.
function keepLinesWithFindings(treeText: string): string {
  const keptLines: string[] = [];
  const ancestorsToPrint: (string | null)[] = [];

  for (const line of treeText.split('\n')) {
    const depth = (line.length - line.trimStart().length) / 2;
    // Anything deeper than this line belongs to a subtree we have left.
    ancestorsToPrint.length = depth;

    if (!line.includes('[!!:')) {
      ancestorsToPrint[depth] = line.replace(/ \[[^\]]*\]/g, '');
      continue;
    }

    for (let index = 0; index < depth; index++) {
      const ancestorLine = ancestorsToPrint[index];
      if (ancestorLine) keptLines.push(ancestorLine);
      ancestorsToPrint[index] = null;
    }
    keptLines.push(line);
    ancestorsToPrint[depth] = null;
  }

  return keptLines.join('\n');
}

// Element mode. The whole page is still measured, since coverage, alignment and spacing are all
// measured against the rest of it. Only the matched elements are printed, with the path down to
// them, so the tree costs a handful of lines instead of the page.
function keepSelectedElements(report: ElementReport, withChildren: boolean): ElementReport | null {
  if (report.isSelected && withChildren) return report;

  const keptChildren = report.children.map((child) => keepSelectedElements(child, withChildren)).filter((child) => child !== null);
  // A match inside a match is still asked for, whatever `withChildren` says about the rest.
  if (report.isSelected) return { ...report, children: keptChildren };
  if (keptChildren.length === 0) return null;

  return { ...report, children: keptChildren };
}

function countSelectedElements(report: ElementReport): number {
  const own = report.isSelected ? 1 : 0;
  return report.children.reduce((total, child) => total + countSelectedElements(child), own);
}

type TreeOptions = { selector: string | undefined; withChildren: boolean; findingsOnly: boolean };

// The tree as it is printed: the whole page, or only what a selector matched, and findings mode on
// top of either.
function formatTree(root: ElementReport, { selector, withChildren, findingsOnly }: TreeOptions): string {
  const printedRoot = selector === undefined ? root : keepSelectedElements(root, withChildren);
  if (!printedRoot) return `no element matched ${selector}`;

  const fullTree = formatReport(printedRoot, 0, new Map()).text;
  const tree = findingsOnly ? keepLinesWithFindings(fullTree) : fullTree;
  if (selector === undefined) return tree;

  // Everything above the tree was measured on the whole page. Without this the matched element
  // reads as all there is, and a summary counting findings it cannot see reads as a bug.
  const matchCount = countSelectedElements(printedRoot);
  const matched = `${matchCount} element${matchCount === 1 ? '' : 's'} matching ${selector}`;
  return `showing ${matched}, with the path down to each. the lines above are the whole page\n${tree}`;
}

type FindingEntry = { identifier: string; finding: string };

function collectFindings(root: ElementReport): FindingEntry[] {
  const entries: FindingEntry[] = [];
  const visit = (report: ElementReport) => {
    for (const finding of report.findings) {
      entries.push({ identifier: report.identifier, finding });
    }
    for (const child of report.children) visit(child);
  };
  visit(root);
  return entries;
}

// The same text color failing on several backgrounds is one palette bug, not one bug per background.
const contrastPattern = /^contrast (\d+(?:\.\d+)?) under \d+(?:\.\d+)?, (#[0-9a-f]+) on (#[0-9a-f]+)$/;

type ContrastGroup = { backgrounds: Set<string>; identifiers: string[]; worstRatio: number; worstBackground: string };

function describeContrastGroup(inkColor: string, group: ContrastGroup): string {
  const distinct = [...new Set(group.identifiers)];
  const shown = distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ', …' : '');
  const backgrounds = `${group.backgrounds.size} background${group.backgrounds.size === 1 ? '' : 's'}`;
  const elements = `${group.identifiers.length} element${group.identifiers.length === 1 ? '' : 's'}`;
  return `  ${inkColor} fails contrast on ${backgrounds}, ${elements}, worst ${group.worstRatio} on ${group.worstBackground} — ${shown}`;
}

// Something a reader cannot see comes before something they can. A hundred decorative boxes with no
// words in them are worth knowing about and are almost never the reason someone ran this, and
// sorting on count alone put them at the top while the one button nobody can click sat at the
// bottom. Within a group the count still decides.
const summaryOrder = [
  /\bhidden by\b/,
  /\bclipped\b|\bscrolled out\b|\boutside viewport\b/,
  /\bcovered by\b|\boverlaps\b/,
  /\btruncated\b|\boverflows\b/,
  /\bcontrast\b|\bnot loaded\b/,
  /\boff-center\b|\bthan\b/,
  /\buneven spacing\b|\bfree\b/,
];

function getSummaryRank(line: string): number {
  const found = summaryOrder.findIndex((kind) => kind.test(line));
  return found === -1 ? summaryOrder.length : found;
}

// Same finding on many elements is one bug. Say it once with a count, before the tree.
function summarizeFindings(entries: FindingEntry[]): string {
  const elementsByFinding = new Map<string, string[]>();
  const contrastGroups = new Map<string, ContrastGroup>();

  for (const { identifier, finding } of entries) {
    const contrast = finding.match(contrastPattern);
    if (contrast) {
      const [, ratioText = '', inkColor = '', backgroundColor = ''] = contrast;
      const ratio = parseFloat(ratioText);
      const group = contrastGroups.get(inkColor) ?? { backgrounds: new Set<string>(), identifiers: [], worstRatio: ratio, worstBackground: backgroundColor };
      group.backgrounds.add(backgroundColor);
      group.identifiers.push(identifier);
      if (ratio <= group.worstRatio) {
        group.worstRatio = ratio;
        group.worstBackground = backgroundColor;
      }
      contrastGroups.set(inkColor, group);
      continue;
    }
    const list = elementsByFinding.get(finding) ?? [];
    list.push(identifier);
    elementsByFinding.set(finding, list);
  }

  if (elementsByFinding.size === 0 && contrastGroups.size === 0) return 'findings: none';

  // Same kind of finding with different numbers is still one kind: "scrolled out right 47…497 ×5".
  // A hex color counts as a value too. Ten contrast failures in ten colors then stay one kind.
  const valuePattern = /#[0-9a-f]{3,8}|-?\d+(?:\.\d+)?/gi;
  // Where a number was, while findings are grouped and the range is put back. It has to be a
  // character no finding can hold. A plain `N` matched the capital in `div.Nav` and printed the
  // class back as `div.av`.
  const valuePlaceholder = String.fromCharCode(0xe000);
  // the same character written out, for anyone searching the file for it: '';
  //';
  // Quoted words are the element's own text, not a measurement. A label reading "908" is not a number
  // to put in a range.
  const maskQuotedText = (finding: string) => finding.replace(/"[^"]*"/g, '"…"');
  const groups = new Map<string, { findings: string[]; identifiers: string[] }>();
  for (const [finding, identifiers] of elementsByFinding) {
    const kind = maskQuotedText(finding).replace(valuePattern, valuePlaceholder);
    const group = groups.get(kind) ?? { findings: [], identifiers: [] };
    group.findings.push(finding);
    group.identifiers.push(...identifiers);
    groups.set(kind, group);
  }

  // The first number becomes a range. The other numbers have to agree across the group ("under
  // 4.5"). When they do not, the group only gets a count.
  const describeGroup = (kind: string, findings: string[]) => {
    if (findings.length === 1) return findings[0]!;
    const valueLists = findings.map((finding) => maskQuotedText(finding).match(valuePattern) ?? []);
    const restOfFirst = valueLists[0]!.slice(1).join(' ');
    const restAgrees = valueLists.every((values) => values.slice(1).join(' ') === restOfFirst);
    if (!restAgrees) return `${findings[0]} and ${findings.length - 1} more`;
    const firstNumbers = valueLists.map((values) => parseFloat(values[0] ?? '0'));
    if (firstNumbers.some(Number.isNaN)) return `${findings[0]} and ${findings.length - 1} more`;
    // "to", never "…". The ellipsis on a line is where text was cut, not where a range runs.
    const range = `${Math.min(...firstNumbers)} to ${Math.max(...firstNumbers)}`;
    const rest = valueLists[0]!.slice(1);
    return kind.split(valuePlaceholder).reduce((line, word, at) => {
      if (at === 0) return word;
      const value = at === 1 ? range : rest[at - 2] ?? '';
      return line + value + word;
    });
  };

  const countedLines = [...groups].map(([kind, group]) => {
    const distinct = [...new Set(group.identifiers)];
    const shown = distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ', …' : '');
    const count = group.identifiers.length > 1 ? ` ×${group.identifiers.length}` : '';
    return { count: group.identifiers.length, text: `  ${describeGroup(kind, group.findings)}${count} — ${shown}` };
  });
  for (const [inkColor, group] of contrastGroups) {
    countedLines.push({ count: group.identifiers.length, text: describeContrastGroup(inkColor, group) });
  }

  const lines = countedLines.sort((a, b) => getSummaryRank(a.text) - getSummaryRank(b.text) || b.count - a.count).map((line) => line.text);
  const total = countedLines.reduce((sum, line) => sum + line.count, 0);
  return `findings: ${total} on ${countedLines.length} kinds\n${lines.join('\n')}`;
}

// The previous run of the same page at the same size. A run can then say what the last edit changed.
const previousRunDirectory = join(tmpdir(), 'layout-lens');

function getPreviousRunPath(runKey: string): string {
  return join(previousRunDirectory, createHash('sha1').update(runKey).digest('hex').slice(0, 16) + '.json');
}

// Anything could be sitting at that path. It is a shared temp directory, and whatever comes back is
// printed as the last run's findings, so it has to be the shape we wrote.
function readPreviousRun(path: string): string[] | null {
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(stored) || stored.some((line) => typeof line !== 'string')) return null;
    return stored as string[];
  } catch {
    return null;
  }
}

function storeRun(path: string, lines: string[]): void {
  mkdirSync(previousRunDirectory, { recursive: true });
  writeFileSync(path, JSON.stringify(lines));
}

// Findings match when the text and the element are both the same. Two of the same line are two
// findings. A count that drops by one shows up as one gone.
function takeMissing(lines: string[], others: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const line of others) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const line of lines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
      continue;
    }
    missing.push(line);
  }
  return missing;
}

// Every number that is a measurement. The words the element shows are left alone. A label reading
// "908" is not something that moved. Neither is the element's own name, which comes before the
// first colon: the 3 in `div:nth-child(3)` was read as a measurement, so two different elements
// carrying the same finding paired up and printed as one that changed.
function replaceMeasurements(line: string, replace: (value: string) => string): string {
  const nameEnd = line.indexOf(': ');
  const name = nameEnd === -1 ? '' : line.slice(0, nameEnd + 2);
  const rest = line.slice(name.length);

  // Element names inside the finding are matched whole and passed through, along with quoted words.
  // A finding naming `div.no-scrollbar.z-10` was coming back as `div.no-scrollbar.z7 to -10`.
  const skipped = /"[^"]*"|\b[a-z][a-z0-9]*(?:#[\w-]+|\.[^\s,]+|:nth-child\(\d+\))+/g;
  const measurement = /-?\d+(?:\.\d+)?/g;

  return name + rest.replace(new RegExp(`${skipped.source}|${measurement.source}`, 'g'), (match) => (/^-?[\d.]+$/.test(match) ? replace(match) : match));
}

function getFindingShape(line: string): string {
  return replaceMeasurements(line, () => 'N');
}

// The same finding with the numbers it had before written in. `text truncated 74.5 to 156.5 hidden
// at end` reads as one thing that moved, where a gone line and a new line read as two.
function mergeChangedNumbers(previousLine: string, currentLine: string): string {
  const previousNumbers = replaceMeasurements(previousLine, (value) => value).match(/-?\d+(?:\.\d+)?/g) ?? [];
  let index = 0;
  return replaceMeasurements(currentLine, (current) => {
    const previous = previousNumbers[index++];
    return previous === undefined || previous === current ? current : `${previous} to ${current}`;
  });
}

function describeSinceLastRun(previousLines: string[] | null, currentLines: string[]): string {
  if (!previousLines) return 'since last run: first run';

  const gone = takeMissing(previousLines, currentLines);
  const added = takeMissing(currentLines, previousLines);

  // A finding whose only change is a number is one finding that moved, not one gone and one new.
  const changed: string[] = [];
  const stillGone: string[] = [];
  for (const goneLine of gone) {
    const shape = getFindingShape(goneLine);
    const matchIndex = added.findIndex((addedLine) => getFindingShape(addedLine) === shape);
    if (matchIndex < 0) {
      stillGone.push(goneLine);
      continue;
    }
    const [addedLine] = added.splice(matchIndex, 1) as [string];
    changed.push(mergeChangedNumbers(goneLine, addedLine));
  }

  const header = `since last run: ${stillGone.length} gone, ${added.length} new, ${changed.length} changed`;
  const lines = [
    ...stillGone.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`),
    ...changed.map((line) => `~ ${line.replace(': ', ': changed, ')}`),
  ];
  return [header, ...lines].join('\n');
}

type LoadResult = { httpStatus: number | null; failure: string | null };

/** Waiting for the network to go quiet gets this share of the timeout. */
const networkIdleShare = 0.25;

// A slow page is common enough that it is a result, not a crash. Wait for load, then give the
// network a short while to go quiet and carry on either way. `networkidle` never settles on a page
// that polls, and waiting the whole timeout for it costs 45 seconds on a chat app. Only when load
// itself never comes does a second try take the dom and give the rest of it two seconds to arrive.
export async function loadPage(page: Page, url: string, timeout: number): Promise<LoadResult> {
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    // A local file has no network to go quiet. Waiting for it spent half a second on every run of
    // the thing an agent is told to call after every change.
    if (!url.startsWith('file:')) {
      await page.waitForLoadState('networkidle', { timeout: timeout * networkIdleShare }).catch(() => {});
    }
    return { httpStatus: response?.status() ?? null, failure: null };
  } catch {
    // ignored, the second try is the real answer
  }

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(2000);
    return { httpStatus: response?.status() ?? null, failure: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { httpStatus: null, failure: message.split('\n')[0]!.replace(/^page\.goto: /, '') };
  }
}

/**
 * Scrolls the page down and returns how far it got. Runs inside the page, so it carries everything
 * it needs. Instant, since `scroll-behavior: smooth` would still be animating when the page is
 * measured.
 */
export async function scrollWindow(target: number | 'bottom'): Promise<number> {
  // Most pages scroll the document itself. An app shell scrolls a box inside it, and then the
  // window never moves however far you ask it to. Take the box with the most to scroll.
  // Asking for 0 asks for the page as it loads, so a chat that scrolled itself to the newest
  // message is left where it is.
  const documentScroller = document.scrollingElement ?? document.documentElement;
  let scroller = documentScroller;

  if (target !== 0 && documentScroller.scrollHeight <= documentScroller.clientHeight) {
    let widestScrollableRoom = 0;

    for (const candidate of document.querySelectorAll('*')) {
      const room = candidate.scrollHeight - candidate.clientHeight;
      if (room <= widestScrollableRoom) continue;

      const overflow = getComputedStyle(candidate).overflowY;
      const isScrollable = overflow === 'auto' || overflow === 'scroll';
      if (!isScrollable) continue;

      widestScrollableRoom = room;
      scroller = candidate;
    }
  }

  const top = target === 'bottom' ? scroller.scrollHeight : target;
  scroller.scrollTo({ top, behavior: 'instant' });

  // An animation driven by scrolling moves on the next frame. Reading the page before that frame
  // shows it as it was before the scroll.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  return scroller.scrollTop;
}

/**
 * Finishes every animation that runs on time, so nothing is measured half way through a transition.
 * Runs inside the page.
 */
export function finishAnimations(): void {
  for (const animation of document.getAnimations()) {
    // An animation tied to scrolling is already where the scroll put it. Finishing one jumps it to
    // its end state, and a page whose cards pile up as you scroll then reads the same at every
    // offset.
    const isScrollDriven = animation.timeline !== document.timeline;
    if (isScrollDriven) continue;

    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
}

export type Viewport = { width: number; height: number };

// The phone, the tablet and the laptop everyone checks. A width on its own gets the height that
// goes with it.
const defaultHeightByWidth: Record<number, number> = { 390: 844, 820: 1180, 1280: 720 };

export function parseViewports(widths: (number | string)[], fallbackHeight: number): Viewport[] {
  return widths.map((entry) => {
    const [widthText = '', heightText] = String(entry).trim().split('x');
    const width = Number(widthText);
    const height = heightText ? Number(heightText) : defaultHeightByWidth[width] ?? fallbackHeight;
    return { width, height };
  });
}

// One measurement of the page. `label` tells it apart from the others, by width, by scheme or by
// both. The across block lists a finding under that label.
type MeasuredRun = { viewport: Viewport; scheme: ColorScheme; label: string; header: string; summary: string; sinceLastRun: string; tree: string; findingLines: string[] };


// Two findings are the same when they are the same kind, on the same element, about the same other
// element. What the viewport changes is the measurement. Every number, every percentage and the
// words the element shows are taken out first. `text "Ada" 43% hidden by div.bar` and `text "Ada
// Lovelace" hidden by div.bar` were landing as one finding at each width instead of one shared.
function getFindingKey(findingLine: string): string {
  return findingLine
    .replace(/"[^"]*"/g, '')
    .replace(/-?\d+(?:\.\d+)?%?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Which findings only show up in some of the runs. At several widths that is the responsive bug. In
// both color schemes it is the dark mode someone forgot. The rest is the same page.
function describeAcrossRuns(heading: string, runs: MeasuredRun[]): string {
  type SharedFinding = { labels: string[]; findingLine: string };
  const findingsByKey = new Map<string, SharedFinding>();

  for (const run of runs) {
    for (const findingLine of new Set(run.findingLines.map(getFindingKey))) {
      const found = findingsByKey.get(findingLine);
      if (found) {
        found.labels.push(run.label);
        continue;
      }
      const original = run.findingLines.find((line) => getFindingKey(line) === findingLine)!;
      findingsByKey.set(findingLine, { labels: [run.label], findingLine: original });
    }
  }

  const lines: string[] = [];
  let sharedCount = 0;
  for (const { labels, findingLine } of findingsByKey.values()) {
    if (labels.length === runs.length) {
      sharedCount++;
      continue;
    }
    lines.push(`  ${labels.join(', ')} only: ${findingLine}`);
  }

  return [heading, ...lines, `  all: ${sharedCount} findings shared`].join('\n');
}

/**
 * Opens the page in headless Chromium and returns the layout report as text. A page that never
 * loads comes back as a `could not load` line rather than throwing.
 */
export async function inspectPage(options: InspectPageOptions): Promise<string> {
  const {
    target,
    width = 1280,
    height = 720,
    scheme = 'light',
    scroll = 0,
    shadow = true,
    findingsOnly = false,
    colors = false,
    selector,
    withChildren = true,
    timeout = 30000,
    widths,
    schemes,
  } = options;
  const url = getTargetUrl(target);
  const viewports = widths && widths.length > 0 ? parseViewports(widths, height) : [{ width, height }];
  const schemesToMeasure = schemes && schemes.length > 0 ? schemes : [scheme];
  const hasSeveralViewports = viewports.length > 1;
  const hasSeveralSchemes = schemesToMeasure.length > 1;

  // Playwright downloads Chromium separately from the package. A first run without it is common.
  // One line with the command to fix it, not a Playwright stack.
  let browser: Browser;
  try {
    browser = await chromium.launch();
  } catch {
    return `${loadFailurePrefix}launch chromium, run: npx playwright install chromium`;
  }

  try {
    const runs: MeasuredRun[] = [];

    // The color scheme is fixed when the page is created. Each scheme gets a page of its own.
    for (const runScheme of schemesToMeasure) {
      const page = await browser.newPage({ viewport: viewports[0]!, colorScheme: runScheme });

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        const { httpStatus, failure } = await loadPage(page, url, timeout);
        if (failure) return `${loadFailurePrefix}load ${target}: ${failure}`;

        const scrolledTo = await page.evaluate(scrollWindow, scroll);
        await page.evaluate(finishAnimations);
        await page.evaluate(() => document.fonts.ready);

        // The walk runs in the page and a page with thousands of siblings can take minutes. Give it
        // the same ceiling the load got, so one call cannot hang for ever.
        const walk = page.evaluate(inspectLayout, { walkShadowRoots: shadow, httpStatus, colors, selector, scrolledTo });
        let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
        const gaveUp = new Promise<null>((resolve) => {
          giveUpTimer = setTimeout(() => resolve(null), timeout);
        });
        const measured = await Promise.race([walk, gaveUp]).finally(() => clearTimeout(giveUpTimer));
        if (!measured) return `${loadFailurePrefix}measure ${target}: the page is too large to walk within ${timeout}ms`;

        const { header, headerFindings, root, isSelectorValid } = measured;
        if (!isSelectorValid) return `${selector} is not a valid css selector`;

        // A page that sends you somewhere else is measured at the place you landed, not the one you asked for.
        // Compared as urls, so the slash a browser adds to a bare host is not a redirect.
        const finalUrl = page.url();
        const isSamePlace = finalUrl === url || finalUrl === new URL(url).href;
        const headerWithRedirect = isSamePlace ? header : `${header}, redirected to ${finalUrl}`;

        // The page-level findings count like the rest. A 404 page said `findings: none` under them.
        const pageEntries = headerFindings.map((finding) => ({ identifier: 'page', finding }));
        const entries = [...pageEntries, ...collectFindings(root)];
        const currentLines = entries.map((entry) => `${entry.identifier}: ${entry.finding}`);

        // The resolved url, not what the caller typed. Two `index.html` in different folders are
        // two pages, and keying on the typed name diffed one against the other.
        const previousRunPath = getPreviousRunPath([url, viewport.width, viewport.height, runScheme, scroll, !shadow].join('|'));
        const sinceLastRun = describeSinceLastRun(readPreviousRun(previousRunPath), currentLines);
        storeRun(previousRunPath, currentLines);

        const labelParts = [hasSeveralViewports ? String(viewport.width) : '', hasSeveralSchemes ? runScheme : ''];
        const label = labelParts.filter(Boolean).join(' ');

        const tree = formatTree(root, { selector, withChildren, findingsOnly });
        const summary = summarizeFindings(entries);
        runs.push({ viewport, scheme: runScheme, label, header: headerWithRedirect, summary, sinceLastRun, tree, findingLines: currentLines });
      }

      await page.close();
    }

    const [onlyRun] = runs;
    if (runs.length === 1 && onlyRun) {
      return onlyRun.header + '\n\n' + onlyRun.sinceLastRun + '\n\n' + onlyRun.summary + '\n\n' + onlyRun.tree;
    }

    const headingParts = [hasSeveralViewports ? 'viewports' : '', hasSeveralSchemes ? 'schemes' : ''];
    const heading = `across ${headingParts.filter(Boolean).join(' and ')}`;

    const reports = runs.map((run) => [run.header, '', run.sinceLastRun, '', run.summary].join('\n'));
    const trees = runs.map((run) => `viewport ${run.viewport.width}x${run.viewport.height}${hasSeveralSchemes ? `, ${run.scheme}` : ''}\n${run.tree}`);
    return [reports.join('\n\n'), describeAcrossRuns(heading, runs), ...trees].join('\n\n');
  } finally {
    await browser.close();
  }
}

// Scores the tool against the adversarial suite. Does it find the planted bug, and does it stay
// quiet on the pages that only look broken?
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectPage } from '../src/inspectPage.ts';

// `npm run score` scores fixtures/adversarial, `npm run score -- adversarial2` another suite.
const suiteName = process.argv[2] ?? 'adversarial';
const adversarialDirectory = join(import.meta.dirname, '..', 'fixtures', suiteName);

type ManifestEntry = {
  file: string;
  kind: 'bug' | 'clean';
  width: number;
  height: number;
  scroll: number;
  expect: string;
  mustNotReport: string | null;
};

const manifest: ManifestEntry[] = JSON.parse(readFileSync(join(adversarialDirectory, 'manifest.json'), 'utf8'));

function inspectFixture(entry: ManifestEntry): Promise<string> {
  return inspectPage({
    target: join(adversarialDirectory, entry.file),
    width: entry.width,
    height: entry.height,
    scroll: entry.scroll,
  });
}

type ElementLine = { label: string; tags: string; line: string };

// Every element line of the tree, split into the label and its tags. An expectation about
// `[pos: ...]` can then be matched as well as one about a finding.
function readElementLines(report: string): ElementLine[] {
  const treeLines = report.split('\n').filter((line) => /^\s*[a-z][a-z0-9-]*[#. "]/.test(line) && line.includes(' ['));
  return treeLines.map((line) => {
    const trimmed = line.trim();
    const tagStart = trimmed.indexOf(' [');
    return {
      label: trimmed.slice(0, tagStart).toLowerCase(),
      tags: trimmed.slice(tagStart).toLowerCase(),
      line: trimmed,
    };
  });
}

function filterFindingLines(elementLines: ElementLine[]): ElementLine[] {
  return elementLines.filter((element) => element.line.includes('[!!:'));
}

function readFindingLines(report: string): ElementLine[] {
  return filterFindingLines(readElementLines(report));
}

function getFindingsPart(tags: string): string {
  const findingStart = tags.indexOf('[!!:');
  return findingStart === -1 ? '' : tags.slice(findingStart);
}

// `a#nav-settings.nav-link` is found by its id, `span.avatar` by tag and class.
function getElementMatcher(elementName: string): string {
  const withId = elementName.match(/#[A-Za-z0-9_-]+/);
  return (withId ? withId[0] : elementName).toLowerCase();
}

function getNamedElements(sentence: string): string[] {
  const tokens = sentence.match(/\b[a-z][a-z0-9]*(?:#[A-Za-z0-9_-]+)?(?:\.[A-Za-z][A-Za-z0-9_-]*)+/g) ?? [];
  const withIds = sentence.match(/\b[a-z][a-z0-9]*#[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set([...tokens, ...withIds].map(getElementMatcher))];
}

function getQuotedPhrases(sentence: string): string[] {
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

// A phrase is matched on its plain words, never its numbers or its element names. `contrast 4.3
// under 4.5, #7a7a7a on #ffffff` then also matches a run that measured 4.4.
function getPhraseWords(phrase: string): string[] {
  const withoutElements = phrase
    .replace(/"[^"]*"/g, ' ')
    .replace(/\b[a-z][a-z0-9]*(?:#[A-Za-z0-9_-]+)?(?:\.[A-Za-z][A-Za-z0-9_-]*)+/g, ' ')
    .replace(/#[0-9a-f]{3,8}\b/gi, ' ');
  const words = withoutElements.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
  return words;
}

// The match is loose because the tool may drop a word of the phrase. `3 further end than
// input.field` is the finding the manifest wrote as `start edge 3 further end than input.field`.
function isPhraseInFinding(phrase: string, findings: string): boolean {
  const words = getPhraseWords(phrase);
  if (words.length === 0) return false;

  const isPresent = (word: string) => new RegExp(`(^|[^a-z-])${word}([^a-z-]|$)`).test(findings);
  const presentCount = words.filter(isPresent).length;
  const leastPresent = Math.min(2, words.length);
  return presentCount >= leastPresent && presentCount / words.length >= 0.6;
}

type PageResult = {
  entry: ManifestEntry;
  status: 'HIT' | 'MISS' | 'PASS' | 'FAIL';
  otherFindings: number;
  note: string;
};

// The expectation names the element first, or after a lead-in such as `At scroll 400` or `The
// svg inside`. The first element token in the sentence is the one being scored.
function getExpectedElement(expect: string): string {
  const firstElement = expect.match(/\b[a-z][a-z0-9]*(?:#[A-Za-z0-9_-]+|(?:\.[A-Za-z][A-Za-z0-9_-]*)+)/);
  return firstElement ? firstElement[0] : expect.trim().split(/\s+/)[0]!;
}

function scoreBugPage(entry: ManifestEntry, report: string): PageResult {
  const elementName = getExpectedElement(entry.expect);
  const elementMatcher = getElementMatcher(elementName);
  const phrases = getQuotedPhrases(entry.expect);
  const elementLines = readElementLines(report);
  const findingLines = filterFindingLines(elementLines);

  // A phrase from a `[pos: ...]` expectation matches the whole tag part. A finding phrase matches
  // only inside `[!!: ...]`. A word such as `end` in `[pos: end 3]` cannot satisfy a finding.
  const hitLine = elementLines.find((found) => {
    if (!found.label.includes(elementMatcher)) return false;
    return phrases.some((phrase) => {
      const isTagPhrase = phrase.startsWith('[');
      const searched = isTagPhrase ? found.tags : getFindingsPart(found.tags);
      return isPhraseInFinding(phrase, searched);
    });
  });

  const otherFindings = findingLines.filter((found) => found !== hitLine);
  const note = hitLine
    ? otherFindings.map((found) => found.line).join(' | ')
    : `no matching finding on ${elementName}` +
      (findingLines.length > 0 ? `; saw ${findingLines.map((found) => found.line).join(' | ')}` : '');

  return {
    entry,
    status: hitLine ? 'HIT' : 'MISS',
    otherFindings: otherFindings.length,
    note,
  };
}

function scoreCleanPage(entry: ManifestEntry, report: string): PageResult {
  const forbidden = entry.mustNotReport ?? '';
  const phrases = getQuotedPhrases(forbidden);
  const namedElements = getNamedElements(forbidden);
  const findingLines = readFindingLines(report);

  const failures = findingLines.filter((found) => {
    const matchedPhrase = phrases.find((phrase) => isPhraseInFinding(phrase, found.tags));
    if (!matchedPhrase) return false;

    // A phrase naming an element of its own (`overlaps figure.side-figure`, `hidden by body`) is
    // already specific. A bare kind has to land on one of the elements the sentence named.
    const phraseNamesElement = getNamedElements(matchedPhrase).length > 0 || /\b(body|html)\b/.test(matchedPhrase);
    if (phraseNamesElement) return true;

    return namedElements.some((element) => found.label.includes(element) || found.tags.includes(element));
  });

  return {
    entry,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    otherFindings: 0,
    note: failures.map((found) => found.line).join(' | '),
  };
}

const results: PageResult[] = [];

for (const entry of manifest) {
  const report = await inspectFixture(entry);
  const result = entry.kind === 'bug' ? scoreBugPage(entry, report) : scoreCleanPage(entry, report);
  results.push(result);

  const extra = result.otherFindings > 0 ? ` (+${result.otherFindings} other findings)` : '';
  console.log(`${result.status.padEnd(4)} ${entry.file}${extra}`);
  if (result.note) console.log(`     ${result.note}`);
}

const bugPages = results.filter((result) => result.entry.kind === 'bug');
const hitCount = bugPages.filter((result) => result.status === 'HIT').length;
const otherFindingCount = results.reduce((total, result) => total + result.otherFindings, 0);
const cleanFailCount = results.filter((result) => result.status === 'FAIL').length;

// A clean page's mustNotReport is the only thing a manifest can call wrong. Nobody ever judged the
// other findings on a bug page. Describing everything true about a page is the job. Counting each
// of those as a false positive scored a suite at 0.53 while only one finding was untrue.
const recall = hitCount / bugPages.length;
const precision = hitCount / (hitCount + cleanFailCount);

console.log(`\nhits ${hitCount}/${bugPages.length}, other findings ${otherFindingCount}, clean fails ${cleanFailCount}`);
console.log(`recall ${recall.toFixed(2)}, precision ${precision.toFixed(2)}`);
process.exit(recall < 0.9 || precision < 0.9 ? 1 : 0);

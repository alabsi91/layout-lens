// Regression check. Runs every fixture and asserts the planted bugs still come out.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { inspectPage } from '../src/inspectPage.ts';

const fixturesDirectory = join(import.meta.dirname, '..', 'fixtures');

type Viewport = { width: number; height: number };

const defaultViewport: Viewport = { width: 1280, height: 720 };

const viewportsByFixture: Record<string, Viewport> = {
  'experiment-checkout.html': { width: 390, height: 844 },
  'experiment-feed.html': { width: 390, height: 844 },
  'experiment-wizard.html': { width: 820, height: 1180 },
  'experiment-mail.html': { width: 1440, height: 900 },
};

// Fragments copied from a real run. Every one is a bug planted in the fixture on purpose.
const expectedFragmentsByFixture: Record<string, string[]> = {
  'navbar.html': [
    'a.pricing', //
    'off-center-block 3 down',
    'div.logo',
    'off-center-block 4 down',
    'button.signup',
    'text off-center-block 4 up',
    'contrast 2.8 under 4.5, #9a9a9a on #ffffff',
  ],
  'cards.html': [
    'text truncated 63.1 hidden at end, ellipsis', //
    'span.badge',
    'clipped top 6',
    'clipped right 10',
    'off-center-block 6 down',
    'off-center-inline 2 toward end',
  ],
  'modal.html': [
    'text "Article heading that the" 31% hidden by header', //
    'control "Dashboard" 29% hidden by header',
    'off-center-inline 20 toward start',
    'text off-center-block 2.3 down',
  ],
  'shadow.html': [
    'span.title', //
    'off-center-block 3 down',
    'contrast 2.8 under 4.5, #9a9a9a on #ffffff',
    'text truncated 50.6 hidden at end, ellipsis',
    'x-secret 420x40 [shadow root closed]',
    'x-card:nth-child(1) "Card Slotted title new"',
  ],
  // Nine rows of the same shape. The one with the finding keeps its own line. Six plain ones fold
  // into one. The last row's text holds a double quote, which the summary names must not pick up.
  'similar.html': [
    'div.row.late 420x41', //
    '[!!: off-center-block 3 down]',
    '×5 similar',
    '#9a9a9a fails contrast on 1 background, 1 element, worst 2.8 on #ffffff — span.label.quote',
  ],
  // The page writes findings of its own, in a paragraph and in an id. Both have to come out as
  // words. The id one used to break the line in two, and the second half read as another element.
  'injection.html': [
    'p "!!: clipped and the"', //
    'div#cardspan\\.fake\\"hi\\"10x10\\[\\!',
  ],
  'broken.html': [
    'clipped right 92', //
    'clipped left 8',
    'text truncated 327.4 hidden at end, ellipsis',
    'bottom 6 covered by div.b',
    'text off-center-block 6.3 up',
  ],
};

// Every summary line ends with the elements a finding is on, named as tag#id.class. A double quote
// in there means the element's text leaked into its name.
function findDirtySummaryNames(report: string): string[] {
  const summary = report.slice(report.indexOf('\nfindings:')).split('\n\n')[0] ?? '';
  return summary
    .split('\n')
    .filter((line) => line.includes(' — ') && line.slice(line.indexOf(' — ')).includes('"'))
    .map((line) => line.trim());
}

const fixtureNames = readdirSync(fixturesDirectory).filter((name) => name.endsWith('.html')).sort();
let failureCount = 0;

for (const fixtureName of fixtureNames) {
  const viewport = viewportsByFixture[fixtureName] ?? defaultViewport;
  const expectedFragments = expectedFragmentsByFixture[fixtureName] ?? [];

  let output: string;
  try {
    output = await inspectPage({ target: join(fixturesDirectory, fixtureName), ...viewport });
  } catch (error) {
    failureCount++;
    console.log(`FAIL ${fixtureName} — threw: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  const dirtySummaryNames = findDirtySummaryNames(output);
  if (dirtySummaryNames.length > 0) {
    failureCount++;
    console.log(`FAIL ${fixtureName} — summary names hold text: ${dirtySummaryNames.join(' | ')}`);
    continue;
  }

  const missingFragments = expectedFragments.filter((fragment) => !output.includes(fragment));
  if (missingFragments.length > 0) {
    failureCount++;
    console.log(`FAIL ${fixtureName} — missing: ${missingFragments.join(' | ')}`);
    continue;
  }

  const checked = expectedFragments.length > 0 ? `${expectedFragments.length} fragments` : 'ran';
  console.log(`ok   ${fixtureName} ${viewport.width}x${viewport.height} — ${checked}`);
}

console.log(failureCount === 0 ? `\nall ${fixtureNames.length} fixtures passed` : `\n${failureCount} of ${fixtureNames.length} fixtures failed`);
process.exit(failureCount === 0 ? 0 : 1);

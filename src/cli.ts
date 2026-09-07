#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ColorScheme } from './inspectPage.ts';
import { inspectPage, loadFailurePrefix } from './inspectPage.ts';
import { getPngSize, screenshotPage } from './screenshotPage.ts';
import { legend } from './legend.ts';

const usage = `usage: layout-lens <url|file> [--width 1280] [--height 720] [--widths 390,820,1280] [--scheme light|dark] [--schemes light,dark] [--scroll 0|bottom] [--timeout 30000] [--no-shadow] [--findings] [--colors] [--element selector] [--no-children] [--screenshot out.png] [--legend]
  <url|file>    a url, or a path to a local html file
  --width       viewport width in px, 1280 by default
  --height      viewport height in px, 720 by default
  --widths      measure at several viewports and compare them, 390,820,1280 or 390x844,1280x720
  --scheme      the color scheme the page is rendered in, light or dark. light by default
  --schemes     measure in both color schemes and compare them, light,dark
  --scroll      how far down the page is scrolled before measuring, in px, or bottom. 0 by default
  --timeout     how long to wait for the page to load, in ms, 30000 by default
  --no-shadow   walk the markup children instead of open shadow roots
  --findings    print only the lines that carry a finding, plus the path down to each one
  --colors      write the rendered color of what each element paints, as hex
  --element     print only the elements matching this css selector, with the path down to each one
  --no-children with --element, leave out what is inside the matched elements
  --screenshot  write a png of the whole page to this path instead of printing the tree
                with --element, shoot only the box of the first element matching it
  --legend      print the legend that explains the output and exit
  --help        print this

the output is dense. run layout-lens --legend once and keep it, or read README.md`;

// An unknown flag is a typo, not a crash. Print what went wrong and the flags instead of a stack.
function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        width: { type: 'string', default: '1280' },
        height: { type: 'string', default: '720' },
        widths: { type: 'string' },
        scheme: { type: 'string', default: 'light' },
        schemes: { type: 'string' },
        scroll: { type: 'string', default: '0' },
        timeout: { type: 'string', default: '30000' },
        'no-shadow': { type: 'boolean', default: false },
        findings: { type: 'boolean', default: false },
        colors: { type: 'boolean', default: false },
        screenshot: { type: 'string' },
        element: { type: 'string' },
        'no-children': { type: 'boolean', default: false },
        legend: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    process.exit(1);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(usage);
    process.exit(1);
  }

  return parsed;
}

const { values, positionals } = parseCommandLine();

if (values.help) {
  console.log(usage);
  process.exit(0);
}

if (values.legend) {
  console.log(legend);
  process.exit(0);
}

const target = positionals[0];
if (!target) {
  console.error(usage);
  process.exit(1);
}

// A directory loads as a file listing, which is not a page anyone asked about.
const isLocalPath = !/^[a-z]+:/i.test(target);
if (isLocalPath && statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`${target} is a directory, pass a url or an html file`);
  process.exit(1);
}

const width = parsePositiveInteger(values.width);
const height = parsePositiveInteger(values.height);
const timeout = parsePositiveInteger(values.timeout);

const scrollTarget: number | 'bottom' = values.scroll === 'bottom' ? 'bottom' : Number(values.scroll);
if (scrollTarget !== 'bottom' && !Number.isFinite(scrollTarget)) {
  console.error(usage);
  process.exit(1);
}

const widths = values.widths?.split(',').map((entry) => entry.trim());
if (widths?.some((entry) => !/^\d+(?:x\d+)?$/.test(entry))) {
  console.error(usage);
  process.exit(1);
}

const isColorScheme = (entry: string): entry is ColorScheme => entry === 'light' || entry === 'dark';

const schemes = values.schemes?.split(',').map((entry) => entry.trim()) ?? [];
if (!isColorScheme(values.scheme) || !schemes.every(isColorScheme)) {
  console.error(usage);
  process.exit(1);
}

if (values['no-children'] && !values.element) {
  console.error('--no-children does nothing without --element, ignoring it');
}

if (values.screenshot) {
  const outputPath = values.screenshot;
  try {
    const shots = await screenshotPage({
      target,
      width,
      height,
      scheme: values.scheme,
      scroll: scrollTarget,
      timeout,
      element: values.element,
    });

    const png = shots[0]!.png;

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, png);
    const pngSize = getPngSize(png);
    console.log(`screenshot: ${outputPath} ${pngSize.width}x${pngSize.height}`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const text = await inspectPage({
  target,
  widths,
  width,
  height,
  scheme: values.scheme,
  schemes,
  scroll: scrollTarget,
  timeout,
  shadow: !values['no-shadow'],
  findingsOnly: values.findings,
  colors: values.colors,
  selector: values.element,
  withChildren: !values['no-children'],
});

console.log(text);

// The page never loaded. That is a result with a reason in it, not a crash. It exits 2 and prints
// no stack trace.
if (text.startsWith(loadFailurePrefix)) {
  process.exit(2);
}

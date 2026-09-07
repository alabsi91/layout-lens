#!/usr/bin/env node
import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { inspectPage } from './inspectPage.ts';
import { getPngSize, screenshotPage } from './screenshotPage.ts';
import { legend } from './legend.ts';

// Enough syntax to read a report without asking for more, and short enough to sit in a tool list.
// The full legend is a tool of its own.
const description = `Measure the layout of a rendered web page and get the numbers back as text.

Reading the HTML or the CSS cannot answer these questions. The browser resolves the cascade, fonts,
flex and grid at run time, and only the drawn box has numbers. If you are about to open a file to
check spacing, alignment, clipping, overlap or contrast, call this instead.

Opens the page or local file in headless Chromium at a given viewport, waits for fonts and
animations to settle, and prints one indented line per element. It answers "is this label 3px off
center", "is this card clipped", "what covers this button", "does this text run past its box" with
pixel numbers. Run it first after every CSS change, before taking a screenshot. findings_only keeps
just the flagged lines and the path down to them. When the page has a dark mode, pass schemes
["light", "dark"] and check both, a fix in one scheme is often a bug in the other.

Every number is px. A line is tag#id.class "first words" WxH, then tags. One looks like this:

  span.badge "Popular" 57.4x18 [pad: 2 8] [pos: top -6, end -10] [text: Helvetica 12/14, contrast
  3.8] [!!: clipped top 6, clipped right 10, contrast 3.8 under 4.5, #ffffff on #ef4444]

The badge sits 6px above its card and 10px past its end, so that corner is cut off on two sides,
and the white on red fails contrast.

The first line is the page: viewport, scroll, page size, painted to (how far down anything is
drawn), http status, dpr, direction, color scheme. Read it before the findings. Painted to 200 on a page 4000
tall, or status 403, means what follows is a shell or a block page.

Tags: [renders] what it paints. [scroll] a scrollable box, content size in visible size. [pad]
padding. [pos] where it sits inside the parent's content box, inside border and padding, the box
CSS centers things in. [bleed] wider than the parent on purpose. [gaps] space between children.
[stacked] children pulled onto each other on purpose. [line] inline children sharing one line.
[text] font, size/line-height, ink top, ink bottom, lines, contrast. [shadow root] the lines under it
are its shadow tree. [sr-only] [offscreen] [oversized] [rotated] [scaled] [not painted] measured,
and left out of the checks. [!!] what looks wrong.

[!!] carries what looks wrong: off center, covered, hidden, clipped, scrolled out, outside the
viewport, truncated, overflowing, misaligned, mismatched in size, unevenly spaced, low contrast.
layout_legend spells out every one of them.

Under the first line every kind of finding is summarized once with a count, then since last run
says what went away and what appeared against the previous run of the same page.

Every finding is a measurement of what the browser drew, not a guess. The number happened. What is
still yours to judge is whether it matters: a badge 6px outside its card may be the design. Judge
that from the page, not by assuming the tool is wrong, and say which of the two you decided. An
element with no finding is not thereby correct, the tool only reports what it measures.

Call layout_legend once for the full syntax.`;

// Read from package.json. A second copy here would drift from the published one.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Loaded once by the client rather than with every tool listing. It carries the standing habit,
// which is the part an agent needs before it has decided to call anything.
const instructions = `layout-lens measures a rendered page in a real browser. Run inspect_layout
after every CSS change, before deciding a fix worked, and before taking a screenshot, since reading
the file cannot tell you what the browser drew. Its syntax is dense: call layout_legend once per
session and keep it, it never changes. What it reports was measured off the rendered page, so treat
a finding as true and decide whether it matters, rather than waving it away as a false positive.`;

const server = new McpServer({ name: 'layout-lens', version }, { instructions });

server.registerTool(
  'inspect_layout',
  {
    description,
    inputSchema: {
      target: z.string().describe('A url, or a path to a local html file.'),
      width: z.number().int().min(1).max(10000).default(1280).describe('Viewport width in px.'),
      height: z.number().int().min(1).max(10000).default(720).describe('Viewport height in px.'),
      widths: z
        .array(z.union([z.number(), z.string()]))
        .max(10)
        .optional()
        .describe(
          'Measure the page at several viewports and compare them, as [390, 820, 1280] or ["390x844", "1280x720"]. A width on its own gets 844 at 390, 1180 at 820, 720 at 1280, and the height option anywhere else. Width is ignored when this is given.',
        ),
      scheme: z.enum(['light', 'dark']).default('light').describe('The color scheme the page is rendered in.'),
      schemes: z
        .array(z.enum(['light', 'dark']))
        .optional()
        .describe('Measure the page in both color schemes and compare them, as ["light", "dark"]. An "across schemes" block then says which findings only show up in one of them. Scheme is ignored when this is given.'),
      scroll: z.union([z.number(), z.literal('bottom')]).default(0).describe('How far down the page is scrolled before measuring, in px, or "bottom".'),
      shadow: z.boolean().default(true).describe('Walk open shadow roots. False shows the markup children instead.'),
      findings_only: z.boolean().default(false).describe('Print only the lines that carry a finding, with the lines above them in the tree.'),
      timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .default(30000)
        .describe(
          'How long to wait for the page to load, in ms. The network then gets a quarter of it to go quiet and the page is measured either way. A page that never loads comes back as a "could not load" line.',
        ),
    },
  },
  async ({ target, width, height, widths, scheme, schemes, scroll, shadow, findings_only, timeout }) => {
    const text = await inspectPage({ target, width, height, widths, scheme, schemes, scroll, shadow, findingsOnly: findings_only, timeout });
    return { content: [{ type: 'text', text }] };
  },
);

const screenshotDescription = `Take a png of the same page inspect_layout measures, loaded the same way.

Read the numbers first and use this to look at one box: pass element with a CSS selector and only
that element is captured, which is small enough to read. Without element you get the whole page,
top to bottom, which is often tall and hard to see anything in.

The picture shows what is drawn. It does not tell you a label is 3px off center or that a card is
clipped by 10px, inspect_layout does. Use them together: numbers to find the bug, picture to see
what it looks like.

The image comes back with a line saying its pixel size, and in element mode where the element sits
on the page.`;

server.registerTool(
  'screenshot_layout',
  {
    description: screenshotDescription,
    inputSchema: {
      target: z.string().describe('A url, or a path to a local html file.'),
      width: z.number().int().min(1).max(10000).default(1280).describe('Viewport width in px.'),
      height: z.number().int().min(1).max(10000).default(720).describe('Viewport height in px.'),
      scheme: z.enum(['light', 'dark']).default('light').describe('The color scheme the page is rendered in.'),
      scroll: z.union([z.number(), z.literal('bottom')]).default(0).describe('How far down the page is scrolled before the shot, in px, or "bottom".'),
      timeout: z.number().int().min(1000).max(120000).default(30000).describe('How long to wait for the page to load, in ms. The network then gets a quarter of it to go quiet.'),
      element: z.string().optional().describe('A CSS selector. Given, only the box of the first element matching it is captured. Left out, the whole page is.'),
    },
  },
  async ({ target, width, height, scheme, scroll, timeout, element }) => {
    try {
      const { png, rect } = await screenshotPage({ target, width, height, scheme, scroll, timeout, element });
      const size = getPngSize(png);
      const place = rect ? `, ${element} at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)} on the page` : '';
      return {
        content: [
          { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: `screenshot ${size.width}x${size.height}${place}` },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: message }], isError: true };
    }
  },
);

server.registerTool(
  'layout_legend',
  {
    description:
      'The full syntax of what inspect_layout prints: every tag, every finding, and when each one is left out. Call it once, it never changes and the reports do not repeat it.',
  },
  async () => ({ content: [{ type: 'text', text: legend }] }),
);

await server.connect(new StdioServerTransport());

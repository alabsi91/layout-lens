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
animations to settle, and prints one indented line per element: tag#id.class "first words" WxH, then
tags. Every number is px.

  span.badge "Popular" 57.4x18 [pad: 2 8] [pos: top -6, end -10] [text: Helvetica 12/14, contrast
  3.8] [!!: clipped top 6, clipped right 10, contrast 3.8 under 4.5, #ffffff on #ef4444]

The badge sits 6px above its card and 10px past its end, so that corner is cut off on two sides,
and the white on red fails contrast.

The first line is the page: viewport, scroll, page size, painted to (how far down anything is
drawn), http status, dpr, direction, color scheme. Painted to 200 on a page 4000 tall, or status
403, means what follows is a shell or a block page. Under it every kind of finding is counted once,
then since last run says what went away and what appeared against the previous run of the same page.

[!!] is what looks wrong: off center, covered, hidden, clipped, scrolled out, outside the viewport,
truncated, overflowing, misaligned, mismatched in size, unevenly spaced, low contrast.

Tags: [renders] what it paints, [scroll] content size in visible size, [pad] padding, [pos] where it
sits in the parent's content box, [bleed] wider than the parent on purpose, [gaps] space between
children, [stacked] children pulled onto each other on purpose, [line] inline children on one line,
[text] font, size/line-height, ink top and bottom, lines, contrast.

findings_only keeps just the flagged lines and the path down to them. colors adds the rendered color
of everything that paints one, as hex, blended over what is behind it, which is a better answer than
guessing at a screenshot. element takes a CSS selector and prints only what matches it, with the
path down to each one, and the whole page is still measured. widths and schemes measure the page at
several viewports or in both color schemes and say which findings only show up in some of them,
which is the responsive bug and the dark mode nobody checked.

Every finding was measured off the rendered page, so it is true. Whether it matters is yours to
judge. Call layout_legend once for the full syntax.`;

// Read from package.json. A second copy here would drift from the published one.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Loaded once by the client rather than with every tool listing. It carries the standing habit,
// which is the part an agent needs before it has decided to call anything.
const instructions = `layout-lens measures a rendered page in a real browser. Run inspect_layout
after every CSS change, before deciding a fix worked, and before taking a screenshot, since reading
the file cannot tell you what the browser drew. Its syntax is dense: call layout_legend once per
session and keep it, it never changes.

A report is one viewport in one color scheme, and it says nothing about the others. The same page is
laid out differently at 390 and at 1280, and painted with other colors in dark. Let your edit pick:
pass widths when you touched anything that reflows, schemes when you touched a color, both when you
touched both. Either tool takes them, and one run is only ever proof about that one window.

To check what color something came out as, ask inspect_layout with colors true rather than looking at
a screenshot. It gives you the hex the browser painted, translucency and everything under it already
blended in, which reading pixels off a picture cannot do. Take the screenshot after that, when the
question is how the page looks rather than what a color is.

What it reports was measured off the rendered page, so treat a finding as true and decide whether it
matters, rather than waving it away as a false positive. Once you have decided a finding is the
design, say so once and then stop mentioning it. It will be in every run of that page for as long as
the design stands, and repeating "this one is fine" on every reply is noise. Report what changed and
what you are acting on, not the list you already dismissed.`;

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
      colors: z
        .boolean()
        .default(false)
        .describe(
          'Write the rendered color of what each element paints, as hex, blended over what is behind it. Use this instead of a screenshot to check what color something ended up as.',
        ),
      element: z.string().optional().describe('A CSS selector. Given, only the elements matching it are printed, with the path down to each one. The whole page is still measured.'),
      children: z.boolean().default(true).describe('With element, print what is inside the matched elements too.'),
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
  async ({ target, width, height, widths, scheme, schemes, scroll, shadow, findings_only, colors, element, children, timeout }) => {
    const text = await inspectPage({
      target,
      width,
      height,
      widths,
      scheme,
      schemes,
      scroll,
      shadow,
      findingsOnly: findings_only,
      colors,
      selector: element,
      withChildren: children,
      timeout,
    });
    return { content: [{ type: 'text', text }] };
  },
);

const screenshotDescription = `Take a png of the same page inspect_layout measures, loaded the same way.

element captures only that box, which is small enough to read. Without it you get the whole page,
often tall and hard to see anything in.

A picture shows what is drawn, not by how much. inspect_layout has the numbers, read them first.

widths and schemes take one shot per viewport and per color scheme, so you get dark next to light,
or 390 next to 1280, and can compare them yourself. They size the browser window, not the png, which
is as tall as the page turns out to be.

Each image comes with a line: its pixel size, the viewport and scheme it was taken at, and with
element where it sits on the page.`;

server.registerTool(
  'screenshot_layout',
  {
    description: screenshotDescription,
    inputSchema: {
      target: z.string().describe('A url, or a path to a local html file.'),
      width: z.number().int().min(1).max(10000).default(1280).describe('Viewport width in px.'),
      height: z.number().int().min(1).max(10000).default(720).describe('Viewport height in px.'),
      widths: z
        .array(z.union([z.number(), z.string()]))
        .max(10)
        .optional()
        .describe(
          'One shot per viewport, as [390, 820, 1280] or ["390x844", "1280x720"]. A width on its own gets 844 at 390, 1180 at 820, 720 at 1280, and the height option anywhere else. Width is ignored when this is given.',
        ),
      scheme: z.enum(['light', 'dark']).default('light').describe('The color scheme the page is rendered in.'),
      schemes: z
        .array(z.enum(['light', 'dark']))
        .optional()
        .describe('One shot per color scheme, as ["light", "dark"]. Scheme is ignored when this is given.'),
      scroll: z.union([z.number(), z.literal('bottom')]).default(0).describe('How far down the page is scrolled before the shot, in px, or "bottom".'),
      timeout: z.number().int().min(1000).max(120000).default(30000).describe('How long to wait for the page to load, in ms. The network then gets a quarter of it to go quiet.'),
      element: z.string().optional().describe('A CSS selector. Given, only the box of the first element matching it is captured. Left out, the whole page is.'),
    },
  },
  async ({ target, width, height, widths, scheme, schemes, scroll, timeout, element }) => {
    try {
      const shots = await screenshotPage({ target, width, height, widths, scheme, schemes, scroll, timeout, element });
      const content = shots.flatMap((shot) => {
        const size = getPngSize(shot.png);
        const rect = shot.rect;
        const at = `at viewport ${shot.viewport.width}x${shot.viewport.height}, ${shot.scheme}`;
        const place = rect ? `, ${element} at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)} on the page` : '';
        return [
          { type: 'image' as const, data: shot.png.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: `screenshot ${size.width}x${size.height} ${at}${place}` },
        ];
      });
      return { content };
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

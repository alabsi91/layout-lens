import { chromium } from 'playwright';
import type { Page } from 'playwright';

import type { ColorScheme, Viewport } from './inspectPage.ts';
import { loadPage, loadFailurePrefix, parseViewports } from './inspectPage.ts';
import { getTargetUrl } from './targetUrl.ts';

export type ScreenshotPageOptions = {
  /** A url, or a path to a local file. */
  target: string;
  /** Viewport width in px. Default 1280. */
  width?: number;
  /** Viewport height in px. Default 720. */
  height?: number;
  /**
   * Take a shot at each of these viewports, as `[390, 820, 1280]` or `["390x844", "1280x720"]`. A
   * width on its own gets 844 at 390, 1180 at 820, 720 at 1280, and `height` anywhere else. When
   * set, `width` is ignored.
   */
  widths?: (number | string)[];
  /** The color scheme the page is rendered in. Default 'light'. */
  scheme?: ColorScheme;
  /** Take a shot in each of these color schemes. When set, `scheme` is ignored. */
  schemes?: ColorScheme[];
  /** How far down to scroll the page before the shot. Default 0. */
  scroll?: number | 'bottom';
  /** How long to wait for the page to load, in ms. Default 30000. */
  timeout?: number;
  /** A CSS selector. When set, the shot covers only the box of the first element that matches. */
  element?: string;
  /** Capture the whole page instead of the viewport. Default true, ignored with `element`. */
  fullPage?: boolean;
};

/** The box an element takes on the page, in css px. */
export type ElementRect = { x: number; y: number; width: number; height: number };

export type ScreenshotResult = {
  /** The PNG bytes. */
  png: Buffer;
  /** Where the element sits on the page. Null unless `element` was given. */
  rect: ElementRect | null;
  /** The viewport the page was rendered at. */
  viewport: Viewport;
  /** The color scheme the page was rendered in. */
  scheme: ColorScheme;
};

function scrollWindow(target: number | 'bottom'): void {
  window.scrollTo(0, target === 'bottom' ? document.documentElement.scrollHeight : target);
}

function finishAnimations(): void {
  for (const animation of document.getAnimations()) {
    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
}

/** Reads the width and height of a PNG out of its header. */
export function getPngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

type CapturedShot = { png: Buffer; rect: ElementRect | null };

async function captureShot(page: Page, target: string, element: string | undefined, fullPage: boolean): Promise<CapturedShot> {
  if (!element) {
    const png = await page.screenshot({ fullPage });
    return { png, rect: null };
  }

  const locator = page.locator(element).first();
  const found = await locator.count();
  if (found === 0) throw new Error(`no element matches ${element} on ${target}`);

  const rect = await locator.boundingBox();
  if (!rect) throw new Error(`${element} on ${target} has no box, nothing of it is drawn`);

  const png = await locator.screenshot();
  return { png, rect };
}

/**
 * Opens the page in headless Chromium the same way `inspectPage` does, and takes a PNG of it. One
 * shot per viewport and color scheme asked for, in that order.
 * Throws when the page fails to load, and when `element` matches nothing or is not drawn.
 */
export async function screenshotPage(options: ScreenshotPageOptions): Promise<ScreenshotResult[]> {
  const { target, width = 1280, height = 720, widths, scheme = 'light', schemes, scroll = 0, timeout = 30000, element, fullPage = true } = options;
  const url = getTargetUrl(target);
  const viewports = widths && widths.length > 0 ? parseViewports(widths, height) : [{ width, height }];
  const schemesToShoot = schemes && schemes.length > 0 ? schemes : [scheme];

  const browser = await chromium.launch();
  try {
    const shots: ScreenshotResult[] = [];

    // The color scheme is fixed when the page is created. Each scheme gets a page of its own.
    for (const shotScheme of schemesToShoot) {
      const page = await browser.newPage({ viewport: viewports[0]!, colorScheme: shotScheme });

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);

        const { failure } = await loadPage(page, url, timeout);
        if (failure) throw new Error(`${loadFailurePrefix}load ${target}: ${failure}`);

        await page.evaluate(scrollWindow, scroll);
        await page.evaluate(finishAnimations);
        await page.evaluate(() => document.fonts.ready);

        const shot = await captureShot(page, target, element, fullPage);
        shots.push({ ...shot, viewport, scheme: shotScheme });
      }

      await page.close();
    }

    return shots;
  } finally {
    await browser.close();
  }
}

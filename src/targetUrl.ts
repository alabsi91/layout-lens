import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Turns a target into a url. A url comes back unchanged. A filesystem path becomes a `file://` url.
 * A `?query` or a `#fragment` after a path stays as written. Only the path itself gets encoded.
 */
export function getTargetUrl(target: string): string {
  if (/^[a-z]+:/i.test(target)) {
    return target;
  }

  const suffixStart = target.search(/[?#]/);
  if (suffixStart === -1) {
    return pathToFileURL(resolve(target)).href;
  }

  const path = target.slice(0, suffixStart);
  const suffix = target.slice(suffixStart);

  return pathToFileURL(resolve(path)).href + suffix;
}

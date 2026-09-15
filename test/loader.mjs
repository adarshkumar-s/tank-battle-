// ESM loader hook: the client imports shared code with browser-absolute paths
// ("/shared/..."), which Node must map back into the repository.

import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/')) {
    return next(new URL('.' + specifier, ROOT).href, context);
  }
  return next(specifier, context);
}

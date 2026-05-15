import type { LedProcessOptions } from './types';

/** Escape user/base64 payload for single-quoted injectJavaScript string. */
export function escapeForSingleQuotedJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildProcessImageInjection(
  base64: string,
  mime: string,
  gridWidth: number,
  gridHeight: number,
  options: LedProcessOptions
): string {
  const b64 = escapeForSingleQuotedJs(base64);
  const m = escapeForSingleQuotedJs(mime);
  const optsJson = escapeForSingleQuotedJs(JSON.stringify(options));
  return `processImage('${b64}', '${m}', ${gridWidth}, ${gridHeight}, '${optsJson}'); true;`;
}

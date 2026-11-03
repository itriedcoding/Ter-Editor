/** Convert an absolute filesystem path to a file:// URI, portable across platforms. */
export function fileUri(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/');
  const encoded = normalized
    .split('/')
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`;
}

/** Convert a file:// URI back to an absolute filesystem path. */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) throw new Error(`Unsupported URI scheme: ${uri}`);
  const url = new URL(uri);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  if (/^[A-Za-z]:/.test(pathname)) return pathname.replace(/\//g, '\\');
  return pathname;
}

export function isFileUri(value: string): boolean {
  return value.startsWith('file:');
}

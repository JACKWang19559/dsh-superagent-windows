/** Browser-safe key normalization: Windows drive/UNC paths ignore case and slash style; POSIX paths retain case. */
export function normalizeWorkspacePath(path: string): string {
  const slashes = path.replace(/\\/g, '/')
  const windows = /^[a-z]:/i.test(slashes) || slashes.startsWith('//') || path.includes('\\')
  const prefix = slashes.startsWith('//') ? '//' : ''
  let normalized = prefix + slashes.slice(prefix.length).replace(/\/+/g, '/')
  normalized = normalized.replace(/\/+$/, '') || '/'
  if (/^[a-z]:\/+$/i.test(slashes)) normalized += '/'
  return windows ? normalized.toLowerCase() : normalized
}

/** Pure shared parsing for repository names and GitHub branch links; never probes the network. */
export interface RepositoryTarget { repository: string; branch: string | null }

/** Git branch restrictions plus a bounded length; branch names retain case and may contain slashes. */
export function isValidBranch(value: string): boolean {
  return !!value && value.length <= 1024 && value !== '@' && !value.startsWith('-')
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'))
}
const repositoryName = (parts: string[]) => parts.length === 2
  && parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')

/** Accept owner/repo, /owner/repo, a GitHub repository URL, or a URL whose entire /tree/ suffix is a branch. */
export function parseRepositoryInput(input: string): RepositoryTarget | null {
  const value = input.trim()
  if (!value || value.length > 2048) return null
  const link = /^https:\/\/github\.com\/([^?#]+)$/i.exec(value)
  if (!link) {
    const parts = value.replace(/^\/(?!\/)/, '').split('/')
    return repositoryName(parts) ? { repository: parts.join('/'), branch: null } : null
  }
  let parts: string[]
  try { parts = link[1]!.replace(/\/$/, '').split('/').map(part => decodeURIComponent(part)) }
  catch { return null }
  if (!repositoryName(parts.slice(0, 2))) return null
  const repository = parts.slice(0, 2).join('/').replace(/\.git$/, '')
  if (!repositoryName(repository.split('/'))) return null
  if (parts.length === 2) return { repository, branch: null }
  if (parts[2] !== 'tree') return null
  const branch = parts.slice(3).join('/')
  return isValidBranch(branch) ? { repository, branch } : null
}

/** A round-trippable input, including the selected branch when there is one. */
export function repositoryInput(target: RepositoryTarget): string {
  return target.branch ? `https://github.com/${target.repository}/tree/${target.branch.split('/').map(encodeURIComponent).join('/')}` : target.repository
}

/** Repository names ignore case; Git branch names do not. */
export function sameRepositoryTarget(left: RepositoryTarget, right: RepositoryTarget): boolean {
  return left.repository.toLowerCase() === right.repository.toLowerCase() && left.branch === right.branch
}

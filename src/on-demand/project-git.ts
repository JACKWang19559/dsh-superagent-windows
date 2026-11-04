/** Bounded, cached local Git identity; commands never fetch, invoke gh, or write repository state. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION } from '../infra/environment.ts'
import { isValidBranch, parseRepositoryInput } from './repository.ts'
import type { ProjectReason } from './project-types.ts'

export interface ProjectGitIdentity {
  repository: string | null
  branch: string | null
  defaultBranch: string | null
  reason: ProjectReason
  error: string | null
}
const empty = (reason: ProjectReason, error: string | null = null): ProjectGitIdentity => ({ repository: null, branch: null, defaultBranch: null, reason, error })

/** Discard URL credentials before parsing the two GitHub path components. Raw URLs never leave this module. */
export function githubRemote(value: string): string | null {
  let path: string
  const scp = /^git@github\.com:([^\s?#]+)$/i.exec(value)
  if (scp) path = '/' + scp[1]
  else {
    try {
      const url = new URL(value)
      if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null
      if (url.protocol === 'https:' && !url.port) path = url.pathname
      else if (url.protocol === 'ssh:' && url.username === 'git' && (!url.port || url.port === '22')) path = url.pathname
      else return null
    } catch { return null }
  }
  if (!/^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/?$/.test(path)) return null
  try { return parseRepositoryInput(`https://github.com${path}`)?.repository ?? null } catch { return null }
}

/** Enforces cancellation even if a provider takes longer to settle its own promise. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}

interface Probe { controller: AbortController; readers: number; settled: boolean; result: Promise<ProjectGitIdentity> }
/** Shares one probe per canonical workspace path and cancels a probe when its last reader leaves. */
export class ProjectGit {
  private readonly lifetime = new AbortController()
  private readonly cache = new Map<string, { until: number; value: ProjectGitIdentity }>()
  private readonly probes = new Map<string, Probe>()
  private readonly children = new Set<Promise<unknown>>()
  constructor(private readonly subprocess: Context['subprocess'], private readonly ttl = 5000) {}

  async read(path: string, signal: AbortSignal): Promise<ProjectGitIdentity> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    const cached = this.cache.get(key)
    if (cached && cached.until > Date.now()) return { ...cached.value }
    let probe = this.probes.get(key)
    if (!probe) {
      if (this.probes.size >= 16) return empty('git-unavailable', 'Too many local Git queries; retry shortly.')
      const controller = new AbortController()
      const combined = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(6000)])
      probe = { controller, readers: 0, settled: false, result: Promise.resolve(empty(null)) }
      const current = probe
      current.result = this.inspect(path, combined).then(value => {
        combined.throwIfAborted()
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(key, { until: Date.now() + this.ttl, value })
        return value
      }).finally(() => { current.settled = true; if (this.probes.get(key) === current) this.probes.delete(key) })
      this.probes.set(key, current)
    }
    probe.readers++
    try { return { ...await abortable(probe.result, signal) } }
    finally {
      if (--probe.readers === 0 && !probe.settled) {
        probe.controller.abort()
        if (this.probes.get(key) === probe) this.probes.delete(key)
      }
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(); this.cache.clear()
    await Promise.allSettled([...this.probes.values()].map(probe => probe.result))
    await Promise.allSettled([...this.children])
  }

  private async inspect(cwd: string, signal: AbortSignal): Promise<ProjectGitIdentity> {
    try {
      const executable = await abortable(this.subprocess.resolveExecutable('git', undefined, signal), signal)
      const env: Record<string, string | undefined> = {
        ...Object.fromEntries(GIT_LOCATION.map(key => [key, undefined])),
        GIT_CONFIG: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: undefined,
      }
      const run = async (...args: string[]): Promise<{ code: number | null; text: string }> => {
        signal.throwIfAborted()
        if (this.children.size >= 32) throw new Error('Git query capacity reached')
        const handle = this.subprocess.spawn({ argv: [executable, '--no-optional-locks', ...args], cwd, env, signal, graceMs: 500,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } } })
        const done = handle.done
        this.children.add(done)
        void done.then(() => this.children.delete(done), () => this.children.delete(done))
        const outcome = await abortable(done, signal)
        const output = handle.collected.stdout?.readFrom(0)
        if (output?.lossy) throw new Error('Git output exceeded its limit')
        return { code: outcome.exitCode, text: output?.text ?? '' }
      }
      const inside = await run('rev-parse', '--is-inside-work-tree')
      if (inside.code !== 0 || inside.text.trim() !== 'true') return empty('not-git')
      const head = await run('symbolic-ref', '--quiet', 'HEAD')
      if (head.code === 1) return empty('detached-head')
      if (head.code !== 0 || !head.text.trim().startsWith('refs/heads/')) throw new Error('Unreadable branch')
      const branch = head.text.trim().slice('refs/heads/'.length)
      if (!isValidBranch(branch)) return empty('detached-head')
      const configured = await run('config', '--null', '--get-regexp', String.raw`^(remote\..*\.url|branch\..*\.(remote|merge))$`)
      if (configured.code !== 0 && configured.code !== 1) throw new Error('Unreadable local configuration')
      const remotes = new Map<string, string[]>()
      let upstream: string | null = null, merge: string | null = null
      for (const entry of configured.text.split('\0').filter(Boolean)) {
        const split = entry.indexOf('\n')
        if (split < 0) throw new Error('Invalid local configuration')
        const key = entry.slice(0, split), value = entry.slice(split + 1)
        if (key === `branch.${branch}.remote`) upstream = value
        if (key === `branch.${branch}.merge`) merge = value
        const remote = /^remote\.(.+)\.url$/.exec(key)?.[1]
        if (remote) remotes.set(remote, [...remotes.get(remote) ?? [], value])
      }
      const preferred = upstream && upstream !== '.' && merge?.startsWith('refs/heads/') ? upstream : null
      const candidates = preferred ? [[preferred, remotes.get(preferred) ?? []] as const] : [...remotes]
      const repositories = new Map<string, { repository: string; remotes: string[] }>()
      for (const [remote, urls] of candidates) {
        for (const url of urls) {
          const repository = githubRemote(url)
          if (!repository) continue
          const key = repository.toLowerCase(), match = repositories.get(key) ?? { repository, remotes: [] }
          if (!match.remotes.includes(remote)) match.remotes.push(remote)
          repositories.set(key, match)
        }
      }
      if (repositories.size === 0) return { ...empty('no-github-remote'), branch }
      if (repositories.size > 1) return { ...empty('ambiguous-remotes'), branch }
      const selected = [...repositories.values()][0]!
      if (selected.remotes.length > 32) return { ...empty('ambiguous-remotes'), branch }
      const heads = await run('for-each-ref', '--format=%(refname)%00%(symref)', ...selected.remotes.map(remote => `refs/remotes/${remote}/HEAD`))
      if (heads.code !== 0) throw new Error('Unreadable remote HEAD')
      const defaults = new Set<string>()
      for (const line of heads.text.trim().split('\n')) {
        const [ref, target] = line.split('\0')
        for (const remote of selected.remotes) {
          const prefix = `refs/remotes/${remote}/`
          if (ref === `${prefix}HEAD` && target?.startsWith(prefix) && isValidBranch(target.slice(prefix.length))) defaults.add(target.slice(prefix.length))
        }
      }
      return { repository: selected.repository, branch, defaultBranch: defaults.size === 1 ? [...defaults][0]! : null, reason: null, error: null }
    } catch {
      signal.throwIfAborted()
      return empty('git-unavailable', 'Local Git project information could not be read.')
    }
  }
}

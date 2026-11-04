/** Host supervisor. Only an explicit start constructs the repository Runtime and exposes its SourceHost. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import type { Machine } from '../deployment.ts'
import { Runtime } from '../app/runtime.ts'
import { Store } from '../app/store.ts'
import { Launcher, LaunchFailure, RepositorySchema, type ActiveRun } from './controller.ts'
import { LaunchHistoryStore } from './history.ts'
import { readProjectSnapshot, type ProjectSnapshot } from './project-db.ts'
import { isValidBranch, parseRepositoryInput, repositoryInput, type RepositoryTarget } from './repository.ts'
import type { LaunchControl, LaunchHistory, LaunchStatus } from './types.ts'

/** Default-branch repositories keep their old directory; explicit branches have separate, case-sensitive state. */
export const repositoryDirectory = (stateDir: string, repository: string, branch: string | null = null): string =>
  join(stateDir, 'repositories', createHash('sha256').update(repository.toLowerCase() + (branch ? `\0${branch}` : '')).digest('hex').slice(0, 32))

/** This fixed prepare command runs only for a newly admitted ticket; user data stays in environment arguments. */
export const defaultPrepare = (platform = process.platform): string => platform === 'win32'
  ? '$superagentCloneArgs = @(\'repo\', \'clone\', $env:DSH_SUPERAGENT_GITHUB_REPOSITORY, $env:DSH_SUPERAGENT_DIR); if ($env:DSH_SUPERAGENT_GITHUB_BASE_BRANCH) { $superagentCloneArgs += @(\'--\', \'--branch\', $env:DSH_SUPERAGENT_GITHUB_BASE_BRANCH) }; & gh @superagentCloneArgs; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & git -C $env:DSH_SUPERAGENT_DIR checkout -b ("agent/" + $env:DSH_SUPERAGENT_NAME); exit $LASTEXITCODE'
  : 'if [ -n "$DSH_SUPERAGENT_GITHUB_BASE_BRANCH" ]; then gh repo clone "$DSH_SUPERAGENT_GITHUB_REPOSITORY" "$DSH_SUPERAGENT_DIR" -- --branch "$DSH_SUPERAGENT_GITHUB_BASE_BRANCH"; else gh repo clone "$DSH_SUPERAGENT_GITHUB_REPOSITORY" "$DSH_SUPERAGENT_DIR"; fi && git -C "$DSH_SUPERAGENT_DIR" checkout -b "agent/$DSH_SUPERAGENT_NAME"'

/** Seed a new repository/branch only. Existing account/executor settings retain their panel-only write path. */
export function initializeRepository(stateDir: string, repository: string, branch: string | null = null): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const release = lockSync(stateDir, { stale: 30_000 })
  let store: Store | undefined
  try {
    store = new Store(join(stateDir, 'orchestrator.sqlite'))
    const settings = store.settings()
    const existing = settings.sources.github?.config.repository
    if (existing) {
      if (String(existing).toLowerCase() !== repository.toLowerCase()) throw new Error(`Saved repository ${String(existing)} does not match ${repository}; restore its repository setting before starting.`)
      if (String(settings.sources.github?.config.branch ?? '') !== (branch ?? '')) throw new Error('Saved branch does not match the selected branch; restore its branch setting before starting.')
      return
    }
    store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: defaultPrepare() },
      sources: { ...settings.sources, github: { enabled: true, config: { repository, branch: branch ?? '', cli: 'gh' } } } })
  } finally { store?.close(); release() }
}

/** Read the last target without starting it; legacy repository-only launcher files remain valid. */
export function rememberedRepository(stateDir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, 'launcher.json'), 'utf8')) as { repository?: unknown; branch?: unknown }
    const parsed = RepositorySchema.safeParse(value.repository)
    if (!parsed.success) return null
    const target = parseRepositoryInput(parsed.data)!
    if (value.branch !== undefined && value.branch !== null && value.branch !== '') {
      if (typeof value.branch !== 'string' || !isValidBranch(value.branch)) return null
      target.branch = value.branch
    }
    return repositoryInput(target)
  } catch { return null }
}

declare module '@deepseek-ai/cordis' { interface Context { superagentControl: LaunchControl } }

/** Host-owned launcher that creates and disposes one isolated repository Runtime on explicit user requests. */
export class SuperagentControl extends Service implements LaunchControl {
  private readonly launcher: Launcher
  constructor(ctx: Context, private readonly machine: Machine) {
    super(ctx, 'superagentControl')
    this.launcher = new Launcher((target, signal) => this.activate(ctx, target, signal), rememberedRepository(machine.stateDir),
      new LaunchHistoryStore(join(machine.stateDir, 'history.json')))
    ctx.effect(() => () => this.launcher.dispose())
  }
  status(): LaunchStatus { return this.launcher.status() }
  history(): LaunchHistory { return this.launcher.history() }
  summary(target: RepositoryTarget): ProjectSnapshot | undefined { return this.launcher.summary(target) }
  start(repository: string, consoleId?: string): Promise<LaunchStatus> { return this.launcher.start(repository, consoleId) }
  stop(): Promise<LaunchStatus> { return this.launcher.stop() }
  private async activate(ctx: Context, { repository, branch }: RepositoryTarget, signal: AbortSignal): Promise<ActiveRun> {
    signal.throwIfAborted()
    const machine = { ...this.machine, repositoryLock: repository, branchLock: branch ?? '',
      stateDir: repositoryDirectory(this.machine.stateDir, repository, branch) }
    initializeRepository(machine.stateDir, repository, branch)
    signal.throwIfAborted()
    let runtime: Runtime | undefined
    let ready = false
    let disposed = false
    let stopped = false
    let restartError: string | null = null
    // Each activation gets a new plugin identity; disposing it removes its service, which also stops dependent Source plugins.
    const fork = ctx.plugin({ name: 'dsh-superagent-active', apply: (child: Context) => {
      ready = false
      const instance = runtime = new Runtime(child, machine, () => {
        if (disposed || signal.aborted) return
        void child.fiber.restart().catch(error => {
          restartError = error instanceof Error ? error.message : String(error)
          child.logger.error('Superagent restart failed: %s', String(error))
        })
      })
      child.effect(() => () => instance.stop())
      const cancel = () => { void instance.stop().catch(error => child.logger.warn('Superagent shutdown failed: %s', String(error))) }
      signal.addEventListener('abort', cancel, { once: true })
      child.effect(() => () => signal.removeEventListener('abort', cancel))
      if (signal.aborted) cancel()
      void instance.ready.then(() => { if (runtime === instance) ready = true }, error => {
        restartError = error instanceof Error ? error.message : String(error)
      })
    } })
    const stop = async () => {
      if (stopped) return
      disposed = true
      try { await runtime?.stop() } finally { await fork.dispose(); stopped = true }
    }
    try {
      await fork.await()
      signal.throwIfAborted()
      if (!runtime) throw new Error('Superagent could not create its repository runtime.')
      await runtime.ready
      signal.throwIfAborted()
      mkdirSync(this.machine.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(this.machine.stateDir, 'launcher.json'), JSON.stringify({ repository, branch }) + '\n', { mode: 0o600 })
      return { stop, summary: () => ready && !disposed && !stopped && runtime
        ? readProjectSnapshot(runtime.store.db, { repository, branch }) : undefined,
        view: () => ({ phase: restartError ? 'error' : !ready ? 'starting' : runtime!.configured() ? 'running' : 'needs-setup',
        masterId: ready && runtime!.configured() ? runtime!.masterId : null, panelAvailable: ready && !restartError && !stopped,
        error: restartError ?? runtime!.setupProblem?.detail ?? null }) }
    } catch (error) {
      const masterId = ready && runtime?.configured() ? runtime.masterId : null
      try { await stop() } catch (cleanupError) { throw new LaunchFailure(cleanupError, masterId, true) }
      throw new LaunchFailure(error, masterId)
    }
  }
}

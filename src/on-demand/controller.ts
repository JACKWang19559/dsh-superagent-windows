/** Explicit, single-flight lifetime for the repository orchestrator, with bounded local launch history. */
import { z } from 'zod'
import type { LaunchControl, LaunchHistory, LaunchHistoryPhase, LaunchPhase, LaunchStatus } from './types.ts'
import { HistorySessionId, LaunchHistoryStore } from './history.ts'
import { parseRepositoryInput, repositoryInput, sameRepositoryTarget, type RepositoryTarget } from './repository.ts'
import type { ProjectSnapshot } from './project-db.ts'

export const RepositorySchema = z.string().trim().max(2048).refine(value => !!parseRepositoryInput(value),
  'Use owner/repo, a GitHub repository URL, or https://github.com/owner/repo/tree/branch (the whole suffix is the branch)')
export const LaunchRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('history') }).strict(),
  z.object({ action: z.literal('start'), repository: RepositorySchema }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
])
export interface ActiveRun {
  view(): Pick<LaunchStatus, 'phase' | 'masterId' | 'panelAvailable' | 'error'>
  stop(): Promise<void>
  /** Optional read-only snapshot of this captured run's existing database connection. */
  summary?(): ProjectSnapshot | undefined
}
export type LaunchFactory = (target: RepositoryTarget, signal: AbortSignal) => Promise<ActiveRun>
/** A launch request conflicts with the active repository or a lifecycle transition. */
export class LaunchConflict extends Error {}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const historyPhase = (phase: LaunchPhase): LaunchHistoryPhase => phase === 'idle' ? 'stopped' : phase
/** Preserve a known orchestrator link even when activation must dispose its Runtime before returning. */
export class LaunchFailure extends Error {
  constructor(error: unknown, readonly masterId: string | null, readonly cleanupFailed = false) { super(reason(error), { cause: error }) }
}

/** Serializes explicit activation and disposal. Status/history are side-effect-free snapshots. */
export class Launcher implements LaunchControl {
  private phase: LaunchPhase = 'idle'
  private target: RepositoryTarget | null = null
  private lastTarget: RepositoryTarget | null
  private error: string | null = null
  private active?: ActiveRun
  private starting?: Promise<LaunchStatus>
  private stopping?: Promise<LaunchStatus>
  private cancellation?: AbortController
  private consoleId: string | null = null
  private masterId: string | null = null
  private entryId?: string
  private closed = false
  constructor(private readonly create: LaunchFactory, lastRepository: string | null = null,
    private readonly journal = new LaunchHistoryStore()) {
    this.lastTarget = lastRepository ? parseRepositoryInput(lastRepository) : null
  }
  private view(): ReturnType<ActiveRun['view']> | undefined {
    try { return this.active?.view() }
    catch (error) { return { phase: 'error', masterId: this.masterId, panelAvailable: false, error: reason(error) } }
  }
  status(): LaunchStatus {
    const view = this.view()
    return { executor: 'harness', repository: this.target?.repository ?? null, branch: this.target?.branch ?? null,
      lastRepository: this.lastTarget?.repository ?? null, lastBranch: this.lastTarget?.branch ?? null,
      masterId: view?.masterId ?? null, consoleId: this.consoleId, panelAvailable: view?.panelAvailable ?? false,
      phase: this.phase === 'stopping' || this.phase === 'error' ? this.phase : view?.phase ?? this.phase,
      error: this.error ?? view?.error ?? null }
  }
  history(): LaunchHistory {
    const result = this.journal.snapshot()
    if (!this.entryId) return result
    const status = this.status()
    result.entries = result.entries.map(entry => entry.id === this.entryId ? { ...entry,
      phase: historyPhase(status.phase), masterId: status.masterId ?? entry.masterId,
      error: status.error?.slice(0, 4000) ?? null } : entry)
    return result
  }
  /** Only the exact active namespace can expose its captured connection; reads never activate a run. */
  summary(target: RepositoryTarget): ProjectSnapshot | undefined {
    if (this.closed || this.stopping || !this.target || !sameRepositoryTarget(this.target, target)) return undefined
    try { return this.active?.summary?.() }
    catch { return { summary: null, error: 'Saved project data could not be read from the active run.' } }
  }
  async start(input: string, consoleId?: string): Promise<LaunchStatus> {
    const target = parseRepositoryInput(RepositorySchema.parse(input))!
    const console = consoleId === undefined ? null : HistorySessionId.parse(consoleId)
    if (this.closed) throw new LaunchConflict('Superagent is unloading; start it again after the plugin is available.')
    if (this.stopping) throw new LaunchConflict('Superagent is stopping. Wait for idle before starting a repository.')
    if (this.target && !sameRepositoryTarget(this.target, target)) {
      throw new LaunchConflict(`Superagent is already using ${repositoryInput(this.target)}. Stop it before selecting another repository or branch.`)
    }
    if (this.starting) return this.starting
    if (this.active) return this.status()
    this.target = target
    this.lastTarget = target
    this.phase = 'starting'; this.error = null; this.masterId = null; this.consoleId = console
    this.entryId = this.journal.begin(target, console)
    const cancellation = this.cancellation = new AbortController()
    this.starting = this.begin(target, cancellation.signal).finally(() => { this.starting = undefined })
    return this.starting
  }
  /** Capture the last known master before a cancellation/disposal can clear Runtime state. */
  private capture(phase?: LaunchHistoryPhase): ReturnType<ActiveRun['view']> | undefined {
    const view = this.view()
    if (view?.masterId) this.masterId = view.masterId
    this.journal.update(this.entryId, { masterId: this.masterId,
      ...phase ? { phase } : view ? { phase: historyPhase(view.phase) } : {},
      ...view || this.error !== null ? { error: this.error ?? view?.error ?? null } : {} })
    return view
  }
  private finish(phase: 'stopped' | 'error', error?: string | null): void {
    this.journal.update(this.entryId, { phase, endedAt: new Date().toISOString(), masterId: this.masterId,
      ...error != null ? { error } : {} })
    this.entryId = undefined
  }
  private async begin(target: RepositoryTarget, signal: AbortSignal): Promise<LaunchStatus> {
    try {
      this.active = await this.create(target, signal)
      const view = this.capture(signal.aborted ? 'stopping' : undefined)
      // stop() owns cleanup, including a Runtime whose factory resolved after cancellation.
      if (!signal.aborted) this.phase = view?.phase ?? 'error'
    } catch (error) {
      if (error instanceof LaunchFailure && error.masterId) this.masterId = error.masterId
      this.journal.update(this.entryId, { masterId: this.masterId })
      if (signal.aborted) {
        if (error instanceof LaunchFailure && error.cleanupFailed) throw error
      } else {
        this.phase = 'error'; this.error = reason(error); this.target = null
        this.finish('error', this.error)
      }
    }
    return this.status()
  }
  async stop(): Promise<LaunchStatus> {
    if (this.stopping) return this.stopping
    if (!this.active && !this.starting) {
      if (this.entryId) this.finish(this.phase === 'error' ? 'error' : 'stopped', this.error)
      this.phase = 'idle'; this.target = null; this.error = null; this.consoleId = null; this.cancellation = undefined
      return this.status()
    }
    this.capture('stopping')
    this.phase = 'stopping'
    this.cancellation?.abort()
    this.stopping = (async () => {
      await this.starting
      this.capture('stopping')
      await this.active?.stop()
      this.finish('stopped', this.error)
      this.active = undefined; this.cancellation = undefined; this.masterId = null; this.consoleId = null
      this.phase = 'idle'; this.target = null; this.error = null
      return this.status()
    })().catch(error => {
      this.phase = 'error'; this.error = reason(error)
      this.journal.update(this.entryId, { phase: 'error', error: this.error })
      throw error
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }
  async dispose(): Promise<void> { this.closed = true; await this.stop() }
}

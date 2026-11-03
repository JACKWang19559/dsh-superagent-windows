/** Explicit, single-flight lifetime for the existing repository orchestrator. Construction is inert. */
import { z } from 'zod'
import type { LaunchControl, LaunchPhase, LaunchStatus } from './types.ts'
import { parseRepositoryInput, repositoryInput, sameRepositoryTarget, type RepositoryTarget } from './repository.ts'

export const RepositorySchema = z.string().trim().max(2048).refine(value => !!parseRepositoryInput(value),
  'Use owner/repo, a GitHub repository URL, or https://github.com/owner/repo/tree/branch (the whole suffix is the branch)')
export const LaunchRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('start'), repository: RepositorySchema }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
])
export interface ActiveRun {
  view(): Pick<LaunchStatus, 'phase' | 'masterId' | 'panelAvailable' | 'error'>
  stop(): Promise<void>
}
export type LaunchFactory = (target: RepositoryTarget, signal: AbortSignal) => Promise<ActiveRun>
/** A launch request conflicts with the active repository or a lifecycle transition. */
export class LaunchConflict extends Error {}

/** Serializes explicit activation and disposal while exposing a cold, side-effect-free status snapshot. */
export class Launcher implements LaunchControl {
  private phase: LaunchPhase = 'idle'
  private target: RepositoryTarget | null = null
  private lastTarget: RepositoryTarget | null
  private error: string | null = null
  private active?: ActiveRun
  private starting?: Promise<LaunchStatus>
  private stopping?: Promise<LaunchStatus>
  private cancellation?: AbortController
  private closed = false
  constructor(private readonly create: LaunchFactory, lastRepository: string | null = null) {
    this.lastTarget = lastRepository ? parseRepositoryInput(lastRepository) : null
  }
  status(): LaunchStatus {
    const view = this.active?.view()
    return { executor: 'harness', repository: this.target?.repository ?? null, branch: this.target?.branch ?? null,
      lastRepository: this.lastTarget?.repository ?? null, lastBranch: this.lastTarget?.branch ?? null,
      masterId: view?.masterId ?? null, panelAvailable: view?.panelAvailable ?? false,
      phase: this.phase === 'stopping' || this.phase === 'error' ? this.phase : view?.phase ?? this.phase,
      error: this.error ?? view?.error ?? null }
  }
  async start(input: string): Promise<LaunchStatus> {
    const target = parseRepositoryInput(RepositorySchema.parse(input))!
    if (this.closed) throw new LaunchConflict('Superagent is unloading; start it again after the plugin is available.')
    if (this.stopping) throw new LaunchConflict('Superagent is stopping. Wait for idle before starting a repository.')
    if (this.target && !sameRepositoryTarget(this.target, target)) {
      throw new LaunchConflict(`Superagent is already using ${repositoryInput(this.target)}. Stop it before selecting another repository or branch.`)
    }
    if (this.starting) return this.starting
    if (this.active) return this.status()
    this.target = target
    this.lastTarget = target
    this.phase = 'starting'; this.error = null
    const cancellation = this.cancellation = new AbortController()
    this.starting = this.begin(target, cancellation.signal).finally(() => { this.starting = undefined })
    return this.starting
  }
  private async begin(target: RepositoryTarget, signal: AbortSignal): Promise<LaunchStatus> {
    try {
      const active = await this.create(target, signal)
      if (signal.aborted) { await active.stop(); return this.status() }
      this.active = active
      this.phase = active.view().phase
    } catch (error) {
      if (!signal.aborted) {
        this.phase = 'error'; this.error = error instanceof Error ? error.message : String(error)
        this.target = null
      }
    }
    return this.status()
  }
  async stop(): Promise<LaunchStatus> {
    if (this.stopping) return this.stopping
    if (!this.active && !this.starting) {
      this.phase = 'idle'; this.target = null; this.error = null
      return this.status()
    }
    this.phase = 'stopping'
    this.cancellation?.abort()
    this.stopping = (async () => {
      await this.starting
      await this.active?.stop()
      this.active = undefined; this.cancellation = undefined
      this.phase = 'idle'; this.target = null; this.error = null
      return this.status()
    })().catch(error => {
      this.phase = 'error'; this.error = error instanceof Error ? error.message : String(error)
      throw error
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }
  async dispose(): Promise<void> { this.closed = true; await this.stop() }
}

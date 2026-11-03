/** Shared, credential-free contract for the optional session launcher and its management view. */
export type LaunchPhase = 'idle' | 'starting' | 'running' | 'needs-setup' | 'stopping' | 'error'
export interface LaunchStatus {
  phase: LaunchPhase
  executor: 'harness'
  repository: string | null
  branch: string | null
  lastRepository: string | null
  lastBranch: string | null
  masterId: string | null
  panelAvailable: boolean
  error: string | null
}
export type LaunchRequest = { action: 'status' } | { action: 'start'; repository: string } | { action: 'stop' }
export interface LaunchControl {
  status(): LaunchStatus
  start(repository: string): Promise<LaunchStatus>
  stop(): Promise<LaunchStatus>
}

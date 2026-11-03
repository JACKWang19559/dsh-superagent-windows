/** Shared, credential-free contracts for the session startup console and its history/management view. */
export type LaunchPhase = 'idle' | 'starting' | 'running' | 'needs-setup' | 'stopping' | 'error'
export interface LaunchStatus {
  phase: LaunchPhase
  executor: 'harness'
  repository: string | null
  branch: string | null
  lastRepository: string | null
  lastBranch: string | null
  masterId: string | null
  /** The user console that explicitly started the current run, when known. */
  consoleId?: string | null
  panelAvailable: boolean
  error: string | null
}
export type LaunchHistoryPhase = Exclude<LaunchPhase, 'idle'> | 'stopped' | 'interrupted'
export interface LaunchHistoryEntry {
  id: string
  repository: string
  branch: string | null
  consoleId: string | null
  masterId: string | null
  startedAt: string
  endedAt: string | null
  phase: LaunchHistoryPhase
  error: string | null
}
export interface LaunchHistory {
  /** Most recent first; bounded independently of any repository's ticket database. */
  entries: LaunchHistoryEntry[]
  limit: number
  /** Local history storage problems; these must not prevent stopping workers. */
  error: string | null
}
export type LaunchRequest = { action: 'status' } | { action: 'history' } | { action: 'start'; repository: string } | { action: 'stop' }
export interface LaunchControl {
  status(): LaunchStatus
  history(): LaunchHistory
  start(repository: string, consoleId?: string): Promise<LaunchStatus>
  stop(): Promise<LaunchStatus>
}

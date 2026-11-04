/** Read-only project view for one durable session; no global Runtime data leaks into another workspace. */
import type { TicketStage } from '../core/stage.ts'
import type { LaunchHistory, LaunchStatus } from './types.ts'

export type ProjectReason = 'session-not-found' | 'workspace-missing' | 'git-unavailable' | 'not-git'
  | 'no-github-remote' | 'ambiguous-remotes' | 'detached-head' | 'ambiguous-history' | null
export interface ProjectWorkspace {
  id: string | null
  title: string
  path: string
  source: 'registry' | 'session-header'
}
export interface ProjectTicket {
  id: string
  title: string
  /** Persisted stage, never a claim that a stopped worker is currently running. */
  stage: TicketStage
  updatedAt: string
  workerSessionId: string | null
}
export interface ProjectSummary {
  source: 'saved'
  counts: { total: number; open: number; person: number; working: number; idle: number; ended: number }
  recentTickets: ProjectTicket[]
  maxWorkers: number | null
  paused: boolean | null
  /** Exposed only after sessionPersistence.stat confirms the session exists. */
  masterId: string | null
  updatedAt: string | null
}
export interface ProjectView {
  sessionId: string
  workspace: ProjectWorkspace | null
  repository: string | null
  /** Current local branch, or the exact launch branch for a session identified solely by launch history. */
  branch: string | null
  /** A locally recorded remote HEAD; null means no proof of the default branch. */
  defaultBranch: string | null
  source: 'git' | 'launch-history' | null
  reason: ProjectReason
  /** Present only when the active run's repository AND branch belong to this project. */
  status: LaunchStatus | null
  history: LaunchHistory
  summary: ProjectSummary | null
  /** Saved-data failure is independent of identification and live status. */
  summaryError: string | null
  error: string | null
}

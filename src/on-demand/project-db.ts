/** Schema-11 snapshot reader. It never constructs Store, migrates, checkpoints, or creates a database. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { ticketStage } from '../core/stage.ts'
import type { Ticket } from '../core/model.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { isValidBranch, parseRepositoryInput, sameRepositoryTarget, type RepositoryTarget } from './repository.ts'
import type { ProjectSummary, ProjectTicket } from './project-types.ts'

export interface ProjectSnapshot { summary: ProjectSummary | null; error: string | null }
export const ProjectSessionId = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const timestamp = z.string().max(64).refine(value => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
const shape = z.object({
  id: ProjectSessionId, title: z.string().max(4000), updatedAt: timestamp,
  ended: z.object({ at: timestamp }).passthrough().optional(),
  delivery: z.object({}).passthrough().optional(), attention: z.object({}).passthrough().optional(),
  assignments: z.array(z.object({ state: z.enum(['pending', 'running', 'ended']),
    report: z.object({ state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']), at: timestamp }).optional() })),
  inputs: z.array(z.object({ kind: z.string(), human: z.boolean().optional(), context: z.boolean().optional(), at: timestamp })),
})
const settingsShape = z.object({ savedAt: timestamp, settings: z.object({ paused: z.boolean(),
  executor: z.object({ maxWorkers: z.number().int().min(1).max(10000) }),
  sources: z.object({ github: z.object({ config: z.object({ repository: z.string(), branch: z.string().optional() }) }) }),
}) })
const unreadable = 'Saved project data is unreadable or corrupt.'

/** Reuses an owned connection without changing its flags, closing it, or committing an outer transaction. */
export function readProjectSnapshot(db: DatabaseSync, target: RepositoryTarget): ProjectSnapshot {
  let problem = unreadable, opened = false
  let result: ProjectSnapshot = { summary: null, error: problem }
  try {
    db.exec('SAVEPOINT superagent_project_overview'); opened = true
    // The SAVEPOINT starts a read transaction, or nests safely inside the owner's existing transaction.
    const get = (key: string): unknown => {
      const row = db.prepare('SELECT substr(value,1,262145) AS value FROM kv WHERE key=?').get(key)
      if (!row) return undefined
      const text = String(row.value)
      if (text.length > 262144) throw new Error('Oversized saved record')
      return JSON.parse(text)
    }
    if (get(KV.store.schema) !== 11) {
      problem = 'Saved project data uses an unsupported schema; this view only reads schema 11.'
      throw new Error(problem)
    }
    const revision = get(KV.settings.revision)
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new Error('Missing settings revision')
    const saved = settingsShape.parse(get(KV.settings.version(Number(revision))))
    const config = saved.settings.sources.github.config
    const repository = parseRepositoryInput(config.repository)
    const branch = config.branch || null
    if (!repository || repository.branch !== null || branch !== null && !isValidBranch(branch)
      || !sameRepositoryTarget({ repository: repository.repository, branch }, target)) {
      problem = 'Saved project identity does not match this repository and branch.'
      throw new Error(problem)
    }
    const counts: ProjectSummary['counts'] = { total: 0, open: 0, person: 0, working: 0, idle: 0, ended: 0 }
    const recentTickets: ProjectTicket[] = []
    let updatedAt = saved.savedAt, bytes = 0
    const started = performance.now()
    for (const row of db.prepare('SELECT id, substr(value,1,262145) AS value FROM ticket ORDER BY rowid DESC LIMIT 10001').iterate()) {
      const value = String(row.value)
      bytes += Buffer.byteLength(value)
      if (++counts.total > 10000 || value.length > 262144 || bytes > 8 * 1024 * 1024 || performance.now() - started > 200) {
        problem = 'Saved project data exceeds the bounded overview limit.'
        throw new Error(problem)
      }
      const ticket = shape.parse(JSON.parse(value))
      if (row.id !== ticket.id) throw new Error('Ticket identity mismatch')
      const stage = ticketStage(ticket as Ticket)
      counts[stage.stage]++
      if (stage.stage !== 'ended') counts.open++
      if (Date.parse(ticket.updatedAt) > Date.parse(updatedAt)) updatedAt = ticket.updatedAt
      recentTickets.push({ id: ticket.id, title: ticket.title, stage, updatedAt: ticket.updatedAt,
        workerSessionId: ticket.assignments.length ? workerSessionId(ticket.id) : null })
      recentTickets.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
      if (recentTickets.length > 12) recentTickets.pop()
    }
    const master = ProjectSessionId.safeParse(get(KV.runtime.masterId))
    result = { summary: { source: 'saved', counts, recentTickets, maxWorkers: saved.settings.executor.maxWorkers,
      paused: saved.settings.paused, masterId: master.success ? master.data : null, updatedAt }, error: null }
  } catch { result = { summary: null, error: problem } }
  finally {
    if (opened) try { db.exec('RELEASE superagent_project_overview') } catch { result = { summary: null, error: unreadable } }
  }
  return result
}

/** Immutable reads cannot create or alter WAL/SHM files; active data must use the owner's existing connection. */
export function readProjectDatabase(file: string, target: RepositoryTarget): ProjectSnapshot {
  let signature: string
  const stamp = (): string => {
    const info = statSync(file, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  }
  const sidecars = (): boolean => ['-wal', '-shm', '-journal'].some(suffix => existsSync(file + suffix))
  const inUse = 'Saved project data is changing or is open outside this launcher; its snapshot is unavailable.'
  try {
    if (!statSync(file).isFile()) return { summary: null, error: 'Saved project data is not a regular database file.' }
    if (sidecars()) return { summary: null, error: inUse }
    signature = stamp()
  } catch (error) {
    return { summary: null, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'Saved project data could not be read.' }
  }
  let db: DatabaseSync | undefined
  let result: ProjectSnapshot = { summary: null, error: unreadable }
  try {
    const uri = pathToFileURL(file)
    uri.searchParams.set('mode', 'ro'); uri.searchParams.set('immutable', '1')
    db = new DatabaseSync(uri.href, { readOnly: true, timeout: 100 })
    result = readProjectSnapshot(db, target)
    // Another process may start writing after the first absence check. Never return that uncertain snapshot.
    if (stamp() !== signature || sidecars()) result = { summary: null, error: inUse }
  } catch { result = { summary: null, error: unreadable } }
  finally { try { db?.close() } catch { result = { summary: null, error: unreadable } } }
  return result
}

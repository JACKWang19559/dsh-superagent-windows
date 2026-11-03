/** Bounded local launch metadata. Reading never opens repository databases or activates a Runtime. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { isValidBranch, parseRepositoryInput, type RepositoryTarget } from './repository.ts'
import type { LaunchHistory, LaunchHistoryEntry } from './types.ts'

export const HISTORY_LIMIT = 30
const MAX_BYTES = 1024 * 1024
const MAX_ERROR = 4000
export const HistorySessionId = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value), 'Invalid session id')
const EntrySchema = z.object({
  id: z.uuid(),
  repository: z.string().max(2048).refine(value => {
    const target = parseRepositoryInput(value)
    return target?.repository === value && target.branch === null
  }, 'Invalid repository'),
  branch: z.string().refine(isValidBranch, 'Invalid branch').nullable(),
  consoleId: HistorySessionId.nullable(), masterId: HistorySessionId.nullable(),
  startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }).nullable(),
  phase: z.enum(['starting', 'running', 'needs-setup', 'stopping', 'error', 'stopped', 'interrupted']),
  error: z.string().max(MAX_ERROR).nullable(),
}).strict()
const FileSchema = z.object({ version: z.literal(1), entries: z.array(EntrySchema).max(HISTORY_LIMIT)
  .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate launch ids') }).strict()
type Update = Partial<Pick<LaunchHistoryEntry, 'masterId' | 'phase' | 'error' | 'endedAt'>>
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR)
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'

/** A missing path makes an in-memory journal, useful for isolated controllers and tests. */
export class LaunchHistoryStore {
  private entries: LaunchHistoryEntry[] = []
  private error: string | null = null
  private original: string | null = null
  private preserveFile = false
  private readonly file?: string
  constructor(file?: string) {
    this.file = file === undefined ? undefined : resolve(file)
    if (!this.file) return
    try {
      this.original = this.read()
      if (this.original === null) return
      this.entries = FileSchema.parse(JSON.parse(this.original)).entries.map(entry => entry.endedAt === null
        ? { ...entry, phase: 'interrupted' } : entry)
    } catch (error) {
      this.preserveFile = true
      this.error = `Cannot read launch history; the existing file will be preserved. ${reason(error)}`
    }
  }
  snapshot(): LaunchHistory { return { entries: this.entries.map(entry => ({ ...entry })), limit: HISTORY_LIMIT, error: this.error } }
  begin(target: RepositoryTarget, consoleId: string | null): string {
    const entry: LaunchHistoryEntry = { id: randomUUID(), ...target, consoleId, masterId: null,
      startedAt: new Date().toISOString(), endedAt: null, phase: 'starting', error: null }
    this.publish([entry, ...this.entries].slice(0, HISTORY_LIMIT))
    return entry.id
  }
  update(id: string | undefined, patch: Update): void {
    if (!id) return
    const bounded = patch.error == null ? patch : { ...patch, error: patch.error.slice(0, MAX_ERROR) }
    this.publish(this.entries.map(entry => entry.id === id ? { ...entry, ...bounded } : entry))
  }
  private read(): string | null {
    try {
      const stat = lstatSync(this.file!)
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Expected a regular history file no larger than 1 MiB.')
      return readFileSync(this.file!, 'utf8')
    } catch (error) { if (missing(error)) return null; throw error }
  }
  private publish(entries: LaunchHistoryEntry[]): void {
    const parsed = FileSchema.safeParse({ version: 1, entries })
    if (!parsed.success) { this.error = `Cannot record launch history: ${reason(parsed.error)}`; return }
    this.entries = parsed.data.entries
    if (!this.file || this.preserveFile) return
    let release: (() => void) | undefined
    let temporary: string | undefined
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      release = lockSync(this.file, { realpath: false, stale: 30_000 })
      if (this.read() !== this.original) {
        this.preserveFile = true
        throw new Error('History changed on disk; reload the plugin before saving. The existing file was preserved.')
      }
      const text = JSON.stringify(parsed.data) + '\n'
      temporary = join(dirname(this.file), `.${basename(this.file)}.${randomUUID()}.tmp`)
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
      renameSync(temporary, this.file)
      temporary = undefined
      this.original = text
      this.error = null
    } catch (error) { this.error = `Cannot save launch history: ${reason(error)}` }
    finally {
      // This is only the unique file just created beside history.json, never a caller-provided deletion target.
      if (temporary) { try { unlinkSync(temporary) } catch { /* The original write failure is already reported. */ } }
      try { release?.() } catch (error) { this.error = `Cannot release the launch history lock: ${reason(error)}` }
    }
  }
}

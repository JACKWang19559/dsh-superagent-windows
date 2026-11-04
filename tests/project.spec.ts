import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { scrubbedParentEnv, type SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectGit, githubRemote } from '../src/on-demand/project-git.ts'
import { ProjectReader, registerProjectHttp } from '../src/on-demand/project.ts'
import { ProjectSessionId, readProjectDatabase, readProjectSnapshot } from '../src/on-demand/project-db.ts'
import { Launcher } from '../src/on-demand/controller.ts'
import { repositoryDirectory } from '../src/on-demand/host.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { LaunchHistoryEntry, LaunchStatus } from '../src/on-demand/types.ts'

vi.mock('../src/app/store.ts', async original => {
  const actual = await original<typeof import('../src/app/store.ts')>()
  return { ...actual, Store: vi.fn(() => { throw new Error('Project reads must not construct a migrating Store') }) }
})
const exec = promisify(execFile)
const git = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'git.exe' : 'git')).find(existsSync)!
const children = new Set<ChildProcess>()
const readers: { dispose(): Promise<void> }[] = []
const databases: DatabaseSync[] = []
const now = '2026-11-04T00:00:00.000Z'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'superagent-project-')) })
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.dispose()))
  await Promise.all([...children].map(child => new Promise<void>(done => { child.once('close', () => done()); child.kill() })))
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
  const target = resolve(root)
  expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^superagent-project-/)
  rmSync(target, { recursive: true, force: true })
})
function environment(overlay: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...scrubbedParentEnv(), ...base }
  for (const [name, value] of Object.entries(overlay)) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key]
    if (value !== undefined) env[name] = value
  }
  return env
}
function native(calls: SubprocessSpawnSpec[] = [], ambient: NodeJS.ProcessEnv = {}): SubprocessRuntime {
  return { resolveExecutable: vi.fn(async (command: string) => { expect(command).toBe('git'); return git }),
    spawn(spec: SubprocessSpawnSpec) {
      calls.push(spec)
      expect(resolve(spec.cwd).startsWith(resolve(root))).toBe(true)
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: environment(spec.env, ambient), stdio: ['ignore', 'pipe', 'pipe'] })
      children.add(child)
      const output = { stdout: '', stderr: '' }
      child.stdout!.setEncoding('utf8').on('data', chunk => { output.stdout += String(chunk) })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output.stderr += String(chunk) })
      const stop = () => { child.kill() }
      spec.signal?.addEventListener('abort', stop, { once: true }); if (spec.signal?.aborted) stop()
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, endedBy) => { children.delete(child); spec.signal?.removeEventListener('abort', stop); resolve({ exitCode, signal: endedBy }) })
      })
      const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: Buffer.byteLength(output[name]), lossy: false }) })
      return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  } } as unknown as SubprocessRuntime
}
async function command(cwd: string, ...args: string[]): Promise<string> {
  return (await exec(git, args, { cwd, env: environment({ GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) })).stdout.trim()
}
async function repository(name = 'repo', remote = 'https://github.com/acme/widgets.git'): Promise<string> {
  const directory = join(root, name)
  mkdirSync(directory)
  await command(directory, 'init', '--initial-branch=main')
  await command(directory, '-c', 'user.name=Project Test', '-c', 'user.email=project@example.test', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'seed')
  if (remote) await command(directory, 'remote', 'add', 'origin', remote)
  return directory
}
const idle = (): LaunchStatus => ({ phase: 'idle', executor: 'harness', repository: null, branch: null, lastRepository: null, lastBranch: null, masterId: null, panelAvailable: false, error: null })
function entry(repository = 'acme/widgets', branch: string | null = 'main', extra: Partial<LaunchHistoryEntry> = {}): LaunchHistoryEntry {
  return { id: `history-${repository}-${branch}`, repository, branch, startedAt: now, endedAt: now, phase: 'stopped', masterId: null, consoleId: null, error: null, ...extra }
}
function setup(path: string | null, calls: SubprocessSpawnSpec[] = [], ambient: NodeJS.ProcessEnv = {}) {
  const header = new Map<string, string>(path ? [['session-1', path]] : [])
  const control = { status: vi.fn(idle), history: vi.fn(() => ({ entries: [] as LaunchHistoryEntry[], limit: 30, error: null })),
    start: vi.fn(() => { throw new Error('read must never start') }), stop: vi.fn(() => { throw new Error('read must never stop') }) }
  const ctx = { subprocess: native(calls, ambient),
    workspaceRegistry: { list: vi.fn(() => path ? [{ id: 'workspace-1', title: 'Original project', path, sessionIds: ['session-1'] }] : []), create: vi.fn(() => { throw new Error('read must not create workspace') }) },
    sessionPersistence: { stat: vi.fn(async (id: string) => header.has(id) ? { header: { id, cwd: header.get(id)! } } : undefined),
      open: vi.fn(() => { throw new Error('read must not open session logs') }), create: vi.fn(() => { throw new Error('read must not create session') }) },
    sessionController: { resolveAgent: vi.fn(() => { throw new Error('read must not activate an agent') }) },
  }
  const stateDir = join(root, 'state')
  const reader = new ProjectReader(ctx as unknown as Context, control, stateDir)
  readers.push(reader)
  return { ctx, control, reader, stateDir, header }
}
function database(stateDir: string, repository = 'acme/widgets', branch: string | null = 'main', wal = false) {
  const directory = repositoryDirectory(stateDir, repository, branch)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, 'orchestrator.sqlite'), db = new DatabaseSync(file)
  databases.push(db)
  if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').run(key, JSON.stringify(value))
  put('schema', 11); put('settings-revision', 1)
  put('settings-version:1', { savedAt: now, settings: SettingsSchema.parse({ paused: true, executor: { maxWorkers: 4 }, sources: { github: { config: { repository, branch: branch ?? '' } } } }) })
  return { file, db, put, ticket: (id: string, fields: Record<string, unknown> = {}) => db.prepare('INSERT OR REPLACE INTO ticket VALUES (?, ?)').run(id,
    JSON.stringify({ id, title: `Ticket ${id}`, assignments: [], inputs: [], updatedAt: now, ...fields })) }
}
function bytes(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {}
  const files: Record<string, string> = {}
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, bytes(path))
    else files[path] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return files
}

describe('local Git identity and project isolation', () => {
  it.each(['https://github.com/acme/widgets.git', 'https://user:SECRET@github.com/acme/widgets.git', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git'])('normalizes credential-free identity from %s', url => {
    expect(githubRemote(url)).toBe('acme/widgets')
  })
  it.each(['https://github.com.evil.test/acme/widgets', 'https://gitlab.com/acme/widgets', 'ssh://evil@github.com/acme/widgets', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?token=SECRET'])('rejects a noncanonical remote %s', url => { expect(githubRemote(url)).toBeNull() })
  it('prefers current upstream over origin and never exposes another workspace run or raw credentials', async () => {
    const path = await repository('工作区 quoted', 'https://user:TOP-SECRET@github.com/upstream/widgets.git')
    await command(path, 'remote', 'add', 'windows', 'git@github.com:acme/widgets.git')
    await command(path, 'config', 'branch.main.remote', 'windows'); await command(path, 'config', 'branch.main.merge', 'refs/heads/main')
    const state = setup(path)
    state.control.status.mockReturnValue({ ...idle(), phase: 'running', repository: 'other/project', branch: 'main', consoleId: 'session-1', panelAvailable: true })
    state.control.history.mockReturnValue({ entries: [entry('other/project', 'main', { consoleId: 'session-1' }), entry(), entry('acme/widgets', 'Main'), entry('acme/widgets', null)], limit: 30, error: null })
    const before = bytes(root)
    const view = await state.reader.read('session-1')
    expect(view).toMatchObject({ sessionId: 'session-1', repository: 'acme/widgets', branch: 'main', defaultBranch: null, source: 'git', status: null, summary: null, error: null })
    expect(view.workspace).toMatchObject({ id: 'workspace-1', title: 'Original project', path, source: 'registry' })
    expect(view.history.entries).toEqual([entry()]); expect(JSON.stringify(view)).not.toContain('TOP-SECRET')
    expect(bytes(root)).toEqual(before); expect(state.control.start).not.toHaveBeenCalled(); expect(state.ctx.sessionPersistence.open).not.toHaveBeenCalled()
  })
  it('refuses multiple repository remotes without upstream even with matching console history', async () => {
    const path = await repository(); await command(path, 'remote', 'add', 'fork', 'https://github.com/other/widgets')
    const { reader, control } = setup(path)
    control.history.mockReturnValue({ entries: [entry('acme/widgets', 'main', { consoleId: 'session-1' })], limit: 30, error: null })
    expect(await reader.read('session-1')).toMatchObject({ reason: 'ambiguous-remotes', repository: null, status: null, summary: null, history: { entries: [] } })
  })
  it('deduplicates aliases and only maps null default after local remote HEAD proves it', async () => {
    const path = await repository(); await command(path, 'remote', 'add', 'same', 'ssh://git@github.com/ACME/Widgets.git')
    await command(path, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await command(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const state = setup(path)
    state.control.history.mockReturnValue({ entries: [entry(), entry('acme/widgets', null), entry('acme/widgets', 'feature')], limit: 30, error: null })
    database(state.stateDir, 'acme/widgets', null).ticket('default-ticket')
    expect(await state.reader.read('session-1')).toMatchObject({ defaultBranch: 'main', history: { entries: [entry(), entry('acme/widgets', null)] }, summary: { counts: { total: 1 } } })
    await command(path, 'checkout', '-b', 'feature')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    expect(await state.reader.read('session-1')).toMatchObject({ branch: 'feature', defaultBranch: 'main', history: { entries: [entry('acme/widgets', 'feature')] }, summary: null })
  })
  it('clears inherited Git repository overrides and shares cached probes', async () => {
    const a = await repository('a'), b = await repository('b', 'https://github.com/wrong/project')
    const calls: SubprocessSpawnSpec[] = [], state = setup(a, calls, { GIT_DIR: join(b, '.git'), GIT_WORK_TREE: b, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://github.com/wrong/injected' })
    const views = await Promise.all([state.reader.read('session-1'), state.reader.read('session-1')])
    expect(views.every(view => view.repository === 'acme/widgets')).toBe(true)
    expect(calls).toHaveLength(4)
    await state.reader.read('session-1'); expect(calls).toHaveLength(4)
    expect(calls.every(call => call.argv[1] === '--no-optional-locks')).toBe(true)
  })
  it('uses immutable header fallback without requiring a registered workspace', async () => {
    const path = await repository(), state = setup(null)
    state.header.set('session-1', path)
    expect(await state.reader.read('session-1')).toMatchObject({ workspace: { id: null, path, source: 'session-header' }, repository: 'acme/widgets' })
    expect(await state.reader.read('unknown')).toMatchObject({ sessionId: 'unknown', reason: 'session-not-found', workspace: null, status: null })
  })
  it('uses only a unique exact launch link for a non-Git master and rejects ambiguous links', async () => {
    const state = setup(root)
    state.control.history.mockReturnValue({ entries: [entry('acme/widgets', 'feature', { masterId: 'session-1' })], limit: 30, error: null })
    expect(await state.reader.read('session-1')).toMatchObject({ repository: 'acme/widgets', branch: 'feature', source: 'launch-history', reason: null })
    state.control.history.mockReturnValue({ entries: [entry('acme/widgets', 'feature', { masterId: 'session-1' }), entry('other/project', 'main', { consoleId: 'session-1' })], limit: 30, error: null })
    expect(await state.reader.read('session-1')).toMatchObject({ repository: null, reason: 'ambiguous-history', status: null })
  })
  it('does not use launch links to override detached HEAD or a non-GitHub project', async () => {
    const path = await repository('foreign', 'https://gitlab.com/acme/widgets'), state = setup(path)
    state.control.history.mockReturnValue({ entries: [entry('acme/widgets', 'main', { consoleId: 'session-1' })], limit: 30, error: null })
    expect(await state.reader.read('session-1')).toMatchObject({ reason: 'no-github-remote', repository: null })
    await command(path, 'checkout', '--detach')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    expect(await state.reader.read('session-1')).toMatchObject({ reason: 'detached-head', repository: null })
  })
})

describe('read-only persisted summaries', () => {
  it('supports immutable SQLite URI reads of a closed WAL-mode database without creating sidecars', () => {
    const saved = database(join(root, 'state'), 'acme/widgets', 'main', true)
    saved.ticket('closed-wal')
    saved.db.close(); databases.splice(databases.indexOf(saved.db), 1)
    const before = bytes(root)
    const uri = pathToFileURL(saved.file); uri.searchParams.set('immutable', '1')
    const reader = new DatabaseSync(uri.href, { readOnly: true })
    try { expect(reader.prepare('SELECT COUNT(*) AS total FROM ticket').get()!.total).toBe(1) }
    finally { reader.close() }
    expect(bytes(root)).toEqual(before)
  })
  it('reads schema 11 saved stages, verifies durable links and preserves database bytes', async () => {
    const path = await repository(), state = setup(path), saved = database(state.stateDir)
    saved.put('master-id', 'saved-master')
    saved.ticket('one', { assignments: [{ state: 'running' }] })
    saved.ticket('two', { ended: { at: now }, assignments: [{ state: 'ended' }] })
    saved.ticket('three', { assignments: [{ state: 'ended', report: { state: 'ready', at: now } }] })
    state.header.set('saved-master', root); state.header.set('worker-one', path)
    const before = bytes(root)
    const view = await state.reader.read('session-1')
    expect(view.status).toBeNull()
    expect(view.summary).toMatchObject({ source: 'saved', counts: { total: 3, open: 2, working: 1, ended: 1, person: 1, idle: 0 }, paused: true, maxWorkers: 4, masterId: 'saved-master', updatedAt: now })
    expect(view.summary!.recentTickets.find(ticket => ticket.id === 'one')).toMatchObject({ stage: { stage: 'working' }, workerSessionId: 'worker-one' })
    expect(view.summary!.recentTickets.find(ticket => ticket.id === 'two')!.workerSessionId).toBeNull()
    expect(bytes(root)).toEqual(before)
  })
  it('refuses an externally open WAL database without changing database, WAL or SHM bytes', () => {
    const saved = database(join(root, 'state'), 'acme/widgets', 'main', true)
    saved.ticket('in-wal')
    const before = bytes(root)
    expect(readProjectDatabase(saved.file, { repository: 'acme/widgets', branch: 'main' })).toMatchObject({ summary: null, error: expect.stringContaining('outside this launcher') })
    expect(bytes(root)).toEqual(before)
  })
  it('reads active WAL through the exact captured run and reads its stopped snapshot without sidecars', async () => {
    const path = await repository(), state = setup(path), saved = database(state.stateDir, 'acme/widgets', 'main', true)
    saved.ticket('running', { assignments: [{ state: 'running' }] })
    const summary = vi.fn(() => readProjectSnapshot(saved.db, { repository: 'acme/widgets', branch: 'main' }))
    const launcher = new Launcher(async () => ({ view: () => ({ phase: 'running', masterId: null, panelAvailable: true, error: null }), stop: async () => {}, summary }))
    const reader = new ProjectReader(state.ctx as unknown as Context, launcher, state.stateDir); readers.push(reader)
    expect(launcher.summary({ repository: 'acme/widgets', branch: 'main' })).toBeUndefined()
    await launcher.start('https://github.com/acme/widgets/tree/main', 'session-1')
    expect(launcher.summary({ repository: 'other/project', branch: 'main' })).toBeUndefined()
    expect(launcher.summary({ repository: 'acme/widgets', branch: 'Main' })).toBeUndefined()
    expect(launcher.summary({ repository: 'acme/widgets', branch: null })).toBeUndefined()
    expect(summary).not.toHaveBeenCalled()
    const before = bytes(root), view = await reader.read('session-1'), after = bytes(root)
    expect(view).toMatchObject({ status: { phase: 'running' }, summary: { source: 'saved', counts: { total: 1, working: 1 } }, summaryError: null })
    expect(summary).toHaveBeenCalledOnce()
    expect(after[saved.file]).toBe(before[saved.file]); expect(after[saved.file + '-wal']).toBe(before[saved.file + '-wal'])
    await launcher.stop()
    saved.db.close(); databases.splice(databases.indexOf(saved.db), 1)
    const stopped = bytes(root)
    expect(await reader.read('session-1')).toMatchObject({ status: null, summary: { source: 'saved', counts: { total: 1, working: 1 } }, summaryError: null })
    expect(bytes(root)).toEqual(stopped); expect(summary).toHaveBeenCalledOnce()
  })
  it('never commits an owner transaction, changes query_only or closes the owned database', () => {
    const saved = database(join(root, 'state'), 'acme/widgets', 'main', true)
    saved.db.exec('BEGIN'); saved.ticket('uncommitted')
    expect(readProjectSnapshot(saved.db, { repository: 'acme/widgets', branch: 'main' })).toMatchObject({ summary: { counts: { total: 1 } }, error: null })
    expect(saved.db.prepare('PRAGMA query_only').get()!.query_only).toBe(0)
    saved.db.exec('ROLLBACK')
    expect(saved.db.prepare('SELECT COUNT(*) AS total FROM ticket').get()!.total).toBe(0)
    saved.ticket('after-read')
    expect(readProjectSnapshot(saved.db, { repository: 'acme/widgets', branch: 'main' })).toMatchObject({ summary: { counts: { total: 1 } }, error: null })
  })
  it.each([10, 12])('leaves unsupported schema %i unchanged', schema => {
    const saved = database(join(root, 'state')); saved.put('schema', schema)
    const before = bytes(root)
    expect(readProjectDatabase(saved.file, { repository: 'acme/widgets', branch: 'main' })).toMatchObject({ summary: null, error: expect.stringContaining('schema') })
    expect(bytes(root)).toEqual(before)
  })
  it('keeps mismatched saved identity and corrupt files unchanged, and never creates a missing database', () => {
    const saved = database(join(root, 'state'))
    const before = bytes(root)
    expect(readProjectDatabase(saved.file, { repository: 'other/project', branch: 'main' })).toMatchObject({ summary: null, error: expect.stringContaining('identity') })
    expect(readProjectDatabase(saved.file, { repository: 'acme/widgets', branch: 'Main' })).toMatchObject({ summary: null, error: expect.stringContaining('identity') })
    expect(readProjectDatabase(join(root, 'absent', 'orchestrator.sqlite'), { repository: 'acme/widgets', branch: 'main' })).toEqual({ summary: null, error: null })
    expect(bytes(root)).toEqual(before)
    const corrupt = join(root, 'corrupt.sqlite'); writeFileSync(corrupt, 'not sqlite SECRET')
    expect(readProjectDatabase(corrupt, { repository: 'acme/widgets', branch: 'main' })).toEqual({ summary: null, error: 'Saved project data is unreadable or corrupt.' })
    expect(readFileSync(corrupt, 'utf8')).toBe('not sqlite SECRET')
  })
  it('keeps live project status when saved data is corrupt and suppresses non-existent master sessions', async () => {
    const path = await repository(), state = setup(path), saved = database(state.stateDir)
    saved.put('schema', 12)
    state.control.status.mockReturnValue({ ...idle(), phase: 'running', repository: 'ACME/Widgets', branch: 'main', masterId: 'preallocated-only', panelAvailable: true, lastRepository: 'other/project' })
    expect(await state.reader.read('session-1')).toMatchObject({ status: { phase: 'running', masterId: null, lastRepository: 'ACME/Widgets' }, summary: null, summaryError: expect.stringContaining('schema'), error: null })
  })
  it('bounds recent tickets and rejects oversized rows', () => {
    const saved = database(join(root, 'state'))
    for (let index = 0; index < 15; index++) saved.ticket(`ticket-${index}`, { updatedAt: new Date(Date.parse(now) + index * 1000).toISOString() })
    const result = readProjectDatabase(saved.file, { repository: 'acme/widgets', branch: 'main' })
    expect(result.summary!.counts.total).toBe(15); expect(result.summary!.recentTickets).toHaveLength(12); expect(result.summary!.recentTickets[0]!.id).toBe('ticket-14')
    saved.ticket('large', { unused: 'x'.repeat(262144) })
    expect(readProjectDatabase(saved.file, { repository: 'acme/widgets', branch: 'main' })).toMatchObject({ summary: null, error: expect.stringContaining('bounded') })
  })
})

it('serves the idle GET-only endpoint through the real web server, rejects unsafe requests and disposes the route', async () => {
  const ctx = new Context(), state = setup(null)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const mounted = Object.assign(Object.create(ctx), state.ctx) as Context
  const dispose = registerProjectHttp(mounted, state.control, state.stateDir)
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const get = (query = '?sessionId=session-1', options: RequestInit = {}) => fetch(`${origin}/orchestrator/project${query}`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5000), ...options })
  try {
    const response = await get(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ sessionId: 'session-1', reason: 'session-not-found' })
    expect((await get('', { method: 'POST' })).status).toBe(405)
    expect((await get('', { headers: {} })).status).toBe(403)
    expect((await get('?sessionId=session-1', { headers: { 'x-orchestrator-request': '1', origin: 'https://evil.test' } })).status).toBe(403)
    for (const query of ['', '?sessionId=../outside', '?sessionId=a&sessionId=b', '?sessionId=a&path=x', '?sessionId=%00', '?sessionId=' + 'a'.repeat(513)]) expect((await get(query)).status).toBe(400)
    expect(state.ctx.sessionPersistence.stat).toHaveBeenCalledTimes(1)
    await dispose(); expect((await get()).status).toBe(404)
    const remounted = registerProjectHttp(mounted, state.control, state.stateDir); await remounted()
    expect(state.control.start).not.toHaveBeenCalled(); expect(state.control.stop).not.toHaveBeenCalled()
  } finally { await dispose(); await ctx.fiber.dispose() }
})

it('cancels a shared Git probe only when the last reader leaves and awaits child cleanup', async () => {
  let observed: AbortSignal | undefined
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const runtime = { resolveExecutable: async () => git, spawn: (spec: SubprocessSpawnSpec) => {
    observed = spec.signal
    const done = new Promise(resolve => { spec.signal!.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true }) })
    started()
    return { done, collected: { stdout: { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) } } }
  } } as unknown as SubprocessRuntime
  const probe = new ProjectGit(runtime); readers.push(probe)
  const one = new AbortController(), two = new AbortController()
  const first = probe.read(root, one.signal), second = probe.read(root, two.signal)
  const settled = Promise.allSettled([first, second])
  await ready; one.abort(); await Promise.resolve(); expect(observed!.aborted).toBe(false)
  two.abort(); await settled; expect(observed!.aborted).toBe(true)
  await probe.dispose()
})

it('cancels a disconnected HTTP read and rejects readers after disposal', async () => {
  const ctx = new Context(), state = setup(null)
  let began!: () => void
  let done!: () => void
  const started = new Promise<void>(resolve => { began = resolve }), cancelled = new Promise<void>(resolve => { done = resolve })
  state.ctx.sessionPersistence.stat = vi.fn((_id: string, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => { done(); reject(options!.signal!.reason) }, { once: true }); began()
  })) as never
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  const dispose = registerProjectHttp(Object.assign(Object.create(ctx), state.ctx), state.control, state.stateDir)
  const req = httpRequest(`http://127.0.0.1:${ctx.webServer.port}/orchestrator/project?sessionId=session-1`, { headers: { 'x-orchestrator-request': '1' } })
  req.on('error', () => {}); req.end()
  try { await started; req.destroy(); await cancelled; await dispose(); await expect(state.reader.read('bad/id')).rejects.toThrow() }
  finally { req.destroy(); await dispose(); await ctx.fiber.dispose() }
})

it('rejects non-loopback registration and validates opaque safe session IDs', () => {
  expect(() => registerProjectHttp({ webServer: { host: '0.0.0.0' } } as never, {} as never, root)).toThrow('loopback')
  expect(ProjectSessionId.parse('worker-1234_abc')).toBe('worker-1234_abc')
})

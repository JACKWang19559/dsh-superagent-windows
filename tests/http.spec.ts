import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp, sameOrigin } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { Store } from '../src/app/store.ts'
import type { WorkspaceFoldersView } from '../src/app/api.ts'
import type { Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { normalizeWorkspacePath } from '../src/workspace-path.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('accepts the desktop proxy shape at a random loopback port while rejecting its raw application Origin', () => {
  const headers = { host: '127.0.0.1:49183', 'x-orchestrator-request': '1' }
  // The authenticated desktop proxy removes Origin and rewrites Host before forwarding to the local Web server.
  expect(sameOrigin({ headers }, 49183)).toBe(true)
  expect(sameOrigin({ headers: { ...headers, origin: 'dsh-app://app' } }, 49183)).toBe(false)
  expect(sameOrigin({ headers: { ...headers, origin: 'null' } }, 49183)).toBe(false)
  expect(sameOrigin({ headers }, 49184)).toBe(false)
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

/** A real persistent Store and HTTP boundary, with runtime actions deliberately unavailable. */
function folderServer(repository: string | undefined = 'Acme/Widgets') {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-folders-')), database = join(directory, 'state.sqlite')
  let store = new Store(database)
  const action = vi.fn(() => { throw new Error('Folder metadata must not launch work') })
  onTestFinished(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const call = (method: string, body?: unknown) => serve({ store, configured: () => !!repository,
    machine: { stateDir: 'C:\\Agent\\State' }, deployment: { repository },
    requestPass: action, checkSetup: action, models: action, engine: {}, sessions: {}, executor: {},
  })(method, 'workspace-folders', body)
  return { directory, call, action, get store() { return store },
    reopen: () => { store.close(); store = new Store(database) },
    view: async () => { const result = await call('GET'); expect(result.status).toBe(200); return result.body as unknown as WorkspaceFoldersView } }
}
const folderTicket = (id: string, directory?: string, ended = false): Ticket => ({
  id, title: id, decisionId: '', mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
    actor: { source: 'local', id: 'operator' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: '', triggerIds: [] },
  ...(directory ? { execution: { name: id, directory, assignment: '' } } : {}),
  ...(ended ? { ended: { at: '', by: 'executor' as const, outcome: 'completed' as const } } : {}),
})

it('canonicalizes Windows workspace paths without changing POSIX case or roots', () => {
  for (const [path, normalized] of [
    ['C:\\Work\\Project\\', 'c:/work/project'], ['c:/WORK//Project/', 'c:/work/project'],
    ['\\\\Server\\Share\\Project\\', '//server/share/project'], ['//SERVER/Share/PROJECT/', '//server/share/project'],
    ['C:\\', 'c:/'], ['C:', 'c:'], ['C:Project', 'c:project'], ['/', '/'], ['/Work//Project/', '/Work/Project'],
  ]) expect(normalizeWorkspacePath(path!)).toBe(normalized)
})

it('derives the repository group and every ticket directory, including ended tickets, without writes or work', async () => {
  const fixture = folderServer(), { store } = fixture
  store.tickets.save(folderTicket('active', 'D:\\Tasks\\Active'))
  store.tickets.save(folderTicket('ended', 'D:\\Tasks\\Ended', true))
  store.tickets.save(folderTicket('waiting'))
  const changes = () => store.db.prepare('SELECT total_changes() AS count').get()!.count
  const before = changes(), write = vi.spyOn(store, 'set')
  const view = await fixture.view(), id = 'repository:acme/widgets'
  expect(view).toEqual({ revision: 0, folders: [{ id, name: 'Acme/Widgets', automatic: true }], assignments: {
    'c:/agent/state': id, 'd:/tasks/active': id, 'd:/tasks/ended': id,
  } })
  expect(await fixture.view()).toEqual(view)
  expect(changes()).toBe(before)
  expect(store.get(KV.workspaceFolders.state)).toBeUndefined()
  expect(write).not.toHaveBeenCalled()
  expect(fixture.action).not.toHaveBeenCalled()
})

it('creates empty folders and persists their names and canonical manual assignments across reopening', async () => {
  const fixture = folderServer('')
  expect(await fixture.view()).toEqual({ revision: 0, folders: [], assignments: {} })
  const created = await fixture.call('POST', { action: 'create', name: '  Personal  ', revision: 0 })
  expect(created.status).toBe(200)
  const folder = (created.body as unknown as WorkspaceFoldersView).folders[0]!
  expect(created.body).toEqual({ revision: 1, folders: [{ id: folder.id, name: 'Personal' }], assignments: {} })
  expect((await fixture.call('POST', { action: 'assign', path: 'C:\\Work\\Project\\', folderId: folder.id, revision: 1 })).status).toBe(200)
  expect((await fixture.call('POST', { action: 'rename', id: folder.id, name: 'Research', revision: 2 })).status).toBe(200)
  fixture.reopen()
  expect(await fixture.view()).toEqual({ revision: 3, folders: [{ id: folder.id, name: 'Research' }], assignments: { 'c:/work/project': folder.id } })
})

it('keeps manual grouping and explicit null overrides when new task workspaces appear', async () => {
  const fixture = folderServer()
  fixture.store.tickets.save(folderTicket('ended', 'D:\\Tasks\\Ended', true))
  const created = await fixture.call('POST', { action: 'create', name: 'Review', revision: 0 })
  const manual = (created.body as unknown as WorkspaceFoldersView).folders.find(folder => !folder.automatic)!.id
  expect((await fixture.call('POST', { action: 'assign', path: 'D:/TASKS/ENDED/', folderId: manual, revision: 1 })).status).toBe(200)
  expect((await fixture.call('POST', { action: 'assign', path: 'c:/AGENT/state/', folderId: null, revision: 2 })).status).toBe(200)
  fixture.store.tickets.save(folderTicket('new', 'D:\\Tasks\\New'))
  fixture.reopen()
  expect((await fixture.view()).assignments).toEqual({ 'c:/agent/state': null, 'd:/tasks/ended': manual, 'd:/tasks/new': 'repository:acme/widgets' })
  // Deleting the manual category leaves its task ungrouped instead of restoring automatic membership.
  expect((await fixture.call('POST', { action: 'delete', id: manual, revision: 3 })).status).toBe(200)
  expect((await fixture.view()).assignments['d:/tasks/ended']).toBeNull()
})

it('persists automatic renaming and deletion suppression without touching workspace files or tickets', async () => {
  const fixture = folderServer(), directory = join(fixture.directory, 'workspace'), file = join(directory, 'keep.txt')
  mkdirSync(directory); writeFileSync(file, 'keep this workspace')
  const ticket = folderTicket('ended', directory, true), mode = statSync(directory).mode
  fixture.store.tickets.save(ticket)
  const automatic = 'repository:acme/widgets'
  expect((await fixture.call('POST', { action: 'rename', id: automatic, name: 'Repository work', revision: 0 })).status).toBe(200)
  fixture.reopen()
  expect((await fixture.view()).folders).toEqual([{ id: automatic, name: 'Repository work', automatic: true }])
  expect((await fixture.call('POST', { action: 'delete', id: automatic, revision: 1 })).status).toBe(200)
  fixture.reopen()
  fixture.store.tickets.save(folderTicket('future', 'D:\\Tasks\\Future'))
  const suppressed = await fixture.view()
  expect(suppressed.folders).toEqual([])
  expect(suppressed.assignments[normalizeWorkspacePath(directory)]).toBeNull()
  expect(suppressed.assignments['d:/tasks/future']).toBeUndefined()
  expect(fixture.store.tickets.get(ticket.id)).toEqual(ticket)
  expect(readFileSync(file, 'utf8')).toBe('keep this workspace')
  expect(statSync(directory).mode).toBe(mode)
  expect(fixture.action).not.toHaveBeenCalled()
  // Explicit actions still work after suppressing the automatic group, including reusing its former name.
  expect((await fixture.call('POST', { action: 'create', name: 'Repository work', revision: 2 })).status).toBe(200)
  const manual = (await fixture.view()).folders[0]!
  expect((await fixture.call('POST', { action: 'assign', path: directory, folderId: manual.id, revision: 3 })).status).toBe(200)
  expect((await fixture.view()).assignments[normalizeWorkspacePath(directory)]).toBe(manual.id)
})

it('persists manual and automatic folder ordering without changing assignments or automatic discovery', async () => {
  const fixture = folderServer(), automatic = 'repository:acme/widgets'
  fixture.store.tickets.save(folderTicket('task', 'D:/Task'))
  await fixture.call('POST', { action: 'create', name: 'First', revision: 0 })
  await fixture.call('POST', { action: 'create', name: 'Second', revision: 1 })
  const original = await fixture.view(), [first, second] = original.folders.filter(folder => !folder.automatic)
  const write = vi.spyOn(fixture.store, 'set')
  for (const body of [
    { action: 'reorder', id: automatic }, { action: 'reorder', id: '', beforeId: null },
    { action: 'reorder', id: automatic, beforeId: '' },
  ]) expect((await fixture.call('POST', { ...body, revision: 2 })).status).toBe(400)
  for (const body of [
    { id: 'missing', beforeId: null }, { id: first!.id, beforeId: 'missing' },
  ]) expect((await fixture.call('POST', { action: 'reorder', ...body, revision: 2 })).status).toBe(404)
  expect(write).not.toHaveBeenCalled()
  expect((await fixture.call('POST', { action: 'reorder', id: automatic, beforeId: first!.id, revision: 2 })).status).toBe(200)
  fixture.reopen()
  let view = await fixture.view()
  expect(view.folders.map(folder => folder.id)).toEqual([automatic, first!.id, second!.id])
  expect(view.folders[0]!.automatic).toBe(true)
  expect(view.assignments).toEqual(original.assignments)
  expect((await fixture.call('POST', { action: 'reorder', id: first!.id, beforeId: null, revision: 3 })).status).toBe(200)
  fixture.reopen()
  view = await fixture.view()
  expect(view.folders.map(folder => folder.id)).toEqual([automatic, second!.id, first!.id])
  expect(view.assignments).toEqual(original.assignments)
  // A stale drag cannot overwrite the newer order; a self-drop remains a harmless no-op.
  expect((await fixture.call('POST', { action: 'reorder', id: first!.id, beforeId: automatic, revision: 3 })).status).toBe(409)
  expect(await fixture.view()).toEqual(view)
  expect((await fixture.call('POST', { action: 'reorder', id: second!.id, beforeId: second!.id, revision: 4 })).status).toBe(200)
  expect((await fixture.view()).folders).toEqual(view.folders)
  expect((await fixture.call('POST', { action: 'rename', id: automatic, name: 'Repository', revision: 5 })).status).toBe(200)
  expect((await fixture.call('POST', { action: 'create', name: 'New folder', revision: 6 })).status).toBe(200)
  fixture.store.tickets.save(folderTicket('new-task', 'D:/NewTask'))
  fixture.reopen()
  view = await fixture.view()
  expect(view.folders.map(folder => folder.name)).toEqual(['Repository', 'Second', 'First', 'New folder'])
  expect(view.assignments['d:/newtask']).toBe(automatic)
  expect(fixture.action).not.toHaveBeenCalled()
})

it('rejects invalid names, paths, unknown folders and stale revisions before any metadata write', async () => {
  const fixture = folderServer(), write = vi.spyOn(fixture.store, 'set')
  for (const body of [
    { action: 'create', name: '' }, { action: 'create', name: '   ' }, { action: 'create', name: 'x'.repeat(81) },
    { action: 'create', name: 'line\nbreak' }, { action: 'rename', id: 'repository:acme/widgets', name: '' },
    { action: 'assign', path: 'x'.repeat(4097), folderId: null }, { action: 'assign', path: ' ', folderId: null },
    { action: 'assign', path: 'C:/bad\u0000path', folderId: null }, { action: 'assign', path: 'C:/valid' },
    { action: 'other' },
  ]) expect((await fixture.call('POST', { ...body, revision: 0 })).status).toBe(400)
  expect((await fixture.call('POST', { action: 'create', name: 'No revision' })).status).toBe(400)
  expect((await fixture.call('POST', { action: 'create', name: 'Bad revision', revision: -1 })).status).toBe(400)
  for (const body of [
    { action: 'rename', id: 'missing', name: 'Missing' }, { action: 'delete', id: 'missing' },
    { action: 'assign', path: 'C:/valid', folderId: 'missing' },
  ]) expect((await fixture.call('POST', { ...body, revision: 0 })).status).toBe(404)
  expect((await fixture.call('POST', { action: 'create', name: 'Future', revision: 1 })).status).toBe(409)
  expect(write).not.toHaveBeenCalled()
  const results = await Promise.all([
    fixture.call('POST', { action: 'create', name: 'First', revision: 0 }),
    fixture.call('POST', { action: 'create', name: 'Second', revision: 0 }),
  ])
  expect(results.map(result => result.status).sort()).toEqual([200, 409])
  expect(write).toHaveBeenCalledTimes(1)
  const saved = fixture.store.get(KV.workspaceFolders.state)
  expect((await fixture.call('POST', { action: 'assign', path: 'C:/valid', folderId: null, revision: 0 })).status).toBe(409)
  expect((await fixture.call('POST', { action: 'create', name: 'x'.repeat(32 * 1024), revision: 1 })).status).toBe(400)
  expect(fixture.store.get(KV.workspaceFolders.state)).toEqual(saved)
  expect(write).toHaveBeenCalledTimes(1)
})

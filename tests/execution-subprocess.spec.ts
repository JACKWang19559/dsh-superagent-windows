import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime, SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { ExecutionSubprocess, provideExecutionEnvironment } from '../src/execution-subprocess.ts'
import { noWait } from '../src/app/sessions.ts'
import { workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { WINDOWS } from '../src/infra/platform.ts'

const stateDir = join(tmpdir(), 'superagent 代理环境')
const command: SubprocessSpawnSpec = { argv: ['git', 'status'], cwd: stateDir, graceMs: 2000,
  stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } }
function fixture() {
  const handle = { done: Promise.resolve({ exitCode: 0, signal: null }) }
  const upstream = { spawn: vi.fn((_spec: SubprocessSpawnSpec) => handle), resolveExecutable: vi.fn(async (_command: string, _env?: Readonly<Record<string, string>>, _signal?: AbortSignal) => 'resolved'),
    terminalEnvironment: vi.fn(async () => ({ platform: 'windows' })), spawnTerminal: vi.fn() }
  const root = new Context()
  root.provide('subprocess', upstream as unknown as SubprocessRuntime)
  provideExecutionEnvironment(root, stateDir)
  const scope = root.isolate('subprocess')
  const execution = new ExecutionSubprocess(scope, root.get('superagentExecution')!)
  return { root, scope, execution, upstream, handle }
}

it('keeps the desktop provider and environment unchanged while isolating managed command environments', () => {
  const before = { ...process.env }
  const { root, scope, execution, upstream, handle } = fixture()
  expect(root.get('subprocess')).toBe(upstream)
  expect(scope.get('subprocess')).toBeInstanceOf(ExecutionSubprocess)
  expect(execution.spawn({ ...command, env: { LANG: 'test', GH_TOKEN: 'must-be-removed', GIT_CONFIG_GLOBAL: 'operator' } })).toBe(handle)
  const spec = upstream.spawn.mock.calls[0]![0] as unknown as SubprocessSpawnSpec
  expect(spec.env).toMatchObject({ LANG: 'test', GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GH_TOKEN: undefined, GIT_AUTHOR_NAME: undefined })
  expect(spec.env?.PATH?.startsWith(workerBin(stateDir))).toBe(true)
  expect(process.env).toEqual(before)
  // An ordinary desktop call goes straight to the original provider without any account overrides.
  root.get('subprocess')!.spawn(command)
  expect(upstream.spawn.mock.calls[1]![0]).toBe(command)
})

it('overlays RemoteSigned only on managed Windows process and terminal environments', async () => {
  vi.stubEnv('PSExecutionPolicyPreference', 'Restricted')
  try {
    const before = { ...process.env }
    const { root, execution, upstream } = fixture()
    const argv = ['powershell.exe', '-ExecutionPolicy', 'Restricted', '-Command', 'Get-ExecutionPolicy']
    const supplied = { LANG: 'test', PSExecutionPolicyPreference: 'caller-policy' }
    execution.spawn({ ...command, argv, env: supplied })
    const sent = upstream.spawn.mock.calls[0]![0]
    expect(sent.argv).toEqual(argv)
    expect(sent.env?.PSExecutionPolicyPreference).toBe(WINDOWS ? 'RemoteSigned' : 'caller-policy')
    const terminal = { terminate: vi.fn() }
    upstream.spawnTerminal.mockResolvedValue(terminal)
    const spec: SubprocessTerminalSpawnSpec = { argv, cwd: stateDir, env: supplied, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 2000 }
    expect(await execution.spawnTerminal(spec)).toBe(terminal)
    const terminalSpec = upstream.spawnTerminal.mock.calls[0]![0] as SubprocessTerminalSpawnSpec
    expect(terminalSpec.argv).toEqual(argv)
    expect(terminalSpec.env).toMatchObject({ PSExecutionPolicyPreference: WINDOWS ? 'RemoteSigned' : 'caller-policy', GH_TOKEN: '', LANG: 'test' })
    expect(root.get('subprocess')).toBe(upstream)
    expect(process.env).toEqual(before)
  } finally { vi.unstubAllEnvs() }
})

it.skipIf(!WINDOWS)('removes Windows case aliases before account, PATH, and process-policy overlays', async () => {
  const { execution, upstream } = fixture()
  const env = { PSExecutionPolicyPreference: 'AllSigned', psexecutionpolicypreference: 'Restricted',
    PATH: 'first-path', Path: 'last-path', GH_TOKEN: 'operator', gh_token: 'operator-alias' }
  const assertUnique = (sent: Record<string, string | undefined>, key: string, value: unknown): void => {
    expect(Object.keys(sent).filter(name => name.toUpperCase() === key.toUpperCase())).toEqual([key])
    expect(sent[key]).toEqual(value)
  }
  execution.spawn({ ...command, env })
  const sent = upstream.spawn.mock.calls[0]![0].env!
  assertUnique(sent, 'PSExecutionPolicyPreference', 'RemoteSigned')
  assertUnique(sent, 'PATH', expect.stringContaining(workerBin(stateDir)))
  assertUnique(sent, 'GH_TOKEN', undefined)
  upstream.spawnTerminal.mockResolvedValue({ terminate: vi.fn() })
  await execution.spawnTerminal({ argv: ['powershell.exe'], cwd: stateDir, env, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 2000 })
  const terminal = (upstream.spawnTerminal.mock.calls[0]![0] as SubprocessTerminalSpawnSpec).env!
  assertUnique(terminal, 'PSExecutionPolicyPreference', 'RemoteSigned')
  assertUnique(terminal, 'PATH', expect.stringContaining(workerBin(stateDir)))
  assertUnique(terminal, 'GH_TOKEN', '')
  await execution.resolveExecutable('gh', env)
  const lookup = upstream.resolveExecutable.mock.calls[0]![1]!
  assertUnique(lookup, 'PATH', expect.stringContaining(workerBin(stateDir)))
  expect(env.Path).toBe('last-path')
  expect(env.gh_token).toBe('operator-alias')
})

it('preserves cancellation and resolves executables using the managed PATH', async () => {
  const { execution, upstream } = fixture()
  const abort = new AbortController()
  execution.spawn({ ...command, signal: abort.signal })
  const sent = upstream.spawn.mock.calls[0]![0] as unknown as SubprocessSpawnSpec
  abort.abort()
  expect(sent.signal?.aborted).toBe(true)
  await execution.resolveExecutable('gh', { PATH: 'untrusted-path' })
  expect(upstream.resolveExecutable.mock.calls[0]![1]).toMatchObject({ PATH: expect.stringContaining(workerBin(stateDir)) })
})

it('guards PowerShell waits without blocking short commands or background work', () => {
  for (const text of ['Start-Sleep -Seconds 60', 'Get-Date; Start-Sleep 30', 'sleep 30', 'Microsoft.PowerShell.Utility\\Start-Sleep 20']) {
    expect(noWait({ name: 'pwsh', arguments: { command: text } }, () => true)).toMatch(/^Reports/)
  }
  expect(noWait({ name: 'pwsh', arguments: { command: 'git status', timeoutMs: 60000 } }, () => true)).toMatch(/^Reports/)
  expect(noWait({ name: 'pwsh', arguments: { command: 'git status', timeoutMs: 5000 } }, () => true)).toBeUndefined()
  expect(noWait({ name: 'pwsh', arguments: { command: 'git status', run_in_background: true } }, () => false)).toBeUndefined()
})

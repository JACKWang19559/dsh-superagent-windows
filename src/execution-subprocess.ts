/** Subprocess scope for managed presets: account settings never modify the desktop host's environment. */
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, type SubprocessSpawnSpec, type SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { workerEnvironment } from './infra/environment.ts'
import { WINDOWS } from './infra/platform.ts'

/** Windows treats names case-insensitively; remove every prior alias before applying a managed value. */
function overlayEnvironment<T>(base: Readonly<Record<string, T>> | undefined, overrides: Readonly<Record<string, T>>): Record<string, T> {
  const env = { ...base }
  for (const [name, value] of Object.entries(overrides)) {
    if (WINDOWS) for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key]
    env[name] = value
  }
  return env
}

interface ExecutionEnvironment {
  readonly subprocess: SubprocessRuntime
  variables(): Record<string, string | undefined>
}
declare module '@deepseek-ai/cordis' {
  interface Context { superagentExecution: ExecutionEnvironment }
}

/** Publishes the original provider and account environment for the bundle's isolated shell scopes. */
export function provideExecutionEnvironment(ctx: Context, stateDir: string): void {
  const subprocess = ctx.subprocess, path = process.env.PATH ?? ''
  // Process-scope policy is inherited only by managed children, including sandbox runners and terminals.
  // PowerShell still gives explicit -ExecutionPolicy and MachinePolicy/UserPolicy precedence over this env value.
  ctx.provide('superagentExecution', { subprocess, variables: () => ({ ...workerEnvironment(stateDir, path),
    ...WINDOWS ? { PSExecutionPolicyPreference: 'RemoteSigned' } : {},
  }) })
}

/** Forwards only this preset's processes through its account environment and cancellation lifetime. */
export class ExecutionSubprocess extends SubprocessRuntime {
  private readonly lifetime = new AbortController()
  constructor(ctx: Context, private readonly execution: ExecutionEnvironment) {
    super(ctx)
    ctx.effect(() => () => { this.lifetime.abort(new Error('Superagent execution scope disposed')) })
  }
  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
  }
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // Executable lookup needs PATH; account-variable removals apply on spawn, where tombstones are supported.
    return this.execution.subprocess.resolveExecutable(command, overlayEnvironment(env, { PATH: this.execution.variables().PATH ?? '' }), this.signal(signal))
  }
  terminalEnvironment(signal?: AbortSignal) { return this.execution.subprocess.terminalEnvironment(this.signal(signal)) }
  spawn(spec: SubprocessSpawnSpec) {
    return this.execution.subprocess.spawn({ ...spec, env: overlayEnvironment(spec.env, this.execution.variables()), signal: this.signal(spec.signal) })
  }
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec) {
    // Terminal env accepts strings only. Empty values clear ambient account overrides there; regular spawns use tombstones.
    const env = Object.fromEntries(Object.entries(this.execution.variables()).map(([key, value]) => [key, value ?? '']))
    const handle = await this.execution.subprocess.spawnTerminal({ ...spec, env: overlayEnvironment(spec.env, env), signal: this.signal(spec.signal) })
    this.ctx.effect(() => () => handle.terminate())
    return handle
  }
}
export const name = 'dsh-superagent-execution-subprocess'
export const inject = ['superagentExecution']
export function apply(ctx: Context): void { new ExecutionSubprocess(ctx, ctx.superagentExecution) }

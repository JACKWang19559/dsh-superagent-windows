/** Host-side CLI transport, including bounded cancellation of Windows script adapters and their children. */
import { execFile, spawn } from 'node:child_process'
import { isAbsolute, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { WINDOWS, resolveExecutable, workerCommand } from './platform.ts'

const exec = promisify(execFile)
type Environment = Readonly<Record<string, string | undefined>>
interface StreamOptions {
  cwd?: string
  signal: AbortSignal
  environment?: readonly Environment[]
}
interface CommandOptions extends StreamOptions {
  timeout: number
  maxBuffer: number
}
interface Output { stdout: string; stderr: string }
interface Exit { code: number | null; signal: NodeJS.Signals | null }
interface CommandStream {
  stdout: Readable
  stderr: Readable
  /** Resolves after exit and stdio drain; non-zero exit codes are returned to the streaming consumer. */
  done: Promise<Exit>
  /** Stops the still-owned process tree, then bounds the wait for inherited stdio to close. */
  stop(error: Error): void
}

/** Windows has one variable per case-insensitive name; apply tombstones before passing the final map to Node. */
function environment(layers: readonly Environment[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const layer of layers) for (const [name, value] of Object.entries(layer)) {
    const key = WINDOWS ? name.toUpperCase() : name
    if (value === undefined) delete result[key]
    else result[key] = value
  }
  return result
}

const aborted = (signal: AbortSignal): Error => Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })

/** Resolve against the final child environment before applying the same script plan as startup probes. */
function commandPlan(argv: string[], options: StreamOptions) {
  if (options.signal.aborted) throw aborted(options.signal)
  const env = environment([process.env, ...(options.environment ?? [])])
  let requested = argv
  // CreateProcess can search the parent's PATH even when the target environment deletes it. Resolve before spawning.
  if (WINDOWS && !isAbsolute(argv[0]!)) {
    let file: string
    if (/[\\/:]/.test(argv[0]!)) file = resolve(options.cwd ?? process.cwd(), argv[0]!)
    else {
      try { file = resolveExecutable(argv[0]!, env.PATH ?? '', undefined, env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD') }
      catch { throw Object.assign(new Error('Command was not found'), { code: 'ENOENT' }) }
    }
    requested = [file, ...argv.slice(1)]
  }
  let command: string[]
  try { command = workerCommand(requested, env.PATH ?? '') } catch (error) {
    // Only this controlled validation error may supply a pre-spawn diagnostic; it contains no user argument values.
    if (error instanceof Error && error.name === 'WindowsBatchArgumentError'
      && 'code' in error && error.code === 'WINDOWS_BATCH_ARGUMENT') throw Object.assign(error, { stderr: error.message })
    throw error
  }
  const adapted = command !== requested
  // Desktop's process.execPath is Electron. This flag belongs to this adapter child only.
  return { argv: command, adapted, env: adapted ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env }
}

/** Preserve execFile's public failure shape without putting command arguments in error messages. */
export async function execCommand(argv: string[], options: CommandOptions): Promise<Output> {
  const plan = commandPlan(argv, options)
  if (!plan.adapted) {
    const { stdout, stderr } = await exec(plan.argv[0]!, plan.argv.slice(1), {
      cwd: options.cwd, env: plan.env, signal: options.signal, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true,
    })
    return { stdout, stderr }
  }
  return scriptCommand(plan.argv, options, plan.env)
}

/** Starts an unbuffered, unlimited-duration CLI stream with the host command planner and bounded cancellation. */
export function streamCommand(argv: string[], options: StreamOptions): CommandStream {
  const plan = commandPlan(argv, options)
  return startCommand(plan.argv, options, plan.env, 'pipe')
}

/** Keep a Windows parent alive until taskkill has terminated its foreground tree; detached descendants are outside this contract. */
function startCommand(argv: string[], options: StreamOptions, env: Record<string, string>, stdin: 'pipe' | 'ignore'): CommandStream {
  if (options.signal.aborted) throw aborted(options.signal)
  const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] })
  const stdout = child.stdout!, stderr = child.stderr!
  let failure: Error | undefined, spawnError: Error | undefined, cleanup: Promise<void> | undefined
  let closed = false
  let cleanupFinished!: () => void
  const terminated = new Promise<void>(resolve => { cleanupFinished = resolve })
  const stop = (error: Error): void => {
    if (failure || closed) return
    failure = error
    cleanup = (async () => {
      // An exited parent's PID no longer identifies a live owned tree; do not target a possibly reused PID.
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      if (!WINDOWS) { child.kill('SIGTERM'); return }
      try {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        await exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true })
      } catch (error) {
        // The process may have finished while the owned-tree termination was being requested.
        if (!closed && child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGTERM') } catch { /* Preserve the original termination reason even if the fallback cannot kill. */ }
        }
        if (!closed && failure) Object.defineProperty(failure, 'cause', { value: error, configurable: true })
      }
    })().finally(() => { child.stdin?.destroy(); cleanupFinished() })
  }
  stdout.on('error', stop); stderr.on('error', stop)
  child.on('error', error => { spawnError = error })
  const finished = new Promise<Exit>(resolve => {
    child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
  })
  // Detached descendants may retain inherited pipes after their parent exits. They are not an owned PID tree any more.
  // Bound our drain independently; closing these readers is not a claim that arbitrary detached processes were killed.
  const drained = terminated.then(async () => {
    let deadline: NodeJS.Timeout | undefined
    try {
      return await Promise.race([finished, new Promise<Exit>(resolve => {
        deadline = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL') } catch { /* Cleanup has already been attempted; keep the wait bounded. */ }
          }
          stdout.destroy(); stderr.destroy(); child.unref()
          resolve({ code: child.exitCode, signal: child.signalCode })
        }, 1000)
      })])
    } finally { clearTimeout(deadline) }
  })
  const onAbort = (): void => { stop(aborted(options.signal)) }
  options.signal.addEventListener('abort', onAbort, { once: true })
  // Cover a cancellation between the initial check and listener registration.
  if (options.signal.aborted) onAbort()
  const done = (async () => {
    try {
      const result = await Promise.race([finished, drained])
      await cleanup
      if (failure) throw failure
      if (spawnError) throw spawnError
      return result
    } finally { options.signal.removeEventListener('abort', onAbort) }
  })()
  return { stdout, stderr, done, stop }
}

/** Bounded output collection shares process cleanup and drain with long-lived streaming consumers. */
async function scriptCommand(argv: string[], options: CommandOptions, env: Record<string, string>): Promise<Output> {
  const child = startCommand(argv, options, env, 'ignore')
  const chunks: Record<keyof Output, Buffer[]> = { stdout: [], stderr: [] }
  const bytes = { stdout: 0, stderr: 0 }
  const collect = (name: keyof Output, data: Buffer): void => {
    const remaining = Math.max(0, options.maxBuffer - bytes[name])
    if (remaining) chunks[name].push(data.subarray(0, remaining))
    bytes[name] += data.length
    if (bytes[name] > options.maxBuffer) child.stop(Object.assign(new Error('Command printed more output than it may'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }))
  }
  child.stdout.on('data', (data: Buffer) => { collect('stdout', data) })
  child.stderr.on('data', (data: Buffer) => { collect('stderr', data) })
  const timer = options.timeout > 0 ? setTimeout(() => {
    child.stop(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }))
  }, options.timeout) : undefined
  const output = (): Output => ({ stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') })
  try {
    const result = await child.done
    if (result.code !== 0) throw Object.assign(new Error('Command failed'), { code: result.code, signal: result.signal })
    return output()
  } catch (error) { throw Object.assign(error as Error, output()) }
  finally { clearTimeout(timer) }
}

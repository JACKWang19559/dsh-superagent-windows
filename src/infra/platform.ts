/** Host paths and shell dispatch; command arguments stay data when a Windows script needs an interpreter. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, join, resolve } from 'node:path'

export const WINDOWS = process.platform === 'win32'
/** Windows root-relative paths depend on a drive and are not complete host paths. */
export const HOST_ABSOLUTE_PATH = WINDOWS ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/ : /^\//
export const isHostAbsolutePath = (path: string): boolean => HOST_ABSOLUTE_PATH.test(path)
const unquote = (path: string): string => path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => {
    let value: string
    try { value = realpathSync(unquote(path)) } catch { value = resolve(unquote(path)) }
    return WINDOWS ? value.toLowerCase() : value
  }
  return real(a) === real(b)
}
/** Resolve real host executables and script launchers, including PATHEXT and PowerShell scripts on Windows. */
export function resolveExecutable(name: string, path: string, exclude?: string, pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'): string {
  const absolute = isHostAbsolutePath(name)
  if (!absolute && /[\\/:]/.test(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const suffixes = WINDOWS && !extname(name) ? [...new Set(pathext.split(';').filter(Boolean).map(ext => ext.toLowerCase())), '.ps1', ''] : ['']
  const directories = absolute ? [''] : path.split(delimiter).map(unquote).filter(dir => isHostAbsolutePath(dir) && !(exclude && sameDirectory(dir, exclude)))
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = directory ? join(directory, name + suffix) : name + suffix
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Try the next suffix or PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${absolute ? '' : ' on PATH'}`)
}
export function powershell(path = process.env.PATH ?? ''): string {
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    try { return resolveExecutable(name, path) } catch { /* Windows PowerShell may live outside the caller's PATH. */ }
  }
  return resolveExecutable(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), path)
}
export const powershellCommand = (shell: string, script: string): string[] =>
  [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
/** PowerShell 5 does not propagate a failed native command's exit status by itself. */
export function prepareCommand(command: string, path = process.env.PATH ?? ''): string[] {
  if (!WINDOWS) return ['sh', '-c', command]
  return powershellCommand(powershell(path), `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$status = 1
$global:LASTEXITCODE = 0
try {
  & {
${command}
  }
  $succeeded = $?
  if ($global:LASTEXITCODE -ne 0) { $status = $global:LASTEXITCODE }
  elseif ($succeeded) { $status = 0 }
} catch { [Console]::Error.WriteLine($_.ToString()) }
exit $status
`)
}

interface WindowsPlan { argv: string[]; batch?: 'native' | 'script' }
/** Safe to show at command boundaries: messages never interpolate a command, path, or argument. */
export class WindowsBatchArgumentError extends Error {
  override readonly name = 'WindowsBatchArgumentError'
  readonly code = 'WINDOWS_BATCH_ARGUMENT'
}
const batchAdapter = '; use an .exe or .ps1 adapter'

/** Compile complete known forwarding templates; never send their data through CMD expansion. */
function batchPlan(program: string, path: string, shimDir?: string): string[] | undefined {
  const source = readFileSync(program, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').trimEnd()
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean)
  const text = lines.join('\n')
  const host = (executable: string): string => {
    try { return resolveExecutable(executable, path, shimDir) }
    catch { throw new WindowsBatchArgumentError(`The batch template requires an available native Node host${batchAdapter}`) }
  }
  const entry = (file: string): string => resolve(dirname(program), file.replace(/^[\\/]+/, ''))
  const simple = text.match(/^(?:@?echo off\n)?@?("[^"\n]+"|node(?:\.exe)?) "%~dp0([^"%!^&|<>:\n]*\.(?:cjs|mjs|js))" %\*(?:\n@?exit \/b %errorlevel%)?$/i)
  if (simple) {
    const executable = unquote(simple[1]!)
    const bareNode = /^node(?:\.exe)?$/i.test(executable)
    const fixedExecutable = isHostAbsolutePath(executable) && !/["%!^&|<>]/.test(executable)
      && (/[\\/]node\.exe$/i.test(executable) || executable.toLowerCase() === process.execPath.toLowerCase())
    if (bareNode || fixedExecutable) return [host(bareNode ? 'node.exe' : executable), entry(simple[2]!)]
  }
  // cmd-shim's complete Node template, without extra flags or custom environment assignments.
  const npm = text.match(/\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"( {1,2})"%dp0%\\([^"%!^&|<>:\n]*\.(?:cjs|mjs|js))" %\*$/i)
  if (npm) {
    const template = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', 'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"', 'SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"${npm[1]}"%dp0%\\${npm[2]}" %*`,
    ].join('\n')
    if (text.toLowerCase() === template.toLowerCase()) {
      const adjacent = join(dirname(program), 'node.exe')
      return [host(existsSync(adjacent) ? adjacent : 'node.exe'), entry(npm[2]!)]
    }
  }
  const ownPrefix = `@rem # Written by dsh-superagent on every start; edits are lost.\n@setlocal\n@set ELECTRON_RUN_AS_NODE=1\n@"${process.execPath}" "%~dp0..\\worker-launcher.cjs" `
  const own = text.startsWith(ownPrefix) ? text.slice(ownPrefix.length).match(/^([A-Za-z0-9+/]+={0,2}) args %\*\n@exit \/b %errorlevel%$/i) : undefined
  if (own) return [host(process.execPath), resolve(dirname(program), '..', 'worker-launcher.cjs'), own[1]!, 'args']

  // Ordinary batch parameters follow cmd's quote rules. Other programs and extra parsing passes need an adapter.
  const action = '(?:echo(?: [^&|<>()!^\\r\\n]*)?|exit /b (?:-?\\d+|%errorlevel%))'
  const condition = '(?:/i )?(?:not )?"[^"&|<>()!^\\r\\n]*"=="[^"&|<>()!^\\r\\n]*"'
  const statement = new RegExp(`^@?(?:${action}|if ${condition} (?:${action}|\\(${action}\\) else \\(${action}\\))|setlocal(?: DisableDelayedExpansion)?|endlocal|rem(?: [^&|<>!^]*)?)$`, 'i')
  if (!/%\*|EnableDelayedExpansion|\bcall\b/i.test(text) && lines.every(line => statement.test(line))) return undefined
  throw new WindowsBatchArgumentError(`Unsupported batch launcher template${batchAdapter}`)
}
function planWindowsArguments(argv: string[], path: string, shimDir?: string): WindowsPlan {
  const program = argv[0]
  if (!program || !/\.(cmd|bat)$/i.test(program)) return { argv }
  if (argv.some(value => /[\0\r\n]/.test(value))) throw new WindowsBatchArgumentError(`Batch arguments cannot contain NUL or line breaks${batchAdapter}`)
  const native = batchPlan(program, path, shimDir)
  if (native) return { argv: [...native, ...argv.slice(1)], batch: 'native' }
  if (argv.slice(1).some(value => /["%!^&|<>()]/.test(value))) throw new WindowsBatchArgumentError(`Batch script arguments cannot contain quotes or shell metacharacters${batchAdapter}`)
  const meta = /([()\[\]%!^"`<>&|;, *?])/g
  const command = `""%DSH_SUPERAGENT_BATCH_TARGET%" ${argv.slice(1).map(value => `"${value}"`.replace(meta, '^$1')).join(' ')}"`
  if (command.length + program.length > 7000) throw new WindowsBatchArgumentError(`Batch script command exceeds the supported CMD length${batchAdapter}`)
  return { argv, batch: 'script' }
}
const encodeWindowsPlan = (plan: WindowsPlan, shell: string, shimDir?: string): string =>
  Buffer.from(JSON.stringify({ ...plan, powershell: shell, ...shimDir ? { shimDir } : {} }), 'utf8').toString('base64')

/** Standalone Node entry point, serialized into shims and Git helpers; getBuiltinModule survives bundling. */
export function windowsLauncher(payload: string, extra: string[] = []): void {
  const { spawn } = process.getBuiltinModule('child_process')
  const { delimiter, extname, resolve } = process.getBuiltinModule('path')
  const { realpathSync } = process.getBuiltinModule('fs')
  const call = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { argv: string[]; powershell: string; shimDir?: string; batch?: 'native' | 'script' }
  const [program, ...args] = [...call.argv, ...extra] as [string, ...string[]]
  const env = { ...process.env }
  const reject = (message: string): never => {
    const error = new Error(`${message}; use an .exe or .ps1 adapter`)
    error.name = 'WindowsBatchArgumentError'
    Object.assign(error, { code: 'WINDOWS_BATCH_ARGUMENT' })
    throw error
  }
  if (call.batch && [program, ...args].some(value => /[\0\r\n]/.test(value))) reject('Batch arguments cannot contain NUL or line breaks')
  if (call.batch === 'native') env.ELECTRON_RUN_AS_NODE = '1'
  if (call.shimDir) {
    const normalized = (value: string): string => {
      value = value.replace(/^"(.*)"$/, '$1')
      try { return realpathSync(value).toLowerCase() } catch { return resolve(value).toLowerCase() }
    }
    const self = normalized(call.shimDir)
    const seen = new Set<string>([self])
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
    env[key] = (env[key] ?? '').split(delimiter).filter(entry => {
      const value = normalized(entry)
      if (seen.has(value)) return false
      seen.add(value); return true
    }).join(delimiter)
  }
  let argv = [program, ...args]
  let verbatim = false
  if (/^\.(cmd|bat)$/i.test(extname(program))) {
    if (call.batch !== 'script') reject('Unsupported batch launcher template')
    if (args.some(value => /["%!^&|<>()]/.test(value))) reject('Batch script arguments cannot contain quotes or shell metacharacters')
    const meta = /([()\[\]%!^"`<>&|;, *?])/g
    // Environment expansion is one pass: punctuation and literal % in the program path stay data.
    env.DSH_SUPERAGENT_BATCH_TARGET = program
    const command = `""%DSH_SUPERAGENT_BATCH_TARGET%" ${args.map(value => `"${value}"`.replace(meta, '^$1')).join(' ')}"`
    if (command.length + program.length > 7000) reject('Batch script command exceeds the supported CMD length')
    argv = [process.env.ComSpec ?? 'cmd.exe', '/d', '/v:off', '/s', '/c', command]
    verbatim = true
  } else if (/^\.ps1$/i.test(extname(program))) {
    const data = Buffer.from(JSON.stringify([program, ...args]), 'utf8').toString('base64')
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$callArgs = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')))
$program = $callArgs[0]
$forward = @()
if ($callArgs.Count -gt 1) { $forward = $callArgs[1..($callArgs.Count - 1)] }
$status = 1
$global:LASTEXITCODE = 0
try {
  & $program @forward
  $succeeded = $?
  if ($global:LASTEXITCODE -ne 0) { $status = $global:LASTEXITCODE }
  elseif ($succeeded) { $status = 0 }
} catch { [Console]::Error.WriteLine($_.ToString()) }
exit $status
`
    argv = [call.powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  }
  const child = spawn(argv[0]!, argv.slice(1), { env, stdio: 'inherit', windowsVerbatimArguments: verbatim, windowsHide: true })
  child.on('error', (error: Error) => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code: number | null) => { process.exitCode = code ?? 1 })
}
export const windowsLauncherSource = (): string => `(${windowsLauncher.toString()})(process.argv[1], process.argv.slice(2))`
/** Shared plan for account shims and Git credentials, including fixed native argv compiled from known batch templates. */
export const windowsPayload = (argv: string[], shell: string, shimDir?: string): string =>
  encodeWindowsPlan(planWindowsArguments(argv, process.env.PATH ?? '', shimDir), shell, shimDir)

/** Known Node batch templates become direct native argv; only ordinary batch and PowerShell need an adapter. */
export function workerCommand(argv: string[], path = process.env.PATH ?? ''): string[] {
  if (!WINDOWS || !argv.length) return argv
  let file = argv[0]!
  try { file = resolveExecutable(file, path) } catch { /* Let the subprocess provider report a missing executable. */ }
  if (!/\.(cmd|bat|ps1)$/i.test(file)) return argv
  const plan = planWindowsArguments([file, ...argv.slice(1)], path)
  if (plan.batch === 'native') return plan.argv
  return [process.execPath, '-e', windowsLauncherSource(), encodeWindowsPlan(plan, powershell(path))]
}

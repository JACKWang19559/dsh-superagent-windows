/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'
import { WINDOWS, powershell, sameDirectory, windowsLauncher, windowsLauncherSource, windowsPayload, workerCommand } from './platform.ts'
export { sameDirectory } from './platform.ts'

const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
export const credentialHelper = (cli: string): string => {
  if (!WINDOWS) return `!${shellQuote(cli)} auth git-credential`
  // Git for Windows runs helpers through sh. A Node adapter also supports .cmd/.ps1 identities without shell-interpreting arguments.
  const source = Buffer.from(windowsLauncherSource(), 'utf8').toString('base64')
  const decode = 'eval(Buffer.from(process.argv.splice(1,1)[0],"base64").toString("utf8"))'
  return `!ELECTRON_RUN_AS_NODE=1 ${[process.execPath.replaceAll('\\', '/'), '-e', decode, source, windowsPayload([cli, 'auth', 'git-credential'], powershell())].map(shellQuote).join(' ')}`
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** Worker-only overrides, with one shim PATH entry. This never changes the host process environment. */
export function workerEnvironment(stateDir: string, path = process.env.PATH ?? ''): Record<string, string | undefined> {
  const entries: string[] = []
  for (const entry of [workerBin(stateDir), ...path.split(delimiter)]) {
    if (!entries.some(kept => sameDirectory(kept, entry))) entries.push(entry)
  }
  return { ...agentVariables(stateDir), PATH: entries.join(delimiter) }
}

/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).replace(/^﻿/, '').split('\n', 2)
  return [MARKER, ...LEGACY_MARKERS].some(marker => head.some(line => [marker, `// ${marker}`, `@rem ${marker}`].includes(line.replace(/\r$/, ''))))
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * Each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const file = async (name: string, text: string): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode: 0o755 })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  const shim = (name: string, body: string): Promise<void> => file(name, `#!/bin/sh\n${MARKER}\n${body}\n`)
  const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const launcher = join(stateDir, 'worker-launcher.cjs')
  if (WINDOWS) await own(launcher, `// ${MARKER}\n(${windowsLauncher.toString()})(process.argv[2], process.argv[3] === 'base64' ? JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8')) : process.argv.slice(4))\n`)
  const windowsShim = async (name: string, program?: string, message?: string): Promise<void> => {
    const payload = program ? windowsPayload([program], powershell(), dir) : ''
    const body = program ? [
      "$ErrorActionPreference = 'Continue'",
      "$ProgressPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      "$forward = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($args) -Compress)))",
      '$previousNodeMode = $env:ELECTRON_RUN_AS_NODE',
      '$status = 1',
      '$global:LASTEXITCODE = 1',
      'try {',
      "  $env:ELECTRON_RUN_AS_NODE = '1'",
      // A piped native command waits even when Electron is a Windows GUI executable; keep stdout in the caller's pipeline.
      `  & ${psQuote(process.execPath)} ${psQuote(launcher)} '${payload}' 'base64' $forward | Microsoft.PowerShell.Utility\\Write-Output`,
      '  $status = $global:LASTEXITCODE',
      '} catch { [Console]::Error.WriteLine($_.ToString()) }',
      'finally { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }',
      'exit $status',
    ].join('\n') : `[Console]::Error.WriteLine(${psQuote(message!)})\nexit 1`
    // Windows PowerShell 5 reads scripts using the system codepage without a UTF-8 BOM.
    await file(`${name}.ps1`, `﻿# PowerShell worker launcher.\n${MARKER}\n${body}\n`)
    // Keep batch source ASCII for state paths containing Chinese: %~dp0 supplies the directory at execution time.
    const batch = program ? `@setlocal\r\n@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" "%~dp0..\\worker-launcher.cjs" ${payload} args %*\r\n@exit /b %errorlevel%` : `@echo ${message!.replace(/[&|<>^()%!]/g, '^$&')} 1>&2\r\n@exit /b 1`
    await file(`${name}.cmd`, `@rem ${MARKER}\r\n${batch}\r\n`)
  }
  const withoutShims = [
    `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
  ].join('\n')
  const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
  const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
  const unavailable = 'lark-cli is unavailable: this installation has no Feishu bot.'
  if (WINDOWS) {
    await windowsShim('gh', github.cli)
    await windowsShim('lark-cli', feishu?.cli, unavailable)
  } else {
    await shim('gh', run(github.cli))
    await shim('lark-cli', feishu ? run(feishu.cli) : fail(unavailable))
  }
  const commandName = (name: string): string => WINDOWS ? name.replace(/\.(cmd|ps1|bat|exe|com)$/i, '').toLowerCase() : name
  for (const name of new Set(blockedCommands.map(commandName).filter(name => !WORKER_COMMANDS.includes(name)))) {
    const message = `${name} is blocked in this installation; use gh, which acts as ${github.login}.`
    if (WINDOWS) await windowsShim(name, undefined, message)
    else await shim(name, fail(message))
  }
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/** @deprecated Pass workerEnvironment to each subprocess instead. Retained for callers of the earlier API. */
export function applyEnvironment(variables: Record<string, string | undefined>, stateDir: string, path: string): () => void {
  const values = { ...variables, PATH: [workerBin(stateDir), path].join(delimiter) }
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]))
  const apply = (env: Record<string, string | undefined>): void => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } }
  apply(values)
  return () => { apply(previous) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal, env?: Record<string, string | undefined>): Promise<string> {
  signal.throwIfAborted()
  const command = workerCommand(argv, env?.PATH ?? process.env.PATH ?? '')
  // Electron's executable can serve as Node for the Windows adapter, only in that child process.
  const childEnv = command === argv ? env : { ...env, ELECTRON_RUN_AS_NODE: '1' }
  const handle = subprocess.spawn({ argv: command, cwd, graceMs: 2000, signal, ...childEnv ? { env: childEnv } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  signal.throwIfAborted()
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal, env?: Record<string, string | undefined>): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths. Git may normalize a Windows config path's separators.
  const helpers = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), env ?? workerEnvironment(stateDir)).catch(() => '')).split('\0')
  if (helpers.length !== 3 || !helpers[0]?.startsWith('file:') || !sameDirectory(helpers[0].slice(5), workerGitConfig(stateDir)) || helpers[1] !== credentialHelper(github.cli) || helpers[2] !== '') throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal, env?: Record<string, string | undefined>): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), env)
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}

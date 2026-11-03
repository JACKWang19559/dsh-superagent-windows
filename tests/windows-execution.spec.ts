import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { scrubbedParentEnv, type SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executable, resolveFeishuBot, workerProbe, type Probe } from '../src/deployment.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { credentialHelper, powerShellCommand, runAsWorker, shellEnvironmentPrefix, verifyDirectory, verifyEnvironment, workerBin,
  workerEnvironment, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'
import { defaultPrepare } from '../src/on-demand/host.ts'

const exec = promisify(execFile)
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const signal = () => new AbortController().signal
const children = new Set<ChildProcess>()
/** Matches the live spawn contract: scrubbed ambient base plus a case-insensitive overlay with undefined tombstones. */
function childEnvironment(overlay: NodeJS.ProcessEnv = {}, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...scrubbedParentEnv(), ...base }
  for (const [name, value] of Object.entries(overlay)) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key]
    if (value !== undefined) env[name] = value
  }
  return env
}
function nativeRuntime(calls: SubprocessSpawnSpec[] = [], ambient: NodeJS.ProcessEnv = {}): SubprocessRuntime {
  return { spawn(spec: SubprocessSpawnSpec) {
    calls.push(spec)
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: childEnvironment(spec.env, ambient), stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    const output = { stdout: '', stderr: '' }
    child.stdout!.setEncoding('utf8').on('data', chunk => { output.stdout += String(chunk) })
    child.stderr!.setEncoding('utf8').on('data', chunk => { output.stderr += String(chunk) })
    const stop = () => { child.kill() }
    spec.signal?.addEventListener('abort', stop, { once: true })
    if (spec.signal?.aborted) stop()
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, endedBy) => {
        children.delete(child); spec.signal?.removeEventListener('abort', stop)
        resolve({ exitCode, signal: endedBy })
      })
    })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: Buffer.byteLength(output[name]), lossy: false }) })
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  } } as unknown as SubprocessRuntime
}

it.each(['bash', 'pwsh'] as const)('rejects shell syntax in %s environment names and NUL values', shell => {
  expect(() => shellEnvironmentPrefix(shell, { 'BAD;echo injected': 'x' })).toThrow('Invalid environment variable name')
  expect(() => shellEnvironmentPrefix(shell, { VALID: 'a\0b' })).toThrow('contains NUL')
})

describe.skipIf(process.platform !== 'win32')('native Windows worker execution', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-windows-execution-')) })
  afterEach(async () => {
    await Promise.all([...children].map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill() })))
    const target = resolve(directory)
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target)).toMatch(/^superagent-windows-execution-/)
    rmSync(target, { recursive: true, force: true })
  })
  const deployment = (stateDir: string) => testDeployment({ stateDir, github: { cli: process.execPath, login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }, feishu: undefined })

  it('forwards native arguments exactly from a BOM-encoded PowerShell shim and restores the caller PATH', async () => {
    const state = join(directory, "state 工作区 'quoted'")
    await writeEnvironment(deployment(state), [])
    const bin = workerBin(state), other = join(directory, 'other tools')
    mkdirSync(other)
    const path = [bin, `"${bin.toUpperCase()}\\"`, other, process.env.PATH].join(';')
    const values = ['', 'two words', '中文路径', "single'quote", 'double"quote', 'C:\\tail\\', 'slash\\"quote', '& | < > ^ % !', '$(throw "injected")', 'line\nbreak']
    const code = 'console.log(JSON.stringify({args:process.argv.slice(1),path:process.env.PATH,cwd:process.cwd()}))'
    const command = `$forwarded = @(${['-e', code, '--', ...values].map(literal).join(', ')}); gh @forwarded; [Console]::WriteLine($env:PATH)`
    const output = await runAsWorker(nativeRuntime(), powerShellCommand(command), directory, signal(), { PATH: path })
    const [line, restored] = output.trimEnd().split(/\r?\n/)
    const forwarded = JSON.parse(line!)
    // Windows runners may give TEMP an 8.3 alias while the native process reports its long path.
    expect({ ...forwarded, cwd: realpathSync.native(forwarded.cwd) }).toEqual({
      args: values, path: [other, process.env.PATH].join(';'), cwd: realpathSync.native(directory),
    })
    expect(restored).toBe(path)
    expect(readFileSync(join(bin, 'gh.ps1'), 'utf8').charCodeAt(0)).toBe(0xfeff)
  }, 15_000)

  it('fails blocked and unavailable shims, preserves native exit codes, and replaces only owned scripts', async () => {
    const configured = deployment(directory)
    await writeEnvironment(configured, ['personal-gh', 'GH', 'GIT', 'LARK-CLI'])
    const env = workerEnvironment(directory)
    await expect(runAsWorker(nativeRuntime(), powerShellCommand('personal-gh'), directory, signal(), env))
      .rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('personal-gh is blocked') })
    await expect(runAsWorker(nativeRuntime(), powerShellCommand('lark-cli'), directory, signal(), env))
      .rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('no Feishu bot') })
    await expect(runAsWorker(nativeRuntime(), powerShellCommand(`gh -e ${literal('process.exit(7)')}`), directory, signal(), env))
      .rejects.toMatchObject({ exitCode: 7 })
    await writeEnvironment(configured, [])
    expect(readdirSync(workerBin(directory)).sort()).toEqual(['gh.ps1', 'lark-cli.ps1'])
    const foreign = join(workerBin(directory), 'personal.ps1')
    writeFileSync(foreign, 'Write-Output personal')
    await expect(writeEnvironment(configured, [])).rejects.toThrow('was not written by dsh-superagent')
    expect(readFileSync(foreign, 'utf8')).toBe('Write-Output personal')
  }, 20_000)

  it('runs startup probes without env.exe and applies deletion overlays without touching process.env', async () => {
    const before = { ...process.env }, calls: SubprocessSpawnSpec[] = []
    const bin = workerBin(directory)
    const probe = workerProbe(nativeRuntime(calls, { SA_REMOVE: 'ambient' }), directory, directory, signal(), {
      PATH: [bin, process.env.PATH, `${bin}/`].join(';'), SA_REMOVE: undefined, SA_VALUE: '初始',
    })
    const script = 'console.log(JSON.stringify({path:process.env.PATH,value:process.env.SA_VALUE,removed:process.env.SA_REMOVE}))'
    const result = JSON.parse(await probe([process.execPath, '-e', script], { SA_VALUE: 'per probe' }))
    expect(result).toEqual({ path: process.env.PATH, value: 'per probe' })
    expect(calls[0]!.argv[0]).toBe(process.execPath)
    expect(calls[0]!.env).toHaveProperty('SA_REMOVE', undefined)
    expect(process.env).toEqual(before)
  })

  it('sends Feishu notifier switches through the Probe env parameter', async () => {
    const calls: { argv: string[]; env: NodeJS.ProcessEnv | undefined }[] = []
    const probe: Probe = async (argv, env) => {
      calls.push({ argv, env })
      if (argv[1] === 'auth') return JSON.stringify({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } })
      if (argv[1] === 'config') return 'strict-mode: bot'
      return JSON.stringify({ bot: { open_id: 'ou_bot', app_name: 'Test bot' } })
    }
    await resolveFeishuBot(testMachine({ stateDir: directory }), { cli: process.execPath }, probe)
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.argv[0]).toBe(process.execPath)
      expect(call.env).toEqual({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
    }
  })

  it('sets quoted PowerShell environment values literally and removes inherited values', async () => {
    const marker = join(directory, 'must-not-exist')
    const value = `空 格 'single' "double"; $(New-Item -ItemType File -Path ${literal(marker)}); \`backtick\``
    const prefix = shellEnvironmentPrefix('pwsh', { SA_VALUE: value, SA_REMOVE: undefined, SA_EMPTY: '' })
    const command = `${prefix}@{ value = $env:SA_VALUE; removed = Test-Path Env:SA_REMOVE; empty = [string]$env:SA_EMPTY } | ConvertTo-Json -Compress`
    const output = await runAsWorker(nativeRuntime([], { SA_REMOVE: 'ambient' }), powerShellCommand(command), directory, signal())
    expect(JSON.parse(output)).toEqual({ value, removed: false, empty: '' })
    expect(existsSync(marker)).toBe(false)
  }, 10_000)

  it('retains literal POSIX prefix behavior in Git Bash without executing dollar substitutions', async () => {
    const git = executable('git', process.env.PATH ?? '')
    const bash = join(dirname(dirname(git)), 'bin', 'bash.exe')
    const marker = join(directory, 'must-not-exist').replaceAll('\\', '/')
    const value = `空 格 'single' "double"; $(touch '${marker}'); \`echo injected\``
    const prefix = shellEnvironmentPrefix('bash', { SA_VALUE: value, SA_REMOVE: undefined, SA_EMPTY: '' })
    const output = await runAsWorker(nativeRuntime([], { SA_REMOVE: 'ambient' }), [bash, '--noprofile', '--norc', '-c',
      `${prefix}printf '%s\\n' "$SA_VALUE" "\${SA_REMOVE-unset}" "$SA_EMPTY"`], directory, signal())
    expect(output.replaceAll('\r\n', '\n')).toBe(`${value}\nunset\n\n`)
    expect(existsSync(marker)).toBe(false)
  }, 10_000)

  it('quotes a Windows Git credential helper path through Git itself, without network access', async () => {
    const native = join(directory, "native 工具 'quoted'.exe")
    copyFileSync(process.execPath, native)
    // A local Node stand-in for gh auth git-credential; Git calls only get and performs no network access.
    writeFileSync(join(directory, 'auth'), `if (process.argv.slice(2).join(' ') !== 'git-credential get') process.exit(9);\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('username=agent-test\\npassword=local-test-value\\n\\n'));\n`)
    const configured = deployment(directory)
    configured.github.cli = native
    await writeEnvironment(configured, [])
    const env = workerEnvironment(directory), runtime = nativeRuntime()
    expect(credentialHelper(native)).toContain(native.replaceAll('\\', '/').split("'")[0])
    await expect(verifyEnvironment(configured, runtime, signal(), env)).resolves.toBeUndefined()
    const fill = exec(executable('git', process.env.PATH ?? ''), ['credential', 'fill'], { cwd: directory, env: childEnvironment(env), timeout: 10_000 })
    fill.child.stdin!.end('protocol=https\nhost=github.com\n\n')
    const { stdout } = await fill
    expect(stdout).toContain('username=agent-test')
    expect(stdout).toContain('password=local-test-value')
    await expect(verifyDirectory(directory, runtime, signal(), env)).resolves.toBeUndefined()
  }, 20_000)

  function prepare(stateDir: string, command: string, runtime: SubprocessRuntime, lifetime = signal()) {
    const target = join(stateDir, 'work', 'ticket 工作区')
    const host = { machine: { stateDir }, lifetime, context: { subprocess: runtime },
      effects: { handle: vi.fn() }, store: { settings: () => ({ executor: { prepare: command } }) },
      environment: () => [{ key: 'DSH_SUPERAGENT_DIR', value: target }, { key: 'DSH_SUPERAGENT_TICKET', value: 'ticket-1' }],
    } as unknown as ExecutorHost
    const executor = new DshExecutor(host) as unknown as { prepareDirectory(ticket: Ticket): Promise<void> }
    return { target, run: () => executor.prepareDirectory({ execution: { directory: target } } as Ticket) }
  }

  it('prepares a workspace with native PowerShell and passes isolated git, PATH and ticket variables to both checks', async () => {
    await writeEnvironment(deployment(directory), [])
    const calls: SubprocessSpawnSpec[] = [], before = { ...process.env }
    const command = `[IO.Directory]::CreateDirectory($env:DSH_SUPERAGENT_DIR) | Out-Null\n`
      + `$result = @{ ticket = $env:DSH_SUPERAGENT_TICKET; git = $env:GIT_CONFIG_GLOBAL; path = $env:PATH; hostGit = $env:GIT_DIR } | ConvertTo-Json -Compress\n`
      + `[IO.File]::WriteAllText((Join-Path $env:DSH_SUPERAGENT_DIR 'prepared.json'), $result)`
    const action = prepare(directory, command, nativeRuntime(calls, { GIT_DIR: 'host-repository' }))
    await action.run()
    const saved = JSON.parse(readFileSync(join(action.target, 'prepared.json'), 'utf8'))
    expect(saved).toMatchObject({ ticket: 'ticket-1', git: workerGitConfig(directory), hostGit: null })
    expect(saved.path.split(';')[0]).toBe(workerBin(directory))
    expect(basename(calls[0]!.argv[0]!).toLowerCase()).toBe('powershell.exe')
    expect(calls[1]!.argv[0]).toBe('git')
    expect(calls[1]!.env).toEqual(calls[0]!.env)
    expect(process.env).toEqual(before)
  }, 15_000)

  /** Actual worker gh.ps1 forwards to Node; this local `repo` program implements only `gh repo clone`. */
  async function branchPrepareFixture() {
    await writeEnvironment(deployment(directory), [])
    const git = executable('git', process.env.PATH ?? '')
    const gitEnvironment = childEnvironment(workerEnvironment(directory))
    const runGit = async (...args: string[]) => (await exec(git, args, { cwd: directory, env: gitEnvironment, timeout: 15_000 })).stdout.trim()
    const origin = join(directory, "local 仓库 'origin'"), target = join(directory, "ticket 工作区 'target'"), recorded = join(directory, 'clone-arguments.json')
    const selected = 'codex/video-editing', quoted = "codex/'$literal", workname = 'video-editing'
    await runGit('init', '--quiet', '--initial-branch=main', origin)
    const commit = async (text: string) => {
      writeFileSync(join(origin, 'base.txt'), text)
      await runGit('-C', origin, 'add', 'base.txt')
      await runGit('-C', origin, '-c', 'user.name=Branch Test', '-c', 'user.email=branch-test@example.invalid', 'commit', '--quiet', '-m', text)
      return runGit('-C', origin, 'rev-parse', 'HEAD')
    }
    const defaultHead = await commit('default branch content')
    await runGit('-C', origin, 'checkout', '--quiet', '-b', selected)
    const selectedHead = await commit('selected branch content')
    await runGit('-C', origin, 'branch', quoted)
    await runGit('-C', origin, 'checkout', '--quiet', 'main')
    mkdirSync(target)
    writeFileSync(join(directory, 'repo'), `
      const { writeFileSync } = require('node:fs');
      const { spawnSync } = require('node:child_process');
      const args = process.argv.slice(2);
      writeFileSync(process.env.SA_CLONE_ARGUMENTS, JSON.stringify(args));
      if (args[0] !== 'clone' || args[1] !== process.env.DSH_SUPERAGENT_GITHUB_REPOSITORY || (args.length !== 3 && args[3] !== '--')) {
        console.error('Unexpected gh repo clone arguments: ' + JSON.stringify(args)); process.exit(91);
      }
      const result = spawnSync(process.env.SA_GIT, ['clone', ...args.slice(4), '--', process.env.SA_LOCAL_REPOSITORY, args[2]], { stdio: 'inherit', timeout: 15000 });
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    `)
    const env = { ...workerEnvironment(directory), DSH_SUPERAGENT_GITHUB_REPOSITORY: '5th-Axiom/VideoInWay', DSH_SUPERAGENT_DIR: target,
      DSH_SUPERAGENT_NAME: workname, SA_GIT: git, SA_LOCAL_REPOSITORY: origin, SA_CLONE_ARGUMENTS: recorded }
    const prepare = (branch: string) => runAsWorker(nativeRuntime(), powerShellCommand(defaultPrepare('win32')), directory,
      AbortSignal.timeout(25_000), { ...env, DSH_SUPERAGENT_GITHUB_BASE_BRANCH: branch })
    return { prepare, runGit, origin, target, recorded, workname, selected, quoted, defaultHead, selectedHead }
  }

  it.each(['selected', 'default', 'quoted'] as const)('default prepare creates a work branch from the %s branch commit', async mode => {
    const fixture = await branchPrepareFixture()
    const branch = mode === 'selected' ? fixture.selected : mode === 'quoted' ? fixture.quoted : ''
    expect(fixture.selectedHead).not.toBe(fixture.defaultHead)
    await fixture.prepare(branch)
    expect(await fixture.runGit('-C', fixture.target, 'rev-parse', 'HEAD')).toBe(branch ? fixture.selectedHead : fixture.defaultHead)
    expect(await fixture.runGit('-C', fixture.target, 'symbolic-ref', '--short', 'HEAD')).toBe(`agent/${fixture.workname}`)
    expect(readFileSync(join(fixture.target, 'base.txt'), 'utf8')).toBe(branch ? 'selected branch content' : 'default branch content')
    expect(JSON.parse(readFileSync(fixture.recorded, 'utf8'))).toEqual([
      'clone', '5th-Axiom/VideoInWay', fixture.target, ...branch ? ['--', '--branch', branch] : [],
    ])
    // Preparing a clone never advances the original repository or leaves it on a work branch.
    expect(await fixture.runGit('-C', fixture.origin, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(await fixture.runGit('-C', fixture.origin, 'rev-parse', 'HEAD')).toBe(fixture.defaultHead)
  }, 35_000)

  it('default prepare fails for a missing branch without creating a work branch or falling back', async () => {
    const fixture = await branchPrepareFixture()
    await expect(fixture.prepare('missing/branch')).rejects.toMatchObject({ exitCode: 128, message: expect.stringContaining('missing/branch') })
    expect(JSON.parse(readFileSync(fixture.recorded, 'utf8'))).toEqual([
      'clone', '5th-Axiom/VideoInWay', fixture.target, '--', '--branch', 'missing/branch',
    ])
    expect(existsSync(join(fixture.target, '.git'))).toBe(false)
    expect(await fixture.runGit('-C', fixture.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/agent/')).toBe('')
    expect(await fixture.runGit('-C', fixture.origin, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  }, 35_000)

  it('reports prepare failures and removes only the empty ticket directory they left', async () => {
    const command = `[IO.Directory]::CreateDirectory($env:DSH_SUPERAGENT_DIR) | Out-Null\n[Console]::Error.WriteLine('prepare denied'); exit 9`
    const action = prepare(directory, command, nativeRuntime())
    await expect(action.run()).rejects.toThrow('The prepare command failed: prepare denied')
    expect(existsSync(action.target)).toBe(false)
  }, 10_000)

  it('reports PowerShell errors and stops an actual sleeping shell on timeout', async () => {
    await expect(runAsWorker(nativeRuntime(), powerShellCommand("throw 'native shell failure'"), directory, signal()))
      .rejects.toMatchObject({ exitCode: 1, message: 'native shell failure' })
    const timeout = AbortSignal.timeout(250), started = Date.now()
    const failure = await runAsWorker(nativeRuntime(), powerShellCommand('Start-Sleep -Seconds 30'), directory, timeout).catch(error => error)
    expect(timeout.aborted).toBe(true)
    expect(failure).toBeInstanceOf(CliError)
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10_000)
})

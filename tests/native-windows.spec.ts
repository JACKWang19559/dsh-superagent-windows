/** Real Windows processes only: no account CLI or external service is contacted. */
import { execFile, spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrubbedParentEnv, type SubprocessRuntime, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { executable, workerProbe } from '../src/deployment.ts'
import { DshExecutor, type ExecutorHost } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { CliError } from '../src/infra/commands.ts'
import { credentialHelper, runAsWorker, sameDirectory, verifyDirectory, verifyEnvironment, workerBin, workerEnvironment, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { WINDOWS, WindowsBatchArgumentError, powershell, powershellCommand, prepareCommand, windowsLauncherSource, windowsPayload, workerCommand } from '../src/infra/platform.ts'
import { ExecutionSubprocess, provideExecutionEnvironment } from '../src/execution-subprocess.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const signal = (): AbortSignal => AbortSignal.timeout(20_000)
/** Apply tombstones case-insensitively, as the Windows subprocess provider does. */
const childEnv = (extra: Record<string, string | undefined> = {}): Record<string, string> => {
  const env = scrubbedParentEnv()
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key]
    if (value !== undefined) env[name] = value
  }
  return env
}
/** A real child_process provider with the same scrubbed-parent/explicit-override contract as DSH. */
const nativeSubprocess = (requests: SubprocessSpawnSpec[] = []): SubprocessRuntime => ({
  spawn: (spec: SubprocessSpawnSpec) => {
    requests.push(spec)
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: childEnv(spec.env), signal: spec.signal, windowsHide: true })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const done = new Promise((resolve, reject) => {
      child.on('error', error => { if (error.name !== 'AbortError') reject(error) })
      child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime

// PowerShell startup and Git subprocesses need more than Vitest's default on Windows.
vi.setConfig({ testTimeout: 30_000 })
let dir: string
let runtime: SubprocessRuntime
const args = ['api', '--title', '中文 空格', 'a"quote"b', '&|<>^%PATH%!x;()', '$(literal)', 'trailing\\', '',
  'a\\"b', 'a\\\\"b', 'space end\\', 'a"b&echo DSH_SENTINEL', 'a"b|echo DSH_SENTINEL', '%SUPERAGENT_TEST_LITERAL%', '!SUPERAGENT_TEST_LITERAL!',
  '%SUPERAGENT_TEST_LITERAL:EXP=REP%', '%SUPERAGENT_TEST_LITERAL:E=Q%', '%SUPERAGENT_TEST_LITERAL:~0,3%']
const recordProgram = 'if(process.argv[2]==="fail"){console.error("stub failed");process.exit(23)};console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH,config:process.env.GH_CONFIG_DIR,git:process.env.GIT_CONFIG_GLOBAL,token:process.env.GH_TOKEN,secret:process.env.DSH_TEST_SECRET,notice:process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER}))'
/** ASCII batch source uses %~dp0 so Unicode directory names need no codepage assumptions. */
const batch = (name: string, source = recordProgram): string => {
  const js = `${name}.cjs`, file = join(dir, `${name}.cmd`)
  writeFileSync(join(dir, js), source)
  writeFileSync(file, `@"${process.execPath}" "%~dp0${js}" %*\r\n@exit /b %errorlevel%\r\n`)
  return file
}
const npmBatch = (name: string, source = recordProgram): string => {
  const file = batch(name, source)
  writeFileSync(file, ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${name}.cjs" %*`, '',
  ].join('\r\n'))
  return file
}
const psScript = (name: string, source: string): string => {
  const file = join(dir, `${name}.ps1`)
  writeFileSync(file, `﻿${source}\n`)
  return file
}
const deployment = (cli: string) => testDeployment({ stateDir: join(dir, '状态 空格'), github: { ...testDeployment().github, cli }, feishu: undefined })
const run = (argv: string[], env?: Record<string, string | undefined>): Promise<string> => runAsWorker(runtime, argv, dir, signal(), env)

/** Only used to reach prepareDirectory; command execution and git checks use real Windows children. */
const prepare = (command: string, stateDir: string, directory: string, requests: SubprocessSpawnSpec[] = []): Promise<void> => {
  const host = {
    context: { subprocess: nativeSubprocess(requests) }, machine: { stateDir }, lifetime: new AbortController().signal,
    effects: { handle: vi.fn() }, store: { settings: () => SettingsSchema.parse({ executor: { prepare: command } }) },
    environment: () => [{ key: 'DSH_SUPERAGENT_DIR', value: directory }],
  } as unknown as ExecutorHost
  const executor = new DshExecutor(host) as unknown as { prepareDirectory(ticket: Ticket): Promise<void> }
  return executor.prepareDirectory({ execution: { directory } } as Ticket)
}

describe.skipIf(!WINDOWS)('native Windows platform', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh 中文 空格 (1)-')); runtime = nativeSubprocess(); vi.stubEnv('SUPERAGENT_TEST_LITERAL', 'EXPANDED') })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('resolves PATHEXT, quoted PATH entries, backslash paths, and real CLIs outside shim aliases', async () => {
    const cli = batch('agent gh')
    const current = deployment(cli)
    await writeEnvironment(current, [])
    symlinkSync(current.stateDir, join(dir, 'state alias'), 'junction')
    const path = [workerBin(current.stateDir).toUpperCase(), join(dir, 'state alias', 'worker-bin'), `"${dir}"`].join(delimiter)
    expect(executable('agent gh', path, workerBin(current.stateDir))).toBe(cli)
    expect(executable(cli, path)).toBe(cli)
    for (const relative of ['C:relative', '\\relative', 'bin\\gh', 'bin/gh']) expect(() => executable(relative, path)).toThrow('command name or an absolute path')
  })

  it('dispatches complete Node/npm batch templates and PowerShell with literal arguments and exit codes', async () => {
    for (const make of [batch, npmBatch]) {
      const cli = make(`agent=${make.name}`)
      const long = [...args, '&|<>^%SUPERAGENT_TEST_LITERAL:E=Q%'.repeat(400)]
      const planned = workerCommand([cli, ...long])
      expect(sameDirectory(planned[0]!, process.execPath)).toBe(true)
      expect(planned.slice(1)).toEqual([cli.replace(/\.cmd$/, '.cjs'), ...long])
      expect(JSON.parse(await run([cli, ...long])).args).toEqual(long)
      const payload = windowsPayload([cli], powershell())
      const forwarded = await exec(process.execPath, ['-e', windowsLauncherSource(), payload, ...args])
      expect(JSON.parse(forwarded.stdout).args).toEqual(args)
      const broken = make(`broken ${make.name}`, "console.error('stub failed'); process.exit(23)")
      await expect(run([broken, 'literal & exit 0'])).rejects.toMatchObject({ message: 'stub failed', exitCode: 23 })
      for (const argument of ['line\nbreak', 'carriage\rreturn', 'null\0byte']) {
        await expect(run([cli, argument])).rejects.toMatchObject({ name: 'WindowsBatchArgumentError', code: 'WINDOWS_BATCH_ARGUMENT',
          message: expect.stringContaining('Batch arguments cannot contain NUL or line breaks') })
      }
    }
    const ps = psScript('agent ps', '[Console]::WriteLine((ConvertTo-Json -InputObject @($args) -Compress)); exit 0')
    expect(JSON.parse(await run([ps, ...args]))).toEqual(args)
    const failedPs = psScript('broken ps', "[Console]::Error.WriteLine('ps failed'); exit 17")
    await expect(run([failedPs])).rejects.toMatchObject({ message: 'ps failed', exitCode: 17 })
    const nativeFailure = psScript('native failure', `& ${quote(process.execPath)} -e 'process.exit(31)'`)
    await expect(run([nativeFailure])).rejects.toMatchObject({ exitCode: 31 })
  })

  it('gives ordinary conditional batch scripts cmd parameters without CRT backslash doubling', async () => {
    const cli = join(dir, 'conditional.cmd')
    writeFileSync(cli, '@echo off\r\nif "%~1"=="api" (echo MATCHED) else (echo MISMATCHED)\r\nexit /b 0\r\n')
    expect((await run([cli, 'api', 'user'])).trim()).toBe('MATCHED')
    const data = join(dir, 'data-contract.bat')
    writeFileSync(data, ['@echo off', 'if not "%~1"=="api" exit /b 41', 'if not "%~2"=="%SUPERAGENT_TEST_LITERAL%" exit /b 42',
      'if not "%~3"=="trailing\\" exit /b 43', 'if not "%~4"=="space end\\" exit /b 44', 'if not "%~5"=="" exit /b 45',
      'echo DATA_MATCHED', 'exit /b 37', '',
    ].join('\r\n'))
    vi.stubEnv('SUPERAGENT_TEST_LITERAL', '中文 空格')
    const command = workerCommand([data, 'api', '中文 空格', 'trailing\\', 'space end\\', ''])
    await expect(exec(command[0]!, command.slice(1), { env: childEnv({ ELECTRON_RUN_AS_NODE: '1' }) })).rejects.toMatchObject({ code: 37, stdout: 'DATA_MATCHED\r\n' })

    const requests: SubprocessSpawnSpec[] = []
    runtime = nativeSubprocess(requests)
    const unsafe = 'private-argv-a"b&echo DSH_SENTINEL'
    const error = await run([cli, unsafe]).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(WindowsBatchArgumentError)
    expect(error).toMatchObject({ name: 'WindowsBatchArgumentError', code: 'WINDOWS_BATCH_ARGUMENT', message: expect.stringContaining('.exe or .ps1 adapter') })
    expect((error as Error).message).not.toContain(unsafe)
    expect((error as Error).message).not.toContain(cli)
    expect(requests).toHaveLength(0)
    // Shims cache a profile before their dynamic arguments exist; the serialized launcher must recheck them.
    const payload = windowsPayload([cli], powershell())
    const rejected = await exec(process.execPath, ['-e', windowsLauncherSource(), payload, unsafe]).catch(error => error)
    expect(rejected).toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Batch script arguments cannot contain quotes or shell metacharacters') })
    expect(rejected.stderr).not.toContain(unsafe)
    for (const argument of ['%SUPERAGENT_TEST_LITERAL:E=Q%', 'x'.repeat(9000)]) expect(() => workerCommand([cli, argument])).toThrow(WindowsBatchArgumentError)
    for (const name of ['equals=semi;comma,', 'amp & space', 'literal %SUPERAGENT_TEST_LITERAL%']) {
      const folder = join(dir, name); mkdirSync(folder)
      const script = join(folder, 'conditional.cmd')
      writeFileSync(script, '@echo off\r\nif "%~1"=="api" (echo MATCHED) else (echo MISMATCHED)\r\nexit /b 37\r\n')
      const command = workerCommand([script, 'api', 'user'])
      await expect(exec(command[0]!, command.slice(1))).rejects.toMatchObject({ code: 37, stdout: 'MATCHED\r\n' })
    }
  })

  it('rejects CALL, delayed expansion, and lookalike or complex batch templates at every payload entry', async () => {
    const cli = batch('unsupported')
    const original = readFileSync(cli, 'utf8')
    const npm = readFileSync(npmBatch('npm-lookalike'), 'utf8')
    for (const source of [
      original.replace('@"', '@call "'),
      `@echo off\r\nsetlocal EnableDelayedExpansion\r\n${original}`,
      `@rem # Written by dsh-superagent on every start; edits are lost.\r\n${original}`,
      npm.replace('CALL :find_dp0', 'CALL %*'),
      npm.replace('SET "_prog=node"', 'SET "_prog=unknown"'),
      '@echo off\r\nfor /f %%i in ("unrecognised") do echo %%i\r\nexit /b 0\r\n',
    ]) {
      writeFileSync(cli, source)
      for (const invoke of [() => windowsPayload([cli, 'api', 'user'], powershell()), () => workerCommand([cli, 'api', 'user']), () => credentialHelper(cli)]) {
        expect(invoke).toThrow(WindowsBatchArgumentError)
        expect(invoke).toThrow('Unsupported batch launcher template; use an .exe or .ps1 adapter')
      }
      await expect(writeEnvironment(deployment(cli), [])).rejects.toMatchObject({ name: 'WindowsBatchArgumentError', code: 'WINDOWS_BATCH_ARGUMENT' })
    }
  })

  it('lets PowerShell call account shims and blocked commands from a Unicode state path', async () => {
    const current = deployment(batch('agent gh'))
    await writeEnvironment(current, ['personal-gh', 'GH.CMD', 'GIT.EXE', 'LARK-CLI.ps1'])
    const env = workerEnvironment(current.stateDir)
    const output = await run(prepareCommand(`gh ${args.map(quote).join(' ')}`), env)
    expect(JSON.parse(output).args).toEqual(args)
    expect(JSON.parse(await run([join(workerBin(current.stateDir), 'gh.cmd'), ...args], env)).args).toEqual(args)
    const parsed = await run(prepareCommand("gh api user | ConvertFrom-Json | ForEach-Object { [Console]::WriteLine(($_.args -join ',')) }"), env)
    expect(parsed.trim()).toBe('api,user')
    const nodeMode = await run(prepareCommand("$env:ELECTRON_RUN_AS_NODE = 'caller-value'; gh api user | Out-Null; [Console]::WriteLine($env:ELECTRON_RUN_AS_NODE)"), env)
    expect(nodeMode.trim()).toBe('caller-value')
    expect((await run(prepareCommand("Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; gh api user | Out-Null; [Console]::WriteLine((Test-Path Env:ELECTRON_RUN_AS_NODE))"), env)).trim()).toBe('False')
    await expect(run(prepareCommand("gh fail 'literal & exit 0'"), env)).rejects.toMatchObject({ exitCode: 23, message: 'stub failed' })
    const files = readdirSync(workerBin(current.stateDir))
    expect(files).toEqual(expect.arrayContaining(['gh.ps1', 'gh.cmd', 'personal-gh.ps1', 'personal-gh.cmd']))
    expect(files.some(name => /^git(?:\.|$)/i.test(name))).toBe(false)
    await expect(run(prepareCommand('personal-gh'), env)).rejects.toMatchObject({ message: expect.stringContaining('acts as agent-bot'), exitCode: 1 })
    await expect(run(prepareCommand('lark-cli auth status'), env)).rejects.toMatchObject({ message: expect.stringContaining('no Feishu bot'), exitCode: 1 })
  })

  it('fails a shim with a missing native host and restores the caller Node mode', async () => {
    const current = deployment(batch('missing host account'))
    await writeEnvironment(current, [])
    const shim = join(workerBin(current.stateDir), 'gh.ps1')
    const missing = join(dir, 'missing-node-host.exe')
    writeFileSync(shim, readFileSync(shim, 'utf8').replace(`& ${quote(process.execPath)}`, `& ${quote(missing)}`))
    const command = prepareCommand("$env:ELECTRON_RUN_AS_NODE='caller-value'; gh api user; [Console]::WriteLine($env:ELECTRON_RUN_AS_NODE)")
    await expect(exec(command[0]!, command.slice(1), { env: childEnv(workerEnvironment(current.stateDir)) })).rejects.toMatchObject({
      code: 1, stdout: 'caller-value\r\n', stderr: expect.stringContaining('missing-node-host.exe'),
    })
  })

  it('uses RemoteSigned only in managed Windows children and respects explicit PowerShell policy argv', async () => {
    const current = deployment(batch('managed account'))
    await writeEnvironment(current, [])
    vi.stubEnv('PSExecutionPolicyPreference', 'Restricted')
    const before = { ...process.env }
    const direct = (script: string, policy: string[] = []): string[] => [powershell(), '-NoLogo', '-NoProfile', '-NonInteractive', ...policy,
      '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${script}`, 'utf16le').toString('base64')]
    expect((await run(direct('Get-ExecutionPolicy -Scope Process'))).trim()).toBe('Restricted')
    const root = new Context()
    root.provide('subprocess', runtime)
    provideExecutionEnvironment(root, current.stateDir)
    runtime = new ExecutionSubprocess(root.isolate('subprocess'), root.get('superagentExecution')!)
    const aliases = { PSExecutionPolicyPreference: 'AllSigned', psexecutionpolicypreference: 'Restricted',
      PATH: 'first-untrusted-path', path: 'last-untrusted-path', GH_TOKEN: 'operator', gh_token: 'operator-alias' }
    const output = await run(direct(`$ErrorActionPreference='Stop'; Get-ExecutionPolicy -Scope Process; gh ${args.map(quote).join(' ')}; exit $LASTEXITCODE`), aliases)
    const [policy, ...json] = output.trim().split(/\r?\n/)
    expect(policy).toBe('RemoteSigned')
    const result = JSON.parse(json.join('\n'))
    expect(result.args).toEqual(args)
    expect(result.token).toBeUndefined()
    expect((await run(direct('Get-ExecutionPolicy -Scope Process', ['-ExecutionPolicy', 'Restricted']), aliases)).trim()).toBe('Restricted')
    expect(process.env).toEqual(before)
  })

  it.skipIf(!process.env.DSH_TEST_ELECTRON)('waits for an actual Electron GUI host and preserves shim pipelines, exit status, and Node mode', async () => {
    const current = deployment(batch('desktop account'))
    const module = pathToFileURL(join(import.meta.dirname, '../src/infra/environment.ts')).href
    await exec(process.env.DSH_TEST_ELECTRON!, ['--experimental-transform-types', '--input-type=module', '-e',
      `import { writeEnvironment } from ${JSON.stringify(module)}; await writeEnvironment({ stateDir:process.argv[1], repository:'probe/no-network', github:{cli:process.argv[2],login:'agent-bot'} }, ['personal-gh']);`,
      current.stateDir, current.github.cli,
    ], { env: childEnv({ ELECTRON_RUN_AS_NODE: '1' }), timeout: 20_000 })
    const env = workerEnvironment(current.stateDir)
    expect(JSON.parse(await run(prepareCommand(`gh ${args.map(quote).join(' ')}`), env)).args).toEqual(args)
    expect((await run(prepareCommand("gh api user | ConvertFrom-Json | ForEach-Object { [Console]::WriteLine(($_.args -join ',')) }"), env)).trim()).toBe('api,user')
    await expect(run(prepareCommand("gh fail 'literal & exit 0'; exit $LASTEXITCODE"), env)).rejects.toMatchObject({ exitCode: 23, message: 'stub failed' })
    expect((await run(prepareCommand("$env:ELECTRON_RUN_AS_NODE='caller-value'; gh api user | Out-Null; [Console]::WriteLine($env:ELECTRON_RUN_AS_NODE)"), env)).trim()).toBe('caller-value')
    expect((await run(prepareCommand("Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; gh api user | Out-Null; [Console]::WriteLine((Test-Path Env:ELECTRON_RUN_AS_NODE))"), env)).trim()).toBe('False')
    await expect(run(prepareCommand('personal-gh'), env)).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('acts as agent-bot') })
  })

  it('removes shim aliases and duplicate PATH entries before an account wrapper resolves gh again', async () => {
    const real = join(dir, 'real cli'); mkdirSync(real)
    const stub = batch('gh')
    // Keep the stub's .cjs beside it when moving it into the real PATH directory.
    writeFileSync(join(real, 'gh.cmd'), readFileSync(stub)); writeFileSync(join(real, 'gh.cjs'), readFileSync(join(dir, 'gh.cjs')))
    const wrapper = psScript('gh agent wrapper', `$env:GH_CONFIG_DIR = ${quote(join(dir, 'agent config'))}\n& gh @args\nexit $LASTEXITCODE`)
    const current = deployment(wrapper)
    await writeEnvironment(current, [])
    const bin = workerBin(current.stateDir)
    symlinkSync(current.stateDir, join(dir, 'alias'), 'junction')
    const venv = join(dir, 'venv'); mkdirSync(venv)
    const env = workerEnvironment(current.stateDir, [bin, join(dir, 'alias', 'worker-bin'), bin.toUpperCase(), venv, real, real, process.env.PATH].join(delimiter))
    const output = JSON.parse(await run(prepareCommand("gh api user"), env))
    expect(output.args).toEqual(['api', 'user'])
    expect(output.config).toBe(join(dir, 'agent config'))
    const entries = output.path.split(delimiter) as string[]
    expect(entries.some(entry => sameDirectory(entry, bin))).toBe(false)
    expect(entries.filter(entry => sameDirectory(entry, real))).toHaveLength(1)
    expect(entries).toContain(venv)
  })

  it('probes real account CLIs with explicit env, strips credentials, and leaves ordinary children unchanged', async () => {
    const cli = batch('account probe'), current = deployment(cli)
    await writeEnvironment(current, [])
    vi.stubEnv('PATH', [workerBin(current.stateDir), dir, process.env.PATH].join(delimiter))
    vi.stubEnv('GH_TOKEN', 'operator-token'); vi.stubEnv('DSH_TEST_SECRET', 'operator-secret')
    vi.stubEnv('GIT_AUTHOR_NAME', 'Operator'); vi.stubEnv('GIT_DIR', join(dir, 'unrelated.git'))
    const before = { ...process.env }
    const probe = workerProbe(runtime, current.stateDir, dir, signal())
    const output = JSON.parse(await probe([cli, 'api', 'user'], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' }))
    expect(output).toMatchObject({ args: ['api', 'user'], git: workerGitConfig(current.stateDir), notice: '1' })
    expect(output.token).toBeUndefined(); expect(output.secret).toBeUndefined()
    expect(output.path.split(delimiter).some((entry: string) => sameDirectory(entry, workerBin(current.stateDir)))).toBe(false)
    expect(process.env).toEqual(before)
    const ordinary = JSON.parse((await exec(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'])).stdout)
    expect(ordinary.GH_TOKEN).toBe('operator-token')
    expect(ordinary.DSH_TEST_SECRET).toBe('operator-secret')
    expect(ordinary.GIT_AUTHOR_NAME).toBe('Operator')
  })

  it('uses the agent credential helper in real Git for Windows without a network request', async () => {
    const cli = batch('agent credentials', "if(process.argv.slice(2).join(' ')!=='auth git-credential get')process.exit(19); console.log('username=agent-bot\\npassword=agent-only\\n')")
    const current = deployment(cli)
    await writeEnvironment(current, [])
    const env = workerEnvironment(current.stateDir)
    await verifyEnvironment(current, runtime, signal(), env)
    await run(['git', 'init', '-q', 'repo'], env)
    await expect(verifyDirectory(join(dir, 'repo'), runtime, signal(), env)).resolves.toBeUndefined()
    const fill = exec('git', ['credential', 'fill'], { cwd: join(dir, 'repo'), env: childEnv(env), timeout: 15_000 })
    fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
    const { stdout } = await fill
    expect(stdout).toContain('username=agent-bot\npassword=agent-only')
    await run(['git', '-C', 'repo', 'config', 'credential.helper', 'operator-helper'], env)
    await expect(verifyDirectory(join(dir, 'repo'), runtime, signal(), env)).rejects.toThrow('sets credential.helper')
  })

  it('prepares a real git directory with worker env and verifies it with the same env', async () => {
    const current = deployment(batch('agent prepare')), directory = join(dir, 'work 空格', 'ticket')
    await writeEnvironment(current, [])
    const requests: SubprocessSpawnSpec[] = []
    await prepare('New-Item -ItemType Directory -Path $env:DSH_SUPERAGENT_DIR | Out-Null; git -C $env:DSH_SUPERAGENT_DIR init -q', current.stateDir, directory, requests)
    expect(existsSync(join(directory, '.git'))).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[0]!.argv[0]).toMatch(/(?:pwsh|powershell)\.exe$/i)
    expect(requests[0]!.env).toMatchObject({ ...workerEnvironment(current.stateDir), DSH_SUPERAGENT_DIR: directory })
    expect(requests[1]!.env).toEqual(requests[0]!.env)
  })

  it('propagates prepare native failures and timeout cancellation instead of treating them as success', async () => {
    const nativeFail = `& ${quote(process.execPath)} -e 'process.exit(29)'`
    const failure = await run(prepareCommand(nativeFail)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CliError)
    expect(failure).toMatchObject({ exitCode: 29 })
    await expect(run(prepareCommand("throw 'prepare exception'"))).rejects.toThrow('prepare exception')
    const current = deployment(batch('agent timeout')), directory = join(dir, 'timeout ticket')
    await writeEnvironment(current, [])
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => originalTimeout(ms === 10 * 60_000 ? 1200 : ms))
    await expect(prepare('New-Item -ItemType Directory -Path $env:DSH_SUPERAGENT_DIR | Out-Null; Start-Sleep -Seconds 30', current.stateDir, directory)).rejects.toThrow('The prepare command failed:')
    expect(existsSync(directory)).toBe(false)
  })

  it('finds installed Windows PowerShell when pwsh is absent from PATH', async () => {
    const shell = powershell('')
    expect(shell.toLowerCase()).toContain('windowspowershell')
    expect((await run(powershellCommand(shell, "[Console]::WriteLine('native-ok')"))).trim()).toBe('native-ok')
  })
})

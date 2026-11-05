/** Host account calls must use the same Windows transport as startup checks, without real accounts or network access. */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { resolveDeployment, workerProbe } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { execCommand, streamCommand } from '../src/infra/command-process.ts'
import { WINDOWS } from '../src/infra/platform.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'host CLI 中文 空格-')) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
const lifetime = (): AbortSignal => AbortSignal.timeout(20_000)
const batch = (name: string, code: string): string => {
  const file = join(dir, `${name}.cmd`)
  writeFileSync(join(dir, `${name}.cjs`), code)
  writeFileSync(file, `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n@exit /b %errorlevel%\r\n`)
  return file
}
const ps = (name: string, code: string): string => {
  const file = join(dir, `${name}.ps1`)
  writeFileSync(file, `﻿${code}\n`)
  return file
}
const args = ['api', 'user', '中文 空格', 'a"quote"b', '&|<>^%PATH%!x;()', '$(literal)', 'trailing\\', '']
const record = `const a=process.argv.slice(2); const data={login:'agent-bot',id:7,name:'sample/repo',push:true,args:a,cwd:process.cwd(),config:process.env.GH_CONFIG_DIR,notice:process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER}; console.log(JSON.stringify(a.includes('--as')?{ok:true,data}:data))`
const psRecord = `$data=@{login='agent-bot'; id=7; name='sample/repo'; push=$true; args=@($args); cwd=(Get-Location).Path; config=$env:GH_CONFIG_DIR; notice=$env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER}; if ($args -contains '--as') { $data=@{ok=$true;data=$data} }; [Console]::WriteLine((ConvertTo-Json -InputObject $data -Depth 5 -Compress)); exit 0`
const account = (extension: string): string => extension === 'cmd' ? batch('account', record) : ps('account', psRecord)
const commands = (cli: string, extra: Record<string, string | undefined> = {}, signal = lifetime()): Commands => {
  const base = testDeployment()
  return new Commands(() => testDeployment({ stateDir: dir, github: { ...base.github, cli }, feishu: { ...base.feishu!, cli } }), extra, signal)
}
/** Small real-process provider for exercising resolveDeployment/workerProbe, not a mock of its account checks. */
const subprocess = (): SubprocessRuntime => ({ spawn: (spec: SubprocessSpawnSpec) => {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...spec.env }).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, windowsHide: true })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk) }); child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk) })
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => { resolve({ exitCode }) }) })
  const reader = (chunks: Buffer[]) => ({ readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8') }) })
  return { done, collected: { stdout: reader(stdout), stderr: reader(stderr) } }
} }) as unknown as SubprocessRuntime

it('merges explicit overrides and tombstones without mutating the host environment', async () => {
  vi.stubEnv('DSH_ENV_PROBE', 'operator-only'); vi.stubEnv('GH_TOKEN', 'synthetic-operator-token')
  const key = WINDOWS ? 'dsh_env_probe' : 'DSH_ENV_PROBE'
  const value = commands(process.execPath, { [key]: undefined, [WINDOWS ? 'gh_token' : 'GH_TOKEN']: undefined, DSH_EMPTY_PROBE: '',
    [WINDOWS ? 'Path' : 'PATH']: dir, gh_prompt_disabled: '0', larksuite_cli_no_update_notifier: '0' })
  const output = JSON.parse(await value.run(process.execPath, ['-e', `console.log(JSON.stringify({probe:process.env.DSH_ENV_PROBE,token:process.env.GH_TOKEN,path:process.env.PATH,empty:process.env.DSH_EMPTY_PROBE,gh:process.env.GH_PROMPT_DISABLED,notice:process.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER}))`]))
  expect(output).toEqual({ path: dir, empty: '', gh: '1', notice: '1' })
  expect(process.env.DSH_ENV_PROBE).toBe('operator-only'); expect(process.env.GH_TOKEN).toBe('synthetic-operator-token')
})

describe('real streaming command lifecycle on every host', () => {
  const script = (code: string): string => {
    const file = join(dir, 'stream.cjs')
    writeFileSync(file, code)
    return file
  }
  it('streams beyond the buffered-command limit with literal argv, cwd and final environment', async () => {
    const flag = process.env.ELECTRON_RUN_AS_NODE
    const file = script(`console.error(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),probe:process.env.DSH_STREAM_PROBE,empty:process.env.DSH_STREAM_EMPTY,flag:process.env.ELECTRON_RUN_AS_NODE}));process.stdout.write('x'.repeat(17*1024*1024))`)
    vi.stubEnv('DSH_STREAM_PROBE', 'parent-only')
    const child = streamCommand([process.execPath, file, ...args], { signal: lifetime(), cwd: dir,
      environment: [{ [WINDOWS ? 'dsh_stream_probe' : 'DSH_STREAM_PROBE']: undefined, DSH_STREAM_EMPTY: '' }] })
    let bytes = 0, diagnostic = ''
    child.stdout.on('data', (data: Buffer) => { bytes += data.length })
    child.stderr.setEncoding('utf8').on('data', (data: string) => { diagnostic += data })
    expect(await child.done).toEqual({ code: 0, signal: null })
    expect(bytes).toBe(17 * 1024 * 1024)
    expect(JSON.parse(diagnostic)).toEqual({ args, cwd: dir, empty: '', ...flag === undefined ? {} : { flag } })
    expect(process.env.DSH_STREAM_PROBE).toBe('parent-only')
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(flag)
  })

  it('keeps a stream running beyond 90 seconds and kills its real Node PID on abort', async () => {
    const marker = join(dir, 'stream.pid'), controller = new AbortController()
    const child = streamCommand([process.execPath, script(`require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)`), marker], { signal: controller.signal })
    child.stdout.resume(); child.stderr.resume()
    let settled = false
    const outcome = child.done.catch((error: unknown) => error).finally(() => { settled = true })
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await vi.advanceTimersByTimeAsync(90_001)
      expect(settled).toBe(false)
    } finally { vi.useRealTimers(); controller.abort() }
    expect(await outcome).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    expect(() => process.kill(Number(readFileSync(marker, 'utf8')), 0)).toThrow()
  })

  it('rejects a pre-aborted stream before starting its CLI', () => {
    const marker = join(dir, 'must-not-start'), controller = new AbortController()
    controller.abort(new Error('unloaded'))
    expect(() => streamCommand([process.execPath, script(`require('node:fs').writeFileSync(process.argv[2],'started')`), marker], { signal: controller.signal }))
      .toThrow(expect.objectContaining({ name: 'AbortError', code: 'ABORT_ERR' }))
    expect(existsSync(marker)).toBe(false)
  })

  it('covers an abort between spawning and listener registration', async () => {
    const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal)
    const registration = vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...parameters) => {
      controller.abort(new Error('unloaded during startup'))
      add(...parameters)
    })
    try {
      const child = streamCommand([process.execPath, script('setInterval(()=>{},1000)')], { signal: controller.signal })
      child.stdout.resume(); child.stderr.resume()
      await expect(child.done).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    } finally { registration.mockRestore() }
  })

  it('returns a controlled missing-command failure without echoing arbitrary arguments', async () => {
    const error = await (async () => {
      const child = streamCommand([join(dir, 'missing-native-executable'), 'private reply "&%'], { signal: lifetime() })
      child.stdout.resume(); child.stderr.resume()
      await child.done
    })().catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'ENOENT' })
    expect(String(error)).not.toContain('private reply')
  })

  it('bounds cancellation when an exited native parent leaves inherited pipes open', async () => {
    const marker = join(dir, 'detached.pid'), controller = new AbortController()
    const leaf = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`
    const file = script(`const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[2]],{detached:true,windowsHide:true,stdio:['ignore','inherit','inherit']});child.unref()`)
    const child = streamCommand([process.execPath, file, marker], { signal: controller.signal })
    child.stdout.resume(); child.stderr.resume()
    const outcome = child.done.catch((error: unknown) => error)
    let pid: number | undefined
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 })
      pid = Number(readFileSync(marker, 'utf8'))
      controller.abort()
      let result: unknown
      void outcome.then(value => { result = value })
      await vi.waitFor(() => expect(result).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' }), { timeout: 7000 })
    } finally {
      controller.abort()
      // This fixture deliberately detaches. Kill only its recorded PID; reader closure does not establish process cleanup.
      if (!pid && existsSync(marker)) pid = Number(readFileSync(marker, 'utf8'))
      if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
      await outcome
      if (pid) await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 3000 })
    }
  })
})

describe.skipIf(!WINDOWS)('real Windows host account commands', () => {
  for (const extension of ['cmd', 'ps1']) {
    it(`uses the same .${extension} account for startup and subsequent GitHub/Feishu calls`, async () => {
      const cli = account(extension), config = join(dir, 'agent config')
      const deployment = await resolveDeployment(testDeployment({ stateDir: dir }), { repository: 'sample/repo', cli }, workerProbe(subprocess(), dir, dir, lifetime()))
      const value = new Commands(() => ({ ...deployment, feishu: { ...testDeployment().feishu!, cli } }), { GH_CONFIG_DIR: config }, lifetime())
      expect(await value.gh(['api', 'user'])).toMatchObject({ login: 'agent-bot', args: ['api', 'user'], config })
      expect(await value.gh(args)).toMatchObject({ args })
      expect(await value.lark(['im', '+chat-list'], dir)).toMatchObject({ args: ['im', '+chat-list', '--as', 'bot', '--format', 'json'], cwd: dir, config, notice: '1' })
    })
    it(`retains structured CLI errors and exit status through .${extension}`, async () => {
      const cli = extension === 'cmd' ? batch('failure', `console.error(process.argv[2]==='api'?'gh: Not Found (HTTP 404)':JSON.stringify({error:{code:232011,message:'bot absent'}}));process.exit(23)`)
        : ps('failure', `if ($args[0] -eq 'api') { [Console]::Error.WriteLine('gh: Not Found (HTTP 404)') } else { [Console]::Error.WriteLine('{"error":{"code":232011,"message":"bot absent"}}') }; exit 23`)
      const value = commands(cli)
      await expect(value.gh(['api', 'user'])).rejects.toMatchObject({ code: 404, exitCode: 23 })
      await expect(value.lark(['im', '+chat-list'])).rejects.toMatchObject({ code: 232011, exitCode: 23, message: expect.stringContaining('Add the bot') })
      const quiet = extension === 'cmd' ? batch('quiet', 'process.exit(19)') : ps('quiet', 'exit 19')
      const error = await commands(quiet).run(quiet, ['private reply text']).catch((error: unknown) => error)
      expect(error).toMatchObject({ message: `${basename(quiet)} exited with code 19`, exitCode: 19 })
      expect(String(error)).not.toContain('private reply text')
    })
    it(`cancels the .${extension} adapter tree after the actual CLI has started`, async () => {
      const started = join(dir, 'started.txt'), finished = join(dir, 'must-not-finish.txt')
      const cli = extension === 'cmd' ? batch('long', `const fs=require('node:fs');fs.writeFileSync(process.argv[2],String(process.pid));setTimeout(()=>fs.writeFileSync(process.argv[3],'finished'),5000)`)
        : ps('long', `[IO.File]::WriteAllText($args[0],[string]$PID); Start-Sleep -Seconds 5; [IO.File]::WriteAllText($args[1],'finished')`)
      const controller = new AbortController(), value = commands(cli), running = value.withSignal(controller.signal).run(cli, [started, finished])
      // Attach before aborting, so a fast cancellation cannot become an unhandled rejection.
      const outcome = running.catch((error: unknown) => error)
      await vi.waitFor(() => { expect(existsSync(started)).toBe(true) }, { timeout: 10_000 })
      const pid = Number(readFileSync(started, 'utf8'))
      controller.abort()
      expect(await outcome).toMatchObject({ name: 'AbortError' })
      expect(() => process.kill(pid, 0)).toThrow()
      expect(existsSync(finished)).toBe(false)
      expect(await value.run(process.execPath, ['-e', 'console.log("other work")'])).toBe('other work\n')
    })
  }

  it('does not find a native command through the parent PATH after a target PATH tombstone', async () => {
    const name = 'superagent-parent-only.exe'
    copyFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), join(dir, name))
    vi.stubEnv('PATH', [dir, process.env.PATH].join(delimiter))
    await expect(commands(process.execPath, { Path: undefined }).run(name, ['superagent_nonexistent_fixture']))
      .rejects.toMatchObject({ message: `${name} could not run: ENOENT`, exitCode: undefined })
    expect(process.env.PATH!.split(delimiter)).toContain(dir)
  })

  for (const reason of ['abort', 'timeout']) it(`bounds ${reason} even when an exited CLI leaves inherited pipes open`, async () => {
    const marker = join(dir, 'detached.pid'), controller = new AbortController()
    const leaf = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`
    const cli = batch('background', `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)},process.argv[2]],{detached:true,windowsHide:true,stdio:['ignore','inherit','inherit']});child.unref();process.exit(0)`)
    const outcome = execCommand([cli, marker], { signal: controller.signal, cwd: dir, timeout: reason === 'timeout' ? 2000 : 20_000, maxBuffer: 1024 })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    let pid: number | undefined
    try {
      await vi.waitFor(() => { expect(existsSync(marker)).toBe(true) }, { timeout: 5000 })
      pid = Number(readFileSync(marker, 'utf8'))
      if (reason === 'abort') controller.abort(new Error('runtime was disposed'))
      let settled: Awaited<typeof outcome> | undefined
      void outcome.then(value => { settled = value })
      await vi.waitFor(() => { expect(settled).toBeDefined() }, { timeout: 5000 })
      expect(settled).toMatchObject({ error: reason === 'abort' ? { name: 'AbortError', code: 'ABORT_ERR' } : { killed: true, signal: 'SIGTERM' } })
    } finally {
      controller.abort()
      // Detached processes are outside the PID-tree contract. Explicitly clean up this known fixture, never unrelated PIDs.
      if (!pid && existsSync(marker)) pid = Number(readFileSync(marker, 'utf8'))
      if (pid) {
        try { process.kill(pid, 'SIGKILL') } catch { /* The owned fixture already exited. */ }
        await vi.waitFor(() => { expect(() => process.kill(pid!, 0)).toThrow() }, { timeout: 3000 })
      }
      await outcome
    }
  })

  it('preserves ordinary batch positional arguments for startup and actual business calls', async () => {
    const cli = join(dir, 'conditional.cmd')
    writeFileSync(cli, '@echo off\r\n@if "%~1"=="api" (echo {"login":"agent-bot","id":7,"name":"sample/repo","push":true}) else (exit /b 31)\r\n@exit /b 0\r\n')
    const deployment = await resolveDeployment(testDeployment({ stateDir: dir }), { repository: 'sample/repo', cli }, workerProbe(subprocess(), dir, dir, lifetime()))
    expect(await new Commands(() => deployment, {}, lifetime()).gh(['api', 'user'])).toMatchObject({ login: 'agent-bot' })
  })

  it('runs the documented PowerShell identity wrapper with exact native arguments', async () => {
    const guide = readFileSync(new URL('../docs/009-windows-desktop.md', import.meta.url), 'utf8')
    const example = /```powershell\r?\n([\s\S]*?)```/.exec(guide)?.[1]
    expect(example).toBeDefined()
    const literal = (value: string): string => value.replaceAll("'", "''")
    const config = join(dir, 'documented config')
    const code = example!.replace('C:\\Program Files\\GitHub CLI\\gh.exe', literal(process.execPath)).replace('D:\\AgentData\\github-agent', literal(config))
    const cli = ps('documented wrapper', code)
    const output = await commands(cli, { GH_TOKEN: 'synthetic-parent-token' }).gh(['-e',
      'console.log(JSON.stringify({args:process.argv.slice(1),config:process.env.GH_CONFIG_DIR,token:process.env.GH_TOKEN}))', ...args])
    expect(output).toEqual({ args, config })
  })

  it('refuses unsupported batch data before starting the CLI and keeps the remediation visible', async () => {
    const cli = join(dir, 'unknown.cmd'), marker = join(dir, 'must-not-run.txt')
    writeFileSync(cli, '@echo off\r\n@echo ran>"%~dp0must-not-run.txt"\r\n@echo %~1\r\n@exit /b 0\r\n')
    const privateText = 'private reply "&echo unexpected'
    const error = await commands(cli).run(cli, [privateText]).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: expect.stringMatching(/\.exe.*\.ps1/) })
    expect(String(error)).not.toContain(privateText)
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps percent substitutions and long metacharacter data literal in known Node launchers', async () => {
    const cli = batch('account=equals', record)
    const values = ['api', '%SUPERAGENT_PERCENT_PROBE:EXP=REP%', '%SUPERAGENT_PERCENT_PROBE:E=Q%', 'a"&<>^%'.repeat(800), '', 'end\\']
    const output = await commands(cli, { SUPERAGENT_PERCENT_PROBE: 'EXPANDED' }).gh<{ args: string[] }>(values)
    expect(output.args).toEqual(values)
  })

  it('keeps Commands output larger than the Worker 1 MiB collection limit', async () => {
    const cli = batch('large', `process.stdout.write('x'.repeat(2*1024*1024))`)
    expect((await commands(cli).run(cli, [])).length).toBe(2 * 1024 * 1024)
  })

  it('retains timeout diagnostics and waits for the adapter tree to terminate', async () => {
    const started = join(dir, 'timeout.txt')
    const cli = batch('timeout', `require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)`)
    const outcome = execCommand([cli, started], { signal: lifetime(), cwd: dir, timeout: 2500, maxBuffer: 1024 }).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(existsSync(started)).toBe(true) }, { timeout: 2000 })
    const pid = Number(readFileSync(started, 'utf8'))
    expect(await outcome).toMatchObject({ killed: true, signal: 'SIGTERM' })
    expect(() => process.kill(pid, 0)).toThrow()
  })

  for (const stream of ['stdout', 'stderr']) it(`bounds ${stream} and terminates the adapter tree on overflow`, async () => {
    const started = join(dir, 'overflow.txt')
    const cli = batch('overflow', `require('node:fs').writeFileSync(process.argv[2],String(process.pid));process.${stream}.write('x'.repeat(4096));setInterval(()=>{},1000)`)
    const error = await execCommand([cli, started], { signal: lifetime(), cwd: dir, timeout: 10_000, maxBuffer: 64 }).catch((error: unknown) => error)
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    expect((error as Record<string, string>)[stream]!.length).toBe(64)
    expect(() => process.kill(Number(readFileSync(started, 'utf8')), 0)).toThrow()
  })
})

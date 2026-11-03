import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, executable } from '../src/deployment.ts'
import { sameDirectory, withoutDirectory, workerBin } from '../src/infra/environment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'

it.each(['C:\\SuperAgent\\state', 'D:/Agent 工作区/state', '\\\\server\\share\\state', '/var/lib/superagent'])('accepts an absolute deployment path: %s', stateDir => {
  expect(Config({ stateDir }).stateDir).toBe(stateDir)
  expect(ExecutorConfigSchema.parse({ directory: stateDir }).directory).toBe(stateDir)
})
it.each(['state', './state', 'C:relative', '\\\\server', '\\root-relative', ''])('rejects an incomplete or relative deployment path: %s', stateDir => {
  expect(() => Config({ stateDir })).toThrow()
  if (stateDir) expect(() => ExecutorConfigSchema.parse({ directory: stateDir })).toThrow()
})
it('keeps the empty executor directory default', () => {
  expect(ExecutorConfigSchema.parse({ directory: '' }).directory).toBe('')
})

describe.skipIf(process.platform !== 'win32')('Windows executable lookup', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-windows-paths-')) })
  afterEach(() => {
    const target = resolve(directory)
    expect(dirname(target)).toBe(resolve(tmpdir()))
    expect(basename(target)).toMatch(/^superagent-windows-paths-/)
    rmSync(target, { recursive: true, force: true })
  })
  it('uses semicolon PATH and native PATHEXT entries, excluding every spelling of worker-bin', () => {
    const bin = workerBin(directory), real = join(directory, "real 工具 'quoted'")
    mkdirSync(bin); mkdirSync(real)
    writeFileSync(join(bin, 'gh.exe'), '')
    writeFileSync(join(real, 'gh.cmd'), '')
    writeFileSync(join(real, 'gh.EXE'), '')
    const path = [`"${bin.toUpperCase()}\\"`, `${bin}/`, 'relative', `"${real}"`].join(';')
    expect(executable('gh', path, bin, '.CMD;.PS1;.EXE;.COM')).toBe(join(real, 'gh.exe'))
    expect(withoutDirectory(path, bin)).toBe(`relative;"${real}"`)
    expect(sameDirectory(bin.toUpperCase(), `${bin}/`)).toBe(true)
  })
  it('accepts an explicit native executable or an absolute path missing its extension', () => {
    const native = join(directory, 'gh.exe')
    writeFileSync(native, '')
    expect(executable(native, '', undefined, '.COM')).toBe(native)
    expect(executable(join(directory, 'gh'), '', undefined, '.EXE;.COM')).toBe(native)
    writeFileSync(join(directory, 'gh.com'), '')
    expect(executable('gh', directory, undefined, '.COM;.EXE')).toBe(join(directory, 'gh.com'))
  })
  it.each(['gh.cmd', 'gh.bat', 'gh.ps1', 'GH.PS1'])('rejects configured scripts with a native-CLI explanation: %s', name => {
    const file = join(directory, name)
    writeFileSync(file, '')
    expect(() => executable(file, directory)).toThrow('Windows CLI configuration requires a native .exe or .com executable')
  })
  it.each(['GH', 'Git', 'LARK-CLI'])('keeps required commands protected despite Windows casing: %s', command => {
    expect(() => ExecutorConfigSchema.parse({ blockedCommands: [command] })).toThrow('cannot be blocked')
  })
  it('rejects relative paths, extensionless files and directories that look executable', () => {
    for (const name of ['bin\\gh.exe', 'bin/gh.exe', 'C:gh.exe', '\\gh.exe']) {
      expect(() => executable(name, directory)).toThrow('must be a command name or an absolute path')
    }
    writeFileSync(join(directory, 'gh'), '')
    mkdirSync(join(directory, 'gh.exe'))
    expect(() => executable('gh', directory, undefined, '.EXE;.COM')).toThrow('is not an executable file on PATH')
  })
})

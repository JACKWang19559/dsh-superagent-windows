import { describe, expect, it, vi } from 'vitest'
import { environmentOf } from '../src/app/execution-environment.ts'
import { GithubAccountsSchema, resolveDeployment, SETUP_FIELDS, type Probe } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { readRepositoryPath } from '../src/sources/github-read.ts'
import { SettingsSchema } from '../src/policy.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

const repository = '5th-Axiom/VideoInWay'
const branch = 'codex/video-editing'
const github = { repository, cli: process.execPath }
// Resolve an actual native executable, but keep all account/repository/branch reads local and deterministic.
const branchProbe = (reply: string | Error) => vi.fn<Probe>(async ([, command, endpoint]) => {
  if (command !== 'api') throw new Error(`Unexpected command: ${command}`)
  if (endpoint === 'user') return JSON.stringify({ login: 'Agent-Bot', id: 7 })
  if (endpoint === `repos/${repository}`) return JSON.stringify({ name: repository, push: true })
  if (endpoint !== `repos/${repository}/branches/codex%2Fvideo-editing`) throw new Error(`Unexpected endpoint: ${endpoint}`)
  if (reply instanceof Error) throw reply
  return reply
})

describe('GitHub work base branch', () => {
  it('defaults and trims Source settings, validates branch syntax, and marks the field as requiring setup', () => {
    expect(GithubAccountsSchema.parse({}).branch).toBe('')
    expect(githubKind.schema.parse({}).branch).toBe('')
    expect(githubKind.schema.parse({ branch: ' Codex/Video-Editing ' }).branch).toBe('Codex/Video-Editing')
    expect(githubKind.schema.safeParse({ branch: '../main' }).success).toBe(false)
    expect(SETUP_FIELDS.github).toContain('branch')
    expect(githubKind.fields.find(field => field.key === 'branch')?.type).toBe('text')
  })

  it.each([undefined, '', '   '])('keeps the original two probes when branch is %j', async selected => {
    const probe = branchProbe(new Error('A default-branch setup must not probe branches'))
    const deployment = await resolveDeployment(testMachine(), { ...github, branch: selected }, probe)
    expect(deployment).not.toHaveProperty('branch')
    expect(probe.mock.calls.map(([argv]) => argv.slice(1))).toEqual([
      ['api', 'user'], ['api', `repos/${repository}`, '--jq', '{name: .full_name, push: .permissions.push}'],
    ])
  })

  it('refuses invalid branch syntax before running any account or repository probes', async () => {
    const probe = branchProbe('{}')
    await expect(resolveDeployment(testMachine(), { ...github, branch: '../main' }, probe)).rejects.toThrow('valid Git branch')
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    ['missing or inaccessible branch', new Error('HTTP 404: Branch not found')],
    ['malformed response', 'not JSON'],
    ['missing branch name', '{}'],
    ['differently cased branch', JSON.stringify({ name: 'Codex/video-editing' })],
  ])('fails closed for a %s without retrying the default branch', async (_label, reply) => {
    const probe = branchProbe(reply)
    await expect(resolveDeployment(testMachine(), { ...github, branch }, probe)).rejects.toMatchObject({
      place: 'github', code: 'branchUnreadable', values: { repository, branch, account: 'Agent-Bot', output: expect.any(String) },
    })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(probe.mock.calls[2]![0].slice(1)).toEqual(['api', `repos/${repository}/branches/codex%2Fvideo-editing`])
  })

  it.each([undefined, 'Codex/Video-Editing'])('passes verified branch %j into the execution environment and displayed facts', selected => {
    const deployment = testDeployment(selected ? { repository, branch: selected } : { repository })
    // The verified Deployment, rather than an unverified edited Source setting, owns the execution value.
    const settings = SettingsSchema.parse({ sources: { github: { config: { ...github, branch: 'unverified/config-branch' } } } })
    const sources = new SourceRegistry(() => settings)
    const dispose = sources.register(githubKind)
    try {
      const variables = environmentOf({ deployment, sources, settings, ticket: { id: 'ticket-1', name: 'video-editing', directory: '/work/video-editing' } })
      const value = variables.find(item => item.key === 'DSH_SUPERAGENT_GITHUB_BASE_BRANCH')
      expect(value).toMatchObject({ value: selected ?? '', owner: 'github', description: { en: expect.stringContaining('--base') } })
      const facts = githubKind.facts!(deployment)
      expect(facts.branch).toEqual(selected
        ? { zh: `当前基准分支 ${selected}`, en: `Current base branch ${selected}` }
        : { zh: '使用仓库默认分支', en: 'Using the repository default branch' })
    } finally { dispose() }
  })

  it.each([
    { selected: undefined, ref: '' },
    { selected: branch, ref: '?ref=codex%2Fvideo-editing' },
    { selected: 'Codex/video-editing&review#1', ref: '?ref=Codex%2Fvideo-editing%26review%231' },
  ])('reads both repository files and directories from branch $selected', async ({ selected, ref }) => {
    const deployment = testDeployment(selected ? { repository, branch: selected } : { repository })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) => args.includes('-H')
      ? 'selected-branch source text' : JSON.stringify([{ name: 'video.ts' }, { name: '.git' }, { name: 'node_modules' }, { name: 'index.ts' }]))
    expect(await readRepositoryPath(commands, 'src/video editor.ts', 'file')).toBe('selected-branch source text')
    expect(await readRepositoryPath(commands, 'src', 'directory')).toBe('index.ts\nvideo.ts')
    expect(run.mock.calls.map(([, args]) => args)).toEqual([
      ['api', `repos/${repository}/contents/src/video%20editor.ts${ref}`, '-H', 'Accept: application/vnd.github.raw'],
      ['api', `repos/${repository}/contents/src${ref}`],
    ])
  })

  it.each(['file', 'directory'] as const)('does not fall back to default when the selected branch %s read fails', async kind => {
    const commands = new Commands(() => testDeployment({ repository, branch }), {}, new AbortController().signal)
    const failure = new Error('HTTP 404: selected ref not found')
    const run = vi.spyOn(commands, 'run').mockRejectedValue(failure)
    await expect(readRepositoryPath(commands, 'src', kind)).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![1][1]).toBe(`repos/${repository}/contents/src?ref=codex%2Fvideo-editing`)
  })

  it('still receives repository Issues and PRs when their branches differ from the selected work base', () => {
    const config = githubKind.schema.parse({ branch, observeIssues: true, observePulls: true })
    expect(githubKind.scope!({ meta: { kind: 'issue' } }, config)).toMatchObject({ listened: true, observed: true, row: 'issues' })
    expect(githubKind.scope!({ meta: { kind: 'pull', branch: 'other/branch' } }, config)).toMatchObject({ listened: true, observed: true, row: 'pulls' })
  })
})

import { expect, it } from 'vitest'
import { RepositorySchema } from '../src/on-demand/controller.ts'
import { parseRepositoryInput, repositoryInput } from '../src/on-demand/repository.ts'

it.each(['5th-Axiom/VideoInWay', '/5th-Axiom/VideoInWay', '  5th-Axiom/VideoInWay  ',
  'https://github.com/5th-Axiom/VideoInWay', 'https://github.com/5th-Axiom/VideoInWay/',
  'https://github.com/5th-Axiom/VideoInWay.git'])('accepts repository input %s without selecting a branch', input => {
  expect(RepositorySchema.safeParse(input).success).toBe(true)
  expect(parseRepositoryInput(input)).toEqual({ repository: '5th-Axiom/VideoInWay', branch: null })
})

it.each([
  ['https://github.com/5th-Axiom/VideoInWay/tree/codex/video-editing', 'codex/video-editing'],
  ['https://github.com/5th-Axiom/VideoInWay/tree/codex%2Fvideo-editing', 'codex/video-editing'],
  ['https://github.com/5th-Axiom/VideoInWay/tree/Codex/Video-Editing', 'Codex/Video-Editing'],
  ['https://github.com/5th-Axiom/VideoInWay/tree/feature/%E4%B8%AD%E6%96%87%23test', 'feature/中文#test'],
  ['https://github.com/5th-Axiom/VideoInWay/tree/main/folder', 'main/folder'],
  ['https://github.com/5th-Axiom/VideoInWay/tree/literal%252Fref', 'literal%2Fref'],
])('retains the entire branch in %s and round-trips it', (input, branch) => {
  const target = { repository: '5th-Axiom/VideoInWay', branch }
  expect(RepositorySchema.safeParse(input).success).toBe(true)
  expect(parseRepositoryInput(input)).toEqual(target)
  expect(parseRepositoryInput(repositoryInput(target))).toEqual(target)
})

it.each(['', 'owner', '//owner/repo', '../repo', 'owner/..', 'owner/repo/tree/main', 'owner/repo;echo',
  'http://github.com/owner/repo/tree/main', 'https://gitlab.com/owner/repo', 'https://github.com.evil/owner/repo',
  'https://user:password@github.com/owner/repo', 'https://github.com/owner/repo/blob/main/readme.md',
  'https://github.com/owner/repo/tree/', 'https://github.com/owner/repo/tree/main?ref=other',
  'https://github.com/owner/repo/tree/main#other', 'https://github.com/owner/repo/tree/feature/../main',
  'https://github.com/owner/repo/tree/feature%2F..%2Fmain', 'https://github.com/owner/repo/tree/.hidden/branch',
  'https://github.com/owner/repo/tree/feature.lock/branch', 'https://github.com/owner/repo/tree/a%00b',
  'https://github.com/owner/repo/tree/a%20b', 'https://github.com/owner/repo/tree/a%5Cb',
  'https://github.com/owner/repo/tree/a%3Fb', 'https://github.com/owner/repo/tree/a//b',
  'https://github.com/owner/repo/tree/@%7B1%7D', 'https://github.com/owner/repo/tree/-option',
  'https://github.com/owner/repo/tree/%invalid', 'https://github.com/owner/repo/tree/' + 'a'.repeat(1025),
])('rejects invalid or ambiguous input %s consistently in Client and Host', input => {
  expect(parseRepositoryInput(input)).toBeNull()
  expect(RepositorySchema.safeParse(input).success).toBe(false)
})

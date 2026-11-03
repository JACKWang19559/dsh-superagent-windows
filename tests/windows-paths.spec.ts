import { expect, it } from 'vitest'
import { Config } from '../src/deployment.ts'

it.each(['C:\\SuperAgent\\state', 'D:/Agent 工作区/state', '\\\\server\\share\\state', '/var/lib/superagent'])('accepts an absolute deployment path: %s', stateDir => {
  expect(Config({ stateDir }).stateDir).toBe(stateDir)
})
it.each(['state', './state', 'C:relative', '\\\\server', ''])('rejects an incomplete or relative deployment path: %s', stateDir => {
  expect(() => Config({ stateDir })).toThrow()
})

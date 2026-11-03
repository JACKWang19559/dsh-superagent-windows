/** Same-origin user interface and session tool share the same launch operations. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { json, readBody, sameOrigin } from '../app/http.ts'
import { LaunchConflict, LaunchRequestSchema } from './controller.ts'
import type { LaunchControl, LaunchRequest, LaunchStatus } from './types.ts'

export function dispatch(control: LaunchControl, request: LaunchRequest): LaunchStatus | Promise<LaunchStatus> {
  if (request.action === 'start') return control.start(request.repository)
  if (request.action === 'stop') return control.stop()
  return control.status()
}
export function registerLaunchHttp(ctx: Context, control: LaunchControl): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Superagent management requires a loopback Web server')
  return ctx.webServer.register({ kind: 'exact', path: '/orchestrator/control', handler: async (req, res) => {
    if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
    try {
      if (req.method === 'GET') { json(res, 200, control.status()); return }
      if (req.method !== 'POST') { json(res, 405, { error: 'Use GET for status or POST for an operation' }); return }
      const request = LaunchRequestSchema.parse(await readBody(req, 8192))
      json(res, 200, await dispatch(control, request))
    } catch (error) {
      const status = error instanceof LaunchConflict ? 409 : error instanceof z.ZodError ||
        (error && typeof error === 'object' && 'status' in error && error.status === 400) ? 400 : 500
      json(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  } })
}

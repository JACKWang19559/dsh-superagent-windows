/** Eager preset activation only registers scoped tools and guidance; it never starts the Host Runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { z } from 'zod'
import type {} from './host.ts'
import { LaunchRequestSchema, RepositorySchema } from './controller.ts'
import { dispatch } from './http.ts'

export const name = 'dsh-superagent-on-demand'
export const inject = ['superagentControl', 'tools', 'systemPrompt', 'permissionPresets']
export const LAUNCH_GUIDANCE = `You are Superagent's on-demand startup console. Respond in the user's language.
Selecting or reopening this preset does not authorize starting background work. Start only when the user requests it, using their chosen repository input; ask for it if missing.
Use the Superagent sidebar for setup details, policy, tickets, and opening the separate orchestrator session. The orchestrator admits requests from its configured GitHub sources and runs Harness workers; a chat message here is not itself a submitted ticket.
Report the returned status accurately. If setup is incomplete, explain the reported problem and direct the user to the panel. Stop only on the user's request; stopping cancels this repository's running workers. Never change permissions for the user.`
export const ControlArguments = z.object({
  action: z.enum(['status', 'start', 'stop']),
  repository: RepositorySchema.optional().describe('Required for start: owner/repo, https://github.com/owner/repo, or https://github.com/owner/repo/tree/branch. The entire tree suffix is the branch, including slashes (e.g. codex/video-editing); no branch uses the repository default. Omit for status and stop.'),
}).strict()

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'superagent-on-demand', order: 200, interpolate: false, text: LAUNCH_GUIDANCE }))
  ctx.effect(() => ctx.tools.register({
    name: 'superagent_control',
    description: 'Read Superagent status, explicitly start GitHub synchronization and Harness workers for one repository, or stop its polling and workers. Start uses the existing gh login and requires this session already to have Full access. Returns readiness, setup errors, and the internal orchestrator session id.',
    parameters: z.toJSONSchema(ControlArguments),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, execution) => {
      const request = LaunchRequestSchema.parse(ControlArguments.parse(args))
      if (request.action !== 'status') {
        const agent = execution.agent
        if (!agent || agent.session.header.parentSession) throw new Error('Start and stop are available only in a user Superagent control session.')
        if (request.action === 'start' && ctx.permissionPresets.current(agent.session) !== 'danger-full-access') {
          throw new Error('Superagent workers use Full access. Select Full access yourself in this session before starting; no permission was changed.')
        }
      }
      return dispatch(ctx.superagentControl, request)
    },
  }))
}

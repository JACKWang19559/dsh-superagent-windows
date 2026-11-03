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
export const LAUNCH_GUIDANCE = `You are Superagent's startup console. Respond in the user's language.
Collect the repository or branch link here in this conversation. Start when the user requests it; ask only for missing input. Choosing this preset, reopening a conversation, or viewing history never authorizes starting or resuming work. Keep the user's complete branch link.
Use history to find recent runs and their console/orchestrator session ids. The Superagent sidebar shows history, current status, setup, policy, and tickets. Its new-conversation button opens this console.
Report the returned status and setup problems accurately; direct setup changes to the sidebar. The separate orchestrator admits configured GitHub requests and runs Harness workers; messages here are not tickets. Stop only on request; it cancels current workers. Never change the user's permissions.`
export const ControlArguments = z.object({
  action: z.enum(['status', 'history', 'start', 'stop']),
  repository: RepositorySchema.optional().describe('Required for start: owner/repo, https://github.com/owner/repo, or https://github.com/owner/repo/tree/branch. The entire tree suffix is the branch, including slashes (e.g. codex/video-editing); no branch uses the repository default. Omit for status, history, and stop.'),
}).strict()

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({ name: 'superagent-on-demand', order: 200, interpolate: false, text: LAUNCH_GUIDANCE }))
  ctx.effect(() => ctx.tools.register({
    name: 'superagent_control',
    description: 'Read local Superagent status or the latest 30 runs with session links; explicitly start a repository using the current gh login and Harness workers, or stop its polling/workers. Start requires this user control session already to have Full access. Status returns readiness, setup errors, and session ids.',
    parameters: z.toJSONSchema(ControlArguments),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, execution) => {
      const request = LaunchRequestSchema.parse(ControlArguments.parse(args))
      if (request.action === 'start' || request.action === 'stop') {
        const agent = execution.agent
        if (!agent || agent.session.header.parentSession) throw new Error('Start and stop are available only in a user Superagent control session.')
        if (request.action === 'start' && ctx.permissionPresets.current(agent.session) !== 'danger-full-access') {
          throw new Error('Superagent workers use Full access. Select Full access yourself in this session before starting; no permission was changed.')
        }
      }
      return dispatch(ctx.superagentControl, request, execution.agent?.session.id)
    },
  }))
}

/** Main plugin entry: mounts an inert launcher; the repository Runtime exists only after explicit activation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { SuperagentControl } from './on-demand/host.ts'
import { registerLaunchHttp } from './on-demand/http.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const control = new SuperagentControl(ctx, machine)
  ctx.effect(() => registerLaunchHttp(ctx, control))
  ctx.logger.info('Superagent is idle; select the Superagent preset in a new session or start a repository from the sidebar')
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

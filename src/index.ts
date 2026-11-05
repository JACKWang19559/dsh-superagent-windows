/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { provideExecutionEnvironment } from './execution-subprocess.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  provideExecutionEnvironment(ctx, machine.stateDir)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  let disposed = false
  ctx.effect(() => async () => { disposed = true; await runtime.stop() })
  // The router preset injects superagentExecution, whose strict provider becomes visible only after this fiber activates.
  // Keep Runtime.ready as the HTTP/Source gate, but never make plugin activation wait on its own provider.
  void runtime.ready.then(() => {
    if (!disposed) ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  }, async (error: unknown) => {
    if (disposed) return
    ctx.logger.error('dsh-superagent startup failed: %s', String(error))
    await runtime.stop()
  }).catch((error: unknown) => {
    if (!disposed) ctx.logger.error('dsh-superagent startup cleanup failed: %s', String(error))
  })
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

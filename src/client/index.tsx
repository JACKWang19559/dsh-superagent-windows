/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { Launcher } from './launcher.tsx'
import { ProjectPanel } from './project.tsx'
import { registerPresetPicker } from './preset-picker.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Keep Session navigation within its mounted view and cancel superseded requests. */
function useNavigation(ctx: ClientContext, t: T) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const startSession = useCallback((workspaceId?: Parameters<ClientContext['uiWorkspace']['startSession']>[0]) => {
    pending.current?.abort()
    // rc.5's inspected public contract adds agentPreset; the alpha development declarations predate it.
    const options = { agentPreset: 'superagent' } as Parameters<ClientContext['uiWorkspace']['startSession']>[1] & { agentPreset: string }
    ctx.uiWorkspace.startSession(workspaceId, options)
  }, [ctx])
  return { openSession, startSession }
}

/** Global sidebar retains the existing all-project launcher and management controls. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const { openSession, startSession } = useNavigation(ctx, t)
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <Launcher t={t} openSession={openSession} startSession={startSession} deploymentForm={form} />
}

/** The selected Session identity, rather than the global panel selection, scopes this view. */
function MountedProject({ ctx, t, sessionId }: { ctx: ClientContext; t: T; sessionId: SessionId }) {
  const { openSession, startSession } = useNavigation(ctx, t)
  return <ProjectPanel sessionId={sessionId} t={t} openSession={openSession}
    startSession={workspaceId => startSession(workspaceId as Parameters<typeof startSession>[0])} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  registerPresetPicker(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: ENTRY, order: 11,
    label: () => t('panel'), locale: NS },
    (props: ConvViewProps & { t: T }) => <MountedProject key={props.sessionId} ctx={ctx} t={props.t} sessionId={props.sessionId} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}

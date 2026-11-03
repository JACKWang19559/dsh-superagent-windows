/** Filters the shipped new-session picker through its public Slot entry; Host presets remain registered. */
import { useEffect, useMemo, useRef, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SnapshotSelectorHook, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

const SLOT = 'conversation.hero.agentPreset'
const LOCALE = 'settings.agentPreset'
const INTERNAL = new Set(['dsh-superagent-router', 'dsh-superagent-worker'])
type PickerProps = Record<string, unknown>
type PickerSnapshot = Record<string, unknown> & {
  options: readonly { id: string }[]; current: string; busy: boolean; introduce: boolean
}

/** The rc.5 picker contract; an unfamiliar future snapshot is passed through unchanged. */
function isPickerSnapshot(value: unknown): value is PickerSnapshot {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return Array.isArray(state.options) && state.options.every(option => option && typeof option.id === 'string')
    && typeof state.current === 'string'
    && typeof state.busy === 'boolean' && typeof state.introduce === 'boolean' && 'error' in state
}

function filteredPicker(entry: StoredEntry): ComponentType<PickerProps> {
  const Original = entry.component as ComponentType<PickerProps>
  function ProjectedPicker(props: PickerProps) {
    const useSource = props.useAgentPresetSeat as SnapshotSelectorHook<unknown>
    const snapshot: unknown = useSource((value: unknown) => value)
    const attempted = useRef<string | undefined>(undefined)
    useEffect(() => {
      // The shipped unbound seat only stages here; any existing Session, even blank, keeps its preset.
      if (props.sessionId !== undefined || !isPickerSnapshot(snapshot) || !INTERNAL.has(snapshot.current)) {
        attempted.current = undefined
        return
      }
      if (snapshot.busy || snapshot.error !== null) return
      const target = ['superagent', 'standard'].find(id => snapshot.options.some(option => option.id === id))
      if (!target || attempted.current === snapshot.current) return
      attempted.current = snapshot.current
      // The original controller owns refusals; do not repeat a failed correction on each roster update.
      void Promise.resolve((props.select as (id: string) => Promise<unknown>)(target)).catch(() => {})
    }, [snapshot, props.sessionId, props.select])
    const useVisible = useMemo(() => {
      // Selector hooks can read the same snapshot repeatedly; keep the projected identity stable.
      const snapshots = new WeakMap<PickerSnapshot, PickerSnapshot>()
      const visible = (value: unknown): unknown => {
        if (!isPickerSnapshot(value)) return value
        const cached = snapshots.get(value)
        if (cached) return cached
        const options = value.options.filter(option => !INTERNAL.has(option.id))
        const result = options.length === value.options.length ? value : { ...value, options }
        snapshots.set(value, result)
        return result
      }
      const useFiltered: SnapshotSelectorHook<unknown> = <T,>(selector: (snapshot: unknown) => T, equals?: (left: T, right: T) => boolean): T =>
        useSource((value: unknown) => selector(visible(value)), equals)
      return useFiltered
    }, [useSource])
    return <Original {...props} useAgentPresetSeat={useVisible} />
  }
  return function VisiblePresetPicker(props: PickerProps) {
    const compatible = ['useAgentPresetSeat', 'useDeveloperTools', 'load', 'select', 'dismissRefusal', 'introduced', 't']
      .every(key => typeof props[key] === 'function')
    return compatible ? <ProjectedPicker {...props} /> : <Original {...props} />
  }
}

/** Narrow, inspected registry face: ui-conversation is not a build-time dependency of this bundle. */
interface PickerSlots {
  inject(key: typeof SLOT, effect: () => () => void): () => void
  entries(key: typeof SLOT): readonly StoredEntry[]
  entriesOfSlot(key: typeof SLOT): readonly StoredEntry[]
  subscribe(key: typeof SLOT, notify: () => void): () => void
  spec(key: typeof SLOT): { kind: string; scope: string } | undefined
  register(options: { name: typeof SLOT; priority: number; locale: string; inject: NonNullable<StoredEntry['inject']> },
    component: ComponentType<PickerProps>): () => void
}

/** Own only the picker shadow and its subscription; collapse, hot reload and plugin unload restore the original. */
export function registerPresetPicker(ctx: Pick<Context, 'slots'>): () => void {
  const slots = ctx.slots as unknown as PickerSlots
  if (typeof slots.entries !== 'function' || typeof slots.entriesOfSlot !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.spec !== 'function') return () => {}
  return slots.inject(SLOT, () => {
    const spec = slots.spec(SLOT)
    if (spec?.kind !== 'single' || spec.scope !== 'session-maybe') return () => {}
    let source: StoredEntry | undefined
    let Component: ComponentType<PickerProps> | undefined
    let unregister: (() => void) | undefined
    let disposed = false
    let updating = false
    const sync = () => {
      if (disposed || updating) return
      updating = true
      try {
        // Do not capture ourselves or outrank another plugin's chosen replacement.
        const next = slots.entries(SLOT).filter(entry => entry.component !== Component)
          .reduce<StoredEntry | undefined>((winner, entry) => !winner || (entry.options.priority ?? 0) < (winner.options.priority ?? 0) ? entry : winner, undefined)
        // Production registrant names are minified. Match the stock leaf's public contract instead.
        const candidate = next && (next.options.priority ?? 0) === 0 && next.locale === LOCALE
          && typeof next.component === 'function' && typeof next.inject === 'function' && !next.store
          && (!next.children || Object.keys(next.children).length === 0) ? next : undefined
        if (candidate === source) return
        unregister?.(); unregister = undefined; source = undefined
        Component = undefined
        if (!candidate || slots.entriesOfSlot(SLOT)[0] !== candidate) return
        Component = filteredPicker(candidate)
        source = candidate
        unregister = slots.register({ name: SLOT, priority: -1, locale: LOCALE, inject: candidate.inject! }, Component)
      } finally { updating = false }
    }
    const stop = slots.subscribe(SLOT, sync)
    const dispose = () => { disposed = true; stop(); unregister?.(); unregister = undefined; source = undefined; Component = undefined }
    try { sync() } catch (error) { dispose(); throw error }
    return dispose
  })
}

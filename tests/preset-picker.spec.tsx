// @vitest-environment jsdom
import { act, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotCore, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { registerPresetPicker } from '../src/client/preset-picker.tsx'

const SLOT = 'conversation.hero.agentPreset'
const LOCALE = 'settings.agentPreset'
const ROUTER = 'dsh-superagent-router'
const WORKER = 'dsh-superagent-worker'
type Props = Record<string, unknown>
type UseSnapshot = <T>(selector: (state: Snapshot) => T, equals?: (left: T, right: T) => boolean) => T
type Option = { id: string; name: string; description: string }
type Snapshot = { options: readonly Option[]; current: string; busy: boolean; introduce: boolean; error: unknown }
type Registration = { name: string; priority?: number; locale?: string; inject?: StoredEntry['inject']; registrant?: string; children?: Record<string, unknown> }
const option = (id: string): Option => Object.freeze({ id, name: `Name: ${id}`, description: `Description: ${id}` })
const defaults = (): Snapshot => Object.freeze({ options: Object.freeze(['standard', 'ptc', 'minimal', 'cordis', 'superagent', ROUTER, WORKER, `${WORKER}-custom`].map(option)),
  current: 'superagent', busy: false, introduce: false, error: null })
const disposers: (() => void)[] = []
declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { act(() => { for (const dispose of disposers.splice(0).reverse()) dispose() }) })
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

/** Use the real SlotCore for priorities, declaration epochs, subscription batching and disposal. */
function registry(declared = true, scope = 'session-maybe') {
  const core = new SlotCore()
  const register = (options: Registration, component: ComponentType<Props>) => core.register(options as never, component as never)
  const declare = () => register({ name: 'root', children: { [SLOT]: { kind: 'single', scope } } }, () => null)
  let collapse = declared ? declare() : () => {}
  let subscriptions = 0
  const slots = {
    spec: (key: string) => core.specDynamic(key),
    entries: (key: string) => core.entries(key),
    entriesOfSlot: (key: string) => core.entriesOfSlot(key),
    register,
    subscribe: (key: string, notify: () => void) => {
      subscriptions++
      const stop = core.subscribe(key, notify)
      return () => { subscriptions--; stop() }
    },
    inject: (key: string, effect: () => () => void) => {
      let release: (() => void) | undefined
      const sync = () => { release?.(); release = core.specDynamic(key) ? effect() : undefined }
      const stop = core.subscribeDeclaration(key, sync)
      sync()
      let disposed = false
      return () => { if (disposed) return; disposed = true; stop(); release?.(); release = undefined }
    },
  }
  const install = () => {
    const dispose = registerPresetPicker({ slots } as never)
    disposers.push(dispose)
    return dispose
  }
  disposers.push(() => { collapse() })
  return { core, register, install, subscriptions: () => subscriptions, winner: () => core.entriesOfSlot(SLOT)[0],
    collapse: () => { collapse() }, declare: () => { collapse = declare() } }
}

function nativePicker(initial = defaults()) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  let observed: Snapshot | undefined
  let second: Snapshot | undefined
  let delivered: Props = {}
  const equals = (left: Snapshot, right: Snapshot) => left === right
  const equalities: unknown[] = []
  const useSnapshot: UseSnapshot = (selector, equal) => {
    equalities.push(equal)
    const state = useSyncExternalStore(notify => { listeners.add(notify); return () => { listeners.delete(notify) } }, () => snapshot)
    return selector(state)
  }
  const publish = (next: Snapshot) => { snapshot = next; for (const notify of listeners) notify() }
  const select = vi.fn(async (id: string) => { publish({ ...snapshot, current: id }) })
  const props: Props = { useAgentPresetSeat: useSnapshot, useDeveloperTools: (selector: (value: boolean) => unknown) => selector(true),
    load: vi.fn(), select, dismissRefusal: vi.fn(), introduced: vi.fn(), t: (key: string) => key,
    sessionId: 'blank-session', inputActions: { untouched: true } }
  const Component = (received: Props) => {
    delivered = received
    const hook = received.useAgentPresetSeat as UseSnapshot
    const state = hook(value => value, equals)
    observed = state; second = hook(value => value)
    const [open, setOpen] = useState(false)
    useEffect(() => { (received.load as () => void)() }, [received.load])
    return <div>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>Open modes</button>
      {open && <div role="menu">{state.options.map(row => <button key={row.id} role="menuitemradio" data-mode={row.id}
        aria-checked={state.current === row.id} disabled={state.busy} onClick={() => { void (received.select as (id: string) => Promise<void>)(row.id) }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void (received.select as (id: string) => Promise<void>)(row.id) } }}>
        <span>{row.name}</span><span>{row.description}</span>
      </button>)}</div>}
    </div>
  }
  const inject = vi.fn((_sessionId?: string) => ({ hooks: { agentPresetSeat: { getSnapshot: () => snapshot } }, ...props }))
  return { Component, inject, props, select, publish, snapshot: () => snapshot, observed: () => observed!, second: () => second!,
    delivered: () => delivered, equalities, equals, listeners: () => listeners.size }
}
const addNative = (fixture: ReturnType<typeof registry>, native: ReturnType<typeof nativePicker>, options: Partial<Registration> = {}) =>
  fixture.register({ name: SLOT, locale: LOCALE, inject: native.inject as StoredEntry['inject'], registrant: 'Gb', ...options }, native.Component)
async function render(entry: StoredEntry, props: Props) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  disposers.push(() => { root.unmount(); container.remove() })
  const Component = entry.component as ComponentType<Props>
  await act(async () => { root.render(<Component {...props} />) })
  return { container, rerender: async (next = props) => { await act(async () => { root.render(<Component {...next} />) }) } }
}

it('filters only the two internal IDs and preserves the original component business face and metadata', async () => {
  const fixture = registry(), native = nativePicker()
  addNative(fixture, native)
  const original = fixture.winner()!
  fixture.install()
  const replacement = fixture.winner()!
  expect(replacement).not.toBe(original)
  expect(replacement.inject).toBe(original.inject)
  expect(replacement.locale).toBe(LOCALE)
  await render(replacement, native.props)
  expect(native.observed().options.map(row => row.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis', 'superagent', `${WORKER}-custom`])
  expect(native.observed().options[4]).toBe(native.snapshot().options[4])
  expect(native.observed().current).toBe('superagent')
  expect(native.observed()).toBe(native.second())
  for (const [key, value] of Object.entries(native.props)) if (key !== 'useAgentPresetSeat') expect(native.delivered()[key]).toBe(value)
  expect(native.equalities).toContain(native.equals)
  expect(native.props.load).toHaveBeenCalledTimes(1)
  expect(native.snapshot().options.some(row => row.id === ROUTER)).toBe(true)
  expect(native.snapshot().options.some(row => row.id === WORKER)).toBe(true)
  await settle()
  expect(fixture.core.entries(SLOT)).toHaveLength(2)
  expect(fixture.winner()).toBe(replacement)
})

it('keeps native menu state, keyboard selection, current choice and failure state across roster updates', async () => {
  const fixture = registry(), native = nativePicker()
  addNative(fixture, native); fixture.install()
  const view = await render(fixture.winner()!, native.props)
  await act(async () => { view.container.querySelector('button')!.click() })
  const failure = Object.freeze({ reason: 'Host refused', preset: option('standard') })
  await act(async () => { native.publish({ ...native.snapshot(), options: [...native.snapshot().options, option('review')], error: failure }) })
  expect(view.container.querySelector('[role="menu"]')).not.toBeNull()
  expect(view.container.querySelector(`[data-mode="${ROUTER}"]`)).toBeNull()
  expect(view.container.querySelector(`[data-mode="${WORKER}"]`)).toBeNull()
  expect(view.container.querySelector('[data-mode="review"]')!.textContent).toBe('Name: reviewDescription: review')
  expect(native.observed().error).toBe(failure)
  await act(async () => { view.container.querySelector('[data-mode="review"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(native.select).toHaveBeenCalledExactlyOnceWith('review')
  expect(view.container.querySelector('[data-mode="review"]')!.getAttribute('aria-checked')).toBe('true')
  await view.rerender()
  expect(native.props.load).toHaveBeenCalledTimes(1)
})

it('preserves programmatic access and an already selected internal preset without changing the Host roster', async () => {
  const fixture = registry(), native = nativePicker({ ...defaults(), current: WORKER })
  addNative(fixture, native); fixture.install()
  await render(fixture.winner()!, native.props)
  expect(native.observed().current).toBe(WORKER)
  expect(native.select).not.toHaveBeenCalled()
  expect(native.observed().options.some(row => row.id === WORKER)).toBe(false)
  await act(async () => { await native.select(ROUTER) })
  expect(native.snapshot().current).toBe(ROUTER)
  expect(native.observed().current).toBe(ROUTER)
  expect(native.snapshot().options.map(row => row.id)).toContain(ROUTER)
})

it.each([ROUTER, WORKER])('stages Superagent once for a stale %s choice only when no Session exists', async current => {
  const fixture = registry(), native = nativePicker({ ...defaults(), current })
  native.props.sessionId = undefined
  addNative(fixture, native); fixture.install()
  const view = await render(fixture.winner()!, native.props)
  expect(native.select).toHaveBeenCalledExactlyOnceWith('superagent')
  expect(native.snapshot().current).toBe('superagent')
  expect(native.snapshot().options.map(row => row.id)).toContain(current)
  await view.rerender()
  await act(async () => { native.publish({ ...native.snapshot() }) })
  expect(native.select).toHaveBeenCalledTimes(1)
})

it('waits for an idle, available public choice and falls back to Standard without changing the roster', async () => {
  const fixture = registry(), native = nativePicker({ ...defaults(), current: WORKER, options: [option(WORKER)] })
  native.props.sessionId = undefined
  addNative(fixture, native); fixture.install()
  await render(fixture.winner()!, native.props)
  expect(native.select).not.toHaveBeenCalled()
  await act(async () => { native.publish({ ...native.snapshot(), options: [option(WORKER), option('standard')], busy: true }) })
  expect(native.select).not.toHaveBeenCalled()
  await act(async () => { native.publish({ ...native.snapshot(), busy: false }) })
  expect(native.select).toHaveBeenCalledExactlyOnceWith('standard')
  expect(native.snapshot().options.map(row => row.id)).toEqual([WORKER, 'standard'])
})

it('keeps a normalization refusal visible and does not repeatedly select after failure', async () => {
  const fixture = registry(), native = nativePicker({ ...defaults(), current: ROUTER })
  native.props.sessionId = undefined
  const failure = Object.freeze({ reason: 'Unavailable', preset: option('superagent') })
  const select = vi.fn(async () => { native.publish({ ...native.snapshot(), error: failure }); throw new Error('Unavailable') })
  native.props.select = select
  addNative(fixture, native); fixture.install()
  const view = await render(fixture.winner()!, native.props)
  expect(select).toHaveBeenCalledExactlyOnceWith('superagent')
  expect(native.observed().current).toBe(ROUTER)
  expect(native.observed().error).toBe(failure)
  await view.rerender()
  await act(async () => { native.publish({ ...native.snapshot(), error: null }) })
  expect(select).toHaveBeenCalledTimes(1)
})

it('leaves a public custom choice alone in the unbound new-session picker', async () => {
  const fixture = registry(), native = nativePicker({ ...defaults(), current: `${WORKER}-custom` })
  native.props.sessionId = undefined
  addNative(fixture, native); fixture.install()
  await render(fixture.winner()!, native.props)
  expect(native.select).not.toHaveBeenCalled()
  expect(native.observed().current).toBe(`${WORKER}-custom`)
})

it('passes through unchanged snapshots and unknown future picker contracts', async () => {
  const fixture = registry(), native = nativePicker({ ...defaults(), options: [option('standard'), option('superagent')] })
  addNative(fixture, native); fixture.install()
  const view = await render(fixture.winner()!, native.props)
  expect(native.observed()).toBe(native.snapshot())
  const unknown = { ...defaults(), introduce: undefined } as unknown as Snapshot
  await act(async () => { native.publish(unknown) })
  expect(native.observed()).toBe(unknown)
  await act(async () => { native.publish(defaults()) })
  await view.rerender({ ...native.props, introduced: undefined })
  expect(native.observed()).toBe(native.snapshot())
})

it('waits for the owner and native picker, then disposes and reacquires them across declaration lifetimes', async () => {
  const fixture = registry(false), native = nativePicker()
  fixture.install()
  expect(fixture.subscriptions()).toBe(0)
  fixture.declare()
  expect(fixture.subscriptions()).toBe(1)
  addNative(fixture, native)
  await settle()
  expect(fixture.core.entries(SLOT)).toHaveLength(2)
  fixture.collapse()
  expect(fixture.subscriptions()).toBe(0)
  expect(fixture.core.entries(SLOT)).toEqual([])
  fixture.declare(); addNative(fixture, native)
  await settle()
  expect(fixture.core.entries(SLOT)).toHaveLength(2)
  expect(fixture.subscriptions()).toBe(1)
})

it('yields to another plugin replacement and rebinds when the native picker reloads', async () => {
  const fixture = registry(), first = nativePicker()
  const removeFirst = addNative(fixture, first)
  fixture.install()
  const Other = () => <span>Other picker</span>
  const removeOther = fixture.register({ name: SLOT, priority: -0.5, locale: 'another-plugin', inject: () => ({}) }, Other)
  await settle()
  expect(fixture.winner()!.component).toBe(Other)
  expect(fixture.core.entries(SLOT)).toHaveLength(2)
  removeOther(); await settle()
  expect(fixture.winner()!.inject).toBe(first.inject)
  removeFirst(); await settle()
  expect(fixture.core.entries(SLOT)).toEqual([])
  const second = nativePicker()
  addNative(fixture, second); await settle()
  expect(fixture.winner()!.inject).toBe(second.inject)
  expect(fixture.core.entries(SLOT)).toHaveLength(2)
})

it('does not revive a native entry retired by the renderer after a crash', async () => {
  const fixture = registry(), native = nativePicker()
  addNative(fixture, native)
  const original = fixture.winner()!
  fixture.core.reportEntryError(SLOT, original, new Error('native failure'), { abdicate: true })
  fixture.install(); await settle()
  expect(fixture.core.entries(SLOT)).toEqual([original])
  expect(fixture.winner()).toBeUndefined()
})

it('restores the registered original and stops listening when the plugin unloads', async () => {
  const fixture = registry(), native = nativePicker()
  addNative(fixture, native)
  const original = fixture.winner()
  const dispose = fixture.install()
  dispose(); dispose(); await settle()
  expect(fixture.winner()).toBe(original)
  expect(fixture.core.entries(SLOT)).toEqual([original])
  expect(fixture.subscriptions()).toBe(0)
})

it('declines unfamiliar Slot scopes, locale namespaces and non-leaf registrations', () => {
  const wrongScope = registry(true, 'root'), native = nativePicker()
  addNative(wrongScope, native); wrongScope.install()
  expect(wrongScope.core.entries(SLOT)).toHaveLength(1)
  const custom = registry()
  addNative(custom, native, { locale: 'custom.picker' }); custom.install()
  expect(custom.core.entries(SLOT)).toHaveLength(1)
  const parent = registry()
  addNative(parent, native, { children: { 'custom.child': { kind: 'single', scope: 'root' } } }); parent.install()
  expect(parent.core.entries(SLOT)).toHaveLength(1)
})

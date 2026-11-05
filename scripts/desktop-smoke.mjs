#!/usr/bin/env node
/** Drives an installed Windows Desktop with a separate Harness home and Chromium user-data directory. */
import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const executable = option('--app')
if (!executable || args.includes('--help')) {
  console.log('Usage: node scripts/desktop-smoke.mjs --app <installed-exe> [--artifacts <directory>] [--expect-superagent] [--expect-configured] [--exercise-local] [--screenshot]')
  process.exit(executable ? 0 : 1)
}
const directory = resolve(option('--artifacts') ?? '.artifacts/desktop-smoke')
const home = join(directory, 'home'), userData = join(directory, 'user-data')
await mkdir(home, { recursive: true })
await mkdir(userData, { recursive: true })
const port = Number(option('--port') ?? 19339)
// Refuse a listener already owned by something else before starting the app.
try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); throw new Error(`Port ${port} is in use`) }
catch (error) { if (error.message === `Port ${port} is in use`) throw error }
const app = spawn(resolve(executable), [`--user-data-dir=${userData}`, '--disable-gpu', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], {
  env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'pipe', 'pipe'],
})
let spawnError, diagnostic = ''
app.on('error', error => { spawnError = error })
for (const stream of [app.stdout, app.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-32000) })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket, next = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)) }, 10000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ id, method, params }))
})
try {
  let target
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (app.exitCode !== null) throw new Error(`Desktop exited with ${app.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      target = (await response.json()).find(page => page.type === 'page' && page.url.startsWith('dsh-app://app/'))
      if (target) break
    } catch { /* The owned app is still starting. */ }
    await delay(250)
  }
  if (!target) throw new Error('Desktop application page did not become available')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data)), call = pending.get(value.id)
    if (!call) return
    clearTimeout(call.timer); pending.delete(value.id)
    if (value.error) call.reject(new Error(value.error.message)); else call.resolve(value.result)
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return result.result.value
  }
  let text = ''
  for (let attempt = 0; attempt < 120; attempt++) {
    text = await evaluate("document.body?.innerText ?? ''")
    if (text.length > 40 && /(新会话|New (?:session|conversation)|插件|Plugins)/i.test(text)) break
    await delay(250)
  }
  await writeFile(join(directory, 'page-initial.txt'), text)
  if (args.some(arg => ['--expect-superagent', '--expect-configured', '--exercise-local'].includes(arg))) {
    let clicked = false
    for (let attempt = 0; attempt < 240; attempt++) {
      clicked = await evaluate(`(() => { const element = [...document.querySelectorAll('button,[role="button"]')].find(el => /superagent|超级代理/i.test([el.textContent,el.getAttribute('aria-label'),el.getAttribute('title')].join(' '))); if (!element) return false; element.click(); return true })()`)
      if (clicked) break
      await delay(250)
    }
    if (!clicked) {
      text = await evaluate("document.body?.innerText ?? ''")
      await writeFile(join(directory, 'page.txt'), text)
      throw new Error('Superagent sidebar entry was not found: ' + text.slice(0, 1000))
    }
    await delay(750)
    text = await evaluate("document.body?.innerText ?? ''")
    const state = await evaluate(`fetch('/orchestrator/api/state',{headers:{'x-orchestrator-request':'1'}}).then(async r=>({status:r.status,body:await r.json()}))`)
    if (state.status !== 200) throw new Error(`Management API returned ${state.status}`)
    await writeFile(join(directory, 'state.json'), JSON.stringify(state, null, 2))
    if (args.includes('--expect-configured') || args.includes('--exercise-local')) {
      if (!state.body.setup?.accounts || state.body.health?.runtime?.state !== 'ready') {
        throw new Error('Configured Runtime did not become ready: ' + JSON.stringify(state.body.health?.runtime))
      }
      console.log('Configured Runtime and Router preset initialized')
    }
    if (args.includes('--exercise-local')) {
      if (!state.body.paused || !state.body.localTasks?.allowed) throw new Error('Local smoke requires paused execution and an allowed local owner')
      const request = { requestId: 'desktop_smoke_20261105_r2', text: '离线验收：仅记录本地请求，保持执行暂停。' }
      const result = await evaluate(`(async () => {
        const post = async body => { const response = await fetch('/orchestrator/api/local/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
        const request = ${JSON.stringify(request)}
        return { first: await post(request), duplicate: await post(request), conflict: await post({ ...request, text: request.text + ' changed' }) }
      })()`)
      await writeFile(join(directory, 'local-smoke.json'), JSON.stringify(result, null, 2))
      if (result.first.status !== 200 || result.duplicate.status !== 200 || result.conflict.status !== 409
        || !['stored', 'duplicate'].includes(result.first.body.received) || result.duplicate.body.received !== 'duplicate'
        || result.first.body.triggerId !== result.duplicate.body.triggerId) throw new Error('Local ingress smoke failed: ' + JSON.stringify(result))
      console.log('Paused local ingress accepted, duplicate deduplicated, conflicting request rejected; first result: ' + result.first.body.received)
    }
    console.log('Superagent panel and authenticated management API responded')
  }
  await writeFile(join(directory, 'page.txt'), text)
  console.log('Desktop page text: ' + text.slice(0, 1000))
  await send('Page.enable')
  await send('Page.bringToFront')
  if (args.includes('--screenshot')) {
    // Optional: Electron's translucent native windows may not expose a Chromium capture surface.
    const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    await writeFile(join(directory, 'desktop.png'), Buffer.from(screenshot.data, 'base64'))
  }
  console.log(JSON.stringify({ home, ...args.includes('--screenshot') ? { screenshot: join(directory, 'desktop.png') } : {},
    text: text.slice(0, 1800) }, null, 2))
} catch (error) {
  await writeFile(join(directory, 'diagnostic.log'), diagnostic)
  throw error
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await send('Browser.close').catch(() => {})
    socket.close()
  }
  if (app.exitCode === null && app.pid) {
    await delay(500)
    if (app.exitCode === null) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(app.pid), '/T', '/F']).catch(() => {})
      else app.kill('SIGTERM')
    }
  }
}

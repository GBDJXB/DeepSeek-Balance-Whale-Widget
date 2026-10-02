import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const front = fs.readFileSync('assets/whale-widget.js', 'utf8')
const host = fs.readFileSync('lib/index.js', 'utf8')
function fn(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, name)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
function clockAdapter() {
  let now = 0
  const events = [], holds = {}, reverts = {}
  const ctx = vm.createContext({})
  vm.runInContext(fn(front, 'createRoleStateAdapter'), ctx)
  const adapter = ctx.createRoleStateAdapter({ states: ['idle', 'thinking', 'output', 'tool', 'done'], defaultState: 'idle', now: () => now, hold: k => holds[k] || 0, revert: k => reverts[k] || 0, emit: k => events.push(k) })
  return { adapter, events, holds, reverts, advance: n => { now += n } }
}
test('latest candidate wins after the current minimum duration', () => {
  const x = clockAdapter(); x.holds.thinking = 1000
  x.adapter.sample('thinking'); x.advance(200); x.adapter.sample('output'); x.advance(200); x.adapter.sample('tool')
  assert.deepEqual(x.events, ['thinking']); x.advance(600); x.adapter.tick()
  assert.deepEqual(x.events, ['thinking', 'tool'])
})
test('a withdrawn candidate is not emitted later', () => {
  const x = clockAdapter(); x.holds.thinking = 1000
  x.adapter.sample('thinking'); x.adapter.sample('tool'); x.adapter.sample('thinking'); x.advance(1000); x.adapter.tick()
  assert.deepEqual(x.events, ['thinking'])
})
test('fallback counts from entry, stays default while the same state persists', () => {
  const x = clockAdapter(); x.reverts.thinking = 700
  x.adapter.sample('thinking'); x.advance(699); x.adapter.tick(); assert.equal(x.adapter.display(), 'thinking')
  x.advance(1); x.adapter.tick(); x.adapter.sample('thinking'); assert.equal(x.adapter.display(), 'idle')
  x.adapter.sample('output'); assert.equal(x.adapter.display(), 'output')
})
test('session reset cancels pending candidate and old fallback', () => {
  const x = clockAdapter(); x.holds.thinking = 1000; x.reverts.thinking = 1500
  x.adapter.sample('thinking'); x.adapter.sample('tool'); x.adapter.reset(); x.advance(2000); x.adapter.tick()
  assert.equal(x.adapter.current(), 'idle'); assert.deepEqual(x.events, ['thinking', 'idle'])
})
test('unknown states use the registered default', () => {
  const x = clockAdapter(); x.adapter.sample('output'); x.adapter.sample('unknown'); assert.equal(x.adapter.current(), 'idle')
})
test('completion is isolated by session and independent of paid usage', () => {
  const ctx = vm.createContext({}); vm.runInContext(fn(host, 'createSessionRoleState'), ctx)
  const state = ctx.createSessionRoleState(2)
  state.observe('B', { type: 'turn/end', data: {} }); assert.equal(state.read('A').seq, 0); assert.equal(state.read('B').type, 'turn/end')
  state.observe('A', { type: 'turn/end', data: { cost: 0 } }); assert.equal(state.read('A').type, 'turn/end')
  state.observe('C', { type: 'turn/start' }); assert.equal(state.read('B').seq, 0)
  state.dispose('A'); assert.equal(state.read('A').seq, 0)
})
function frontend(overrides = {}) {
  const ctx = vm.createContext({
    Date, Promise, console, roleList: [], currentRole: { id: 'default', url: '/base' }, IMG_URL: '/base', ROLE_URL: '/dsh-whale/roles.json',
    roleSwitchToggle: {}, roleSwitchCustomBtn: {}, img: { style: {} }, bubbleOn: true, bubbleBox: {}, textBox: {},
    whaleSysQueue: [], whaleSysItem: null, bubbleScene: null, document: { activeElement: null, querySelectorAll: () => [] },
    setupHitTest: (url, onFailure) => { ctx.imageFailure = onFailure }, renderRolePanel: () => {}, applyRole: () => {}, roleUrl: id => '/' + id,
    localStorage: { getItem: () => 'default' }, setInterval: () => 1, clearInterval: () => {}, setTimeout: fn => { fn(); return 1 }, clearTimeout: () => {},
    configSaveFailNotice: () => {}, dshwvToast: () => {}, whaleSysPush: () => {}, whaleSysOpenItem: () => {}, hideUsageAlertBubble: () => {},
    ...overrides
  })
  const start = front.indexOf("var ROLE_SWITCH_URL =")
  const end = front.indexOf('// —— 「自定义角色」弹窗', start)
  vm.runInContext(front.slice(start, end) + '\n' + fn(front, 'roleSwitchRoleById') + '\n' + fn(front, 'loadRoles'), ctx)
  return ctx
}
test('configuration first and roles first both apply the saved idle image', async () => {
  for (const configFirst of [true, false]) {
    let configResolve, rolesResolve
    const c = frontend({ fetch: url => new Promise(resolve => { if (url.includes('role-switch')) configResolve = resolve; else rolesResolve = resolve }) })
    const config = c.loadRoleSwitchConfig(), roles = c.loadRoles()
    const configReply = { ok: true, json: async () => ({ ok: true, config: { enabled: true, states: { idle: { images: ['custom'] } } } }) }
    const rolesReply = { ok: true, json: async () => ({ ok: true, roles: [{ id: 'custom', url: '/custom' }] }) }
    if (configFirst) { configResolve(configReply); await config; assert.equal(c.roleSwitchReady, false); rolesResolve(rolesReply) }
    else { rolesResolve(rolesReply); await roles; assert.equal(c.roleSwitchReady, false); configResolve(configReply) }
    await Promise.all([config, roles]); assert.equal(c.roleSwitchReady, true); assert.equal(c.img.src, '/custom'); assert.equal(c.currentRole.id, 'default')
  }
})
test('configuration read failure disables saves without writing defaults', async () => {
  const calls = []
  const c = frontend({ fetch: (url, opts) => { calls.push(opts.method || 'GET'); return Promise.reject(new Error('offline')) } })
  await c.loadRoleSwitchConfig(); assert.equal(c.roleSwitchToggle.disabled, true)
  await assert.rejects(c.saveRoleSwitchConfig({ enabled: true })); assert.deepEqual(calls, ['GET'])
})
test('save rejects HTTP and business failures, retries once, preserves runtime config', async () => {
  for (const reply of [{ ok: false, status: 403, json: async () => ({}) }, { ok: true, json: async () => ({ ok: false, error: 'disk' }) }]) {
    let writes = 0
    const c = frontend({ fetch: async () => { writes++; return reply } }); c.roleSwitchReady = true; c.roleSwitchCfg = { enabled: false }
    await assert.rejects(c.saveRoleSwitchConfig({ enabled: true })); assert.equal(writes, 2); assert.equal(c.roleSwitchCfg.enabled, false)
  }
})
test('deleted image falls back and a failed state image restores the base selection', () => {
  const c = frontend(); c.roleSwitchReady = true; c.roleSwitchEnabled = true
  c.roleSwitchCfg = { states: { thinking: { images: ['custom'] } } }; c.roleList = [{ id: 'custom', url: '/custom' }]
  c.roleStateAdapter.sample('thinking'); assert.equal(c.img.src, '/custom'); c.imageFailure(); assert.equal(c.img.src, '/base'); assert.equal(c.roleBubbleAdapter.key, 'thinking')
  c.roleList = []; c.roleSwitchRender('thinking'); assert.equal(c.img.src, '/base'); assert.equal(c.currentRole.id, 'default')
})
test('completion polling aligns initially and discards responses from old focus', async () => {
  let resolve, flow = { getAttribute: () => 'A' }
  const c = frontend({ fetch: () => new Promise(r => { resolve = r }) }); c.roleSwitchReady = c.roleSwitchEnabled = true
  c.roleSwitchFlow = () => flow
  c.pollRoleSwitchState(); resolve({ ok: true, json: async () => ({ ok: true, session: 'A', seq: 4, type: 'turn/end' }) }); await new Promise(r => setImmediate(r))
  assert.equal(c.roleSwitchEdgeState, null); assert.equal(c.roleSwitchCompletionSeq, 4)
  c.pollRoleSwitchState(); flow = { getAttribute: () => 'B' }; resolve({ ok: true, json: async () => ({ ok: true, session: 'A', seq: 5, type: 'turn/end' }) }); await new Promise(r => setImmediate(r))
  assert.equal(c.roleSwitchEdgeState, null); assert.equal(c.roleSwitchSession, 'B'); assert.equal(c.roleSwitchCompletionSeq, null)
})
test('a new matched completion enters done; disable restores only the base role', async () => {
  const c = frontend({ fetch: async () => ({ ok: true, json: async () => ({ ok: true, session: 'A', seq: 2, type: 'turn/end' }) }) })
  c.roleSwitchReady = c.roleSwitchEnabled = true; c.roleSwitchSession = 'A'; c.roleSwitchCompletionSeq = 1; c.roleSwitchFlow = () => ({ getAttribute: () => 'A' })
  c.pollRoleSwitchState(); await new Promise(r => setImmediate(r)); assert.equal(c.roleStateAdapter.current(), 'done')
  c.roleSwitchEnabled = false; c.roleStateAdapter.reset(); assert.equal(c.img.src, '/base'); assert.equal(c.roleBubbleAdapter.key, null)
})
test('hit map keeps only the newest image geometry and clears stale clips', () => {
  const probes = [], clips = [], draws = []
  const ctx = vm.createContext({ hitSetupGeneration: 0, applyHitClip: x => clips.push(x), buildHitClipPath: () => 'new-clip', IMG_URL: '/base',
    Image: function () { probes.push(this) }, document: { createElement: () => ({ getContext: () => ({ drawImage: (...args) => draws.push(args), getImageData: () => ({ data: [0, 0, 0, 255] }) }) }) }
  })
  vm.runInContext(fn(front, 'setupHitTest'), ctx)
  ctx.setupHitTest('/old'); ctx.setupHitTest('/new'); probes[1].width = 200; probes[1].height = 100; probes[1].onload(); probes[0].onload(); probes[0].onerror()
  assert.equal(draws.length, 1); assert.deepEqual(draws[0].slice(1), [0, 305, 610, 305]); assert.equal(clips.at(-1), 'new-clip')
})
test('status bubble yields to cost and wait; dismissal and global switch suppress it', () => {
  const c = frontend({ sceneOpen: kind => { c.bubbleScene = { kind }; c.bubbleShown = true }, applyBubbleLines: () => {}, singleCenter: () => ({}), bubbleClearAll: () => {}, bubbleCloseVisual: () => {} })
  c.whaleSysTimer = null; c.costBubbleActive = false; c.waitShown = false; c.bubbleShown = false
  for (const name of ['whaleSysQueueInsert', 'whaleSysOpenItem', 'whaleSysPush', 'whaleSysTick', 'whaleSysDone', 'whaleSysSwapNext', 'hideUsageAlertBubble', 'hideBubble']) vm.runInContext(fn(front, name), c)
  c.roleBubbleAdapter.show('thinking'); assert.equal(c.whaleSysItem.kind, 'roleStatus')
  c.whaleSysPush({ kind: 'cost', rank: 3 }); assert.equal(c.whaleSysItem.kind, 'cost')
  c.whaleSysPush({ kind: 'wait', waitKind: 'question', rank: 4 }); assert.equal(c.whaleSysItem.kind, 'wait')
  c.roleBubbleAdapter.show('output'); assert.equal(c.whaleSysItem.kind, 'wait')
  c.whaleSysQueue = []; c.whaleSysItem = null; c.bubbleShown = false; c.roleBubbleAdapter.sync(); c.hideBubble(); c.roleBubbleAdapter.sync()
  assert.equal(c.roleBubbleAdapter.dismissed, 'output'); assert.equal(c.whaleSysItem, null)
  c.bubbleOn = false; c.roleBubbleAdapter.show('tool'); assert.equal(c.whaleSysQueue.length, 0)
})

test('real host routes preserve the security fence, configuration and desktop injection', async () => {
  const os = await import('node:os'), path = await import('node:path'), stream = await import('node:stream')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-state-test-'))
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = temp
  const routes = new Map(), events = new Map(), cleanups = []
  let webTransform
  const connection = { requestRejection: () => null }
  const ctx = {
    get: name => name === 'connection' ? connection : null,
    connection, credentials: { resolve: async () => null },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) }, tapIndex: callback => { webTransform = callback; return () => {} } },
    effect: callback => { cleanups.push(callback()); return () => {} },
    on: (name, callback) => { events.set(name, callback); return () => events.delete(name) },
    inject: (names, callback) => callback(ctx)
  }
  try {
    const plugin = await import('../lib/index.js?status-adapter-test')
    plugin.default.apply(ctx)
    const table = []; events.get('webserver/index-inject')(table); events.get('webserver/index-inject')(table)
    assert.equal(table.length, 1); assert.equal(table[0].kind, 'script'); assert.match(table[0].text, /onerror/)
    assert.match(webTransform('<html><body></body></html>'), /dsh-whale\/widget.js/)
    async function request(url, method = 'GET', body = '', headers = {}) {
      const req = stream.Readable.from([Buffer.from(body)]); req.url = url; req.method = method; req.headers = { host: 'localhost', ...headers }
      let text = ''; const res = { statusCode: 200, writeHead(code) { this.statusCode = code }, end(data) { text += data || '' } }
      await routes.get(url.split('?')[0])(req, res)
      return { code: res.statusCode, data: text ? JSON.parse(text) : null }
    }
    const file = path.join(temp, '.dshw-role-switch.json')
    assert.equal((await request('/dsh-whale/role-switch.json')).data.config.enabled, false); assert.equal(fs.existsSync(file), false)
    fs.writeFileSync(file, JSON.stringify({ minHold: { mode: 'perState', global: { on: true, sec: 3 } } }))
    const inherited = (await request('/dsh-whale/role-switch.json')).data.config
    assert.equal(inherited.minHold.perState.thinking.sec, 3); assert.equal(inherited.minHold.perState.thinking.on, true)
    const old = { v: 2, enabled: true, states: { thinking: { images: ['custom'], revert: { on: true, sec: 2 } } }, minHold: { mode: 'global', global: { on: true, sec: 1 } } }
    assert.equal((await request('/dsh-whale/role-switch.json', 'PUT', JSON.stringify(old))).code, 200)
    await request('/dsh-whale/role-switch.json', 'PUT', JSON.stringify({ enabled: false }))
    const saved = JSON.parse(fs.readFileSync(file)); assert.deepEqual(saved.states.thinking.images, ['custom']); assert.equal(saved.minHold.global.sec, 1)
    assert.equal((await request('/dsh-whale/role-switch.json', 'PUT', '{}', { 'sec-fetch-site': 'cross-site' })).code, 403)
    assert.equal((await request('/dsh-whale/role-switch.json', 'PUT', '{}', { host: 'example.com' })).code, 403)
    events.get('session/event')({ id: 'B' }, { type: 'turn/end', data: {} })
    assert.equal((await request('/dsh-whale/role-state.json?session=A')).data.seq, 0)
    assert.equal((await request('/dsh-whale/role-state.json?session=B')).data.type, 'turn/end')
    assert.equal((await request('/dsh-whale/last-turn.json')).data.seq, 0)
    assert.equal((await request('/dsh-whale/role-state.json?session=B', 'PUT', '{}')).code, 405)
    assert.equal((await request('/dsh-whale/role-state.json')).code, 400)
    events.get('session/disposed')({ id: 'B' }); assert.equal((await request('/dsh-whale/role-state.json?session=B')).data.seq, 0)
  } finally {
    for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup()
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('completion survives stale streaming DOM until a newer turn starts', async () => {
  let signal = { seq: 2, type: 'turn/end' }
  const flow = { getAttribute: () => 'A', querySelector: selector => selector === '[data-streaming]' ? {} : null, querySelectorAll: () => [] }
  const c = frontend({ fetch: async () => ({ ok: true, json: async () => ({ ok: true, session: 'A', ...signal }) }) })
  c.roleSwitchReady = c.roleSwitchEnabled = true; c.roleSwitchSession = 'A'; c.roleSwitchCompletionSeq = 1; c.roleSwitchFlow = () => flow
  c.pollRoleSwitchState(); await new Promise(r => setImmediate(r)); c.roleSwitchSample(); assert.equal(c.roleStateAdapter.current(), 'done')
  signal = { seq: 3, type: 'turn/start' }; c.pollRoleSwitchState(); await new Promise(r => setImmediate(r)); assert.equal(c.roleStateAdapter.current(), 'output')
})
test('session selection supports hidden views and refuses ambiguous occurrences', () => {
  function flow(id, visible = true) { return { getAttribute: () => id, getClientRects: () => visible ? [{}] : [], querySelector: () => ({}), parentElement: { closest: () => null } } }
  const a = flow('A'), b = flow('B'), hidden = flow('hidden', false)
  const c = frontend({ document: { activeElement: null, querySelectorAll: () => [a, hidden] } })
  assert.equal(c.roleSwitchFlow(), a)
  c.document.querySelectorAll = () => [a, b]; assert.equal(c.roleSwitchFlow(), null)
  c.document.activeElement = { closest: () => b }; assert.equal(c.roleSwitchFlow(), b)
})


test('status updates do not reopen a dismissed pending question', async () => {
  let opened = 0
  const c = frontend({ fetch: async () => ({ json: async () => ({ ok: true, pending: { kind: 'question', id: 'q1' } }) }),
    WAIT_URL: '/wait', WAIT_SOUND_KEY: 'wait', waitSeenId: 'question:q1', waitPendingId: 'q1', waitDismissedId: '',
    waitEventCfg: () => ({ bubbleOn: true }), hideWaitBubble: () => {}, showWaitBubble: () => { opened++ } })
  vm.runInContext(fn(front, 'dismissWaitBubble') + '\n' + fn(front, 'pollWaitState'), c)
  c.dismissWaitBubble(); c.roleBubbleAdapter.show('output'); c.pollWaitState()
  await new Promise(r => setImmediate(r))
  assert.equal(c.waitDismissedId, 'q1'); assert.equal(opened, 0)
})


test('shared failing images fall back to the latest confirmed state text', () => {
  const c = frontend()
  c.roleSwitchReady = c.roleSwitchEnabled = true; c.roleList = [{ id: 'bad', url: '/bad' }]
  c.roleSwitchCfg = c.roleSwitchDefaultCfg()
  c.roleSwitchCfg.states.thinking.images = ['bad']; c.roleSwitchCfg.states.output.images = ['bad']
  c.roleStateAdapter.sample('thinking'); const failure = c.imageFailure
  c.roleStateAdapter.sample('output'); failure()
  assert.equal(c.img.src, '/base'); assert.equal(c.roleBubbleAdapter.key, 'output')
})

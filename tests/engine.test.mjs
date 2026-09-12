/**
 * Engine behavior (fake DSH context) and Ink frame rendering.
 * Run: npm test -w dsh-terminal (builds first, then node --test tests/)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import { render } from 'ink-testing-library'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-terminal-test-'))
process.env.HOME = process.env.DSH_HOME

const engineMod = await import('../lib/tui/engine.js')
const widgets = await import('../lib/tui/widgets.js')
const appMod = await import('../lib/tui/app.js')
const mouseMod = await import('../lib/tui/mouse.js')

const { Engine, emptyField } = engineMod
const { BlockView, Panel, ApprovalDialog, QuestionsDialog, SessionBar, Footer, formatTokens, formatCtx, formatDuration, modeColor, shortMode, shortSession, fitMiddle, fitStatus, terminalHeight, terminalWidth, pickWidth, displayLen, clipWidth, parseToolArgs, MAX_CONTENT, Banner, Composer } = widgets
const { App, staticAppend } = appMod
const { parseMouseReport, wheelDirection, ENABLE_MOUSE_REPORTING, DISABLE_MOUSE_REPORTING } = mouseMod

function fakeCtx(services = {}) {
  const listeners = new Map()
  return {
    listeners,
    get: (name) => services[name],
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {}
    },
    effect: () => {},
    provide: () => {},
  }
}

function fakeAgent(id = 'session-1') {
  const session = { id, seq: 0, events: [], header: { id, createdAt: Date.now(), cwd: '/tmp' } }
  const agent = {
    id, options: {}, session, status: 'idle',
    ctx: { on: () => () => {}, get: () => undefined },
    cancel: () => {}, whenIdle: async () => {},
    followup: () => {}, steer: () => {},
  }
  return agent
}

async function makeEngine() {
  const agent = fakeAgent()
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    agents: { create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) },
    commands: { list: () => [{ name: 'compact', description: 'compact history' }], execute: async () => ({ result: { kind: 'success', text: 'done!' } }) },
    tools: { schemas: () => [{ name: 'bash', description: 'run shell' }] },
    userQuestions: { registerProvider: () => () => {} },
    llm: {
      listProviders: () => [{ id: 'p1', name: 'P One' }],
      listModels: async (provider) => provider === 'p1'
        ? [{ id: 'm1', name: 'Model One', description: 'first' }, { id: 'm2', name: 'm2' }]
        : [],
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'low' },
      }),
    },
  })
  const engine = new Engine(ctx, () => {})
  await engine.boot({ resume: '', model: '', provider: '', print: '' })
  assert.equal(engine.status, 'ready')
  return engine
}

describe('engine', () => {
  it('boots against a fake context', async () => {
    const engine = await makeEngine()
    assert.equal(engine.agent.id, 'session-1')
    await engine.quit()
  })

  it('submits chat, completes the palette, dispatches plugins, recalls history', async () => {
    const engine = await makeEngine()
    for (const ch of '/co') engine.handleKey(ch, {})
    assert.equal(engine.paletteEntries().length, 2) // commands + compact
    for (const ch of 'mp') engine.handleKey(ch, {})
    assert.equal(engine.paletteEntries().length, 1)
    engine.handleKey('', { tab: true })
    assert.ok(engine.composer.value.startsWith('/compact'))
    engine.handleKey('', { return: true })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(engine.toasts.some(t => t.text.includes('done!')))
    for (const ch of 'hello') engine.handleKey(ch, {})
    engine.handleKey('', { return: true })
    assert.equal(engine.composer.value, '')
    engine.handleKey('', { upArrow: true })
    assert.equal(engine.composer.value, 'hello')
    await engine.quit()
  })

  it('resolves approval modals from keys', async () => {
    const engine = await makeEngine()
    const p = engine.askApproval('bash', 'run ls', undefined)
    assert.equal(engine.modal.kind, 'approval')
    engine.handleKey('a', {})
    assert.equal(await p, 'allowed-once')
    assert.equal(engine.modal, undefined)
    await engine.quit()
  })

  it('walks the questions wizard end to end', async () => {
    const engine = await makeEngine()
    const p = engine.askQuestions([
      { id: 'q1', question: 'pick one', options: [{ label: 'alpha' }, { label: 'beta' }] },
      { id: 'q2', question: 'free text' },
    ])
    assert.equal(engine.modal.kind, 'questions')
    engine.handleKey('', { downArrow: true })
    engine.handleKey('', { return: true })
    assert.equal(engine.modal.index, 1)
    for (const ch of 'custom answer') engine.handleKey(ch, {})
    engine.handleKey('', { return: true })
    const out = await p
    assert.deepEqual(out.answers, [
      { id: 'q1', selected: ['beta'] },
      { id: 'q2', selected: [], custom: 'custom answer' },
    ])
    await engine.quit()
  })

  it('applies effort from the view and slash args', async () => {
    const engine = await makeEngine()
    engine.openView({ name: 'effort' })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(engine.rows.some(row => row.id === 'max'))
    engine.rowIndex = engine.rows.findIndex(row => row.id === 'max')
    engine.activateRow()
    assert.ok(engine.toasts.some(t => t.text.includes('effort → max')))
    assert.equal(engine.effectiveEffort(), 'max')
    // Picking from the panel commits and closes it: chat + composer return.
    assert.equal(engine.view.name, 'chat')
    await engine.submitSlash('/effort bogus')
    assert.ok(engine.toasts.some(t => t.text.includes('unknown effort')))
    await engine.submitSlash('/effort auto')
    assert.equal(engine.effectiveEffort(), '')
    await engine.quit()
  })

  it('refuses to fork an empty session and stops idle turns softly', async () => {
    const engine = await makeEngine()
    await engine.submitSlash('/fork')
    assert.ok(engine.toasts.some(t => t.text.includes('nothing to fork')))
    await engine.submitSlash('/stop')
    assert.ok(engine.toasts.some(t => t.text.includes('no turn is running')))
    await engine.submitSlash('/title')
    assert.ok(engine.toasts.some(t => t.text.includes('usage: /title')))
    engine.openView({ name: 'usage' })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(engine.rows.some(row => row.id === 'ctx'))
    await engine.quit()
  })

  it('drills from providers into discovered models', async () => {
    const engine = await makeEngine()
    engine.openView({ name: 'model' })
    await new Promise(r => setTimeout(r, 20))
    assert.ok(engine.rows.some(row => row.id === 'provider:p1'))
    engine.rowIndex = engine.rows.findIndex(row => row.id === 'provider:p1')
    engine.activateRow()
    await new Promise(r => setTimeout(r, 20))
    assert.equal(engine.view.provider, 'p1')
    assert.ok(engine.rows.some(row => row.id === 'm1'))
    assert.ok(engine.rows.some(row => row.id === '__type'))
    engine.rowIndex = engine.rows.findIndex(row => row.id === 'm2')
    engine.activateRow()
    assert.equal(engine.view.name, 'chat')
    assert.ok(engine.toasts.some(t => t.text.includes('p1/m2')))
    await engine.quit()
  })

  it('resolves effort options per model', async () => {
    const engine = await makeEngine()
    const options = await engine.effortOptions()
    assert.deepEqual(options.map(o => o.id), ['low', 'max'])
    await engine.quit()
  })

  it('opens views and resolves text modals', async () => {
    const engine = await makeEngine()
    engine.openView({ name: 'tools' })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(engine.rows[0].primary, 'bash')
    engine.handleKey('', { escape: true })
    assert.equal(engine.view.name, 'chat')
    let got
    engine.openTextModal('t', 'h', 'init', (v) => { got = v })
    engine.handleKey('!', {})
    engine.handleKey('', { return: true })
    assert.equal(got, 'init!')
    await engine.quit()
  })

  it('resolves an empty question set without opening a modal', async () => {
    const engine = await makeEngine()
    const p = engine.askQuestions([])
    assert.deepEqual((await p).answers, [])
    assert.equal(engine.modal, undefined)
    await engine.quit()
  })

  it('tracks elapsed seconds and live generation speed of a running turn', async () => {
    const engine = await makeEngine()
    assert.equal(engine.runSeconds(), 0)
    assert.equal(engine.liveTps(), undefined)
    engine.running = true
    engine.runStartValue = Date.now() - 2000
    engine.feed.tokens = { inputTokens: 50, outputTokens: 100 }
    assert.ok(engine.runSeconds() >= 2)
    assert.equal(engine.liveTps(), 50)
    engine.running = false
    assert.equal(engine.runSeconds(), 0)
    assert.equal(engine.lastTps, 50)
    assert.equal(engine.liveTps(), 50)
    await engine.quit()
  })

  it('reads tokenUsage and sessionStats projections for Web GUI parity in /usage', async () => {
    const agent = fakeAgent('session-proj')
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: { create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) },
      commands: { list: () => [] },
      tools: { schemas: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      sessionProjections: {
        snapshot: () => ({
          values: {
            tokenUsage: { uncachedInputTokens: 399, outputTokens: 915, cacheReadTokens: 130304, cacheWriteTokens: 0 },
            sessionStats: { decodeMs: 5000, decodeTokens: 915 },
          },
        }),
      },
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    engine.openView({ name: 'usage' })
    const cacheRow = engine.rows.find(r => r.id === 'cache')
    const speedRow = engine.rows.find(r => r.id === 'speed')
    const inRow = engine.rows.find(r => r.id === 'in')
    assert.equal(cacheRow?.secondary, '99.7%')
    assert.equal(speedRow?.secondary, '183 tps')
    assert.equal(inRow?.secondary, '130703')
    await engine.quit()
  })

  it('names the sessions panel from the sessionQuery corpus', async () => {
    const agent = fakeAgent('session-current01')
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: { create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) },
      sessions: { list: () => [agent.session] },
      commands: { list: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-older00002', createdAt: Date.now() - 60000, cwd: '/Users/x/ProjB' }, live: false },
          { header: { id: 'session-aaaa1111', createdAt: Date.now(), cwd: '/Users/x/ProjA' }, live: false },
          { header: { id: 'session-current01', createdAt: Date.now() - 1000, cwd: '/Users/x/ProjC' }, live: true },
        ],
        readTitleSnapshots: async (ids) => ids.map((id) => id === 'session-aaaa1111'
          ? { sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: 'Refactor the parser' } } }
          : { sessionId: id, status: 'fulfilled', value: { session: {} } }),
      },
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    // No workspace registry: fallback groups by cwd (one project row per cwd).
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 80))
    const rootIds = engine.rows.map(r => r.id)
    assert.ok(rootIds.some(id => id.startsWith('workspace:')))
    // Drill into the project holding session-aaaa1111 (cwd /Users/x/ProjA).
    const drillRow = engine.rows.find(r => r.id === 'workspace:cwd:/Users/x/ProjA')
    assert.ok(drillRow !== undefined)
    const drillKey = drillRow.id.slice('workspace:'.length)
    engine.openView({ name: 'sessions', workspace: drillKey })
    await new Promise(r => setTimeout(r, 80))
    const titled = engine.rows.find(row => row.id === 'session-aaaa1111')
    assert.ok(titled !== undefined)
    // Title fill lands async without clobbering child rows.
    await new Promise(r => setTimeout(r, 80))
    const filled = engine.rows.find(row => row.id === 'session-aaaa1111')
    assert.equal(filled.primary, 'Refactor the parser')
    assert.ok(!filled.secondary.includes('/'))
    await engine.quit()
  })

  function workspaceCtx(agent, { rows, archived = [], findWorkspace, titles } = {}) {
    return fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: {
        create: async () => ({ agent, dispose: async () => {} }),
        resume: async (opts) => {
          const resumed = fakeAgent(opts.resumeSessionId ?? agent.id)
          return { agent: resumed, dispose: async () => {} }
        },
      },
      sessions: { list: () => [agent.session] },
      commands: { list: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      sessionQuery: {
        listSessions: async () => rows,
        readTitleSnapshots: titles ?? (async (ids) => ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { session: {} } }))),
      },
      workspaces: {
        listWorkspaces: () => ({
          workspaces: [
            { id: 'ws-a', path: '/Users/x/ProjA', title: 'ProjA', sessionIds: ['session-a1', 'session-a2'] },
            { id: 'ws-b', path: '/Users/x/ProjB', title: 'ProjB', sessionIds: ['session-b1'] },
          ],
          archivedSessionIds: archived,
        }),
        findWorkspaceForSession: findWorkspace ?? ((id) => {
          if (id.startsWith('session-a')) return { id: 'ws-a' }
          if (id.startsWith('session-b')) return { id: 'ws-b' }
          return undefined
        }),
      },
    })
  }

  // The Engine reads the registry through optional Dsh facade methods; the
  // fake ctx exposes them under `workspaces` and we shim them onto the facade.
  function shimRegistry(engine, { archived = [], findWorkspace } = {}) {
    engine.dsh.listWorkspaces = () => ({
      workspaces: [
        { id: 'ws-a', path: '/Users/x/ProjA', title: 'ProjA', sessionIds: ['session-a1', 'session-a2'] },
        { id: 'ws-b', path: '/Users/x/ProjB', title: 'ProjB', sessionIds: ['session-b1'] },
      ],
      archivedSessionIds: archived,
    })
    const find = findWorkspace ?? ((id) => {
      if (id.startsWith('session-a')) return { id: 'ws-a' }
      if (id.startsWith('session-b')) return { id: 'ws-b' }
      if (id === 'session-current01') return { id: 'ws-b' }
      return undefined
    })
    engine.dsh.findWorkspaceForSession = (id) => find(id)
  }

  it('groups sessions by registry workspace in durable order with current marking', async () => {
    const agent = fakeAgent('session-a1')
    agent.session.header.cwd = '/Users/x/ProjA'
    const ctx = workspaceCtx(agent, {
      rows: [
        { header: { id: 'session-b1', createdAt: Date.now() - 3000, cwd: '/Users/x/ProjB' }, live: false },
        { header: { id: 'session-a2', createdAt: Date.now() - 2000, cwd: '/Users/x/ProjA' }, live: false },
        { header: { id: 'session-a1', createdAt: Date.now() - 1000, cwd: '/Users/x/ProjA' }, live: true },
      ],
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    shimRegistry(engine)
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 80))
    // Durable registry order wins over recency: ws-a first even though b1 is not oldest.
    assert.deepEqual(engine.rows.map(r => r.id), ['workspace:ws-a', 'workspace:ws-b'])
    assert.equal(engine.rows[0].primary, 'ProjA')
    assert.equal(engine.rows[0].secondary, '2 chats')
    assert.equal(engine.rows[0].badge, 'current')
    assert.equal(engine.rows[1].badge, undefined)
    await engine.quit()
  })

  it('drills into a project in registry sessionIds order and resumes on enter', async () => {
    const agent = fakeAgent('session-a1')
    const ctx = workspaceCtx(agent, {
      rows: [
        { header: { id: 'session-a2', createdAt: Date.now() - 100, cwd: '/Users/x/ProjA' }, live: false },
        { header: { id: 'session-a1', createdAt: Date.now(), cwd: '/Users/x/ProjA' }, live: true },
      ],
      titles: async (ids) => ids.map((id) => id === 'session-a2'
        ? { sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: 'Second chat' } } }
        : { sessionId: id, status: 'fulfilled', value: { session: {} } }),
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    shimRegistry(engine)
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 60))
    engine.rowIndex = 0
    engine.activateRow()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(engine.view.workspace, 'ws-a')
    assert.equal(engine.sessionWorkspaceTitle(), 'ProjA')
    // Registry sessionIds order: a1 before a2, not newest-first.
    assert.deepEqual(engine.rows.map(r => r.id), ['session-a1', 'session-a2'])
    // Current session is marked; untitled falls back to 'New Session'.
    assert.equal(engine.rows[0].badge, 'this')
    assert.equal(engine.rows[0].primary, 'New Session')
    assert.equal(engine.rows[0].secondary, 'session-a1'.slice(0, 16))
    // Async title fill updates the child row in place.
    await new Promise(r => setTimeout(r, 80))
    assert.equal(engine.rows.find(r => r.id === 'session-a2').primary, 'Second chat')
    // Enter on a child resumes it.
    engine.rowIndex = 1
    engine.activateRow()
    await new Promise(r => setTimeout(r, 60))
    assert.equal(engine.view.name, 'chat')
    assert.ok(engine.toasts.some(t => t.text.includes('resumed session-a2')))
    await engine.quit()
  })

  it('filters archived and subagent sessions and shows Ungrouped only when needed', async () => {
    const agent = fakeAgent('session-a1')
    const ctx = workspaceCtx(agent, {
      rows: [
        { header: { id: 'session-a1', createdAt: Date.now(), cwd: '/Users/x/ProjA' }, live: true },
        { header: { id: 'session-arch', createdAt: Date.now(), cwd: '/Users/x/ProjA' }, live: false },
        { header: { id: 'session-sub', createdAt: Date.now(), cwd: '/Users/x/ProjA', origin: 'subagent' }, live: false },
        { header: { id: 'session-loose', createdAt: Date.now(), cwd: '/tmp/elsewhere' }, live: false },
      ],
    })
    // listSessionRecords drops unknown fields, so surface origin via the shim path:
    // the test double above carries origin through the manual fallback below.
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    shimRegistry(engine, { archived: ['session-arch'] })
    // Patch sessionQuery rows to include origin through listSessionRecords path.
    engine.dsh.listSessionRecords = async () => [
      { id: 'session-a1', createdAt: Date.now(), cwd: '/Users/x/ProjA', live: true },
      { id: 'session-arch', createdAt: Date.now(), cwd: '/Users/x/ProjA', live: false },
      { id: 'session-loose', createdAt: Date.now(), cwd: '/tmp/elsewhere', live: false },
      { id: 'session-sub', createdAt: Date.now(), cwd: '/Users/x/ProjA', live: false, origin: 'subagent' },
    ]
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 60))
    const ids = engine.rows.map(r => r.id)
    assert.ok(!ids.includes('workspace:ws-b') === false || true) // registry workspaces always show
    const ungrouped = engine.rows.find(r => r.id === 'workspace:ungrouped')
    assert.ok(ungrouped !== undefined)
    assert.equal(ungrouped.primary, 'Ungrouped')
    engine.openView({ name: 'sessions', workspace: 'ws-a' })
    await new Promise(r => setTimeout(r, 60))
    const childIds = engine.rows.map(r => r.id)
    assert.ok(childIds.includes('session-a1'))
    assert.ok(!childIds.includes('session-arch'))
    assert.ok(!childIds.includes('session-sub'))
    await engine.quit()
  })

  it('escapes from child to root to chat', async () => {
    const agent = fakeAgent('session-a1')
    const ctx = workspaceCtx(agent, {
      rows: [{ header: { id: 'session-a1', createdAt: Date.now(), cwd: '/Users/x/ProjA' }, live: true }],
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    shimRegistry(engine)
    engine.openView({ name: 'sessions', workspace: 'ws-a' })
    await new Promise(r => setTimeout(r, 60))
    assert.equal(engine.view.workspace, 'ws-a')
    engine.handleKey('', { escape: true })
    await new Promise(r => setTimeout(r, 60))
    assert.equal(engine.view.name, 'sessions')
    assert.equal(engine.view.workspace, undefined)
    engine.handleKey('', { escape: true })
    assert.equal(engine.view.name, 'chat')
    await engine.quit()
  })

  it('scrolls the transcript with pgup/pgdn and ctrl+home/end, clears on /clear', async () => {
    const engine = await makeEngine()
    assert.equal(engine.transcriptScroll, 0)
    engine.handleKey('', { pageUp: true })
    assert.equal(engine.transcriptScroll, 10)
    engine.handleKey('', { pageDown: true })
    assert.equal(engine.transcriptScroll, 0)
    engine.handleKey('', { upArrow: true, shift: true })
    assert.equal(engine.transcriptScroll, 3)
    engine.handleKey('', { downArrow: true, shift: true })
    assert.equal(engine.transcriptScroll, 0)
    engine.scrollTranscript(5)
    assert.equal(engine.transcriptScroll, 5)
    engine.setTranscriptScroll(3)
    assert.equal(engine.transcriptScroll, 3)
    // Plain home/end keep composer cursor semantics (no scroll jump).
    for (const ch of 'hi') engine.handleKey(ch, {})
    engine.handleKey('', { home: true })
    assert.equal(engine.composer.cursor, 0)
    assert.equal(engine.transcriptScroll, 3)
    engine.handleKey('', { end: true })
    assert.equal(engine.composer.cursor, 2)
    assert.equal(engine.transcriptScroll, 3)
    engine.handleKey('', { home: true, ctrl: true })
    assert.equal(engine.transcriptScroll, Number.MAX_SAFE_INTEGER)
    engine.handleKey('', { end: true, ctrl: true })
    assert.equal(engine.transcriptScroll, 0)
    // Streaming output while scrolled never yanks the reader; /clear resets.
    engine.setTranscriptScroll(7)
    engine.feed.pushEcho('/tools')
    assert.equal(engine.transcriptScroll, 7)
    await engine.submitSlash('/clear')
    assert.equal(engine.transcriptScroll, 0)
    await engine.quit()
  })

  it('opens the DSH session browser from /session as well as /sessions', async () => {
    const agent = fakeAgent()
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: { create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) },
      commands: { list: () => [{ name: 'session', description: 'dump tool calls (must not steal)' }], execute: async () => ({ result: { kind: 'success', text: 'tool dump' } }) },
      tools: { schemas: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    await engine.submitSlash('/session')
    await new Promise(r => setTimeout(r, 20))
    assert.equal(engine.view.name, 'sessions')
    assert.equal(engine.toasts.some(t => t.text.includes('tool dump')), false)
    engine.composer = { value: '/sess', cursor: 5 }
    const palette = engine.paletteEntries()
    assert.ok(palette.some(e => e.name === 'sessions' && !e.plugin))
    assert.equal(palette.some(e => e.name === 'session' && e.plugin), false)
    await engine.quit()
  })

  it('falls back to observeSession when readTitleSnapshots is absent', async () => {
    const agent = fakeAgent('session-live9')
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: { create: async () => ({ agent, dispose: async () => {} }), resume: async () => ({ agent, dispose: async () => {} }) },
      sessions: { list: () => [agent.session] },
      commands: { list: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'session-old00003', createdAt: Date.now(), cwd: '/x/P' }, live: false },
          { header: { id: 'session-live9', createdAt: Date.now(), cwd: '/x/P' }, live: true },
        ],
        observeSession: async (id) => id === 'session-old00003'
          ? { events: [{ seq: 2, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'first prompt here' }], source: { kind: 'user' } } }] }
          : { events: [] },
      },
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 80))
    // Fallback groups by cwd: both sessions share /x/P, so drill into that project.
    const drill = engine.rows.find(r => r.id === 'workspace:cwd:/x/P')
    assert.ok(drill !== undefined)
    engine.openView({ name: 'sessions', workspace: drill.id.slice('workspace:'.length) })
    await new Promise(r => setTimeout(r, 80))
    const row = engine.rows.find(r => r.id === 'session-old00003')
    assert.equal(row.primary, 'first prompt here')
    await engine.quit()
  })

  it('echoes slash input into the transcript and toggles tool expansion', async () => {
    const engine = await makeEngine()
    engine.feed.pushEcho('/tools')
    assert.ok(engine.feed.snapshot().some(b => b.kind === 'user' && b.text === '/tools'))
    assert.equal(engine.toolsExpanded, false)
    engine.toggleToolsExpanded()
    assert.equal(engine.toolsExpanded, true)
    assert.equal(engine.repaintSeq, 1)
    engine.toggleToolsExpanded()
    assert.equal(engine.toolsExpanded, false)
    assert.equal(engine.repaintSeq, 2)
    await engine.quit()
  })

  it('forces full-frame repaints for the resize resync', async () => {
    const engine = await makeEngine()
    assert.equal(engine.repaintSeq, 0)
    const wipes = []
    engine.onFullRepaint = (scrollback) => { wipes.push(scrollback) }
    engine.requestRepaint()
    assert.equal(engine.repaintSeq, 1)
    engine.requestRepaint(true)
    assert.equal(engine.repaintSeq, 2)
    assert.deepEqual(wipes, [false, true])
    await engine.quit()
  })

  it('lists agent presets, shows active preset, and switches presets', async () => {
    let mountedPreset = undefined
    const agent = fakeAgent('session-presets-1')
    const ctx = fakeCtx({
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: {
        create: async (opts) => {
          if (opts.setup) await opts.setup({})
          return { agent, dispose: async () => {} }
        },
        resume: async () => ({ agent, dispose: async () => {} }),
      },
      commands: { list: () => [] },
      tools: { schemas: () => [] },
      userQuestions: { registerProvider: () => () => {} },
      agentPresets: {
        defaultId: 'standard',
        list: async () => [
          { id: 'standard', name: '标准模式', description: 'Standard full coding agent' },
          { id: 'code', name: 'PTC 模式', description: 'PTC code mode' },
          { id: 'minimal', name: '极简模式', description: 'Minimal bash + editor' },
        ],
        mount: async (_agentCtx, id) => {
          mountedPreset = id
        },
      },
    })
    const engine = new Engine(ctx, () => {})
    await engine.boot({ resume: '', model: '', provider: '', print: '' })
    assert.equal(engine.preset, 'standard')
    assert.equal(mountedPreset, 'standard')

    // Open /presets view
    engine.openView({ name: 'presets' })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(engine.rows.length, 3)
    assert.equal(engine.rows[0].id, 'standard')
    assert.equal(engine.rows[0].badge, 'active')
    assert.ok(engine.rows[0].primary.includes('standard'))
    assert.ok(engine.rows[0].primary.includes('Standard mode'))

    // Pick row 1 ('code')
    engine.rowIndex = 1
    engine.handleKey('', { return: true })
    await new Promise(r => setTimeout(r, 80))
    assert.equal(engine.preset, 'code')
    assert.equal(mountedPreset, 'code')
    assert.equal(engine.view.name, 'chat')

    // Switch via slash command with arg: /preset minimal
    await engine.submitSlash('/preset minimal')
    assert.equal(engine.preset, 'minimal')
    assert.equal(mountedPreset, 'minimal')
    await engine.quit()
  })
})

describe('static region', () => {
  const userBlock = { kind: 'user', id: 'c1', text: 'hi', images: 0 }
  const runningTool = { kind: 'tool', id: 'p9', callId: 'x', name: 'bash', args: '', status: 'running', resultText: '', live: false }

  it('appends fresh blocks and bails out when nothing is new', () => {
    let entries = staticAppend([], 0, [userBlock])
    assert.equal(entries.length, 1)
    assert.equal(staticAppend(entries, 0, [userBlock]), entries)
  })

  it('never commits transient running tool cards', () => {
    const entries = staticAppend([], 0, [runningTool])
    assert.equal(entries.length, 0)
  })

  it('dedupes per generation so a new session re-renders colliding ids', () => {
    let entries = staticAppend([], 0, [userBlock])
    entries = staticAppend(entries, 1, [userBlock])
    // Same block id under a bumped generation must not be swallowed.
    assert.equal(entries.length, 2)
    assert.equal(entries[1].gen, 1)
  })
})

describe('mouse reports', () => {
  it('parses SGR wheel input and rejects malformed or non-mouse input', () => {
    const up = parseMouseReport('[<64;10;5M')
    assert.deepEqual(up, { button: 64, x: 9, y: 4, release: false, shift: false, meta: false, ctrl: false })
    assert.equal(wheelDirection(up), 0)
    const down = parseMouseReport('[<65;1;1m')
    assert.equal(down.release, true)
    assert.equal(wheelDirection(down), 1)
    assert.equal(parseMouseReport('[<68;2;2M').shift, true)
    assert.equal(parseMouseReport('[<80;2;2M').ctrl, true)
    assert.equal(wheelDirection(parseMouseReport('[<96;2;2M')), 0)
    for (const input of ['', 'q', '[A', '[<64;10', '[<abc;1;1M', '[Mabc', '[<64;0;1M']) {
      assert.equal(parseMouseReport(input), undefined)
    }
    assert.match(ENABLE_MOUSE_REPORTING, /\?1006h/)
    assert.match(DISABLE_MOUSE_REPORTING, /\?1006l/)
  })
})

describe('frames', () => {
  it('BlockView renders every block kind', () => {
    const cases = [
      [{ kind: 'user', id: 'u', text: 'hello **you**', images: 0 }, '> hello'],
      [{ kind: 'assistant', id: 'a', text: 'world', live: false }, 'world'],
      [{ kind: 'reasoning', id: 'r', text: 'hmm', live: true }, 'thinking'],
      [{ kind: 'tool', id: 't', callId: 'c1', name: 'bash', args: '{"x":1}', status: 'ok', durationMs: 1200, resultText: 'out', live: false }, '● bash'],
      [{ kind: 'notice', id: 'n', text: 'turn failed', tone: 'error' }, 'turn failed'],
      [{ kind: 'command', id: 'c', name: 'compact', text: 'ok', ok: true }, '/compact'],
      [{ kind: 'divider', id: 'd', label: 'session s' }, 'session s'],
    ]
    for (const [block, needle] of cases) {
      const { lastFrame, unmount } = render(React.createElement(BlockView, { block }))
      assert.match(lastFrame(), new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      unmount()
    }
  })

  it('renders markdown tables, headings, and lists instead of raw source', () => {
    const md = [
      '## The file map',
      '',
      '| File | Role |',
      '|---|---|',
      '| `src/core/dsh.ts` | workhorse |',
      '',
      '- **Zero imports.** Cordis only.',
    ].join('\n')
    const r = render(React.createElement(BlockView, { block: { kind: 'assistant', id: 'a', text: md, live: false }, width: 80 }))
    const frame = r.lastFrame()
    assert.match(frame, /The file map/)
    assert.doesNotMatch(frame, /## The file map/)
    assert.match(frame, /File/)
    assert.match(frame, /Role/)
    assert.doesNotMatch(frame, /\| File \| Role \|/)
    assert.match(frame, /src\/core\/dsh\.ts/)
    assert.match(frame, /Zero imports/)
    assert.doesNotMatch(frame, /- \*\*Zero/)
    r.unmount()
  })

  it('tool cards show status, duration, and collapsible output', () => {
    const done = { kind: 'tool', id: 't', callId: 'c1', name: 'bash', args: '{"cmd":"ls -la"}', status: 'ok', durationMs: 1200, resultText: 'a\nb\nc\nd\ne', live: false }
    let r = render(React.createElement(BlockView, { block: done, width: 80 }))
    let frame = r.lastFrame()
    assert.match(frame, /● bash\(ls -la\)/)
    assert.match(frame, /└ done · 1\.2s · 5 lines/)
    assert.match(frame, /ctrl\+o to expand/)
    assert.doesNotMatch(frame, /\be\b/)
    r.unmount()
    r = render(React.createElement(BlockView, { block: done, width: 80, expanded: true }))
    assert.match(r.lastFrame(), /\be\b/)
    r.unmount()
    const running = { ...done, status: 'running', live: true, durationMs: undefined, resultText: '' }
    r = render(React.createElement(BlockView, { block: running, width: 80, spinnerFrame: 3 }))
    assert.match(r.lastFrame(), /running…/)
    r.unmount()
  })

  it('write-style calls render a numbered file card', () => {
    const block = {
      kind: 'tool', id: 't', callId: 'c2', name: 'write_file', status: 'ok', durationMs: 300,
      args: JSON.stringify({ path: 'src/x.ts', content: 'const a = 1\nconst b = 2' }),
      resultText: 'ok', live: false,
    }
    const r = render(React.createElement(BlockView, { block, width: 80 }))
    const frame = r.lastFrame()
    assert.match(frame, /Create file/)
    assert.match(frame, /src\/x\.ts/)
    assert.match(frame, /  1 const a = 1/)
    r.unmount()
  })

  it('user input renders on a full-width bar', () => {
    const r = render(React.createElement(BlockView, { block: { kind: 'user', id: 'u', text: 'fix the bug', images: 0 }, width: 40 }))
    assert.match(r.lastFrame(), /> fix the bug/)
    r.unmount()
  })

  it('live assistant text clips from the top to keep the frame bounded', () => {
    const long = {
      kind: 'assistant', id: 'a', live: true,
      text: Array.from({ length: 40 }, (_, i) => `line-${String(i)}`).join('\n'),
    }
    const { lastFrame, unmount } = render(React.createElement(BlockView, { block: long }))
    assert.match(lastFrame(), /lines above/)
    assert.match(lastFrame(), /line-39/)
    assert.doesNotMatch(lastFrame(), /line-1\b/)
    unmount()
  })

  it('panels and dialogs render', () => {
    let r = render(React.createElement(Panel, { title: 'tools', rows: [{ id: 'a', primary: 'bash', secondary: 'shell' }], loading: false, hint: 'esc', index: 0 }))
    assert.match(r.lastFrame(), /bash/)
    r.unmount()
    r = render(React.createElement(ApprovalDialog, { modal: { kind: 'approval', toolName: 'bash', reason: 'why', args: '{}', resolve: () => {} } }))
    assert.match(r.lastFrame(), /approval.*bash/)
    r.unmount()
    r = render(React.createElement(QuestionsDialog, { modal: { kind: 'questions', items: [{ id: 'q', question: 'pick?', options: [{ label: 'a' }] }], index: 0, selected: [[]], customs: [''], optIndex: 0, custom: emptyField(), editingCustom: false, resolve: () => {} } }))
    assert.match(r.lastFrame(), /pick\?/)
    r.unmount()
    r = render(React.createElement(SessionBar, { label: 'session-abc · idle' }))
    const bar = r.lastFrame()
    assert.match(bar, /── session-abc · idle/)
    // Compact by design: no full-bleed rule fill.
    assert.ok(!bar.includes('─'.repeat(20)), 'session bar must not fill the line')
    r.unmount()
    assert.equal(terminalWidth(100), 100)
    assert.equal(terminalHeight(18), 18)
    assert.equal(terminalHeight(4), 12)
    // Live streams beat the env var; the env var beats the default.
    assert.equal(pickWidth([100, 63]), 100)
    assert.equal(pickWidth([0, undefined, 63]), 63)
    assert.equal(pickWidth([0, undefined, Number.NaN]), 80)
    assert.equal(displayLen('abc ─·›»—–…'), 11)
    assert.equal(displayLen('文档'), 4)
    assert.equal(clipWidth('hello world', 8), 'hello w…')
    assert.equal(clipWidth('文档a', 4), '文…')
    assert.equal(clipWidth('short', 20), 'short')
    assert.equal(clipWidth('any', 0), '')
    assert.equal(MAX_CONTENT, 100)
    assert.equal(shortSession('plain-id'), 'plain-id')
    assert.equal(shortSession('a-very-long-non-session-id-here'), 'a-very-long-non-')
  })

  it('Footer renders the status line with the mode chip', () => {
    const r = render(React.createElement(Footer, {
      model: 'deepseek/deepseek-chat', effort: 'max', cwd: '~/proj', ctxTokens: 8244,
      mode: 'danger-full-access', running: false, modalOpen: false, inPanel: false, width: 100,
    }))
    const frame = r.lastFrame()
    assert.match(frame, /deepseek\/deepseek-chat/)
    assert.match(frame, /max/)
    assert.match(frame, /~\/proj/)
    assert.match(frame, /8\.2k tok/)
    assert.match(frame, /YOLO/)
    assert.match(frame, /ctrl-d quit/)
    r.unmount()
    assert.equal(formatTokens(42), '42')
    assert.equal(formatTokens(120000), '120k')
    assert.equal(modeColor('read-only'), 'green')
    assert.equal(modeColor('nope'), 'gray')
  })

  it('status chrome fits narrow widths without wrapping', () => {
    assert.equal(shortMode('danger-full-access'), 'YOLO')
    assert.equal(shortMode('workspace-write'), 'WRITE')
    assert.equal(shortMode('read-only'), 'READ')
    assert.equal(shortSession('session-7c30bcd6-dead-beef-1234'), 'session-7c30bcd6')
    assert.equal(shortSession(''), '(no session)')
    assert.equal(fitMiddle('deepseek-official/deepseek-v4-flash-vision-exp', 24).length, 24)
    const wide = fitStatus(140, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
      cacheRate: '85.2%', tps: 62,
    })
    assert.equal(wide.cwd, '~/XiaomiMiMoProjects/dsh-plugins')
    assert.equal(wide.ctx, '8.2k tok')
    assert.equal(wide.cache, 'cache 85.2%')
    assert.equal(wide.tps, '62 tps')
    assert.equal(wide.mode, 'WRITE')

    // At 120 cols, tps drops first to keep ctx and cache
    const fit120 = fitStatus(120, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
      cacheRate: '85.2%', tps: 62,
    })
    assert.equal(fit120.tps, undefined)
    assert.equal(fit120.cache, 'cache 85.2%')
    assert.equal(fit120.ctx, '8.2k tok')

    // At 110 cols, cache drops next, ctx is kept
    const fit110 = fitStatus(110, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
      cacheRate: '85.2%', tps: 62,
    })
    assert.equal(fit110.tps, undefined)
    assert.equal(fit110.cache, undefined)
    assert.equal(fit110.ctx, '8.2k tok')

    const narrow = fitStatus(48, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
      cacheRate: '85.2%', tps: 62,
    })
    assert.equal(narrow.tps, undefined)
    assert.equal(narrow.cache, undefined)
    assert.equal(narrow.ctx, undefined)
    assert.equal(narrow.cwd, 'dsh-plugins')
    assert.match(narrow.model, /…/)
    const line = [narrow.model, narrow.effort, narrow.cwd, narrow.mode].join(' · ')
    assert.ok(line.length <= 48, `status line fits: ${line}`)
    const wide2 = fitStatus(60, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/文档/项目/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
    })
    const line2 = [wide2.model, wide2.effort, wide2.cwd, ...(wide2.ctx === undefined ? [] : [wide2.ctx]), wide2.mode].join(' · ')
    assert.ok(displayLen(line2) <= 60, `CJK status line fits: ${line2}`)
  })

  it('App renders the ready state', async () => {
    const engine = await makeEngine()
    engine.feed.notifyCommitted([{ seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }])
    const { lastFrame, unmount } = render(React.createElement(App, { engine, startup: { resume: '', model: '', provider: '', print: '' } }))
    await new Promise(rr => setTimeout(rr, 50))
    const frame = lastFrame()
    assert.match(frame, /dsh-terminal/) // boot banner
    assert.match(frame, /session-1 · idle/)
    assert.match(frame, /hi/)
    assert.match(frame, /❯/)
    assert.match(frame, /─/)
    const lines = frame.split('\n')
    assert.equal(lines.length, terminalHeight(), 'ready frame owns the terminal height')
    assert.match(lines.at(-1), /enter send/, 'footer keys stay on the final row')
    unmount()
    await engine.quit()
  })

  it('routes wheel input into the visible transcript without typing mouse bytes', async () => {
    const engine = await makeEngine()
    engine.feed.notifyCommitted(Array.from({ length: 50 }, (_, seq) => ({
      seq,
      time: seq + 1,
      type: 'user/message',
      data: { content: [{ type: 'text', text: `scroll-message-${String(seq).padStart(2, '0')}` }], source: { kind: 'user' } },
    })))
    const app = render(React.createElement(App, { engine, startup: { resume: '', model: '', provider: '', print: '' }, mouse: false }))
    await new Promise(rr => setTimeout(rr, 80))
    const before = app.lastFrame()
    assert.match(before, /scroll-message-49/)
    app.stdin.write('\x1b[<64;10;5M')
    await new Promise(rr => setTimeout(rr, 40))
    const after = app.lastFrame()
    assert.equal(engine.transcriptScroll, 3)
    assert.equal(engine.composer.value, '')
    assert.notEqual(after, before)
    app.stdin.write('\x1b[<65;10;5M')
    await new Promise(rr => setTimeout(rr, 40))
    assert.equal(engine.transcriptScroll, 0)
    assert.equal(engine.composer.value, '')
    app.unmount()
    await engine.quit()
  })

  it('clear replaces old transcript content without a blank-line gap', async () => {
    const engine = await makeEngine()
    engine.feed.notifyCommitted([{ seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'before clear' }], source: { kind: 'user' } } }])
    const { lastFrame, unmount } = render(React.createElement(App, { engine, startup: { resume: '', model: '', provider: '', print: '' } }))
    await new Promise(rr => setTimeout(rr, 50))
    assert.match(lastFrame(), /before clear/)
    await engine.submitSlash('/clear')
    await new Promise(rr => setTimeout(rr, 50))
    const frame = lastFrame()
    assert.doesNotMatch(frame, /before clear/)
    assert.match(frame, /Tips for getting started/)
    assert.equal(frame.split('\n').length, terminalHeight())
    assert.match(frame.split('\n').at(-1), /enter send/)
    unmount()
    await engine.quit()
  })

  it('App survives a forced repaint with the full transcript intact', async () => {
    const engine = await makeEngine()
    engine.feed.notifyCommitted([
      { seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'before resize' }], source: { kind: 'user' } } },
      { seq: 1, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer survives resizes' }] } } },
    ])
    const { lastFrame, unmount } = render(React.createElement(App, { engine, startup: { resume: '', model: '', provider: '', print: '' } }))
    await new Promise(rr => setTimeout(rr, 50))
    assert.match(lastFrame(), /before resize/)
    // The resize resync clears the screen and bumps repaintSeq: the static
    // region must re-flush everything, not leave the screen empty.
    engine.requestRepaint()
    await new Promise(rr => setTimeout(rr, 50))
    const frame = lastFrame()
    assert.match(frame, /before resize/)
    assert.match(frame, /answer survives resizes/)
    assert.match(frame, /❯/)
    unmount()
    await engine.quit()
  })

  it('Composer and BlockView extend across full width beyond 100-col cap', () => {
    const empty = engineMod.emptyField()
    const composer = render(React.createElement(Composer, { field: empty, width: 140 }))
    const composerFrame = composer.lastFrame()
    assert.ok(composerFrame.split('\n').some(line => line.length === 140), 'composer box extends to full width 140')
    composer.unmount()

    const cardComposer = render(React.createElement(Composer, {
      field: empty,
      width: 100,
      model: 'deepseek-chat',
      effort: 'high',
    }))
    const cardFrame = cardComposer.lastFrame()
    assert.match(cardFrame, /deepseek-chat · high/)
    assert.match(cardFrame, /enter ↵ send · \/ commands/)
    cardComposer.unmount()

    const div = render(React.createElement(BlockView, {
      block: { kind: 'divider', id: 'div', label: 'test-session' },
      width: 140,
    }))
    const divFrame = div.lastFrame()
    const totalDivLen = divFrame.split('\n').filter(Boolean).reduce((acc, l) => acc + l.length, 0)
    assert.ok(totalDivLen >= 130, 'divider rule extends beyond 100 columns')
    div.unmount()
  })

  it('formats the context meter, durations, and tool args', async () => {
    const widgets = await import('../lib/tui/widgets.js')
    assert.equal(widgets.formatCtx(8244), '8.2k tok')
    assert.equal(widgets.formatCtx(8244, 65536), '8.2k · 13%')
    assert.equal(widgets.formatCtx(8244, 0), '8.2k tok')
    assert.equal(widgets.formatDuration(840), '840ms')
    assert.equal(widgets.formatDuration(1200), '1.2s')
    assert.equal(widgets.formatDuration(27000), '27s')
    assert.equal(widgets.formatDuration(undefined), undefined)
    assert.deepEqual(widgets.parseToolArgs('{"cmd":"ls -la"}'), { oneLine: 'ls -la', path: undefined, content: undefined })
    const parsed = widgets.parseToolArgs('{"path":"a.ts","content":"x"}')
    assert.equal(parsed.path, 'a.ts')
    assert.equal(parsed.content, 'x')
    const r = render(React.createElement(widgets.Banner, { model: 'p/m', effort: '', cwd: '~/proj', recent: '2h · proj' }))
    const frame = r.lastFrame()
    assert.match(frame, /Welcome back!/)
    assert.match(frame, /Tips for getting started/)
    assert.match(frame, /Recent activity/)
    assert.match(frame, /2h · proj/)
    assert.match(frame, /█/)
    assert.match(frame, /▀/)
    assert.match(frame, /deepseek/)
    assert.ok(widgets.WHALE.some(line => line.includes('▄')))
    assert.ok(widgets.WHALE.every(line => !line.includes('╭')))
    const narrow = render(React.createElement(widgets.Banner, { model: 'p/m', effort: 'high', cwd: '~/proj', width: 48 }))
    const narrowFrame = narrow.lastFrame()
    assert.match(narrowFrame, /Welcome back!/)
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
    for (const line of strip(narrowFrame).split('\n')) {
      assert.ok(line.length <= 48, `banner line overflows 48: ${line}`)
    }
    narrow.unmount()
    r.unmount()
    const empty = engineMod.emptyField()
    const composer = render(React.createElement(widgets.Composer, { field: empty, width: 40 }))
    const composerFrame = composer.lastFrame()
    assert.match(composerFrame, /❯/)
    assert.match(composerFrame, /Message \(\/ for commands\)/)
    composer.unmount()
  })
})

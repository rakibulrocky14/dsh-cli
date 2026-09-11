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

const { Engine, emptyField } = engineMod
const { BlockView, Panel, ApprovalDialog, QuestionsDialog, SessionBar, Footer, formatTokens, formatCtx, formatDuration, modeColor, shortMode, shortSession, fitMiddle, fitStatus, terminalWidth, pickWidth, displayLen, clipWidth, parseToolArgs, MAX_CONTENT, Banner, Composer } = widgets
const { App, staticAppend } = appMod

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

  it('tracks elapsed seconds of a running turn', async () => {
    const engine = await makeEngine()
    assert.equal(engine.runSeconds(), 0)
    engine.running = true
    engine.runStartValue = Date.now() - 5200
    assert.ok(engine.runSeconds() >= 5)
    engine.running = false
    assert.equal(engine.runSeconds(), 0)
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
    engine.openView({ name: 'sessions' })
    await new Promise(r => setTimeout(r, 80))
    assert.equal(engine.rows[0].id, 'session-aaaa1111') // newest first
    assert.equal(engine.rows[0].primary, 'Refactor the parser')
    assert.equal(engine.rows[0].secondary.includes('/'), false) // project basename, not the path
    assert.ok(engine.rows[0].secondary.includes('session-aaaa1111'))
    const current = engine.rows.find(row => row.id === 'session-current01')
    assert.equal(current.badge, 'this')
    const older = engine.rows.find(row => row.id === 'session-older00002')
    assert.equal(older.primary, 'ProjB') // web-parity: project basename for untitled
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
    const wide = fitStatus(120, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
    })
    assert.equal(wide.cwd, '~/XiaomiMiMoProjects/dsh-plugins')
    assert.equal(wide.ctx, '8.2k tok')
    assert.equal(wide.mode, 'WRITE')
    const narrow = fitStatus(48, {
      model: 'deepseek-official/deepseek-v4-flash-vision-exp', effort: 'max',
      cwd: '~/XiaomiMiMoProjects/dsh-plugins', ctxTokens: 8244, mode: 'workspace-write',
    })
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

/**
 * Core projection, message, parser, and field-editing coverage.
 * Run: npm test -w dsh-terminal (builds first, then node --test tests/)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-terminal-test-'))
process.env.HOME = process.env.DSH_HOME

const transcript = await import('../lib/core/transcript.js')
const messages = await import('../lib/core/messages.js')
const commands = await import('../lib/core/commands.js')
const dshMod = await import('../lib/core/dsh.js')
const engine = await import('../lib/tui/engine.js')

const { projectEvents, LiveFeed, summarizeInterval, parseInline, splitFences, foldTodos, foldUsage, extractCacheTokens, formatCacheHitRate, isTokenDelta } = transcript
const { parseMarkdown } = await import('../lib/core/markdown.js')
const { createUserMessage } = messages
const { parseModelSelection, parseAssignments, normalizeEffort, shortHome, BUILTINS, EFFORT_LEVELS } = commands
const { forkBoundary } = dshMod
const { editField, emptyField } = engine

const LOG = [
  { seq: 0, time: 1, type: 'turn/start', data: {} },
  { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  { seq: 2, time: 1, type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
  { seq: 3, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi there' }] } } },
  { seq: 4, time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
  { seq: 5, time: 1, type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb' }], isError: false }] } } },
  { seq: 6, time: 1, type: 'command/run', data: { commandId: 'k1', name: 'compact', args: 'now', source: { kind: 'user' } } },
  { seq: 7, time: 1, type: 'command/done', data: { commandId: 'k1', kind: 'success', text: 'compacted' } },
  { seq: 8, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: '[model changed]' }], source: { kind: 'plugin', plugin: 'x', form: 'notice' } } },
  { seq: 9, time: 1, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E', message: 'boom' } } } },
  { seq: 10, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'plugin', plugin: 'sys', form: 'snapshot' } } },
  { seq: 11, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'catalog' }], source: { kind: 'skill-catalog', form: 'catalog' } } },
]

describe('projectEvents', () => {
  it('folds the durable log into render blocks', () => {
    const blocks = projectEvents(LOG)
    assert.deepEqual(blocks.map(b => b.kind), ['user', 'assistant', 'tool', 'command', 'notice', 'notice'])
    assert.equal(blocks[0].text, 'hello')
    assert.equal(blocks[1].text, 'hi there')
    assert.equal(blocks[2].status, 'ok')
    assert.equal(blocks[2].resultText, 'a\nb')
    assert.equal(blocks[3].name, 'compact')
    assert.equal(blocks[3].text, 'compacted')
    assert.match(blocks[5].text, /boom/)
  })

  it('skips context snapshots and catalogs', () => {
    const blocks = projectEvents(LOG)
    assert.ok(blocks.every(b => !('text' in b) || !b.text.includes('runtime context')))
    assert.ok(blocks.every(b => !('text' in b) || b.text !== 'catalog'))
  })

  it('renders a pending tool/call as running', () => {
    const blocks = projectEvents([{ seq: 0, time: 1, type: 'tool/call', data: { callId: 'c9', name: 'x', arguments: '' } }])
    assert.equal(blocks[0].status, 'running')
  })
})

describe('LiveFeed', () => {
  it('overlays chunks then clears them on commit', () => {
    const feed = new LiveFeed()
    feed.pushChunk({ type: 'text-delta', index: 0, text: 'hel' })
    feed.pushChunk({ type: 'reasoning-delta', index: 1, text: 'hmm' })
    feed.pushChunk({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{"a":' })
    let snap = feed.snapshot()
    assert.equal(snap.filter(b => b.kind === 'assistant')[0].text, 'hel')
    assert.equal(snap.filter(b => b.kind === 'reasoning')[0].text, 'hmm')
    feed.notifyCommitted([
      { seq: 0, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
      { seq: 1, time: 1, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }] } } },
    ])
    snap = feed.snapshot()
    assert.ok(snap.every(b => b.live !== true))
    assert.equal(snap.filter(b => b.kind === 'assistant')[0].text, 'hello')
  })

  it('hides a committed pending tool while the live overlay covers the same call', () => {
    const feed = new LiveFeed()
    feed.pushChunk({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'bash', argumentsDelta: '{}' })
    feed.notifyCommitted([
      { seq: 0, time: 1, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } },
    ])
    // One running card, not two (committed pending + live overlay).
    const snap = feed.snapshot()
    assert.equal(snap.filter(b => b.kind === 'tool').length, 1)
    assert.equal(snap.filter(b => b.kind === 'tool')[0].live, true)
    // The durable view still holds the pending card.
    assert.equal(feed.committedBlocks().length, 1)
  })

  it('caches the snapshot between mutations', () => {
    const feed = new LiveFeed()
    feed.pushChunk({ type: 'text-delta', index: 0, text: 'a' })
    const first = feed.snapshot()
    assert.equal(feed.snapshot(), first)
    feed.pushChunk({ type: 'text-delta', index: 0, text: 'b' })
    const second = feed.snapshot()
    assert.notEqual(second, first)
    assert.equal(second.filter(b => b.kind === 'assistant')[0].text, 'ab')
  })

  it('aggregates interval text and outcome', () => {
    const out = summarizeInterval(LOG, 0)
    assert.equal(out.text, 'hi there')
    assert.equal(out.reasonKind, 'error')
  })

  it('measures live streaming TPS from first token decode elapsed time', () => {
    const feed = new LiveFeed()
    assert.equal(feed.liveTps(), undefined)
    feed.pushChunk({ type: 'block-start', index: 0, blockType: 'text' })
    assert.equal(feed.liveTps(), undefined)
    feed.pushChunk({ type: 'text-delta', index: 0, text: 'Hello world' })
    feed.firstTokenTime = Date.now() - 1000
    feed.tokens = { inputTokens: 100, outputTokens: 80 }
    assert.equal(feed.liveTps(), 80)
    feed.notifyCommitted([
      { seq: 0, time: Date.now(), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Hello world' }] }, usage: { outputTokens: 80 } } },
    ])
    assert.equal(feed.liveTps(), 80)
  })
})

describe('inline markup', () => {
  it('parses bold/code spans and fences', () => {
    assert.deepEqual(parseInline('a **b** `c`'), [
      { text: 'a ', bold: false, code: false },
      { text: 'b', bold: true, code: false },
      { text: ' ', bold: false, code: false },
      { text: 'c', bold: false, code: true },
    ])
    const sections = splitFences('hi\n```js\nx()\n```\nbye')
    assert.equal(sections.length, 3)
    assert.equal(sections[1].code, true)
    assert.equal(sections[1].lang, 'js')
  })
})

describe('markdown blocks', () => {
  it('parses headings, tables, lists, and quotes', () => {
    const blocks = parseMarkdown([
      '## The file map',
      '',
      '| File | Role |',
      '|---|---|',
      '| `src/core/dsh.ts` | **workhorse** |',
      '| `src/tui/app.tsx` | renderer |',
      '',
      '- **Zero imports.** Cordis only.',
      '- second item',
      '',
      '> quoted line',
      '',
      '1. first',
      '2. second',
    ].join('\n'))
    assert.equal(blocks[0].kind, 'heading')
    assert.equal(blocks[0].text, 'The file map')
    assert.equal(blocks[1].kind, 'table')
    assert.deepEqual(blocks[1].headers, ['File', 'Role'])
    assert.equal(blocks[1].rows.length, 2)
    assert.equal(blocks[2].kind, 'list')
    assert.equal(blocks[2].ordered, false)
    assert.equal(blocks[2].items[0], '**Zero imports.** Cordis only.')
    assert.equal(blocks[3].kind, 'quote')
    assert.equal(blocks[4].kind, 'list')
    assert.equal(blocks[4].ordered, true)
  })

  it('safely handles incomplete streaming tables without hanging in an infinite loop', () => {
    // Single header line without separator (e.g. streaming mid-turn)
    const stream1 = parseMarkdown("Sure! Here's\n| col1 | col2 |")
    assert.equal(stream1.length, 1)
    assert.equal(stream1[0].kind, 'para')

    // Header and separator line arrived, no data rows yet
    const stream2 = parseMarkdown("Sure! Here's\n\n| col1 | col2 |\n|---|---|")
    assert.equal(stream2.length, 2)
    assert.equal(stream2[0].kind, 'para')
    assert.equal(stream2[1].kind, 'table')
    assert.deepEqual(stream2[1].headers, ['col1', 'col2'])
    assert.equal(stream2[1].rows.length, 0)

    // Header, separator, and data rows arrived
    const stream3 = parseMarkdown("Sure! Here's\n\n| col1 | col2 |\n|---|---|\n| val1 | val2 |")
    assert.equal(stream3.length, 2)
    assert.equal(stream3[1].kind, 'table')
    assert.deepEqual(stream3[1].rows, [['val1', 'val2']])

    // Standalone pipe line in text
    const textWithPipes = parseMarkdown("command | grep foo | sort")
    assert.equal(textWithPipes.length, 1)
    assert.equal(textWithPipes[0].kind, 'para')
  })
})

describe('messages', () => {
  it('deep-freezes user messages', () => {
    const msg = createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })
    assert.equal(msg.role, 'user')
    assert.ok(Object.isFrozen(msg))
    assert.ok(Object.isFrozen(msg.content))
    assert.ok(Object.isFrozen(msg.content[0]))
  })
})

describe('slash-line parsers', () => {
  it('parses model selections and k=v assignments', () => {
    assert.deepEqual(parseModelSelection('deepseek/deepseek-chat'), { provider: 'deepseek', model: 'deepseek-chat' })
    assert.deepEqual(parseModelSelection('m'), { provider: '', model: 'm' })
    assert.deepEqual(parseAssignments(['a=1', 'b="x y"', 'c=raw']), { a: 1, b: 'x y', c: 'raw' })
    assert.throws(() => parseAssignments(['nope']), /k=v/)
  })

  it('normalizes effort arguments', () => {
    assert.equal(normalizeEffort(''), undefined)
    assert.deepEqual(normalizeEffort('auto'), { clear: true })
    assert.deepEqual(normalizeEffort('MAX'), { level: 'max' })
    for (const level of EFFORT_LEVELS) assert.deepEqual(normalizeEffort(level), { level })
    assert.throws(() => normalizeEffort('turbo'), /unknown effort/)
    assert.deepEqual(normalizeEffort('Eco', ['eco', 'max']), { level: 'eco' })
    assert.throws(() => normalizeEffort('high', ['eco', 'max']), /eco\|max/)
  })

  it('shortens home paths', () => {
    assert.equal(shortHome(process.env.HOME), '~')
    assert.equal(shortHome(`${process.env.HOME}/a/b`), '~/a/b')
    assert.equal(shortHome('/elsewhere'), '/elsewhere')
  })

  it('keeps builtin names unique with descriptions', () => {
    const names = BUILTINS.map(b => b.name)
    assert.equal(new Set(names).size, names.length)
    assert.ok(BUILTINS.every(b => b.desc !== ''))
    for (const name of ['fork', 'effort', 'title', 'skills', 'agents', 'terminals', 'todos', 'usage', 'stop']) {
      assert.ok(names.includes(name), `missing /${name}`)
    }
  })
})

describe('log folds', () => {
  it('folds the latest todo list', () => {
    const events = [
      { seq: 0, time: 1, type: 'todo/write', data: { todos: [{ content: 'old', status: 'done' }] } },
      { seq: 1, time: 1, type: 'todo/write', data: { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', done: true }] } },
    ]
    assert.deepEqual(foldTodos(events), [
      { text: 'a', status: 'in_progress' },
      { text: 'b', status: 'done' },
    ])
    assert.equal(foldTodos([]), undefined)
  })

  it('folds usage without double counting', () => {
    const withMessages = [
      { seq: 0, time: 1, type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } } },
      { seq: 1, time: 1, type: 'assistant/message', data: { message: { content: [] }, usage: { inputTokens: 100, outputTokens: 50 } } },
    ]
    assert.deepEqual(foldUsage(withMessages), { input: 100, output: 50, responses: 1 })
    const chunksOnly = [withMessages[0]]
    assert.deepEqual(foldUsage(chunksOnly), { input: 10, output: 5, responses: 0 })
  })

  it('extracts cache tokens and formats hit rates correctly', () => {
    // DeepSeek format
    assert.deepEqual(extractCacheTokens({ prompt_cache_hit_tokens: 850, prompt_cache_miss_tokens: 150 }), { hit: 850, miss: 150 })
    // Claude / Bedrock format
    assert.deepEqual(extractCacheTokens({ cacheRead: 400, cacheWrite: 100 }), { hit: 400, miss: 100 })
    // OpenAI prompt_tokens_details
    assert.deepEqual(extractCacheTokens({ prompt_tokens_details: { cached_tokens: 300 } }), { hit: 300, miss: 0 })
    // Empty
    assert.deepEqual(extractCacheTokens({}), { hit: 0, miss: 0 })

    // formatCacheHitRate
    assert.equal(formatCacheHitRate(0, 100), undefined)
    // DSH / pi-ai format: 85 cached, 15 uncached => 85 / 100 = 85.0%
    assert.equal(formatCacheHitRate(85, 15), '85.0%')
    // Raw provider format with total prompt tokens (1000 total, 850 hit, 150 miss)
    assert.equal(formatCacheHitRate(850, 1000, 150), '85.0%')
    // High cache hit never falsely rounds up to 100% when uncached tokens exist
    assert.equal(formatCacheHitRate(130304, 399, 0), '99.7%')
    // True 100% cache hit when 0 uncached tokens
    assert.equal(formatCacheHitRate(1000, 0, 0), '100.0%')
    assert.equal(formatCacheHitRate(100, -100), undefined)
  })

  it('folds usage with prompt cache hit rate and generation speed', () => {
    const events = [
      { seq: 0, time: 1000, type: 'turn/start', data: {} },
      { seq: 1, time: 1500, type: 'assistant/message', data: { message: { content: [] }, usage: { inputTokens: 1000, outputTokens: 120, prompt_cache_hit_tokens: 850, prompt_cache_miss_tokens: 150 } } },
      { seq: 2, time: 3000, type: 'turn/end', data: {} },
    ]
    const totals = foldUsage(events)
    assert.equal(totals.input, 1000)
    assert.equal(totals.output, 120)
    assert.equal(totals.responses, 1)
    assert.equal(totals.cacheHit, 850)
    assert.equal(totals.cacheMiss, 150)
    assert.equal(totals.cacheRate, '85.0%')
    // 120 tokens / 2 seconds = 60 tps
    assert.equal(totals.tps, 60)
  })

  it('calculates decode throughput rather than total wall-clock turn duration', () => {
    // Turn: TTFT is 2s, decode is 1s for 75 tokens, and tool call takes 20s.
    // Total turn wall clock = 23s (which in naive formula would collapse to 3 tps!).
    // Actual decode speed = 75 tokens / 1.0s = 75 tps!
    const events = [
      { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 1000, type: 'step/start', data: { turn: 1, step: 0 } },
      { seq: 2, time: 3000, type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
      { seq: 3, time: 4000, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [] }, usage: { inputTokens: 500, outputTokens: 75 } } },
      { seq: 4, time: 4000, type: 'step/end', data: { turn: 1, step: 0 } },
      { seq: 5, time: 4010, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      { seq: 6, time: 24000, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }] } } },
      { seq: 7, time: 24000, type: 'turn/end', data: { turn: 1 } },
    ]
    const totals = foldUsage(events)
    assert.equal(totals.output, 75)
    assert.equal(totals.tps, 75)
    assert.equal(totals.turnTps, 75)
  })

  it('validates isTokenDelta helper', () => {
    assert.equal(isTokenDelta({ type: 'text-delta', text: 'hi' }), true)
    assert.equal(isTokenDelta({ type: 'text-delta', text: '' }), false)
    assert.equal(isTokenDelta({ type: 'reasoning-delta', text: 'thinking' }), true)
    assert.equal(isTokenDelta({ type: 'reasoning-delta', text: '' }), false)
    assert.equal(isTokenDelta({ type: 'tool-call-delta', argumentsDelta: '{"a":1}' }), true)
    assert.equal(isTokenDelta({ type: 'tool-call-delta', argumentsDelta: '', name: 'bash' }), true)
    assert.equal(isTokenDelta({ type: 'tool-call-delta', argumentsDelta: '' }), false)
    assert.equal(isTokenDelta({ type: 'block-start' }), false)
    assert.equal(isTokenDelta({ type: 'usage' }), false)
    assert.equal(isTokenDelta(null), false)
  })

  it('finds fork boundaries at completed turns', () => {
    assert.equal(forkBoundary([]), undefined)
    assert.equal(forkBoundary([{ seq: 0, time: 1, type: 'turn/start', data: {} }]), undefined)
    const events = [
      { seq: 0, time: 1, type: 'turn/start', data: {} },
      { seq: 1, time: 1, type: 'turn/end', data: {} },
      { seq: 2, time: 1, type: 'turn/start', data: {} },
    ]
    assert.equal(forkBoundary(events), 1)
  })
})

describe('editField', () => {
  it('edits, kills, and submits', () => {
    const f = emptyField('hello')
    assert.equal(editField(f, '', { leftArrow: true }), 'continue')
    assert.equal(f.cursor, 4)
    editField(f, '', { backspace: true })
    assert.equal(f.value, 'helo')
    editField(f, 'X', {})
    assert.equal(f.value, 'helXo')
    editField(f, 'a', { ctrl: true })
    assert.equal(f.cursor, 0)
    editField(f, 'k', { ctrl: true })
    assert.equal(f.value, '')
    assert.equal(editField(f, '', { return: true }), 'submit')
  })

  it('submits on a newline bundled into the input chunk', () => {
    // Terminals may deliver text+Enter in one chunk; Ink reports it as
    // plain input with return:false. The Enter must still submit.
    const g = emptyField('ab')
    assert.equal(editField(g, 'c\r', {}), 'submit')
    assert.equal(g.value, 'abc')
    const h = emptyField('')
    assert.equal(editField(h, 'x\ny', {}), 'submit')
    assert.equal(h.value, 'x')
  })
})

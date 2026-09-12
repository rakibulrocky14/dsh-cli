/**
 * Transcript projection: the durable session log folds into render blocks,
 * and live stream chunks overlay as pending blocks until their committed
 * message lands. Both the full-screen TUI and the line REPL render from
 * these blocks, so the two surfaces can never disagree about history.
 *
 * @module dsh-terminal/core/transcript
 */

import type { ContentBlock, SessionEvent, StreamChunk } from './types.js'

/** One renderable transcript row. */
export type Block =
  | { kind: 'user'; id: string; text: string; images: number }
  | { kind: 'assistant'; id: string; text: string; live: boolean }
  | { kind: 'reasoning'; id: string; text: string; live: boolean }
  | {
    kind: 'tool'
    id: string
    callId: string | undefined
    name: string
    args: string
    status: 'running' | 'ok' | 'error'
    /** Wall time from tool/call to tool/result, when both are in the log. */
    durationMs: number | undefined
    resultText: string
    live: boolean
  }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'warn' | 'error' }
  | { kind: 'command'; id: string; name: string; text: string; ok: boolean }
  | { kind: 'divider'; id: string; label: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** True when a block is an in-flight live overlay (not yet committed). */
export function isLiveBlock(block: Block): boolean {
  return block.kind === 'assistant' || block.kind === 'reasoning' || block.kind === 'tool'
    ? block.live
    : false
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Extract readable text from model-facing content blocks. */
export function blocksText(blocks: unknown): { text: string; images: number } {
  if (!Array.isArray(blocks)) return { text: '', images: 0 }
  const parts: string[] = []
  let images = 0
  for (const block of blocks as ContentBlock[]) {
    if (!isRecord(block)) continue
    switch (block.type) {
      case 'text':
      case 'reasoning': {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && text !== '') parts.push(text)
        break
      }
      case 'image':
        images++
        break
      case 'tool-result': {
        const inner = block.content
        if (Array.isArray(inner)) {
          const nested = blocksText(inner)
          if (nested.text !== '') parts.push(nested.text)
          images += nested.images
        }
        break
      }
      default:
        break
    }
  }
  return { text: parts.join(''), images }
}

/** Parse one tool's JSON argument string into a compact one-line summary. */
export function summarizeArgs(argsText: string, max = 120): string {
  const flat = argsText.replace(/\s+/g, ' ').trim()
  if (flat === '' || flat === '{}') return ''
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

interface PendingTool {
  seq: number
  callId: string
  name: string
  args: string
  time: number
}

/**
 * Fold durable session events into render blocks.
 * Token-level `assistant/chunk` runs are skipped: the committed
 * `assistant/message` carries the same content.
 * @param events - the session log in seq order.
 * @returns render blocks, oldest first.
 */
export function projectEvents(events: readonly SessionEvent[]): Block[] {
  const blocks: Block[] = []
  const pendingTools = new Map<string, PendingTool>()
  const pendingCommands = new Map<string, { seq: number; name: string }>()

  const toolResultKey = (message: unknown): string | undefined => {
    const content = isRecord(message) ? (message as { content?: unknown }).content : undefined
    if (!Array.isArray(content)) return undefined
    const first = content[0] as ContentBlock | undefined
    if (first !== undefined && isRecord(first) && first.type === 'tool-result'
      && typeof first.toolCallId === 'string') return first.toolCallId
    return undefined
  }

  for (const event of events) {
    const data = event.data
    switch (event.type) {
      case 'user/message': {
        const { text, images } = blocksText((data as { content?: unknown }).content)
        const source = (data as { source?: { kind?: unknown; form?: unknown } }).source
        if (source?.kind === 'user') {
          if (text !== '' || images > 0) {
            blocks.push({ kind: 'user', id: `c${String(event.seq)}`, text, images })
          }
        } else if (source?.form === 'notice' && text !== '') {
          // Genuine notices (model switches, …). Context snapshots
          // (form 'snapshot'/'catalog') stay out of the transcript.
          blocks.push({ kind: 'notice', id: `c${String(event.seq)}`, text, tone: 'info' })
        }
        break
      }
      case 'assistant/attempt': {
        // Newer releases settle failed attempts here instead of a message.
        const error = (data as { error?: { code?: unknown; message?: unknown } }).error
        const code = isRecord(error) ? textOf(error.code) : ''
        const message = isRecord(error) ? textOf(error.message) : ''
        if (code !== '' || message !== '') {
          blocks.push({
            kind: 'notice', id: `c${String(event.seq)}`,
            text: `attempt failed${code === '' ? '' : ` (${code})`}${message === '' ? '' : `: ${message}`}`,
            tone: 'error',
          })
        }
        break
      }
      case 'assistant/message': {
        const message = (data as { message?: { content?: unknown } }).message
        const content = message?.content
        if (!Array.isArray(content)) break
        const text: string[] = []
        const reasoning: string[] = []
        for (const block of content as ContentBlock[]) {
          if (!isRecord(block)) continue
          const textValue = (block as { text?: unknown }).text
          if (typeof textValue !== 'string') continue
          if (block.type === 'text') text.push(textValue)
          else if (block.type === 'reasoning') reasoning.push(textValue)
        }
        if (reasoning.length > 0) {
          blocks.push({ kind: 'reasoning', id: `c${String(event.seq)}r`, text: reasoning.join(''), live: false })
        }
        if (text.length > 0) {
          blocks.push({ kind: 'assistant', id: `c${String(event.seq)}`, text: text.join(''), live: false })
        }
        break
      }
      case 'tool/call': {
        const callId = textOf(data.callId)
        const name = textOf(data.name) === '' ? '(unknown tool)' : textOf(data.name)
        if (callId !== '') pendingTools.set(callId, { seq: event.seq, callId, name, args: textOf(data.arguments), time: typeof event.time === 'number' ? event.time : 0 })
        else blocks.push({ kind: 'tool', id: `c${String(event.seq)}`, callId: undefined, name, args: textOf(data.arguments), status: 'running', resultText: '', live: false, durationMs: undefined })
        break
      }
      case 'tool/result': {
        const message = data.message
        const key = toolResultKey(message)
        const pending = key === undefined ? undefined : pendingTools.get(key)
        const { text, images } = blocksText([{
          type: 'tool-result',
          toolCallId: key ?? '',
          content: (isRecord(message) ? (message as { content?: unknown }).content : []) as ContentBlock[],
          isError: false,
        }])
        const failed = isRecord(data.error)
        const resultText = images > 0 && text === '' ? `[${String(images)} image${images === 1 ? '' : 's'}]` : text
        const durationMs = pending !== undefined && pending.time > 0 && typeof event.time === 'number'
          ? Math.max(0, event.time - pending.time)
          : undefined
        if (pending !== undefined) {
          pendingTools.delete(pending.callId)
          blocks.push({
            kind: 'tool', id: `c${String(event.seq)}`, callId: pending.callId, name: pending.name,
            args: pending.args, status: failed ? 'error' : 'ok', durationMs, resultText, live: false,
          })
        } else {
          blocks.push({
            kind: 'tool', id: `c${String(event.seq)}`, callId: key, name: '(unknown tool)',
            args: '', status: failed ? 'error' : 'ok', durationMs, resultText, live: false,
          })
        }
        break
      }
      case 'command/run': {
        const id = textOf(data.commandId)
        const direct = textOf(data.name)
        const line = textOf(data.line) === '' ? textOf(data.rawInput) : textOf(data.line)
        const fromLine = line.startsWith('/') ? line.slice(1).split(/\s/u)[0] ?? '' : ''
        const name = direct !== '' ? direct : fromLine === '' ? '(command)' : fromLine
        if (id !== '') pendingCommands.set(id, { seq: event.seq, name })
        else blocks.push({ kind: 'command', id: `c${String(event.seq)}`, name, text: '', ok: true })
        break
      }
      case 'command/done': {
        const id = textOf(data.commandId)
        const pending = id === '' ? undefined : pendingCommands.get(id)
        if (pending !== undefined && id !== '') pendingCommands.delete(id)
        // Flat `{kind, text}` on older releases, nested `result` on newer.
        const result = data.result as CommandResultInfo | undefined
        const kind = textOf(data.kind) === '' ? (isRecord(result) ? textOf(result.kind) : '') : textOf(data.kind)
        const nested = isRecord(result) ? textOf(result.text) : ''
        const text = textOf(data.text) === '' ? nested : textOf(data.text)
        const name = pending?.name ?? textOf(data.name)
        blocks.push({ kind: 'command', id: `c${String(event.seq)}`, name: name === '' ? '(command)' : name, text, ok: kind !== 'error' })
        break
      }
      case 'turn/end': {
        const reason = data.reason as { kind?: unknown; error?: { code?: unknown; message?: unknown } } | undefined
        if (reason?.kind === 'error') {
          const code = textOf(reason.error?.code)
          const message = textOf(reason.error?.message)
          blocks.push({
            kind: 'notice', id: `c${String(event.seq)}`,
            text: `turn failed${code === '' ? '' : ` (${code})`}${message === '' ? '' : `: ${message}`}`,
            tone: 'error',
          })
        } else if (reason?.kind === 'cancelled' || reason?.kind === 'canceled') {
          blocks.push({ kind: 'notice', id: `c${String(event.seq)}`, text: 'turn cancelled', tone: 'warn' })
        }
        break
      }
      default:
        break
    }
  }
  // Calls still running at the fold point render as open cards.
  for (const pending of [...pendingTools.values()].sort((a, b) => a.seq - b.seq)) {
    blocks.push({
      kind: 'tool', id: `p${String(pending.seq)}`, callId: pending.callId, name: pending.name,
      args: pending.args, status: 'running', durationMs: undefined, resultText: '', live: false,
    })
  }
  return blocks
}

/** One task-list row folded from the latest `todo/write`. */
export interface TodoRow {
  text: string
  status: string
}

/**
 * Fold the session's current task list (latest write wins).
 * @param events - the session log in seq order.
 * @returns rows, or undefined when the session never wrote one.
 */
export function foldTodos(events: readonly SessionEvent[]): TodoRow[] | undefined {
  let last: unknown
  for (const event of events) {
    if (event.type === 'todo/write') last = (event.data as { todos?: unknown }).todos
  }
  if (!Array.isArray(last)) return undefined
  return last.map((item): TodoRow => {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const text = [record.text, record.content, record.title].find(v => typeof v === 'string')
    const status = [record.status, record.state].find(v => typeof v === 'string')
    return {
      text: typeof text === 'string' && text !== '' ? text : JSON.stringify(item),
      status: typeof status === 'string' && status !== ''
        ? status
        : record.done === true || record.completed === true ? 'done' : 'open',
    }
  })
}

/** Token totals folded from usage records, including cache hit rate and speed. */
export interface UsageTotals {
  input: number
  output: number
  responses: number
  cacheHit?: number
  cacheMiss?: number
  cacheRate?: string
  tps?: number
}

/** Extract prompt cache hits and misses across provider usage formats. */
export function extractCacheTokens(usage: unknown): { hit: number; miss: number } {
  if (typeof usage !== 'object' || usage === null) return { hit: 0, miss: 0 }
  const u = usage as Record<string, unknown>
  const hit = Number(
    u.prompt_cache_hit_tokens ??
    u.cacheRead ??
    u.cacheReadTokens ??
    u.cacheReadInputTokens ??
    u.cachedTokens ??
    (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
    0
  ) || 0
  const miss = Number(
    u.prompt_cache_miss_tokens ??
    u.cacheWrite ??
    u.cacheWriteTokens ??
    u.cacheCreationInputTokens ??
    0
  ) || 0
  return { hit, miss }
}

/**
 * Format prompt cache hit rate string, matching DSH Web GUI's calculation.
 * In DSH/OpenAI/Anthropic billing:
 * - prompt tokens = uncached input + cacheRead (hits) + cacheWrite (misses/writes).
 * - hit rate = cacheRead / (uncached input + cacheRead + cacheWrite).
 * - never falsely rounds up to 100% if there were any uncached tokens.
 */
export function formatCacheHitRate(hit: number, uncachedInput: number, miss = 0): string | undefined {
  if (hit <= 0) return undefined
  // In raw provider APIs (e.g. raw DeepSeek/OpenAI), uncachedInput is prompt_tokens (total).
  // In DSH / pi-ai / Anthropic, uncachedInput is uncached prompt tokens only.
  const isTotalInput = uncachedInput >= (hit + miss) && miss > 0
  const denominator = isTotalInput ? uncachedInput : (uncachedInput + hit + miss)
  if (denominator <= 0) return undefined
  const missed = isTotalInput ? (denominator - hit) : (uncachedInput + miss)
  if (missed <= 0) return '100.0%'
  const rate = (hit / denominator) * 100
  // Never falsely round to 100.0% if there were uncached prompt tokens
  if (rate >= 99.95) {
    const decimal = Math.min(9, Math.floor((1 - (missed / denominator)) * 1000) % 10)
    return `99.${String(decimal)}%`
  }
  return `${rate.toFixed(1)}%`
}

/**
 * Fold token usage: committed per-message records win; otherwise sum the
 * token-level usage chunks (never both — they describe the same calls).
 * Also aggregates cache hit rate and average generation speed.
 * @param events - the session log in seq order.
 */
export function foldUsage(events: readonly SessionEvent[]): UsageTotals {
  let input = 0
  let output = 0
  let responses = 0
  let chunkInput = 0
  let chunkOutput = 0
  let sawMessage = false
  let cacheHit = 0
  let cacheMiss = 0
  let chunkCacheHit = 0
  let chunkCacheMiss = 0
  const turnStarts: number[] = []
  let totalTurnSec = 0

  for (const event of events) {
    if (event.type === 'turn/start') {
      if (typeof event.time === 'number') turnStarts.push(event.time)
    } else if (event.type === 'turn/end') {
      const start = turnStarts.pop()
      if (start !== undefined && typeof event.time === 'number' && event.time > start) {
        totalTurnSec += (event.time - start) / 1000
      }
    } else if (event.type === 'assistant/message') {
      responses++
      const data = event.data as { usage?: Record<string, unknown> }
      const usage = data?.usage
      if (usage !== undefined && typeof usage.inputTokens === 'number') {
        sawMessage = true
        input += usage.inputTokens
        output += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        const c = extractCacheTokens(usage)
        cacheHit += c.hit
        cacheMiss += c.miss
      }
    } else if (event.type === 'assistant/chunk') {
      const chunk = (event.data as { chunk?: { type?: string; usage?: Record<string, unknown> } }).chunk
      const usage = chunk?.type === 'usage' ? chunk.usage : undefined
      if (usage !== undefined && typeof usage.inputTokens === 'number') {
        chunkInput += usage.inputTokens
        chunkOutput += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
        const c = extractCacheTokens(usage)
        chunkCacheHit += c.hit
        chunkCacheMiss += c.miss
      }
    }
  }

  const finalInput = sawMessage ? input : chunkInput
  const finalOutput = sawMessage ? output : chunkOutput
  const finalCacheHit = sawMessage ? cacheHit : chunkCacheHit
  const finalCacheMiss = sawMessage ? cacheMiss : chunkCacheMiss

  const totals: UsageTotals = { input: finalInput, output: finalOutput, responses }
  if (finalCacheHit > 0) {
    totals.cacheHit = finalCacheHit
    totals.cacheMiss = finalCacheMiss
    totals.cacheRate = formatCacheHitRate(finalCacheHit, finalInput, finalCacheMiss)
  }
  if (totalTurnSec > 0 && finalOutput > 0) {
    totals.tps = Math.round(finalOutput / totalTurnSec)
  }
  return totals
}

/** Outcome of one owned run interval (for one-shot exit codes). */
export interface RunOutcome {
  text: string
  reasonKind: string | undefined
}

/**
 * Aggregate the last assistant text and turn outcome over an interval.
 * @param events - the session log in seq order.
 * @param firstSeq - first seq owned by the interval.
 */
export function summarizeInterval(events: readonly SessionEvent[], firstSeq: number): RunOutcome {
  let started = false
  let text = ''
  let reasonKind: string | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: unknown } }).message
      const joined = blocksText(message?.content).text
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason as { kind?: unknown } | undefined
      reasonKind = typeof reason?.kind === 'string' ? reason.kind : undefined
    }
  }
  return { text, reasonKind }
}

interface LiveTool {
  key: string
  callId: string | undefined
  name: string
  args: string
}

/** Cap for buffered live tool-argument text. */
const LIVE_ARGS_MAX = 2000

/**
 * Live overlay for in-flight stream chunks. Committed events stay the truth:
 * every `notifyCommitted` rebuilds from the log and drops the live state the
 * new events supersede.
 */
export class LiveFeed {
  private text = ''
  private reasoning = ''
  private tools: LiveTool[] = []
  private committed: Block[] = []
  private committedSeq = -1
  private listeners = new Set<() => void>()
  private snapshotCache: Block[] | undefined = undefined
  private echoes: Block[] = []
  private echoSeq = 0
  tokens: { inputTokens: number; outputTokens: number; [key: string]: unknown } | undefined = undefined

  get liveText(): string { return this.text }
  get liveReasoning(): string { return this.reasoning }

  /** Live prompt cache hit rate when reported in streaming usage chunks. */
  cacheRate(): string | undefined {
    if (this.tokens === undefined) return undefined
    const { hit, miss } = extractCacheTokens(this.tokens)
    return formatCacheHitRate(hit, this.tokens.inputTokens, miss)
  }

  /**
   * Surface-local input echo (slash commands never commit a log event, so
   * without this the submitted line would vanish from the transcript).
   */
  pushEcho(text: string): void {
    this.echoes.push({ kind: 'user', id: `echo-${String(++this.echoSeq)}`, text, images: 0 })
    this.snapshotCache = undefined
    this.emit()
  }

  /** Subscribe to overlay changes; returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Consume one provider-neutral stream chunk. */
  pushChunk(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text-delta':
        if (chunk.text === '') return
        this.text += chunk.text
        this.snapshotCache = undefined
        this.emit()
        return
      case 'reasoning-delta':
        if (chunk.text === '') return
        this.reasoning += chunk.text
        this.snapshotCache = undefined
        this.emit()
        return
      case 'tool-call-delta': {
        const key = chunk.id !== '' ? chunk.id : `idx:${String(chunk.index)}`
        let tool = this.tools.find(t => t.key === key)
        if (tool === undefined) {
          tool = { key, callId: chunk.id !== '' ? chunk.id : undefined, name: '', args: '' }
          this.tools.push(tool)
        }
        if (chunk.name !== undefined && chunk.name !== '') tool.name = chunk.name
        if (chunk.argumentsDelta !== '' && tool.args.length < LIVE_ARGS_MAX) {
          tool.args = (tool.args + chunk.argumentsDelta).slice(0, LIVE_ARGS_MAX)
        }
        this.snapshotCache = undefined
        this.emit()
        return
      }
      case 'usage':
        this.tokens = { ...chunk.usage }
        this.snapshotCache = undefined
        this.emit()
        return
      default:
        return
    }
  }

  /**
   * Rebuild committed blocks from the log and clear superseded live state.
   * @param events - the session log in seq order.
   */
  notifyCommitted(events: readonly SessionEvent[]): void {
    const fresh = events.filter(e => e.seq > this.committedSeq)
    if (fresh.length === 0) return
    this.committedSeq = events.length === 0 ? -1 : events[events.length - 1]!.seq
    let sawMessage = false
    const settled = new Set<string>()
    for (const event of fresh) {
      if (event.type === 'assistant/message') sawMessage = true
      if (event.type === 'tool/result') {
        const content = (event.data.message as { content?: unknown[] } | undefined)?.content
        const first = Array.isArray(content) ? content[0] as { toolCallId?: unknown } | undefined : undefined
        if (typeof first?.toolCallId === 'string') settled.add(first.toolCallId)
      }
    }
    if (sawMessage) {
      this.text = ''
      this.reasoning = ''
    }
    if (settled.size > 0) this.tools = this.tools.filter(t => t.callId === undefined || !settled.has(t.callId))
    this.committed = projectEvents(events)
    this.snapshotCache = undefined
    this.emit()
  }

  /** Forget everything (agent switch). */
  reset(): void {
    this.text = ''
    this.reasoning = ''
    this.tools = []
    this.committed = []
    this.committedSeq = -1
    this.tokens = undefined
    this.echoes = []
    this.snapshotCache = undefined
    this.emit()
  }

  /** Committed blocks without the live overlay. */
  committedBlocks(): Block[] {
    return [...this.committed]
  }

  /**
   * Committed blocks plus the live overlay. A committed tool call still
   * running in the log is hidden while the live overlay covers the same
   * callId, so a call can never show as two running cards at once. The
   * snapshot is cached between mutations: stream chunks arrive far more
   * often than commits, and every render used to copy the whole log.
   */
  snapshot(): Block[] {
    if (this.snapshotCache !== undefined) return this.snapshotCache
    const out: Block[] = []
    const liveCallIds = new Set<string>()
    for (const tool of this.tools) {
      if (tool.callId !== undefined) liveCallIds.add(tool.callId)
    }
    for (const block of this.committed) {
      if (block.kind === 'tool' && block.status === 'running'
        && block.callId !== undefined && liveCallIds.has(block.callId)) continue
      out.push(block)
    }
    out.push(...this.echoes)
    if (this.reasoning !== '') out.push({ kind: 'reasoning', id: 'live-reasoning', text: this.reasoning, live: true })
    if (this.text !== '') out.push({ kind: 'assistant', id: 'live-text', text: this.text, live: true })
    for (const tool of this.tools) {
      out.push({
        kind: 'tool', id: `live-${tool.key}`, callId: tool.callId,
        name: tool.name === '' ? '(calling…)' : tool.name, args: tool.args,
        status: 'running', durationMs: undefined, resultText: '', live: true,
      })
    }
    this.snapshotCache = out
    return out
  }
}

/** One inline-formatted text run. */
export interface Segment {
  text: string
  bold: boolean
  code: boolean
}

/**
 * Parse lightweight inline markup (`**bold**`, `` `code` ``).
 * @param text - one logical line.
 */
export function parseInline(text: string): Segment[] {
  const segments: Segment[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/gu
  let rest = text
  let match: RegExpExecArray | null
  let last = 0
  pattern.lastIndex = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), bold: false, code: false })
    const token = match[0]
    if (token.startsWith('**')) segments.push({ text: token.slice(2, -2), bold: true, code: false })
    else segments.push({ text: token.slice(1, -1), bold: false, code: true })
    last = match.index + token.length
    rest = text.slice(last)
  }
  if (rest !== '') segments.push({ text: rest, bold: false, code: false })
  return segments
}

/** One fence-split section of assistant text. */
export interface TextSection {
  code: boolean
  lang: string
  text: string
}

/**
 * Split fenced code blocks out of markdown-ish text.
 * @param text - assistant or tool text.
 */
export function splitFences(text: string): TextSection[] {
  const sections: TextSection[] = []
  const lines = text.split('\n')
  let prose: string[] = []
  let fence: string[] | undefined
  let lang = ''
  const flushProse = (): void => {
    if (prose.length > 0) {
      sections.push({ code: false, lang: '', text: prose.join('\n') })
      prose = []
    }
  }
  for (const line of lines) {
    const open = line.match(/^```(\S*)\s*$/u)
    if (fence === undefined && open !== null) {
      flushProse()
      fence = []
      lang = open[1] ?? ''
    } else if (fence !== undefined && line.trim() === '```') {
      sections.push({ code: true, lang, text: fence.join('\n') })
      fence = undefined
      lang = ''
    } else if (fence !== undefined) {
      fence.push(line)
    } else {
      prose.push(line)
    }
  }
  if (fence !== undefined) sections.push({ code: true, lang, text: fence.join('\n') })
  flushProse()
  return sections
}

type CommandResultInfo = { kind: string; text?: unknown }

/**
 * Render one block as plain text (line REPL, one-shot output).
 * @param block - the block to render.
 */
export function renderBlockText(block: Block): string {
  switch (block.kind) {
    case 'user':
      return `you › ${block.text}${block.images > 0 ? ` [+${String(block.images)} image${block.images === 1 ? '' : 's'}]` : ''}`
    case 'assistant':
      return block.text
    case 'reasoning': {
      const first = block.text.split('\n', 2).join('\n')
      return `thinking ${first}${block.text.includes('\n') ? ' …' : ''}`
    }
    case 'tool': {
      const head = block.status === 'running'
        ? `tool: ${block.name}`
        : block.status === 'ok'
          ? `tool ${block.name} ✓`
          : `tool ${block.name} ✗`
      const args = summarizeArgs(block.args)
      const lines = [`${head}${args === '' ? '' : ` ${args}`}`]
      if (block.resultText !== '') {
        const clipped = block.resultText.length > 800 ? `${block.resultText.slice(0, 799)}…` : block.resultText
        lines.push(clipped.split('\n').map(l => `  ${l}`).join('\n'))
      }
      return lines.join('\n')
    }
    case 'notice':
      return block.tone === 'info' ? block.text : `${block.tone}: ${block.text}`
    case 'command':
      return `${block.ok ? 'command' : 'command failed'} /${block.name}${block.text === '' ? '' : `\n${block.text}`}`
    case 'divider':
      return `── ${block.label} ──`
  }
}

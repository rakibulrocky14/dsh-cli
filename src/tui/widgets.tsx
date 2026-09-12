/**
 * Presentational Ink widgets for the terminal surface. All components take
 * plain props (no engine import) so they render deterministically in tests.
 *
 * @module dsh-terminal/tui/widgets
 */

import React from 'react'
import { Box, Text } from 'ink'
import { parseMarkdown } from '../core/markdown.js'
import { parseInline, splitFences, summarizeArgs, type Block } from '../core/transcript.js'
import { spinnerGlyph, type Field, type Modal, type Row, type Toast } from './engine.js'

/** Semantic palette (chalk honors NO_COLOR automatically). */
export const theme = {
  accent: '#4d6bfe',
  user: '#4d6bfe',
  thinking: 'gray',
  code: 'gray',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  muted: 'gray',
  border: 'gray',
  selection: '#4d6bfe',
  glyph: 'magenta',
} as const

/**
 * Pixel-art DeepSeek whale — half-block glyphs (`█▀▄`) rasterized directly
 * from the official DeepSeek vector logo. Two-lobed tail fluke top-right,
 * arched dorsal back top-left, white belly cut-out, and chin/flippers below.
 */
export const WHALE = [
  '   ▄▄▄▄▄██   █▄   ▄',
  ' █████████▄  █████▀',
  '█▀▀▀████████▄▄██▀  ',
  '█▄    ▀███▄ ████   ',
  '▀█▄     ▀██████    ',
  ' ▀█▄▄ █▄▄ ▀███     ',
  '   ▀▀██████▀▀▀▀    ',
] as const

/** Getting-started tips shown in the welcome box. */
const BANNER_TIPS = [
  '/ + tab completes commands',
  '/model switches · /effort tunes reasoning',
  'ctrl+o expands tool output',
]

/**
 * Welcome hero banner: unboxed Claude-Code-style hero header. The DeepSeek
 * whale mascot sits on the left with plenty of room, product info on the
 * right, and getting-started tips cleanly below. No cramped border box.
 */
export function Banner({ model, effort, cwd, recent, width = MAX_CONTENT }: {
  model: string
  effort: string
  cwd: string
  recent?: string
  width?: number
}): React.JSX.Element {
  const boxWidth = Math.max(40, width)
  const whaleWidth = WHALE.reduce((n, line) => Math.max(n, displayLen(line)), 0)
  const leftWidth = whaleWidth + 2
  const rightWidth = Math.max(16, boxWidth - leftWidth - 2)
  const info = `${model === '' ? 'unknown model' : model} · ${effort === '' ? 'auto' : effort}`
  return (
    <Box flexDirection="column" width={boxWidth}>
      <Box flexDirection="row" width={boxWidth} alignItems="flex-start">
        <Box flexDirection="column" width={leftWidth} marginRight={2} alignItems="center">
          {WHALE.map((line, i) => (
            <Text key={i} color={theme.accent}>{line.padEnd(whaleWidth)}</Text>
          ))}
          <Text bold color={theme.accent}>deepseek</Text>
        </Box>
        <Box flexDirection="column" width={rightWidth} justifyContent="center">
          <Text bold color={theme.accent}>DeepSeek Terminal <Text dimColor>· Welcome back!</Text></Text>
          <Text dimColor>{clipWidth(info, rightWidth)}</Text>
          <Text dimColor>{clipWidth(cwd, rightWidth)}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.warn}>Recent activity</Text>
            <Text dimColor>{recent === undefined || recent === '' ? 'No recent activity' : clipWidth(recent, rightWidth)}</Text>
          </Box>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text color={theme.warn}>Tips for getting started</Text>
        {BANNER_TIPS.map(t => <Text key={t} dimColor>{clipWidth(`  · ${t}`, boxWidth - 2)}</Text>)}
      </Box>
    </Box>
  )
}

/** Human wall time for tool cards (`840ms`, `1.2s`, `27s`). */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !(ms >= 0)) return undefined
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return seconds % 1 === 0 ? `${String(Math.round(seconds))}s` : `${seconds.toFixed(1)}s`
  return `${String(Math.round(seconds))}s`
}

const ARG_KEYS_GENERIC = new Set(['cmd', 'command', 'path', 'file_path', 'file', 'pattern', 'query', 'url', 'skill', 'name', 'id', 'prompt', 'question'])

/** Parsed view of one tool-call argument string. */
export interface ParsedToolArgs {
  /** Compact `Head(args)` text for the tool head. */
  oneLine: string
  /** File path argument, when present — drives the file card. */
  path?: string
  /** Content argument (new file body / edited text), when present. */
  content?: string
}

/**
 * Parse one tool argument string for display: single generic args collapse
 * to their bare value (`bash(ls -la)`), multi-field args render as
 * `k: v` pairs, and path+content args light up the Claude-style file card.
 */
export function parseToolArgs(argsText: string, max = 96): ParsedToolArgs {
  let obj: Record<string, unknown> | undefined
  try {
    const value = JSON.parse(argsText) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) obj = value as Record<string, unknown>
  } catch {
    // Not JSON: fall through to the raw summary.
  }
  let oneLine: string
  if (obj !== undefined) {
    const entries = Object.entries(obj).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    if (entries.length === 1 && ARG_KEYS_GENERIC.has(entries[0]![0])) oneLine = String(entries[0]![1])
    else if (entries.length > 0) oneLine = entries.map(([k, v]) => `${k}: ${String(v).split('\n')[0] ?? ''}`).join(' · ')
    else oneLine = summarizeArgs(argsText)
  } else {
    oneLine = summarizeArgs(argsText)
  }
  const path = ['path', 'file_path', 'file']
    .map(k => obj?.[k])
    .find(v => typeof v === 'string' && v !== '') as string | undefined
  const content = ['content', 'new_string', 'new_source', 'code']
    .map(k => obj?.[k])
    .find(v => typeof v === 'string' && v !== '') as string | undefined
  // File cards carry the content too — the head shows just the path
  // (Claude-Code style: Write(src/x.ts)), never the body preview.
  if (path !== undefined) oneLine = path
  return { oneLine: clipWidth(oneLine, max), path, content }
}

/** Inline spans (bold/code) for short single-paragraph text. */
export function InlineText({ text, dimmed = false }: { text: string; dimmed?: boolean }): React.JSX.Element {
  return (
    <Text dimColor={dimmed}>
      {parseInline(text).map((segment, i) => (
        <Text key={i} bold={segment.bold} dimColor={dimmed || segment.code}>{segment.text}</Text>
      ))}
    </Text>
  )
}

/** One markdown table as a padded column grid. */
function MarkdownTable({ headers, rows, width, dimmed }: {
  headers: string[]
  rows: string[][]
  width: number
  dimmed: boolean
}): React.JSX.Element {
  const cols = Math.max(1, headers.length, ...rows.map(r => r.length))
  const cells = (row: string[]): string[] => Array.from({ length: cols }, (_, i) => row[i] ?? '')
  const raw = [cells(headers), ...rows.map(cells)]
  const budget = Math.max(12, width)
  const colW = raw[0]!.map((_, c) => Math.min(28, Math.max(3, ...raw.map(r => displayLen(r[c] ?? '')))))
  const total = colW.reduce((n, w) => n + w, 0) + Math.max(0, cols - 1) * 3
  const scale = total > budget ? budget / total : 1
  const widths = colW.map(w => Math.max(3, Math.floor(w * scale)))
  const pad = (cell: string, w: number): string => {
    const clipped = clipWidth(cell.replace(/\*\*/g, '').replace(/`/g, ''), w)
    return clipped + ' '.repeat(Math.max(0, w - displayLen(clipped)))
  }
  const line = (row: string[]): string => row.map((c, i) => pad(c, widths[i]!)).join(' · ')
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color={dimmed ? undefined : theme.accent} dimColor={dimmed}>{line(cells(headers))}</Text>
      <Text dimColor>{widths.map(w => '─'.repeat(w)).join('─┼─')}</Text>
      {rows.map((row, i) => (
        <Text key={i} dimColor={dimmed}>{line(cells(row))}</Text>
      ))}
    </Box>
  )
}

/**
 * Markdown-aware assistant text: headings, tables, lists, quotes, fences,
 * and inline bold/code — the same family of chrome other TUIs show instead
 * of dumping raw `|` / `##` source.
 */
export function RichText({ text, dimmed = false, width = MAX_CONTENT }: {
  text: string
  dimmed?: boolean
  width?: number
}): React.JSX.Element {
  const sections = splitFences(text)
  return (
    <Box flexDirection="column">
      {sections.map((section, i) => {
        if (section.code) {
          return (
            <Box key={i} flexDirection="column" marginY={1}>
              {section.lang === '' ? undefined : <Text dimColor>  {section.lang}</Text>}
              <Text dimColor={dimmed} color={theme.code}>{section.text.split('\n').map(line => `  ${line}`).join('\n')}</Text>
            </Box>
          )
        }
        return (
          <Box key={i} flexDirection="column">
            {parseMarkdown(section.text).map((block, j) => {
              switch (block.kind) {
                case 'heading':
                  return (
                    <Box key={j} marginTop={j === 0 ? 0 : 1}>
                      <Text bold color={dimmed ? undefined : theme.accent} dimColor={dimmed}>{block.text}</Text>
                    </Box>
                  )
                case 'hr':
                  return <Text key={j} dimColor>{'─'.repeat(Math.min(24, Math.max(8, width - 4)))}</Text>
                case 'quote':
                  return (
                    <Box key={j} flexDirection="column" marginLeft={1}>
                      {block.lines.map((line, k) => (
                        <Text key={k} dimColor italic>│ {line}</Text>
                      ))}
                    </Box>
                  )
                case 'list':
                  return (
                    <Box key={j} flexDirection="column">
                      {block.items.map((item, k) => (
                        <Text key={k} dimColor={dimmed}>
                          {block.ordered ? `${String(k + 1)}. ` : '· '}
                          <InlineText text={item} dimmed={dimmed} />
                        </Text>
                      ))}
                    </Box>
                  )
                case 'table':
                  return <MarkdownTable key={j} headers={block.headers} rows={block.rows} width={width} dimmed={dimmed} />
                case 'para':
                  return (
                    <Box key={j} marginTop={j === 0 ? 0 : 1}>
                      <InlineText text={block.text} dimmed={dimmed} />
                    </Box>
                  )
              }
            })}
          </Box>
        )
      })}
    </Box>
  )
}

/** Clip long text to N lines with an ellipsis marker. */
function clipLines(text: string, max: number): { text: string; clipped: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, clipped: 0 }
  return { text: lines.slice(0, max).join('\n'), clipped: lines.length - max }
}

/** Keep the LAST N lines (live streaming region must not outgrow the screen). */
function clipTail(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, hidden: 0 }
  return { text: lines.slice(-max).join('\n'), hidden: lines.length - max }
}

/** Lines of live assistant text kept in the dynamic region while streaming. */
const LIVE_TEXT_LINES = 14

/**
 * One transcript block, Claude-Code-styled: user input on a full-width bar,
 * tool calls as `● Name(args)` cards with a `└` status line and collapsible
 * output, reasoning dimmed and collapsed by default. `width` is the content
 * column (bars and cards clip to it); `expanded` (ctrl+o) reveals full tool
 * output and reasoning. Live blocks carry activity glyphs.
 */
export function BlockView({ block, width = MAX_CONTENT, expanded = false, spinnerFrame = 0 }: {
  block: Block
  width?: number
  expanded?: boolean
  spinnerFrame?: number
}): React.JSX.Element {
  switch (block.kind) {
    case 'user': {
      const text = block.images > 0
        ? `${block.text}${block.text === '' ? '' : '\n'}[+${String(block.images)} image${block.images === 1 ? '' : 's'}]`
        : block.text
      return (
        <Box marginTop={1} width={width} backgroundColor="gray">
          <Text bold>{'> '}{text}</Text>
        </Box>
      )
    }
    case 'assistant': {
      // Live text clips from the top: the full message lands in scrollback
      // once committed, and a bounded live region keeps repaints cheap.
      const body = block.live ? clipTail(block.text, LIVE_TEXT_LINES) : { text: block.text, hidden: 0 }
      return (
        <Box flexDirection="column">
          {block.live ? <Text color={theme.success}>✻ assistant</Text> : undefined}
          {body.hidden > 0 ? <Text dimColor>… +{String(body.hidden)} lines above</Text> : undefined}
          <RichText text={body.text} width={width} />
        </Box>
      )
    }
    case 'reasoning': {
      const lines = block.text.split('\n')
      const label = `⋯ thinking${block.live ? ` ${spinnerGlyph(spinnerFrame)}` : ''}${lines.length > 1 ? ` · ${String(lines.length)} lines` : ''}`
      if (!expanded && !block.live) {
        const preview = clipWidth(lines[0] ?? '', Math.max(12, width - 4))
        return (
          <Box flexDirection="column">
            <Text dimColor>{label}</Text>
            {preview === '' ? undefined : <Text dimColor italic>  {preview}</Text>}
          </Box>
        )
      }
      const cap = block.live ? (expanded ? LIVE_TEXT_LINES : 4) : 20
      const tail = lines.slice(-cap)
      const hidden = lines.length - tail.length
      return (
        <Box flexDirection="column">
          <Text dimColor>{label}</Text>
          <Text dimColor italic>{tail.map(l => `  ${l}`).join('\n')}</Text>
          {hidden > 0 ? <Text dimColor>  … +{String(hidden)} lines{block.live ? ' above' : ' (ctrl+o to expand)'}</Text> : undefined}
        </Box>
      )
    }
    case 'tool':
      return <ToolCard block={block} width={width} expanded={expanded} spinnerFrame={spinnerFrame} />
    case 'notice': {
      const style = block.tone === 'info'
        ? { glyph: '·', color: theme.muted }
        : block.tone === 'warn'
          ? { glyph: '⚠', color: theme.warn }
          : { glyph: '✗', color: theme.error }
      return (
        <Box marginTop={1}>
          <Text color={style.color}>{style.glyph} {clipWidth(block.text, width - 3)}</Text>
        </Box>
      )
    }
    case 'command': {
      const textLines = block.text === '' ? [] : block.text.split('\n')
      const head = `└ /${block.name}${block.ok ? '' : ' failed'}`
      const first = textLines[0] ?? ''
      return (
        <Box flexDirection="column">
          <Text color={block.ok ? theme.muted : theme.error}>
            {clipWidth(first === '' ? head : `${head} — ${first}`, width - 1)}
          </Text>
          {textLines.length > 1 ? <Text dimColor>  {clipLines(textLines.slice(1).join('\n'), 6).text}</Text> : undefined}
        </Box>
      )
    }
    case 'divider': {
      // Centered session marker inside the padded content column.
      const label = ` ${block.label} `
      const rule = Math.max(20, width)
      const fill = Math.max(0, rule - displayLen(label))
      const left = Math.floor(fill / 2)
      return (
        <Box marginTop={1}>
          <Text dimColor>{'─'.repeat(left)}{label}{'─'.repeat(fill - left)}</Text>
        </Box>
      )
    }
  }
}

/** Cap for expanded tool output. */
const TOOL_EXPANDED_LINES = 40

/**
 * Tool call card: `● name(args)` head colored by status, a `└` status line
 * with wall time, and output that stays collapsed (3 lines) until ctrl+o.
 * Calls carrying a path+content argument render a Claude-style file card
 * with numbered lines instead of raw output.
 */
function ToolCard({ block, width, expanded, spinnerFrame }: {
  block: Extract<Block, { kind: 'tool' }>
  width: number
  expanded: boolean
  spinnerFrame: number
}): React.JSX.Element {
  const { oneLine, path, content } = parseToolArgs(block.args)
  const color = block.status === 'running' ? theme.warn : block.status === 'ok' ? theme.success : theme.error
  const duration = formatDuration(block.durationMs)
  const resultLines = block.resultText === '' ? [] : block.resultText.split('\n')
  const cardWidth = Math.max(20, width - 2)
  const isFileCard = !block.live && path !== undefined && content !== undefined
  const cardTitle = /write|create|add|save/i.test(block.name) ? 'Create file'
    : /edit|patch|replace|update|insert/i.test(block.name) ? 'Edit file'
      : 'File'
  const contentLines = content === undefined ? [] : content.split('\n')
  const cap = expanded ? TOOL_EXPANDED_LINES : 8
  const shownContent = contentLines.slice(0, cap)
  const hiddenContent = contentLines.length - shownContent.length
  const shownResult = resultLines.slice(0, expanded ? TOOL_EXPANDED_LINES : 3)
  const hiddenResult = resultLines.length - shownResult.length
  const statusLine = block.status === 'running'
    ? `└ ${spinnerGlyph(spinnerFrame)} running…`
    : `└ ${block.status === 'ok' ? 'done' : 'failed'}${duration === undefined ? '' : ` · ${duration}`}${resultLines.length > 0 && !isFileCard ? ` · ${String(resultLines.length)} line${resultLines.length === 1 ? '' : 's'}` : ''}`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={color} bold={block.status === 'running'}>● {block.name}</Text>
        {oneLine === '' ? undefined : <Text dimColor>({clipWidth(oneLine, Math.max(12, cardWidth - displayLen(block.name) - 4))})</Text>}
      </Text>
      <Text dimColor>  {statusLine}</Text>
      {isFileCard ? (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          <Text><Text bold color={theme.accent}>{cardTitle}</Text> <Text dimColor>{clipWidth(path ?? '', cardWidth - 4)}</Text></Text>
          <Text dimColor>{'┄'.repeat(Math.min(cardWidth, Math.max(12, (path ?? '').length + 14)))}</Text>
          {shownContent.map((line, i) => (
            <Text key={i}><Text dimColor>{String(i + 1).padStart(3)} </Text>{clipWidth(line, cardWidth - 5)}</Text>
          ))}
          {hiddenContent > 0 ? <Text dimColor>  … +{String(hiddenContent)} lines{expanded ? '' : ' (ctrl+o to expand)'}</Text> : undefined}
        </Box>
      ) : shownResult.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {shownResult.map((line, i) => (
            <Text key={i} dimColor>│ {clipWidth(line, cardWidth - 4)}</Text>
          ))}
          {hiddenResult > 0 ? <Text dimColor>│ … +{String(hiddenResult)} lines{expanded ? '' : ' (ctrl+o to expand)'}</Text> : undefined}
        </Box>
      ) : undefined}
    </Box>
  )
}

/** Short session id for chrome — implementation lives in core/commands. */
export { shortSession } from '../core/commands.js'

/** Width cap for the whole frame: ultra-wide terminals keep a readable column. */
export const MAX_CONTENT = 100

/** Display width of one character (ASCII and chrome glyphs 1, everything else 2). */
function charWidth(ch: string): number {
  return ch <= '~' || '─·›»—–…❯◆⚙✻✓✗⚠◉○◈⋯●└┄╭╮╰╯│┤╲╱█▀▄▌▐▖▗▘▝▙▚▛▜▞▟'.includes(ch) ? 1 : 2
}

/**
 * Conservative display width: ASCII and the box/dot symbols Ink chrome uses
 * count 1; anything else counts 2. Overcounting only shortens a fitted line
 * by a column or two, while undercounting wraps a full-width rule and
 * desyncs the fullscreen repaint — so this errs wide on purpose.
 * @param text - text to measure.
 */
export function displayLen(text: string): number {
  let n = 0
  for (const ch of text) n += charWidth(ch)
  return n
}

/**
 * Display-width-aware clip: the result never exceeds `max` columns
 * (ellipsis included). Used everywhere secondary text meets a border box,
 * so narrow terminals clip instead of wrapping mid-frame.
 */
export function clipWidth(text: string, max: number): string {
  if (max <= 0) return ''
  if (displayLen(text) <= max) return text
  let out = ''
  let n = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (n + w > max - 1) return `${out}…`
    out += ch
    n += w
  }
  return out
}

/** Short mode chip for the status line (full names live in /permissions). */
export function shortMode(mode: string): string {
  if (mode === 'danger-full-access') return 'YOLO'
  if (mode === 'workspace-write') return 'WRITE'
  if (mode === 'read-only') return 'READ'
  if (mode === '') return ''
  const upper = mode.toUpperCase()
  return upper.length > 8 ? upper.slice(0, 8) : upper
}

/** Clip the middle out of a long id, keeping both recognizable ends. */
export function fitMiddle(text: string, max: number): string {
  if (text.length <= max || max < 8) return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** Status-line segments before width fitting. */
export interface StatusInput {
  model: string
  effort: string
  cwd: string
  ctxTokens: number | undefined
  /** Model context window, when resolved — upgrades the ctx segment to a percent. */
  ctxWindow?: number
  mode: string
  /** Prompt cache hit rate (e.g. '85.2%'). */
  cacheRate?: string
  /** Settled or live generation speed in tokens per second. */
  tps?: number
}

/** Status-line segments after width fitting (single line, no wrapping). */
export interface StatusFit {
  model: string
  effort: string
  cwd: string
  ctx: string | undefined
  mode: string
  cache?: string
  tps?: string
}

/**
 * Context segment: `8.2k · 13%` when the window is known, else `8.2k tok`.
 */
export function formatCtx(tokens: number, window?: number): string {
  const base = formatTokens(tokens)
  if (window === undefined || window <= 0) return `${base} tok`
  const pct = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)))
  return `${base} · ${String(pct)}%`
}

/**
 * Fit status segments into one line: short mode chip always, then drop tps,
 * drop cache, drop ctx, shorten the path to its basename, then mid-clip the model id.
 * @param width - available content columns.
 * @param input - raw segments.
 */
export function fitStatus(width: number, input: StatusInput): StatusFit {
  const mode = shortMode(input.mode)
  const effort = input.effort === '' ? 'auto' : input.effort
  let cwd = input.cwd
  let ctx = input.ctxTokens === undefined ? undefined : formatCtx(input.ctxTokens, input.ctxWindow)
  let cache = input.cacheRate !== undefined && input.cacheRate !== '' ? `cache ${input.cacheRate}` : undefined
  let tps = input.tps !== undefined && input.tps > 0 ? `${String(input.tps)} tps` : undefined
  let model = input.model === '' ? 'unknown model' : input.model
  const total = (): number => {
    const parts = [model, effort, cwd, mode]
    if (ctx !== undefined) parts.push(ctx)
    if (cache !== undefined) parts.push(cache)
    if (tps !== undefined) parts.push(tps)
    return parts.reduce((n, part) => n + displayLen(part), 0) + (parts.length - 1) * 3
  }
  if (total() > width) tps = undefined
  if (total() > width) cache = undefined
  if (total() > width) ctx = undefined
  if (total() > width) {
    const slash = cwd.lastIndexOf('/')
    cwd = slash < 0 ? cwd : cwd.slice(slash + 1) === '' ? cwd : cwd.slice(slash + 1)
    if (cwd === '') cwd = input.cwd
  }
  if (total() > width) {
    const others = [effort, cwd, mode].reduce((n, part) => n + displayLen(part), 0)
      + (ctx === undefined ? 0 : displayLen(ctx))
      + (cache === undefined ? 0 : displayLen(cache))
      + (tps === undefined ? 0 : displayLen(tps))
      + 4 * 3
    model = fitMiddle(model, Math.max(16, width - others))
  }
  return { model, effort, cwd, ctx, mode, cache, tps }
}

/**
 * First positive finite candidate wins; 80 is the last resort.
 * Pure so the priority order stays unit-testable (live streams vary).
 * @param cands - width candidates, best first.
 */
export function pickWidth(cands: (number | undefined)[]): number {
  for (const cand of cands) {
    if (cand !== undefined && Number.isFinite(cand) && cand > 0) return Math.floor(cand)
  }
  return 80
}

/**
 * Resolve the usable terminal width. Live TTY sizes come first (Ink's
 * stdout, then the process streams — plugin hosts may pipe stdout, leaving
 * stderr as the surviving TTY); the `COLUMNS` env var follows, since an
 * exported copy goes stale on resize and must never beat a live reading.
 * @param stdoutColumns - columns reported by Ink's stdout handle.
 */
export function terminalWidth(stdoutColumns?: number): number {
  return pickWidth([
    stdoutColumns,
    process.stdout?.columns,
    process.stderr?.columns,
    Number(process.env.COLUMNS),
  ])
}

/**
 * Resolve the usable terminal height in rows (used for full-screen pinning).
 * @param stdoutRows - rows reported by Ink's stdout handle.
 */
export function terminalHeight(stdoutRows?: number): number {
  return Math.max(12, pickWidth([
    stdoutRows,
    process.stdout?.rows,
    process.stderr?.rows,
    Number(process.env.LINES),
    24,
  ]))
}

/**
 * Compact session marker above the composer (`── label`). Deliberately does
 * NOT fill the line: full-bleed rules fight the terminal frame on every
 * width and look heavy on wide screens.
 */
export function SessionBar({ label }: { label: string }): React.JSX.Element {
  return (
    <Text dimColor>── <Text color={theme.accent}>{label}</Text></Text>
  )
}

/** Compact token count (`12.4k`, `120k` — no trailing `.0`). */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  const k = count / 1000
  if (k >= 100) return `${String(Math.round(k))}k`
  return k % 1 === 0 ? `${String(k)}k` : `${k.toFixed(1)}k`
}

/** Mode-chip color by permission preset risk. */
export function modeColor(mode: string): string {
  if (mode === 'danger-full-access') return theme.error
  if (mode === 'workspace-write') return theme.warn
  if (mode === 'read-only') return theme.success
  return theme.muted
}

/** Single-line field with a block cursor. */
export function FieldView({ label, field, focused, placeholder = '' }: {
  label: string
  field: Field
  focused: boolean
  placeholder?: string
}): React.JSX.Element {
  const before = field.value.slice(0, field.cursor)
  const at = field.value.slice(field.cursor, field.cursor + 1)
  const after = field.value.slice(field.cursor + 1)
  const showPlaceholder = field.value === '' && placeholder !== ''
  return (
    <Box>
      <Text bold color={focused ? theme.accent : theme.muted}>{label} </Text>
      {showPlaceholder ? (
        <>
          {focused ? <Text inverse> </Text> : undefined}
          <Text dimColor>{placeholder}</Text>
        </>
      ) : (
        <Text>
          {before}
          {focused ? <Text inverse>{at === '' ? ' ' : at}</Text> : <Text>{at}</Text>}
          {after}
        </Text>
      )}
    </Box>
  )
}

/**
 * Main chat composer: two-row card with prompt on top and model badge + key hints below.
 * While a turn runs the border warms and the glyph becomes a spinner.
 */
export function Composer({
  field,
  focused = true,
  running = false,
  spinnerFrame = 0,
  runSeconds = 0,
  tps,
  width = MAX_CONTENT,
  placeholder,
  model,
  effort,
}: {
  field: Field
  focused?: boolean
  running?: boolean
  spinnerFrame?: number
  runSeconds?: number
  tps?: number
  width?: number
  placeholder?: string
  model?: string
  effort?: string
}): React.JSX.Element {
  const idleHint = 'Message (/ for commands)'
  const runHint = 'Steer the turn…'
  const label = running ? spinnerGlyph(spinnerFrame) : '❯'
  const innerWidth = Math.max(20, width - 4)
  const tpsPart = tps !== undefined && tps > 0 ? ` · ${String(tps)} tps` : ''
  const leftTag = running
    ? `${spinnerGlyph(spinnerFrame)} working ${String(runSeconds)}s${tpsPart}`
    : model !== undefined && model !== ''
      ? effort ? `${model} · ${effort}` : model
      : ''
  const rightTag = running ? 'typing steers · ctrl-c stops' : 'enter ↵ send · / commands'
  const showRight = innerWidth >= displayLen(leftTag) + displayLen(rightTag) + 4
  const showLeft = innerWidth >= displayLen(leftTag) + 2

  return (
    <Box flexDirection="column" width={width}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={running ? theme.warn : theme.accent}
        paddingX={1}
        width={width}
      >
        <Box flexDirection="row" width={innerWidth}>
          <FieldView
            label={label}
            field={field}
            focused={focused}
            placeholder={placeholder ?? (running ? runHint : idleHint)}
          />
        </Box>
        <Box flexDirection="row" justifyContent="space-between" width={innerWidth} marginTop={1}>
          <Box>
            {running ? (
              <Text color={theme.warn}>{leftTag}</Text>
            ) : showLeft && leftTag !== '' ? (
              <Text color={theme.accent}>◈ {clipWidth(leftTag, innerWidth - (showRight ? displayLen(rightTag) + 2 : 0))}</Text>
            ) : undefined}
          </Box>
          <Box>
            {showRight ? <Text dimColor>{rightTag}</Text> : undefined}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

/** Slash-command palette above the composer. */
export function Palette({ entries, index, width = MAX_CONTENT }: {
  entries: { name: string; desc: string; plugin: boolean }[]
  index: number
  /** Content-column width (for clipping descriptions). */
  width?: number
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  const usable = Math.max(20, width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width}>
      {entries.map((entry, i) => {
        const head = `${i === index ? '❯ ' : '  '}/${entry.name}`
        const descBudget = usable - displayLen(head) - (entry.plugin ? 2 : 0) - 1
        return (
          <Text key={entry.name} color={i === index ? theme.selection : undefined} bold={i === index}>
            {head}{entry.plugin ? <Text dimColor> ◈</Text> : undefined}
            {descBudget > 0 ? <Text dimColor> {clipWidth(entry.desc, descBudget)}</Text> : undefined}
          </Text>
        )
      })}
      <Text dimColor>  ↑↓ pick · tab complete · esc hide</Text>
    </Box>
  )
}

/** Glyph + color per toast tone. */
const TOAST_STYLE: Record<Toast['tone'], { glyph: string; color: string }> = {
  info: { glyph: '·', color: theme.muted },
  ok: { glyph: '✓', color: theme.success },
  warn: { glyph: '⚠', color: theme.warn },
  error: { glyph: '✗', color: theme.error },
}

/** Toast stack (latest last). */
export function Toasts({ items, width = MAX_CONTENT }: { items: Toast[]; width?: number }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <Box flexDirection="column">
      {items.map(toast => (
        <Text key={toast.id} color={TOAST_STYLE[toast.tone]!.color}>
          {TOAST_STYLE[toast.tone]!.glyph} {clipWidth(toast.text, Math.max(20, width - 3))}
        </Text>
      ))}
    </Box>
  )
}

/** Badge color by semantic: active is good, broken is bad, rest dim. */
function badgeColor(badge: string): string {
  if (badge === 'active') return theme.success
  if (badge.startsWith('broken')) return theme.error
  if (badge === 'running' || badge === 'working') return theme.warn
  return theme.muted
}

/** Generic selectable panel. */
export function Panel({ title, rows, loading, hint, index, maxRows = 20, spinnerFrame = 0, width = MAX_CONTENT }: {
  title: string
  rows: Row[]
  loading: boolean
  hint: string
  index: number
  maxRows?: number
  spinnerFrame?: number
  /** Content-column width (for clipping rows). */
  width?: number
}): React.JSX.Element {
  const start = Math.max(0, Math.min(index - Math.floor(maxRows / 2), Math.max(0, rows.length - maxRows)))
  const visible = rows.slice(start, start + maxRows)
  const usable = Math.max(20, width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} width={width}>
      <Text bold color={theme.accent}>▸ {clipWidth(title, usable)}{rows.length > 0 && !loading ? <Text dimColor> ({String(rows.length)})</Text> : undefined}</Text>
      {loading ? <Text dimColor>{spinnerGlyph(spinnerFrame)} loading…</Text> : undefined}
      {!loading && rows.length === 0 ? <Text dimColor>(empty)</Text> : undefined}
      {start > 0 ? <Text dimColor>… {String(start)} more above</Text> : undefined}
      {visible.map((row, i) => {
        const absolute = start + i
        const active = absolute === index
        const badge = row.badge === undefined ? '' : ` [${row.badge}]`
        const head = clipWidth(row.primary, Math.max(8, usable - displayLen(badge) - 6))
        const secondary = row.secondary === undefined || row.secondary === ''
          ? ''
          : clipWidth(row.secondary, Math.max(0, usable - displayLen(head) - displayLen(badge) - 5))
        return (
          <Text key={row.id} color={active ? theme.selection : undefined} bold={active}>
            {active ? '❯ ' : '  '}{head}
            {badge === '' ? '' : <Text color={badgeColor(row.badge!)}>{badge}</Text>}
            {secondary === '' ? '' : <Text dimColor> — {secondary}</Text>}
          </Text>
        )
      })}
      {start + visible.length < rows.length ? <Text dimColor>… {String(rows.length - start - visible.length)} more below</Text> : undefined}
      {hint === '' ? undefined : <Text dimColor>{clipWidth(hint, usable)}</Text>}
    </Box>
  )
}

/** Approval dialog (allow / reject). */
export function ApprovalDialog({ modal, width = MAX_CONTENT }: { modal: Extract<Modal, { kind: 'approval' }>; width?: number }): React.JSX.Element {
  const usable = Math.max(20, width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} marginTop={1} width={width}>
      <Text bold color={theme.warn}>▸ approval · {clipWidth(modal.toolName, usable - 14)}</Text>
      {modal.reason === '' ? undefined : <Text dimColor>{clipWidth(modal.reason, usable)}</Text>}
      {modal.args === '' ? undefined : <Text dimColor>args: {clipWidth(summarizeArgs(modal.args, 300), usable - 6)}</Text>}
      <Text><Text color={theme.success}>[a]llow</Text> <Text dimColor>/</Text> <Text color={theme.error}>[r]eject</Text> <Text dimColor>· esc rejects</Text></Text>
    </Box>
  )
}

/** One-question wizard step for agent questions. */
export function QuestionsDialog({ modal, width = MAX_CONTENT }: { modal: Extract<Modal, { kind: 'questions' }>; width?: number }): React.JSX.Element {
  const item = modal.items[modal.index]!
  if (item === undefined) return <Text dimColor>(no questions)</Text>
  const options = item.options ?? []
  const selected = modal.selected[modal.index]!
  const usable = Math.max(20, width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1} width={width}>
      <Text bold>question {String(modal.index + 1)}/{String(modal.items.length)}{item.header === undefined || item.header === '' ? '' : ` · ${item.header}`}</Text>
      <Text>{clipWidth(item.question, usable)}</Text>
      {item.detail === undefined || item.detail === '' ? undefined : <Text dimColor>{clipWidth(item.detail, usable)}</Text>}
      {options.map((option, i) => {
        const checked = selected.includes(option.label)
        const active = i === modal.optIndex && !modal.editingCustom
        const head = `${i + 1}. ${option.label}`
        const descBudget = Math.max(0, usable - 4 - displayLen(head))
        return (
          <Text key={i} color={active ? theme.selection : undefined} bold={active}>
            {active ? '❯ ' : '  '}
            <Text color={checked ? theme.success : theme.muted}>{checked ? '◉' : '○'}</Text>
            {` ${clipWidth(head, usable - 4)}`}
            {descBudget > 0 && option.description !== undefined && option.description !== ''
              ? <Text dimColor> — {clipWidth(option.description, descBudget)}</Text>
              : undefined}
          </Text>
        )
      })}
      <Box marginTop={options.length === 0 ? 0 : 1}>
        <FieldView label={options.length === 0 ? 'answer' : 'other'} field={modal.custom} focused={modal.editingCustom} placeholder="type here" />
      </Box>
      <Text dimColor>
        {item.multiSelect === true ? 'space toggles · ' : ''}
        {options.length === 0 ? 'enter answers' : 'enter confirms · e edits text · tab next'}
        {modal.items.length > 1 ? ' · shift+tab back' : ''} · esc skips
      </Text>
    </Box>
  )
}

/** Free-text dialog (model ids, settings values). */
export function TextDialog({ modal, width = MAX_CONTENT }: { modal: Extract<Modal, { kind: 'text' }>; width?: number }): React.JSX.Element {
  const usable = Math.max(20, width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1} width={width}>
      <Text bold color={theme.accent}>▸ {clipWidth(modal.title, usable - 2)}</Text>
      <FieldView label="❯" field={modal.field} focused />
      {modal.hint === '' ? undefined : <Text dimColor>{clipWidth(`${modal.hint} · enter confirms · esc cancels`, usable)}</Text>}
    </Box>
  )
}

/** Width-fitted status line (`model · effort · ~/cwd · ctx · cache · tps · MODE`) plus key hints. */
export function Footer({ model, effort, cwd, ctxTokens, ctxWindow, mode, cacheRate, tps, running, modalOpen, inPanel, width }: {
  model: string
  effort: string
  cwd: string
  ctxTokens: number | undefined
  ctxWindow?: number
  mode: string
  cacheRate?: string
  tps?: number
  running: boolean
  modalOpen: boolean
  inPanel: boolean
  width: number
}): React.JSX.Element {
  const keys = modalOpen
    ? 'answer above to continue'
    : inPanel
      ? '↑↓ select · enter open · esc back'
      : running
        ? 'typing steers · ctrl-c stops'
        : 'enter send · wheel/pgup scroll · / commands · ctrl-d quit'
  // One column of guard: the status must never touch the last cell, where a
  // wide-glyph surprise would wrap the line and desync the repaint.
  const fit = fitStatus(Math.max(24, width - 1), { model, effort, cwd, ctxTokens, ctxWindow, mode, cacheRate, tps })
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.accent}>{fit.model}</Text>
        <Text dimColor> · </Text>
        <Text color={theme.accent}>{fit.effort}</Text>
        <Text dimColor> · </Text>
        <Text dimColor>{fit.cwd}</Text>
        {fit.ctx === undefined ? undefined : (<><Text dimColor> · </Text><Text dimColor>{fit.ctx}</Text></>)}
        {fit.cache === undefined ? undefined : (<><Text dimColor> · </Text><Text color={theme.success}>{fit.cache}</Text></>)}
        {fit.tps === undefined ? undefined : (<><Text dimColor> · </Text><Text color={theme.accent}>{fit.tps}</Text></>)}
        <Text dimColor> · </Text>
        {mode === ''
          ? <Text dimColor>–</Text>
          : <Text bold color={modeColor(mode)}>[{fit.mode}]</Text>}
      </Box>
      <Box>
        <Text dimColor>{clipWidth(keys, Math.max(24, width))}</Text>
      </Box>
    </Box>
  )
}

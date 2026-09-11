import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Presentational Ink widgets for the terminal surface. All components take
 * plain props (no engine import) so they render deterministically in tests.
 *
 * @module dsh-terminal/tui/widgets
 */
import React from 'react';
import { Box, Text } from 'ink';
import { parseInline, splitFences, summarizeArgs } from '../core/transcript.js';
import { spinnerGlyph } from './engine.js';
/** Semantic palette (chalk honors NO_COLOR automatically). */
export const theme = {
    accent: 'cyan',
    user: 'cyan',
    thinking: 'gray',
    code: 'gray',
    success: 'green',
    warn: 'yellow',
    error: 'red',
    muted: 'gray',
    border: 'gray',
    selection: 'cyan',
    glyph: 'magenta',
};
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
];
/** Getting-started tips shown in the welcome box. */
const BANNER_TIPS = [
    '/ + tab completes commands',
    '/model switches · /effort tunes reasoning',
    'ctrl+o expands tool output',
];
/**
 * Welcome box: whale mascot on the left, greeting + tips + recent activity
 * on the right. `width` is the content column from the parent — never
 * measure the TTY here, or a lagging `columns` reading wraps the frame.
 */
export function Banner({ model, effort, cwd, recent, width = MAX_CONTENT }) {
    const boxWidth = Math.min(Math.max(40, width), MAX_CONTENT);
    const inner = Math.max(28, boxWidth - 6);
    const whaleWidth = WHALE.reduce((n, line) => Math.max(n, displayLen(line)), 0);
    const leftWidth = whaleWidth + 1;
    const rightWidth = Math.max(16, inner - leftWidth);
    const info = `${model === '' ? 'unknown model' : model} · ${effort === '' ? 'auto' : effort}`;
    return (_jsxs(Box, { borderStyle: "round", borderColor: theme.accent, paddingX: 1, paddingY: 1, width: boxWidth, flexDirection: "row", marginTop: 1, marginBottom: 1, children: [_jsxs(Box, { flexDirection: "column", width: leftWidth, marginRight: 1, alignItems: "center", children: [WHALE.map((line, i) => (_jsx(Text, { color: theme.accent, children: line.padEnd(whaleWidth) }, i))), _jsx(Text, { bold: true, color: theme.accent, children: "deepseek" })] }), _jsxs(Box, { flexDirection: "column", width: rightWidth, justifyContent: "center", children: [_jsx(Text, { bold: true, color: theme.accent, children: "Welcome back!" }), _jsx(Text, { dimColor: true, children: clipWidth(info, rightWidth) }), _jsx(Text, { dimColor: true, children: clipWidth(cwd, rightWidth) }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { color: theme.warn, children: "Tips for getting started" }), BANNER_TIPS.map(t => _jsx(Text, { dimColor: true, children: clipWidth(t, rightWidth) }, t))] }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { color: theme.warn, children: "Recent activity" }), _jsx(Text, { dimColor: true, children: recent === undefined || recent === '' ? 'No recent activity' : clipWidth(recent, rightWidth) })] })] })] }));
}
/** Human wall time for tool cards (`840ms`, `1.2s`, `27s`). */
export function formatDuration(ms) {
    if (ms === undefined || !(ms >= 0))
        return undefined;
    if (ms < 1000)
        return `${String(Math.round(ms))}ms`;
    const seconds = ms / 1000;
    if (seconds < 60)
        return seconds % 1 === 0 ? `${String(Math.round(seconds))}s` : `${seconds.toFixed(1)}s`;
    return `${String(Math.round(seconds))}s`;
}
const ARG_KEYS_GENERIC = new Set(['cmd', 'command', 'path', 'file_path', 'file', 'pattern', 'query', 'url', 'skill', 'name', 'id', 'prompt', 'question']);
/**
 * Parse one tool argument string for display: single generic args collapse
 * to their bare value (`bash(ls -la)`), multi-field args render as
 * `k: v` pairs, and path+content args light up the Claude-style file card.
 */
export function parseToolArgs(argsText, max = 96) {
    let obj;
    try {
        const value = JSON.parse(argsText);
        if (typeof value === 'object' && value !== null && !Array.isArray(value))
            obj = value;
    }
    catch {
        // Not JSON: fall through to the raw summary.
    }
    let oneLine;
    if (obj !== undefined) {
        const entries = Object.entries(obj).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
        if (entries.length === 1 && ARG_KEYS_GENERIC.has(entries[0][0]))
            oneLine = String(entries[0][1]);
        else if (entries.length > 0)
            oneLine = entries.map(([k, v]) => `${k}: ${String(v).split('\n')[0] ?? ''}`).join(' · ');
        else
            oneLine = summarizeArgs(argsText);
    }
    else {
        oneLine = summarizeArgs(argsText);
    }
    const path = ['path', 'file_path', 'file']
        .map(k => obj?.[k])
        .find(v => typeof v === 'string' && v !== '');
    const content = ['content', 'new_string', 'new_source', 'code']
        .map(k => obj?.[k])
        .find(v => typeof v === 'string' && v !== '');
    // File cards carry the content too — the head shows just the path
    // (Claude-Code style: Write(src/x.ts)), never the body preview.
    if (path !== undefined)
        oneLine = path;
    return { oneLine: clipWidth(oneLine, max), path, content };
}
/** Markdown-ish text: fenced code dimmed, inline bold/code spans. */
export function RichText({ text, dimmed = false }) {
    const sections = splitFences(text);
    return (_jsx(Text, { dimColor: dimmed, children: sections.map((section, i) => (_jsxs(Text, { dimColor: dimmed || section.code, color: section.code ? theme.code : undefined, children: [section.code ? section.text.split('\n').map(line => `  ${line}`).join('\n') : section.text, i < sections.length - 1 ? '\n' : ''] }, i))) }));
}
/** Inline spans (bold/code) for short single-paragraph text. */
export function InlineText({ text, dimmed = false }) {
    return (_jsx(Text, { dimColor: dimmed, children: parseInline(text).map((segment, i) => (_jsx(Text, { bold: segment.bold, dimColor: dimmed || segment.code, children: segment.text }, i))) }));
}
/** Clip long text to N lines with an ellipsis marker. */
function clipLines(text, max) {
    const lines = text.split('\n');
    if (lines.length <= max)
        return { text, clipped: 0 };
    return { text: lines.slice(0, max).join('\n'), clipped: lines.length - max };
}
/** Keep the LAST N lines (live streaming region must not outgrow the screen). */
function clipTail(text, max) {
    const lines = text.split('\n');
    if (lines.length <= max)
        return { text, hidden: 0 };
    return { text: lines.slice(-max).join('\n'), hidden: lines.length - max };
}
/** Lines of live assistant text kept in the dynamic region while streaming. */
const LIVE_TEXT_LINES = 14;
/**
 * One transcript block, Claude-Code-styled: user input on a full-width bar,
 * tool calls as `● Name(args)` cards with a `└` status line and collapsible
 * output, reasoning dimmed and collapsed by default. `width` is the content
 * column (bars and cards clip to it); `expanded` (ctrl+o) reveals full tool
 * output and reasoning. Live blocks carry activity glyphs.
 */
export function BlockView({ block, width = MAX_CONTENT, expanded = false, spinnerFrame = 0 }) {
    switch (block.kind) {
        case 'user': {
            const text = block.images > 0
                ? `${block.text}${block.text === '' ? '' : '\n'}[+${String(block.images)} image${block.images === 1 ? '' : 's'}]`
                : block.text;
            return (_jsx(Box, { marginTop: 1, width: width, backgroundColor: "gray", children: _jsxs(Text, { bold: true, children: ['> ', text] }) }));
        }
        case 'assistant': {
            // Live text clips from the top: the full message lands in scrollback
            // once committed, and a bounded live region keeps repaints cheap.
            const body = block.live ? clipTail(block.text, LIVE_TEXT_LINES) : { text: block.text, hidden: 0 };
            return (_jsxs(Box, { flexDirection: "column", children: [block.live ? _jsx(Text, { color: theme.success, children: "\u273B assistant" }) : undefined, body.hidden > 0 ? _jsxs(Text, { dimColor: true, children: ["\u2026 +", String(body.hidden), " lines above"] }) : undefined, _jsx(RichText, { text: body.text })] }));
        }
        case 'reasoning': {
            const lines = block.text.split('\n');
            const label = `⋯ thinking${block.live ? ` ${spinnerGlyph(spinnerFrame)}` : ''}${lines.length > 1 ? ` · ${String(lines.length)} lines` : ''}`;
            if (!expanded && !block.live) {
                const preview = clipWidth(lines[0] ?? '', Math.max(12, width - 4));
                return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: label }), preview === '' ? undefined : _jsxs(Text, { dimColor: true, italic: true, children: ["  ", preview] })] }));
            }
            const cap = block.live ? (expanded ? LIVE_TEXT_LINES : 4) : 20;
            const tail = lines.slice(-cap);
            const hidden = lines.length - tail.length;
            return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { dimColor: true, children: label }), _jsx(Text, { dimColor: true, italic: true, children: tail.map(l => `  ${l}`).join('\n') }), hidden > 0 ? _jsxs(Text, { dimColor: true, children: ["  \u2026 +", String(hidden), " lines", block.live ? ' above' : ' (ctrl+o to expand)'] }) : undefined] }));
        }
        case 'tool':
            return _jsx(ToolCard, { block: block, width: width, expanded: expanded, spinnerFrame: spinnerFrame });
        case 'notice': {
            const style = block.tone === 'info'
                ? { glyph: '·', color: theme.muted }
                : block.tone === 'warn'
                    ? { glyph: '⚠', color: theme.warn }
                    : { glyph: '✗', color: theme.error };
            return (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: style.color, children: [style.glyph, " ", clipWidth(block.text, width - 3)] }) }));
        }
        case 'command': {
            const textLines = block.text === '' ? [] : block.text.split('\n');
            const head = `└ /${block.name}${block.ok ? '' : ' failed'}`;
            const first = textLines[0] ?? '';
            return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: block.ok ? theme.muted : theme.error, children: clipWidth(first === '' ? head : `${head} — ${first}`, width - 1) }), textLines.length > 1 ? _jsxs(Text, { dimColor: true, children: ["  ", clipLines(textLines.slice(1).join('\n'), 6).text] }) : undefined] }));
        }
        case 'divider': {
            // Centered session marker inside the padded content column.
            const label = ` ${block.label} `;
            const rule = Math.min(Math.max(20, width), MAX_CONTENT);
            const fill = Math.max(0, rule - displayLen(label));
            const left = Math.floor(fill / 2);
            return (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ['─'.repeat(left), label, '─'.repeat(fill - left)] }) }));
        }
    }
}
/** Cap for expanded tool output. */
const TOOL_EXPANDED_LINES = 40;
/**
 * Tool call card: `● name(args)` head colored by status, a `└` status line
 * with wall time, and output that stays collapsed (3 lines) until ctrl+o.
 * Calls carrying a path+content argument render a Claude-style file card
 * with numbered lines instead of raw output.
 */
function ToolCard({ block, width, expanded, spinnerFrame }) {
    const { oneLine, path, content } = parseToolArgs(block.args);
    const color = block.status === 'running' ? theme.warn : block.status === 'ok' ? theme.success : theme.error;
    const duration = formatDuration(block.durationMs);
    const resultLines = block.resultText === '' ? [] : block.resultText.split('\n');
    const cardWidth = Math.max(20, width - 2);
    const isFileCard = !block.live && path !== undefined && content !== undefined;
    const cardTitle = /write|create|add|save/i.test(block.name) ? 'Create file'
        : /edit|patch|replace|update|insert/i.test(block.name) ? 'Edit file'
            : 'File';
    const contentLines = content === undefined ? [] : content.split('\n');
    const cap = expanded ? TOOL_EXPANDED_LINES : 8;
    const shownContent = contentLines.slice(0, cap);
    const hiddenContent = contentLines.length - shownContent.length;
    const shownResult = resultLines.slice(0, expanded ? TOOL_EXPANDED_LINES : 3);
    const hiddenResult = resultLines.length - shownResult.length;
    const statusLine = block.status === 'running'
        ? `└ ${spinnerGlyph(spinnerFrame)} running…`
        : `└ ${block.status === 'ok' ? 'done' : 'failed'}${duration === undefined ? '' : ` · ${duration}`}${resultLines.length > 0 && !isFileCard ? ` · ${String(resultLines.length)} line${resultLines.length === 1 ? '' : 's'}` : ''}`;
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: [_jsxs(Text, { color: color, bold: block.status === 'running', children: ["\u25CF ", block.name] }), oneLine === '' ? undefined : _jsxs(Text, { dimColor: true, children: ["(", clipWidth(oneLine, Math.max(12, cardWidth - displayLen(block.name) - 4)), ")"] })] }), _jsxs(Text, { dimColor: true, children: ["  ", statusLine] }), isFileCard ? (_jsxs(Box, { flexDirection: "column", marginLeft: 2, marginTop: 0, children: [_jsxs(Text, { children: [_jsx(Text, { bold: true, color: theme.accent, children: cardTitle }), " ", _jsx(Text, { dimColor: true, children: clipWidth(path ?? '', cardWidth - 4) })] }), _jsx(Text, { dimColor: true, children: '┄'.repeat(Math.min(cardWidth, Math.max(12, (path ?? '').length + 14))) }), shownContent.map((line, i) => (_jsxs(Text, { children: [_jsxs(Text, { dimColor: true, children: [String(i + 1).padStart(3), " "] }), clipWidth(line, cardWidth - 5)] }, i))), hiddenContent > 0 ? _jsxs(Text, { dimColor: true, children: ["  \u2026 +", String(hiddenContent), " lines", expanded ? '' : ' (ctrl+o to expand)'] }) : undefined] })) : shownResult.length > 0 ? (_jsxs(Box, { flexDirection: "column", marginLeft: 2, children: [shownResult.map((line, i) => (_jsxs(Text, { dimColor: true, children: ["\u2502 ", clipWidth(line, cardWidth - 4)] }, i))), hiddenResult > 0 ? _jsxs(Text, { dimColor: true, children: ["\u2502 \u2026 +", String(hiddenResult), " lines", expanded ? '' : ' (ctrl+o to expand)'] }) : undefined] })) : undefined] }));
}
/** Short session id for chrome — implementation lives in core/commands. */
export { shortSession } from '../core/commands.js';
/** Width cap for the whole frame: ultra-wide terminals keep a readable column. */
export const MAX_CONTENT = 100;
/** Display width of one character (ASCII and chrome glyphs 1, everything else 2). */
function charWidth(ch) {
    return ch <= '~' || '─·›»—–…❯◆⚙✻✓✗⚠◉○◈⋯●└┄╭╮╰╯│┤╲╱█▀▄▌▐▖▗▘▝▙▚▛▜▞▟'.includes(ch) ? 1 : 2;
}
/**
 * Conservative display width: ASCII and the box/dot symbols Ink chrome uses
 * count 1; anything else counts 2. Overcounting only shortens a fitted line
 * by a column or two, while undercounting wraps a full-width rule and
 * desyncs the fullscreen repaint — so this errs wide on purpose.
 * @param text - text to measure.
 */
export function displayLen(text) {
    let n = 0;
    for (const ch of text)
        n += charWidth(ch);
    return n;
}
/**
 * Display-width-aware clip: the result never exceeds `max` columns
 * (ellipsis included). Used everywhere secondary text meets a border box,
 * so narrow terminals clip instead of wrapping mid-frame.
 */
export function clipWidth(text, max) {
    if (max <= 0)
        return '';
    if (displayLen(text) <= max)
        return text;
    let out = '';
    let n = 0;
    for (const ch of text) {
        const w = charWidth(ch);
        if (n + w > max - 1)
            return `${out}…`;
        out += ch;
        n += w;
    }
    return out;
}
/** Short mode chip for the status line (full names live in /permissions). */
export function shortMode(mode) {
    if (mode === 'danger-full-access')
        return 'YOLO';
    if (mode === 'workspace-write')
        return 'WRITE';
    if (mode === 'read-only')
        return 'READ';
    if (mode === '')
        return '';
    const upper = mode.toUpperCase();
    return upper.length > 8 ? upper.slice(0, 8) : upper;
}
/** Clip the middle out of a long id, keeping both recognizable ends. */
export function fitMiddle(text, max) {
    if (text.length <= max || max < 8)
        return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
    const head = Math.ceil((max - 1) / 2);
    const tail = Math.floor((max - 1) / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
/**
 * Context segment: `8.2k · 13%` when the window is known, else `8.2k tok`.
 */
export function formatCtx(tokens, window) {
    const base = formatTokens(tokens);
    if (window === undefined || window <= 0)
        return `${base} tok`;
    const pct = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
    return `${base} · ${String(pct)}%`;
}
/**
 * Fit status segments into one line: short mode chip always, then drop ctx,
 * shorten the path to its basename, then mid-clip the model id.
 * @param width - available content columns.
 * @param input - raw segments.
 */
export function fitStatus(width, input) {
    const mode = shortMode(input.mode);
    const effort = input.effort === '' ? 'auto' : input.effort;
    let cwd = input.cwd;
    let ctx = input.ctxTokens === undefined ? undefined : formatCtx(input.ctxTokens, input.ctxWindow);
    let model = input.model === '' ? 'unknown model' : input.model;
    const total = () => {
        const parts = [model, effort, cwd, mode];
        if (ctx !== undefined)
            parts.push(ctx);
        return parts.reduce((n, part) => n + displayLen(part), 0) + (parts.length - 1) * 3;
    };
    if (total() > width)
        ctx = undefined;
    if (total() > width) {
        const slash = cwd.lastIndexOf('/');
        cwd = slash < 0 ? cwd : cwd.slice(slash + 1) === '' ? cwd : cwd.slice(slash + 1);
        if (cwd === '')
            cwd = input.cwd;
    }
    if (total() > width) {
        const others = [effort, cwd, mode].reduce((n, part) => n + displayLen(part), 0)
            + (ctx === undefined ? 0 : displayLen(ctx)) + 4 * 3;
        model = fitMiddle(model, Math.max(16, width - others));
    }
    return { model, effort, cwd, ctx, mode };
}
/**
 * First positive finite candidate wins; 80 is the last resort.
 * Pure so the priority order stays unit-testable (live streams vary).
 * @param cands - width candidates, best first.
 */
export function pickWidth(cands) {
    for (const cand of cands) {
        if (cand !== undefined && Number.isFinite(cand) && cand > 0)
            return Math.floor(cand);
    }
    return 80;
}
/**
 * Resolve the usable terminal width. Live TTY sizes come first (Ink's
 * stdout, then the process streams — plugin hosts may pipe stdout, leaving
 * stderr as the surviving TTY); the `COLUMNS` env var follows, since an
 * exported copy goes stale on resize and must never beat a live reading.
 * @param stdoutColumns - columns reported by Ink's stdout handle.
 */
export function terminalWidth(stdoutColumns) {
    return pickWidth([
        stdoutColumns,
        process.stdout?.columns,
        process.stderr?.columns,
        Number(process.env.COLUMNS),
    ]);
}
/**
 * Compact session marker above the composer (`── label`). Deliberately does
 * NOT fill the line: full-bleed rules fight the terminal frame on every
 * width and look heavy on wide screens.
 */
export function SessionBar({ label }) {
    return (_jsxs(Text, { dimColor: true, children: ["\u2500\u2500 ", _jsx(Text, { color: theme.accent, children: label })] }));
}
/** Compact token count (`12.4k`, `120k` — no trailing `.0`). */
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    const k = count / 1000;
    if (k >= 100)
        return `${String(Math.round(k))}k`;
    return k % 1 === 0 ? `${String(k)}k` : `${k.toFixed(1)}k`;
}
/** Mode-chip color by permission preset risk. */
export function modeColor(mode) {
    if (mode === 'danger-full-access')
        return theme.error;
    if (mode === 'workspace-write')
        return theme.warn;
    if (mode === 'read-only')
        return theme.success;
    return theme.muted;
}
/** Single-line field with a block cursor. */
export function FieldView({ label, field, focused, placeholder = '' }) {
    const before = field.value.slice(0, field.cursor);
    const at = field.value.slice(field.cursor, field.cursor + 1);
    const after = field.value.slice(field.cursor + 1);
    const showPlaceholder = field.value === '' && placeholder !== '';
    return (_jsxs(Box, { children: [_jsxs(Text, { bold: true, color: focused ? theme.accent : theme.muted, children: [label, " "] }), showPlaceholder ? (_jsxs(_Fragment, { children: [focused ? _jsx(Text, { inverse: true, children: " " }) : undefined, _jsx(Text, { dimColor: true, children: placeholder })] })) : (_jsxs(Text, { children: [before, focused ? _jsx(Text, { inverse: true, children: at === '' ? ' ' : at }) : _jsx(Text, { children: at }), after] }))] }));
}
/**
 * Main chat composer: a rounded box with a prompt glyph inside, matching
 * the Claude-Code input chrome. While a turn runs the border warms and the
 * glyph becomes a spinner so steering stays visually distinct from send.
 */
export function Composer({ field, focused = true, running = false, spinnerFrame = 0, runSeconds = 0, width = MAX_CONTENT, placeholder }) {
    const idleHint = 'Message (/ for commands)';
    const runHint = 'Steer the turn…';
    const label = running ? spinnerGlyph(spinnerFrame) : '❯';
    return (_jsxs(Box, { flexDirection: "column", width: width, marginTop: 1, children: [running ? (_jsxs(Text, { color: theme.warn, children: ["  ", spinnerGlyph(spinnerFrame), " working ", String(runSeconds), "s"] })) : undefined, _jsx(Box, { borderStyle: "round", borderColor: running ? theme.warn : theme.accent, paddingX: 1, width: width, children: _jsx(FieldView, { label: label, field: field, focused: focused, placeholder: placeholder ?? (running ? runHint : idleHint) }) })] }));
}
/** Slash-command palette above the composer. */
export function Palette({ entries, index, width = MAX_CONTENT }) {
    if (entries.length === 0)
        return null;
    const usable = Math.max(20, width - 4);
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.accent, paddingX: 1, width: width, children: [entries.map((entry, i) => {
                const head = `${i === index ? '❯ ' : '  '}/${entry.name}`;
                const descBudget = usable - displayLen(head) - (entry.plugin ? 2 : 0) - 1;
                return (_jsxs(Text, { color: i === index ? theme.selection : undefined, bold: i === index, children: [head, entry.plugin ? _jsx(Text, { dimColor: true, children: " \u25C8" }) : undefined, descBudget > 0 ? _jsxs(Text, { dimColor: true, children: [" ", clipWidth(entry.desc, descBudget)] }) : undefined] }, entry.name));
            }), _jsx(Text, { dimColor: true, children: "  \u2191\u2193 pick \u00B7 tab complete \u00B7 esc hide" })] }));
}
/** Glyph + color per toast tone. */
const TOAST_STYLE = {
    info: { glyph: '·', color: theme.muted },
    ok: { glyph: '✓', color: theme.success },
    warn: { glyph: '⚠', color: theme.warn },
    error: { glyph: '✗', color: theme.error },
};
/** Toast stack (latest last). */
export function Toasts({ items, width = MAX_CONTENT }) {
    if (items.length === 0)
        return null;
    return (_jsx(Box, { flexDirection: "column", children: items.map(toast => (_jsxs(Text, { color: TOAST_STYLE[toast.tone].color, children: [TOAST_STYLE[toast.tone].glyph, " ", clipWidth(toast.text, Math.max(20, width - 3))] }, toast.id))) }));
}
/** Badge color by semantic: active is good, broken is bad, rest dim. */
function badgeColor(badge) {
    if (badge === 'active')
        return theme.success;
    if (badge.startsWith('broken'))
        return theme.error;
    if (badge === 'running' || badge === 'working')
        return theme.warn;
    return theme.muted;
}
/** Generic selectable panel. */
export function Panel({ title, rows, loading, hint, index, maxRows = 20, spinnerFrame = 0, width = MAX_CONTENT }) {
    const start = Math.max(0, Math.min(index - Math.floor(maxRows / 2), Math.max(0, rows.length - maxRows)));
    const visible = rows.slice(start, start + maxRows);
    const usable = Math.max(20, width - 4);
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.border, paddingX: 1, marginTop: 1, width: width, children: [_jsxs(Text, { bold: true, color: theme.accent, children: ["\u25B8 ", clipWidth(title, usable), rows.length > 0 && !loading ? _jsxs(Text, { dimColor: true, children: [" (", String(rows.length), ")"] }) : undefined] }), loading ? _jsxs(Text, { dimColor: true, children: [spinnerGlyph(spinnerFrame), " loading\u2026"] }) : undefined, !loading && rows.length === 0 ? _jsx(Text, { dimColor: true, children: "(empty)" }) : undefined, start > 0 ? _jsxs(Text, { dimColor: true, children: ["\u2026 ", String(start), " more above"] }) : undefined, visible.map((row, i) => {
                const absolute = start + i;
                const active = absolute === index;
                const badge = row.badge === undefined ? '' : ` [${row.badge}]`;
                const head = clipWidth(row.primary, Math.max(8, usable - displayLen(badge) - 6));
                const secondary = row.secondary === undefined || row.secondary === ''
                    ? ''
                    : clipWidth(row.secondary, Math.max(0, usable - displayLen(head) - displayLen(badge) - 5));
                return (_jsxs(Text, { color: active ? theme.selection : undefined, bold: active, children: [active ? '❯ ' : '  ', head, badge === '' ? '' : _jsx(Text, { color: badgeColor(row.badge), children: badge }), secondary === '' ? '' : _jsxs(Text, { dimColor: true, children: [" \u2014 ", secondary] })] }, row.id));
            }), start + visible.length < rows.length ? _jsxs(Text, { dimColor: true, children: ["\u2026 ", String(rows.length - start - visible.length), " more below"] }) : undefined, hint === '' ? undefined : _jsx(Text, { dimColor: true, children: clipWidth(hint, usable) })] }));
}
/** Approval dialog (allow / reject). */
export function ApprovalDialog({ modal, width = MAX_CONTENT }) {
    const usable = Math.max(20, width - 4);
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.warn, paddingX: 1, marginTop: 1, width: width, children: [_jsxs(Text, { bold: true, color: theme.warn, children: ["\u25B8 approval \u00B7 ", clipWidth(modal.toolName, usable - 14)] }), modal.reason === '' ? undefined : _jsx(Text, { dimColor: true, children: clipWidth(modal.reason, usable) }), modal.args === '' ? undefined : _jsxs(Text, { dimColor: true, children: ["args: ", clipWidth(summarizeArgs(modal.args, 300), usable - 6)] }), _jsxs(Text, { children: [_jsx(Text, { color: theme.success, children: "[a]llow" }), " ", _jsx(Text, { dimColor: true, children: "/" }), " ", _jsx(Text, { color: theme.error, children: "[r]eject" }), " ", _jsx(Text, { dimColor: true, children: "\u00B7 esc rejects" })] })] }));
}
/** One-question wizard step for agent questions. */
export function QuestionsDialog({ modal, width = MAX_CONTENT }) {
    const item = modal.items[modal.index];
    if (item === undefined)
        return _jsx(Text, { dimColor: true, children: "(no questions)" });
    const options = item.options ?? [];
    const selected = modal.selected[modal.index];
    const usable = Math.max(20, width - 4);
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.accent, paddingX: 1, marginTop: 1, width: width, children: [_jsxs(Text, { bold: true, children: ["question ", String(modal.index + 1), "/", String(modal.items.length), item.header === undefined || item.header === '' ? '' : ` · ${item.header}`] }), _jsx(Text, { children: clipWidth(item.question, usable) }), item.detail === undefined || item.detail === '' ? undefined : _jsx(Text, { dimColor: true, children: clipWidth(item.detail, usable) }), options.map((option, i) => {
                const checked = selected.includes(option.label);
                const active = i === modal.optIndex && !modal.editingCustom;
                const head = `${i + 1}. ${option.label}`;
                const descBudget = Math.max(0, usable - 4 - displayLen(head));
                return (_jsxs(Text, { color: active ? theme.selection : undefined, bold: active, children: [active ? '❯ ' : '  ', _jsx(Text, { color: checked ? theme.success : theme.muted, children: checked ? '◉' : '○' }), ` ${clipWidth(head, usable - 4)}`, descBudget > 0 && option.description !== undefined && option.description !== ''
                            ? _jsxs(Text, { dimColor: true, children: [" \u2014 ", clipWidth(option.description, descBudget)] })
                            : undefined] }, i));
            }), _jsx(Box, { marginTop: options.length === 0 ? 0 : 1, children: _jsx(FieldView, { label: options.length === 0 ? 'answer' : 'other', field: modal.custom, focused: modal.editingCustom, placeholder: "type here" }) }), _jsxs(Text, { dimColor: true, children: [item.multiSelect === true ? 'space toggles · ' : '', options.length === 0 ? 'enter answers' : 'enter confirms · e edits text · tab next', modal.items.length > 1 ? ' · shift+tab back' : '', " \u00B7 esc skips"] })] }));
}
/** Free-text dialog (model ids, settings values). */
export function TextDialog({ modal, width = MAX_CONTENT }) {
    const usable = Math.max(20, width - 4);
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: theme.accent, paddingX: 1, marginTop: 1, width: width, children: [_jsxs(Text, { bold: true, color: theme.accent, children: ["\u25B8 ", clipWidth(modal.title, usable - 2)] }), _jsx(FieldView, { label: "\u276F", field: modal.field, focused: true }), modal.hint === '' ? undefined : _jsx(Text, { dimColor: true, children: clipWidth(`${modal.hint} · enter confirms · esc cancels`, usable) })] }));
}
/** Width-fitted status line (`model · effort · ~/cwd · ctx · MODE`) plus key hints. */
export function Footer({ model, effort, cwd, ctxTokens, ctxWindow, mode, running, modalOpen, inPanel, width }) {
    const keys = modalOpen
        ? 'answer above to continue'
        : inPanel
            ? '↑↓ select · enter open · esc back'
            : running
                ? 'typing steers · ctrl-c stops'
                : 'enter send · / commands · ctrl+o expand · ctrl-d quit';
    // One column of guard: the status must never touch the last cell, where a
    // wide-glyph surprise would wrap the line and desync the repaint.
    const fit = fitStatus(Math.max(24, width - 1), { model, effort, cwd, ctxTokens, ctxWindow, mode });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: theme.accent, children: fit.model }), _jsx(Text, { dimColor: true, children: " \u00B7 " }), _jsx(Text, { color: theme.accent, children: fit.effort }), _jsx(Text, { dimColor: true, children: " \u00B7 " }), _jsx(Text, { dimColor: true, children: fit.cwd }), fit.ctx === undefined ? undefined : (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: " \u00B7 " }), _jsx(Text, { dimColor: true, children: fit.ctx })] })), _jsx(Text, { dimColor: true, children: " \u00B7 " }), mode === ''
                        ? _jsx(Text, { dimColor: true, children: "\u2013" })
                        : _jsxs(Text, { bold: true, color: modeColor(mode), children: ["[", fit.mode, "]"] })] }), _jsx(Box, { children: _jsx(Text, { dimColor: true, children: clipWidth(keys, Math.max(24, width)) }) })] }));
}

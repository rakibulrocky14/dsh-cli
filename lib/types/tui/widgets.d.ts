/**
 * Presentational Ink widgets for the terminal surface. All components take
 * plain props (no engine import) so they render deterministically in tests.
 *
 * @module dsh-terminal/tui/widgets
 */
import React from 'react';
import { type Block } from '../core/transcript.js';
import { type Field, type Modal, type Row, type Toast } from './engine.js';
/** Semantic palette (chalk honors NO_COLOR automatically). */
export declare const theme: {
    readonly accent: "cyan";
    readonly user: "cyan";
    readonly thinking: "gray";
    readonly code: "gray";
    readonly success: "green";
    readonly warn: "yellow";
    readonly error: "red";
    readonly muted: "gray";
    readonly border: "gray";
    readonly selection: "cyan";
    readonly glyph: "magenta";
};
/**
 * Pixel-art DeepSeek whale — half-block glyphs (`█▀▄`) rasterized directly
 * from the official DeepSeek vector logo. Two-lobed tail fluke top-right,
 * arched dorsal back top-left, white belly cut-out, and chin/flippers below.
 */
export declare const WHALE: readonly ["   ▄▄▄▄▄██   █▄   ▄", " █████████▄  █████▀", "█▀▀▀████████▄▄██▀  ", "█▄    ▀███▄ ████   ", "▀█▄     ▀██████    ", " ▀█▄▄ █▄▄ ▀███     ", "   ▀▀██████▀▀▀▀    "];
/**
 * Welcome box: whale mascot on the left, greeting + tips + recent activity
 * on the right. `width` is the content column from the parent — never
 * measure the TTY here, or a lagging `columns` reading wraps the frame.
 */
export declare function Banner({ model, effort, cwd, recent, width }: {
    model: string;
    effort: string;
    cwd: string;
    recent?: string;
    width?: number;
}): React.JSX.Element;
/** Human wall time for tool cards (`840ms`, `1.2s`, `27s`). */
export declare function formatDuration(ms: number | undefined): string | undefined;
/** Parsed view of one tool-call argument string. */
export interface ParsedToolArgs {
    /** Compact `Head(args)` text for the tool head. */
    oneLine: string;
    /** File path argument, when present — drives the file card. */
    path?: string;
    /** Content argument (new file body / edited text), when present. */
    content?: string;
}
/**
 * Parse one tool argument string for display: single generic args collapse
 * to their bare value (`bash(ls -la)`), multi-field args render as
 * `k: v` pairs, and path+content args light up the Claude-style file card.
 */
export declare function parseToolArgs(argsText: string, max?: number): ParsedToolArgs;
/** Markdown-ish text: fenced code dimmed, inline bold/code spans. */
export declare function RichText({ text, dimmed }: {
    text: string;
    dimmed?: boolean;
}): React.JSX.Element;
/** Inline spans (bold/code) for short single-paragraph text. */
export declare function InlineText({ text, dimmed }: {
    text: string;
    dimmed?: boolean;
}): React.JSX.Element;
/**
 * One transcript block, Claude-Code-styled: user input on a full-width bar,
 * tool calls as `● Name(args)` cards with a `└` status line and collapsible
 * output, reasoning dimmed and collapsed by default. `width` is the content
 * column (bars and cards clip to it); `expanded` (ctrl+o) reveals full tool
 * output and reasoning. Live blocks carry activity glyphs.
 */
export declare function BlockView({ block, width, expanded, spinnerFrame }: {
    block: Block;
    width?: number;
    expanded?: boolean;
    spinnerFrame?: number;
}): React.JSX.Element;
/** Short session id for chrome — implementation lives in core/commands. */
export { shortSession } from '../core/commands.js';
/** Width cap for the whole frame: ultra-wide terminals keep a readable column. */
export declare const MAX_CONTENT = 100;
/**
 * Conservative display width: ASCII and the box/dot symbols Ink chrome uses
 * count 1; anything else counts 2. Overcounting only shortens a fitted line
 * by a column or two, while undercounting wraps a full-width rule and
 * desyncs the fullscreen repaint — so this errs wide on purpose.
 * @param text - text to measure.
 */
export declare function displayLen(text: string): number;
/**
 * Display-width-aware clip: the result never exceeds `max` columns
 * (ellipsis included). Used everywhere secondary text meets a border box,
 * so narrow terminals clip instead of wrapping mid-frame.
 */
export declare function clipWidth(text: string, max: number): string;
/** Short mode chip for the status line (full names live in /permissions). */
export declare function shortMode(mode: string): string;
/** Clip the middle out of a long id, keeping both recognizable ends. */
export declare function fitMiddle(text: string, max: number): string;
/** Status-line segments before width fitting. */
export interface StatusInput {
    model: string;
    effort: string;
    cwd: string;
    ctxTokens: number | undefined;
    /** Model context window, when resolved — upgrades the ctx segment to a percent. */
    ctxWindow?: number;
    mode: string;
}
/** Status-line segments after width fitting (single line, no wrapping). */
export interface StatusFit {
    model: string;
    effort: string;
    cwd: string;
    ctx: string | undefined;
    mode: string;
}
/**
 * Context segment: `8.2k · 13%` when the window is known, else `8.2k tok`.
 */
export declare function formatCtx(tokens: number, window?: number): string;
/**
 * Fit status segments into one line: short mode chip always, then drop ctx,
 * shorten the path to its basename, then mid-clip the model id.
 * @param width - available content columns.
 * @param input - raw segments.
 */
export declare function fitStatus(width: number, input: StatusInput): StatusFit;
/**
 * First positive finite candidate wins; 80 is the last resort.
 * Pure so the priority order stays unit-testable (live streams vary).
 * @param cands - width candidates, best first.
 */
export declare function pickWidth(cands: (number | undefined)[]): number;
/**
 * Resolve the usable terminal width. Live TTY sizes come first (Ink's
 * stdout, then the process streams — plugin hosts may pipe stdout, leaving
 * stderr as the surviving TTY); the `COLUMNS` env var follows, since an
 * exported copy goes stale on resize and must never beat a live reading.
 * @param stdoutColumns - columns reported by Ink's stdout handle.
 */
export declare function terminalWidth(stdoutColumns?: number): number;
/**
 * Compact session marker above the composer (`── label`). Deliberately does
 * NOT fill the line: full-bleed rules fight the terminal frame on every
 * width and look heavy on wide screens.
 */
export declare function SessionBar({ label }: {
    label: string;
}): React.JSX.Element;
/** Compact token count (`12.4k`, `120k` — no trailing `.0`). */
export declare function formatTokens(count: number): string;
/** Mode-chip color by permission preset risk. */
export declare function modeColor(mode: string): string;
/** Single-line field with a block cursor. */
export declare function FieldView({ label, field, focused, placeholder }: {
    label: string;
    field: Field;
    focused: boolean;
    placeholder?: string;
}): React.JSX.Element;
/**
 * Main chat composer: a rounded box with a prompt glyph inside, matching
 * the Claude-Code input chrome. While a turn runs the border warms and the
 * glyph becomes a spinner so steering stays visually distinct from send.
 */
export declare function Composer({ field, focused, running, spinnerFrame, runSeconds, width, placeholder }: {
    field: Field;
    focused?: boolean;
    running?: boolean;
    spinnerFrame?: number;
    runSeconds?: number;
    width?: number;
    placeholder?: string;
}): React.JSX.Element;
/** Slash-command palette above the composer. */
export declare function Palette({ entries, index, width }: {
    entries: {
        name: string;
        desc: string;
        plugin: boolean;
    }[];
    index: number;
    /** Content-column width (for clipping descriptions). */
    width?: number;
}): React.JSX.Element | null;
/** Toast stack (latest last). */
export declare function Toasts({ items, width }: {
    items: Toast[];
    width?: number;
}): React.JSX.Element | null;
/** Generic selectable panel. */
export declare function Panel({ title, rows, loading, hint, index, maxRows, spinnerFrame, width }: {
    title: string;
    rows: Row[];
    loading: boolean;
    hint: string;
    index: number;
    maxRows?: number;
    spinnerFrame?: number;
    /** Content-column width (for clipping rows). */
    width?: number;
}): React.JSX.Element;
/** Approval dialog (allow / reject). */
export declare function ApprovalDialog({ modal, width }: {
    modal: Extract<Modal, {
        kind: 'approval';
    }>;
    width?: number;
}): React.JSX.Element;
/** One-question wizard step for agent questions. */
export declare function QuestionsDialog({ modal, width }: {
    modal: Extract<Modal, {
        kind: 'questions';
    }>;
    width?: number;
}): React.JSX.Element;
/** Free-text dialog (model ids, settings values). */
export declare function TextDialog({ modal, width }: {
    modal: Extract<Modal, {
        kind: 'text';
    }>;
    width?: number;
}): React.JSX.Element;
/** Width-fitted status line (`model · effort · ~/cwd · ctx · MODE`) plus key hints. */
export declare function Footer({ model, effort, cwd, ctxTokens, ctxWindow, mode, running, modalOpen, inPanel, width }: {
    model: string;
    effort: string;
    cwd: string;
    ctxTokens: number | undefined;
    ctxWindow?: number;
    mode: string;
    running: boolean;
    modalOpen: boolean;
    inPanel: boolean;
    width: number;
}): React.JSX.Element;

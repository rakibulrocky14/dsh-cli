/**
 * Transcript projection: the durable session log folds into render blocks,
 * and live stream chunks overlay as pending blocks until their committed
 * message lands. Both the full-screen TUI and the line REPL render from
 * these blocks, so the two surfaces can never disagree about history.
 *
 * @module dsh-terminal/core/transcript
 */
import type { SessionEvent, StreamChunk } from './types.js';
/** One renderable transcript row. */
export type Block = {
    kind: 'user';
    id: string;
    text: string;
    images: number;
} | {
    kind: 'assistant';
    id: string;
    text: string;
    live: boolean;
} | {
    kind: 'reasoning';
    id: string;
    text: string;
    live: boolean;
} | {
    kind: 'tool';
    id: string;
    callId: string | undefined;
    name: string;
    args: string;
    status: 'running' | 'ok' | 'error';
    /** Wall time from tool/call to tool/result, when both are in the log. */
    durationMs: number | undefined;
    resultText: string;
    live: boolean;
} | {
    kind: 'notice';
    id: string;
    text: string;
    tone: 'info' | 'warn' | 'error';
} | {
    kind: 'command';
    id: string;
    name: string;
    text: string;
    ok: boolean;
} | {
    kind: 'divider';
    id: string;
    label: string;
};
/** True when a block is an in-flight live overlay (not yet committed). */
export declare function isLiveBlock(block: Block): boolean;
/** Extract readable text from model-facing content blocks. */
export declare function blocksText(blocks: unknown): {
    text: string;
    images: number;
};
/** Parse one tool's JSON argument string into a compact one-line summary. */
export declare function summarizeArgs(argsText: string, max?: number): string;
/**
 * Fold durable session events into render blocks.
 * Token-level `assistant/chunk` runs are skipped: the committed
 * `assistant/message` carries the same content.
 * @param events - the session log in seq order.
 * @returns render blocks, oldest first.
 */
export declare function projectEvents(events: readonly SessionEvent[]): Block[];
/** One task-list row folded from the latest `todo/write`. */
export interface TodoRow {
    text: string;
    status: string;
}
/**
 * Fold the session's current task list (latest write wins).
 * @param events - the session log in seq order.
 * @returns rows, or undefined when the session never wrote one.
 */
export declare function foldTodos(events: readonly SessionEvent[]): TodoRow[] | undefined;
/** Token totals folded from usage records, including cache hit rate and speed. */
export interface UsageTotals {
    input: number;
    output: number;
    responses: number;
    cacheHit?: number;
    cacheMiss?: number;
    cacheRate?: string;
    tps?: number;
}
/** Extract prompt cache hits and misses across provider usage formats. */
export declare function extractCacheTokens(usage: unknown): {
    hit: number;
    miss: number;
};
/** Format cache hit rate percentage string (e.g. '85.2%'). */
export declare function formatCacheHitRate(hit: number, totalInput: number, miss?: number): string | undefined;
/**
 * Fold token usage: committed per-message records win; otherwise sum the
 * token-level usage chunks (never both — they describe the same calls).
 * Also aggregates cache hit rate and average generation speed.
 * @param events - the session log in seq order.
 */
export declare function foldUsage(events: readonly SessionEvent[]): UsageTotals;
/** Outcome of one owned run interval (for one-shot exit codes). */
export interface RunOutcome {
    text: string;
    reasonKind: string | undefined;
}
/**
 * Aggregate the last assistant text and turn outcome over an interval.
 * @param events - the session log in seq order.
 * @param firstSeq - first seq owned by the interval.
 */
export declare function summarizeInterval(events: readonly SessionEvent[], firstSeq: number): RunOutcome;
/**
 * Live overlay for in-flight stream chunks. Committed events stay the truth:
 * every `notifyCommitted` rebuilds from the log and drops the live state the
 * new events supersede.
 */
export declare class LiveFeed {
    private text;
    private reasoning;
    private tools;
    private committed;
    private committedSeq;
    private listeners;
    private snapshotCache;
    private echoes;
    private echoSeq;
    tokens: {
        inputTokens: number;
        outputTokens: number;
        [key: string]: unknown;
    } | undefined;
    get liveText(): string;
    get liveReasoning(): string;
    /** Live prompt cache hit rate when reported in streaming usage chunks. */
    cacheRate(): string | undefined;
    /**
     * Surface-local input echo (slash commands never commit a log event, so
     * without this the submitted line would vanish from the transcript).
     */
    pushEcho(text: string): void;
    /** Subscribe to overlay changes; returns the disposer. */
    subscribe(listener: () => void): () => void;
    private emit;
    /** Consume one provider-neutral stream chunk. */
    pushChunk(chunk: StreamChunk): void;
    /**
     * Rebuild committed blocks from the log and clear superseded live state.
     * @param events - the session log in seq order.
     */
    notifyCommitted(events: readonly SessionEvent[]): void;
    /** Forget everything (agent switch). */
    reset(): void;
    /** Committed blocks without the live overlay. */
    committedBlocks(): Block[];
    /**
     * Committed blocks plus the live overlay. A committed tool call still
     * running in the log is hidden while the live overlay covers the same
     * callId, so a call can never show as two running cards at once. The
     * snapshot is cached between mutations: stream chunks arrive far more
     * often than commits, and every render used to copy the whole log.
     */
    snapshot(): Block[];
}
/** One inline-formatted text run. */
export interface Segment {
    text: string;
    bold: boolean;
    code: boolean;
}
/**
 * Parse lightweight inline markup (`**bold**`, `` `code` ``).
 * @param text - one logical line.
 */
export declare function parseInline(text: string): Segment[];
/** One fence-split section of assistant text. */
export interface TextSection {
    code: boolean;
    lang: string;
    text: string;
}
/**
 * Split fenced code blocks out of markdown-ish text.
 * @param text - assistant or tool text.
 */
export declare function splitFences(text: string): TextSection[];
/**
 * Render one block as plain text (line REPL, one-shot output).
 * @param block - the block to render.
 */
export declare function renderBlockText(block: Block): string;

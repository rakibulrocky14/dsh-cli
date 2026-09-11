/**
 * Single-reader terminal input for the line REPL. Exactly one owner reads
 * stdin at a time: the composer holds it while idle/running, and approval or
 * question modals borrow it with priority, so a modal answer can never leak
 * into chat as a steering message.
 *
 * Two transports: a raw-mode single-line editor (TTY stdin, with history and
 * Emacs keys) and a serialized cooked line queue (piped stdin).
 *
 * @module dsh-terminal/core/lineinput
 */
/** Minimal writer so tests can capture output. */
export interface Writer {
    write(chunk: string): unknown;
}
/**
 * Cooked-stdin line pump: one readline, modal-first dispatch.
 * Used when stdin is piped (raw mode unavailable).
 */
export declare class CookedInput {
    private readonly rl;
    private readonly queue;
    private readonly waiters;
    private ended;
    constructor(stdin: NodeJS.ReadableStream, stdout: Writer);
    /** Ask one line; modal waiters jump the queue. */
    question(prompt: string, stdout: Writer, modal?: boolean): Promise<string>;
    close(): void;
}
/** Callbacks driving one raw editing session. */
export interface EditorCallbacks {
    onSubmit(line: string): void;
    onCtrlC(): void;
    onCtrlD(): void;
    onInterruptHint?(): void;
}
/**
 * Raw-mode single-line editor with history, Emacs keys, and safe output
 * interleaving (`printAbove` redraws the prompt after every write).
 */
export declare class LineEditor {
    private readonly stdin;
    private readonly stdout;
    private readonly decoder;
    private buffer;
    private cursor;
    private prompt;
    private history;
    private historyIndex;
    private draft;
    private active;
    private oneshot;
    private readonly historyFile;
    private readonly cbs;
    private readonly onData;
    constructor(stdin: NodeJS.ReadStream, stdout: Writer, historyFile: string | undefined, cbs: EditorCallbacks);
    private saveHistory;
    /** Begin editing a fresh line under `prompt`. */
    activate(prompt: string): void;
    /** Change the prompt label without touching the buffer. */
    setPrompt(prompt: string): void;
    /** Suspend editing (a modal borrows the reader). */
    deactivate(): void;
    /** Release stdin entirely. */
    close(): void;
    /** Write output above the editing line, then redraw the prompt. */
    printAbove(text: string): void;
    /** Borrow the reader for one modal line (history-free). */
    oneshotLine(prompt: string): Promise<string>;
    private redraw;
    private commitHistory;
    private recall;
    private killWordBack;
    private moveWord;
    private handle;
}

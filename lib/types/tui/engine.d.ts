/**
 * Full-screen TUI engine: owns the agent lifecycle, transcript feed, views,
 * modals, composer, and key handling behind a versioned snapshot. React is a
 * thin renderer over this state, so every behavior here is drivable from
 * plain Node (and covered by smoke tests) without a TTY.
 *
 * @module dsh-terminal/tui/engine
 */
import { Dsh, type StartupValues } from '../core/dsh.js';
import { LiveFeed } from '../core/transcript.js';
import { type AskItem, type DshAgent, type DshContext, type ModelSelection } from '../core/types.js';
/** Panel views; settings drills into one namespace. */
export type View = {
    name: 'chat';
} | {
    name: 'sessions';
} | {
    name: 'model';
    provider?: string;
} | {
    name: 'effort';
} | {
    name: 'tools';
} | {
    name: 'commands';
} | {
    name: 'skills';
} | {
    name: 'agents';
} | {
    name: 'terminals';
} | {
    name: 'todos';
} | {
    name: 'usage';
} | {
    name: 'presets';
} | {
    name: 'plugins';
} | {
    name: 'settings';
    ns?: string;
} | {
    name: 'permissions';
} | {
    name: 'jobs';
} | {
    name: 'doctor';
} | {
    name: 'help';
};
/** One selectable panel row. */
export interface Row {
    id: string;
    primary: string;
    secondary?: string;
    badge?: string;
}
/** Single-line edit state (composer, text modal, custom answers). */
export interface Field {
    value: string;
    cursor: number;
}
export declare function emptyField(value?: string): Field;
/** Modal dialogs; resolvers settle the underlying DSH promise. */
export type Modal = {
    kind: 'approval';
    toolName: string;
    reason: string;
    args: string;
    resolve: (outcome: 'allowed-once' | 'rejected') => void;
} | {
    kind: 'questions';
    items: AskItem[];
    index: number;
    selected: string[][];
    customs: string[];
    optIndex: number;
    custom: Field;
    editingCustom: boolean;
    resolve: (answers: {
        id: string;
        selected: string[];
        custom?: string;
    }[]) => void;
} | {
    kind: 'text';
    title: string;
    hint: string;
    field: Field;
    resolve: (value: string | undefined) => void;
};
/** Braille frames for in-progress indicators (boot, running turn, loading). */
export declare const SPINNER_FRAMES: readonly ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Resolve one frame index to a spinner glyph. */
export declare function spinnerGlyph(frame: number): string;
export interface Toast {
    id: number;
    text: string;
    tone: 'info' | 'ok' | 'warn' | 'error';
}
/** Key event subset (mirrors Ink's useInput key). */
export interface TuiKey {
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    f1?: boolean;
}
/** Apply one key to a single-line field. Returns 'submit' on Enter. */
export declare function editField(field: Field, input: string, key: TuiKey): 'submit' | 'continue';
/** TUI engine: DSH lifecycle plus all interaction state. */
export declare class Engine {
    readonly dsh: Dsh;
    readonly feed: LiveFeed;
    private readonly exitFn;
    private listeners;
    private toastSeq;
    private modalSeq;
    version: number;
    status: 'booting' | 'ready' | 'error';
    bootError: string;
    quitting: boolean;
    cleared: boolean;
    /** Monotonic spinner frame; advances only while something is in flight. */
    spinnerFrame: number;
    /**
     * Bumped on every full-repaint request (terminal resize). The renderer
     * keys the static region with it: Ink's `<Static>` never re-flushes items
     * it already wrote, so without a remount a resize-clear would erase the
     * whole transcript history and never bring it back.
     */
    repaintSeq: number;
    /**
     * Optional wipe run immediately before the remount. The TUI host writes
     * CSI erase-screen (and erase-scrollback on resize) so a Static remount
     * cannot stack a second copy of the banner on leftover wrapped rows.
     * Tests leave this unset.
     */
    onFullRepaint: ((wipeScrollback: boolean) => void) | undefined;
    private runningFlag;
    private runStartValue;
    private spinnerTimer;
    /** A running turn drives the spinner and the elapsed-seconds chrome. */
    get running(): boolean;
    set running(value: boolean);
    view: View;
    rows: Row[];
    rowsLoading: boolean;
    rowsHint: string;
    rowIndex: number;
    modals: Modal[];
    toasts: Toast[];
    composer: Field;
    history: string[];
    private historyIndex;
    private draft;
    paletteIndex: number;
    private paletteDismissed;
    ctxTokens: number | undefined;
    /** Resolved context window of the current model (drives the ctx % meter). */
    ctxWindow: number | undefined;
    /** One-line label of the most recent persisted session (welcome banner). */
    recentActivity: string | undefined;
    /** Tool outputs expand by default when true (ctrl+o toggles + repaints). */
    toolsExpanded: boolean;
    /** Cached session names ('' = known untitled); filled in the background. */
    private readonly titleCache;
    mode: string;
    preset: string;
    private owned;
    private detachStream;
    private detachModel;
    private readonly modelRef;
    private ctxWindowKey;
    private pluginCommands;
    private readonly historyFile;
    constructor(ctx: DshContext, exitFn: (code: number) => void);
    get agent(): DshAgent | undefined;
    get modal(): Modal | undefined;
    get selection(): ModelSelection;
    subscribe: (listener: () => void) => (() => void);
    getVersion: () => number;
    /** Elapsed whole seconds of the running turn (0 when idle). */
    runSeconds(): number;
    /**
     * Keep the spinner interval alive exactly while something is in flight
     * (boot, panel load, running turn). Called from emit() so every state
     * change re-arms it; the tick itself re-emits through the same path.
     */
    private ensureSpinner;
    emit(): void;
    /**
     * Force a full frame repaint: the host wipes the screen, and the static
     * region remounts and re-flushes every committed block at the new width.
     * Used by the resize resync (`wipeScrollback`) and the ctrl+o expand toggle.
     */
    requestRepaint(wipeScrollback?: boolean): void;
    /** Best-effort one-liner about the most recent persisted session. */
    private loadRecentActivity;
    /** Flip the tool-output expansion and repaint the whole frame. */
    toggleToolsExpanded(): void;
    toast(text: string, tone?: Toast['tone'], ms?: number): void;
    private saveHistory;
    private commitHistory;
    /** Boot: settle the tree, open the agent, wire surface handlers. */
    boot(startup: StartupValues): Promise<void>;
    /** (Re)open the agent and rewire stream + model listeners. */
    reopen(startup: StartupValues): Promise<void>;
    /** Wire stream + model listeners around an adopted handle. */
    private adopt;
    /** Refresh cached status-bar readings (context pressure, mode). */
    private refreshStatus;
    /**
     * Resolve the current model's context window for the ctx % meter. Cached
     * per provider/model; a failed or unresolvable lookup keeps the meter off.
     */
    private refreshCtxWindow;
    /** Effective reasoning effort for the status line. */
    effectiveEffort(): string;
    /** Selectable efforts for the current model (resolved, static fallback). */
    effortOptions(): Promise<{
        id: string;
        name: string;
        description: string;
    }[]>;
    /** Switch the session model, keeping effort on the same provider. */
    private switchModel;
    /** Submit the composer line. */
    submitComposer(): void;
    /** Palette entries for the current composer value. */
    paletteEntries(): {
        name: string;
        desc: string;
        plugin: boolean;
    }[];
    /** Dispatch one slash line (views, actions, or plugin commands). */
    submitSlash(line: string): Promise<void>;
    /** Open a panel view and load its rows. */
    openView(view: View): void;
    private loadView;
    /** Live-preferred session corpus, newest first (sessionQuery, else manual merge). */
    private sessionRecords;
    /** Best-known name for one session: live log fold, else the cached read. */
    private sessionTitle;
    /**
     * Name-first row, web-parity labeling: durable title, else the project
     * basename (what the web shows for untitled sessions), with the short id,
     * age, and project as the detail line.
     */
    private sessionRow;
    private buildSessionRows;
    /**
     * Read persisted-session names in one batched background call (cached
     * across opens, '' = known untitled); rows update once when it lands.
     * Selection follows the session id, never a row index.
     */
    private fillSessionTitles;
    /** Activate the selected panel row. */
    activateRow(): void;
    /**
     * Apply a normalized effort selection to the session override, then
     * return to chat — picking from the panel commits and closes it (the
     * composer must come back), matching the model-panel flow.
     */
    private applyEffort;
    private applyModelText;
    private resolveSessionPrefix;
    /** Queue an approval dialog; resolves the DSH waterfall. */
    askApproval(toolName: string, reason: string, callId: string | undefined): Promise<'allowed-once' | 'rejected'>;
    /** Queue a user-questions dialog; resolves the awaiting tool call. */
    askQuestions(items: AskItem[]): Promise<{
        answers: {
            id: string;
            selected: string[];
            custom?: string;
        }[];
    }>;
    /** Queue a free-text dialog. */
    openTextModal(title: string, hint: string, initial: string, resolve: (value: string | undefined) => void): void;
    /** Resolve and drop the active modal. */
    private settleModal;
    /** Recall composer history. */
    private recallHistory;
    /** Central key router (called from the renderer's useInput). */
    handleKey(input: string, key: TuiKey): void;
    private handlePanelKey;
    private handleModalKey;
    /** Cancel, flush, dispose, and request process exit. */
    quit(): Promise<void>;
}

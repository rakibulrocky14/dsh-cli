/**
 * UI-agnostic facade over the live DSH services. Every accessor tolerates a
 * missing service (different profile composition or dsh release) by returning
 * `undefined`/empty, so surfaces degrade to honest empty states instead of
 * crashing.
 *
 * @module dsh-terminal/core/dsh
 */
import { LiveFeed } from './transcript.js';
import { type AgentPresetInfo, type ApprovalOutcome, type ApprovalRequest, type AskAnswer, type AskItem, type CommandDescriptorInfo, type CommandResultInfo, type DshAgent, type DshAgentHandle, type DshContext, type DshSession, type JobSnapshotInfo, type ModelSelection, type ModelSelectionRef, type ProviderInfo, type SessionEvent, type SessionHeaderInfo, type SettingsDescriptorInfo, type ToolSchemaInfo } from './types.js';
/** Values the runner reads from the `terminalStartup` service. */
export interface StartupValues {
    resume: string;
    model: string;
    provider: string;
    print: string;
    preset?: string;
}
/** Async approval answer supplied by the active surface. */
export type ApprovalAnswerer = (request: ApprovalRequest) => Promise<ApprovalOutcome>;
/** Async user-question answer supplied by the active surface. */
export type QuestionAnswerer = (questions: AskItem[], agent: DshAgent | undefined) => Promise<AskAnswer>;
/** One installed profile plugin row. */
export interface PluginRow {
    name: string;
    version: string;
    source: string;
}
/**
 * Fork boundary for a log: the last `turn/end` seq. A fork seed must end at
 * a completed turn — never inside an open one.
 * @param events - the session log in seq order.
 * @returns the inclusive boundary seq, or undefined when unforkable.
 */
export declare function forkBoundary(events: readonly SessionEvent[]): number | undefined;
/** Harness home directory (DSH_HOME or ~/.dsh). */
export declare function dshHome(): string;
/** Active profile name (DSH_PROFILE or 'terminal'). */
export declare function dshProfile(): string;
/** Read installed plugin rows from the active profile's package.json. */
export declare function listProfilePlugins(): {
    rows: PluginRow[];
    profile: string;
    home: string;
};
/**
 * Install an upstream-style mutable model selection on one agent scope:
 * prompt assembly snapshots the selection into `{{provider}}`/`{{model}}`,
 * the request waterfall routes by it, and a durable notice marks switches.
 * @param agentCtx - the agent's scoped context.
 * @param agent - the live agent (for header comparison).
 * @param ref - mutable selection owned by the surface.
 * @returns disposer for the three scoped listeners.
 */
export declare function installModelOverride(agentCtx: DshContext, agent: DshAgent, ref: ModelSelectionRef): () => void;
/** Send one user message, waking the driver. */
export declare function sendFollowup(agent: DshAgent, text: string): void;
/** Steer the nearest step boundary. */
export declare function sendSteer(agent: DshAgent, text: string): void;
/**
 * Attach live-stream ingestion for one agent across dsh releases: newer
 * servers emit `agent/assistant-stream` frames, older ones log top-level
 * `assistant/chunk` events on `session/event`. First chunk source wins, so a
 * server emitting both can never double-render.
 * @param ctx - plugin context carrying the feeds.
 * @param agent - the exact agent to follow.
 * @param feed - overlay receiving chunks.
 * @param onSessionEvent - every committed event for our session.
 * @returns disposer detaching both listeners.
 */
export declare function attachLiveStream(ctx: DshContext, agent: DshAgent, feed: LiveFeed, onSessionEvent: (event: SessionEvent) => void): () => void;
/** One live-preferred corpus record for the sessions browser. */
export interface SessionListRecord {
    id: string;
    createdAt: number | undefined;
    cwd: string | undefined;
    live: boolean;
}
/**
 * Workspace projection mirroring `ctx.workspaceRegistry`: plain data (never
 * the live entity) in durable registry order, so the sessions browser can
 * render without holding Cordis services. Absence of the registry service
 * yields undefined, and the browser falls back to cwd grouping.
 */
export interface WorkspaceRecord {
    id: string;
    path: string;
    title: string;
    sessionIds: string[];
    createdAt: string;
    updatedAt: string;
}
/** Facade over the live DSH services reachable from one context. */
export declare class Dsh {
    readonly ctx: DshContext;
    constructor(ctx: DshContext);
    /** Await loader settlement so agent scopes compose completely. */
    awaitReady(): Promise<void>;
    /**
     * Create (or resume) the process-wide interactive agent.
     * @param startup - resolved CLI values.
     * @param preset - preset id to compose, when the user applied one.
     */
    openAgent(startup: StartupValues, preset?: string): Promise<DshAgentHandle>;
    /**
     * Create (or open) an agent for one explicit canonical cwd — the workspace
     * flow for "open this directory": resolve-or-create the path's workspace,
     * create the session there, and attach it. Attachment failure disposes the
     * newly created handle (the session log itself is untouched — the user can
     * still resume it) and rejects honestly.
     * @param cwd - canonical directory owning the new session.
     * @param startup - resolved CLI values (resume/model/provider).
     * @param preset - preset id to compose, when the user applied one.
     */
    openAgentInWorkspace(cwd: string, startup: StartupValues, preset?: string): Promise<DshAgentHandle>;
    /** Current default provider/model selection. */
    currentModel(): ModelSelection;
    /** Persist the default selection (same keys the Web Models page writes). */
    saveDefaultModel(selection: ModelSelection): Promise<void>;
    /** One provider's advertised models (advisory: unlisted ids may still route). */
    listModels(provider: string): Promise<{
        id: string;
        name: string;
        description: string;
    }[]>;
    /**
     * Resolved model metadata: selectable reasoning efforts plus context facts.
     * @param provider - registered provider route.
     * @param model - exact model id.
     * @returns efforts and context, or undefined when unresolvable.
     */
    resolveModel(provider: string, model: string): Promise<{
        efforts: {
            id: string;
            name: string;
            description: string;
        }[];
        defaultEffort: string;
        contextWindow: number | undefined;
    } | undefined>;
    /** Provider routes with a registered adapter. */
    listProviders(): ProviderInfo[];
    /** Live sessions in this process. */
    listLiveSessions(): DshSession[];
    /**
     * The whole session corpus, newest first: the base bundle's session-query
     * service merged over live + persisted. Returns undefined when the service
     * is absent (older compositions) so callers can fall back to manual merges.
     */
    listSessionRecords(): Promise<SessionListRecord[] | undefined>;
    /**
     * Batch-read durable session titles through the base bundle's
     * session-query service: `readTitleSnapshots` on the installed release,
     * `observeSession` on newer checkouts. Returns id → title, omitting
     * sessions that have none or failed to read.
     */
    readSessionTitles(ids: readonly string[]): Promise<Map<string, string>>;
    /** Persisted session headers across processes. */
    listPersistedSessions(): Promise<SessionHeaderInfo[]>;
    /** Fold the latest `session/title` event from a log. */
    foldTitle(events: readonly SessionEvent[]): string | undefined;
    /** First human message, truncated — title fallback for the browser. */
    firstPrompt(events: readonly SessionEvent[], max?: number): string | undefined;
    /** Flush one session to durable storage; resolves false when unavailable. */
    flush(session: DshSession): Promise<boolean>;
    /** Tool schemas visible to one agent (global view when scopes fail). */
    listTools(agent: DshAgent | undefined): ToolSchemaInfo[];
    /** Human-command descriptors effective for one agent. */
    listCommands(agent: DshAgent): CommandDescriptorInfo[];
    /**
     * Dispatch one slash-command line to the plugin registry.
     * @param agent - exact receiving agent.
     * @param line - complete `/name …` line.
     * @param signal - cancellation for the dispatching request.
     * @returns the settled outcome, or undefined for an admission miss.
     */
    executeCommand(agent: DshAgent, line: string, signal: AbortSignal): Promise<CommandResultInfo | undefined>;
    /** Register the surface's user-question provider. */
    registerQuestions(answerer: QuestionAnswerer, isOurs: (agent: DshAgent | undefined) => boolean): () => void;
    /** Answer approval requests for our agent through the surface handler. */
    onApproval(answerer: ApprovalAnswerer, isOurs: (agent: {
        id: string;
    }) => boolean): () => void;
    /** Find a tool/call's argument string in the log for approval cards. */
    findToolArgs(session: DshSession, callId: string | undefined): string;
    /** Default preset id configured in agentPresets, if present. */
    defaultPresetId(): string | undefined;
    /** Agent presets from every configured root. */
    listPresets(): Promise<AgentPresetInfo[]>;
    /** Compose one agent scope from a preset (call from factory setup). */
    mountPreset(agentCtx: DshContext, id: string): Promise<void>;
    /** Background-job snapshots visible to one agent. */
    listJobs(agent: DshAgent | undefined): JobSnapshotInfo[];
    /** Describe every registered settings namespace for configuration UI. */
    describeSettings(): SettingsDescriptorInfo[];
    /** Merge a patch into one settings namespace's user layer. */
    updateSetting(ns: string, patch: Record<string, unknown>): Promise<void>;
    /** Absolute settings-document path, when file-backed. */
    settingsPath(): string | undefined;
    /** Measure request pressure for the status bar. */
    measureTokens(session: DshSession): {
        totalTokens: number;
        surfaceTokens: number;
    } | undefined;
    /** Permission-preset service across ctx-key spellings. */
    private permissionService;
    /** Permission-preset names in declaration order. */
    permissionNames(): string[];
    /** Effective permission preset for one session's log. */
    permissionCurrent(events: readonly SessionEvent[]): string;
    /** Switch one session's permission preset. */
    permissionSet(session: DshSession, name: string): void;
    /**
     * The preset id a session runs under, newest selection winning: the
     * creation header's value, superseded by any `agent-preset/selected`
     * event. Terminal sessions (rosterless composition) resolve undefined.
     * @param session - live session with header and log.
     */
    sessionPreset(session: DshSession): string | undefined;
    /**
     * Fork a live agent's session at its last turn boundary and create the
     * child agent. The caller flushes and disposes the source handle, then
     * adopts the returned one. The agent must be idle (no open turn).
     * @param agent - the exact live agent to fork.
     * @returns the owned child handle.
     */
    forkAgent(agent: DshAgent): Promise<DshAgentHandle>;
    /** Rename one live session (pins the title; auto-generation stops). */
    renameSession(session: DshSession, title: string): string;
    /**
     * The workspace registry, when the composition mounts it: feature-detected
     * structurally so older profiles (no workspace row) degrade to undefined
     * and the sessions browser falls back to cwd grouping.
     */
    private workspaces;
    /**
     * Workspace listing for the sessions browser: plain records in durable
     * registry order plus the archived set, or undefined when the registry is
     * absent. Malformed rows are skipped, never thrown.
     */
    listWorkspaces(): {
        workspaces: WorkspaceRecord[];
        archivedSessionIds: string[];
    } | undefined;
    /**
     * Resolve (or create) the workspace owning one directory: existing owner
     * first, else a create through `fs.realpath` canonicalization. Returns
     * undefined — never throws for registry absence — so ordinary session
     * creation stays total.
     * @param path - directory in any spelling; must exist.
     */
    resolveWorkspaceForPath(path: string): Promise<WorkspaceRecord | undefined>;
    /**
     * Attach an existing session to a workspace by id. Throws honestly when the
     * registry or workspace is absent (or the attach rejects) — callers decide
     * whether that failure is fatal. Never deletes a session.
     * @param sessionId - live or persisted session to record.
     * @param workspaceId - owning workspace.
     */
    attachSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void>;
    /**
     * Find the workspace owning a session: the registry projection's `sessionIds`
     * membership, probed synchronously so the browser can call it per row.
     * Returns undefined when absent or unowned (older compositions, Ungrouped).
     * @param sessionId - session whose owner to find.
     */
    findWorkspaceForSession(sessionId: string): WorkspaceRecord | undefined;
    /**
     * Selectable efforts for one model: adapter-resolved, else the static
     * DeepSeek vocabulary fallback.
     */
    effortOptions(provider: string, model: string): Promise<{
        id: string;
        name: string;
        description: string;
    }[]>;
    /** Effective reasoning effort: override, live header, default, or ''. */
    currentEffort(agent: DshAgent | undefined, override?: string): string;
    /** Live agents in registration order. */
    listAgents(): {
        id: string;
        status: string;
    }[];
    /** Skill catalog summaries. */
    listSkills(): Promise<{
        name: string;
        description: string;
    }[]>;
    /** Persistent terminal sessions owned by one agent. */
    listTerminals(agent: DshAgent | undefined): {
        id: string;
        status: string;
        label: string;
    }[];
}
/**
 * Canonical English copy for shipped presets, matching `@deepseek-ai/dsh-client-ui-agent-preset`.
 * Raw disk metadata in DSH defaults to Chinese; this lookup aligns the terminal TUI with Web DSH.
 */
export declare const BUILT_IN_PRESET_COPY: Record<string, {
    name: string;
    description: string;
}>;
/**
 * Resolve display copy for an agent preset. Shipped / system presets use
 * Web DSH's English copy; user-authored presets keep their authored metadata.
 */
export declare function presetDisplayText(preset: {
    id: string;
    name?: string;
    description?: string;
    trust?: 'system' | 'user';
}): {
    name: string;
    description?: string;
};

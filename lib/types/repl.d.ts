/**
 * Line-oriented terminal surface: the non-TTY fallback (pipes, CI, dumb
 * terminals) and the scripting path. Shares the agent lifecycle, transcript
 * projection, and service facades with the full-screen TUI.
 *
 * @module dsh-terminal/repl
 */
import { type StartupValues } from './core/dsh.js';
import { type DshContext } from './core/types.js';
/** Process IO for the REPL. */
export interface ReplIo {
    stdin: NodeJS.ReadStream;
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
}
/** Interactive line surface over one DSH context. */
export declare class Repl {
    private readonly dsh;
    private readonly io;
    private readonly raw;
    private readonly editor;
    private readonly cooked;
    private owned;
    private detachStream;
    private detachModel;
    private readonly feed;
    private readonly modelRef;
    private running;
    private quitting;
    private preset;
    private lastCtrlC;
    private lineResolver;
    private textOpen;
    private reasoningOpen;
    private echoedText;
    private echoedReasoning;
    private printedIds;
    constructor(ctx: DshContext, io: ReplIo);
    private get agent();
    private out;
    private closeStreamLine;
    private handleCtrlC;
    private promptLabel;
    private waitLine;
    private modalLine;
    private paintHeader;
    private printStatusTail;
    private printBlocks;
    /** (Re)open the agent and rewire stream + model listeners. */
    private reopen;
    /** Wire stream + model listeners around an adopted handle. */
    private adopt;
    /**
     * Print newly committed blocks after one log append. Pairing (tool
     * calls/results, command run/done) needs full-log context, so the diff
     * runs over the feed's projection rather than the single event.
     * @param triggerType - the committed event type (drives line closing).
     */
    private printFreshCommitted;
    private watchChunks;
    private answerApproval;
    private answerQuestions;
    private helpText;
    private handleSlash;
    private printSessions;
    private resolveSessionId;
    private handleEffort;
    private handleModel;
    private handlePresets;
    private handleSettings;
    private handlePermissions;
    private printDoctor;
    /** Run until quit; resolves the process exit code. */
    start(startup: StartupValues): Promise<number>;
}
/**
 * Run the line surface to completion.
 * @param ctx - plugin context.
 * @param startup - resolved CLI values.
 * @param io - process IO.
 * @returns the process exit code.
 */
export declare function runRepl(ctx: DshContext, startup: StartupValues, io: ReplIo): Promise<number>;

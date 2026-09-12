/**
 * Terminal app command-line provider: parses flags and publishes
 * `terminalStartup` as an ordinary Cordis service.
 * @module dsh-terminal/startup
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "terminal-startup";
/** Services required before flags can be resolved. */
export declare const inject: string[];
/** Service provided by this plugin and injected by the TUI runner. */
export declare const TERMINAL_STARTUP_SERVICE = "terminalStartup";
/** Values the TUI runner reads from {@link TERMINAL_STARTUP_SERVICE}. */
export interface TerminalStartupValues {
    /** Session id to resume, or empty for a new session. */
    resume: string;
    /** Model override, or empty for the profile default. */
    model: string;
    /** Provider override, or empty for the profile default. */
    provider: string;
    /** One-shot task text, or empty for interactive mode. */
    print: string;
    /** Force the line REPL even on a TTY. */
    line: boolean;
}
/**
 * Parse and provide terminal startup values.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;

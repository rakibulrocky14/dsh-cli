/**
 * Interactive terminal surface for vanilla DeepSeek Harness.
 *
 * Stacks on `dsh-base` like the Web GUI: same agents, tools, sessions,
 * approval, settings, and installed Cordis plugins. Web-only UI
 * contributions (ConversationNodeDefinition renderers, settings cards) are
 * ignored; backend contributions always work.
 *
 * Three modes, chosen at boot:
 * - full-screen TUI (both stdio on a TTY),
 * - line REPL fallback (pipes, CI, `--line`),
 * - one-shot `--print` (single task, stdout result, exit code).
 *
 * @module dsh-terminal
 */
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "terminal-runner";
/** Core services required before the interactive surface starts. */
export declare const inject: string[];
/** Plugin config: values resolved from the `terminalStartup` provider. */
export interface Config {
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
 * Mount the terminal surface.
 * @param ctx - plugin context carrying core services and appExit.
 * @param config - startup values from the `terminalStartup` provider.
 */
export declare function apply(ctx: Context, config: Partial<Config>): void;

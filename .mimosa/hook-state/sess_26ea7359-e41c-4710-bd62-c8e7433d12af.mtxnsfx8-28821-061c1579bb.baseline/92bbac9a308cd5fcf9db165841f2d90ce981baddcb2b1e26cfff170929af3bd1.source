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
import { runPrint } from './print.js';
import { runRepl } from './repl.js';
import { startTui } from './tui/app.js';
/** Stable Cordis plugin name. */
export const name = 'terminal-runner';
/** Core services required before the interactive surface starts. */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
/** Normalize raw patch config (missing keys default to empty/off). */
function normalizeConfig(config) {
    return {
        resume: typeof config?.resume === 'string' ? config.resume : '',
        model: typeof config?.model === 'string' ? config.model : '',
        provider: typeof config?.provider === 'string' ? config.provider : '',
        print: typeof config?.print === 'string' ? config.print : '',
        line: config?.line === true,
    };
}
/**
 * Mount the terminal surface.
 * @param ctx - plugin context carrying core services and appExit.
 * @param config - startup values from the `terminalStartup` provider.
 */
export function apply(ctx, config) {
    const exit = ctx.get('appExit');
    if (typeof exit !== 'function') {
        throw new Error('terminal-runner: the launcher must provide ctx.appExit before the tree mounts');
    }
    const dshCtx = ctx;
    const startup = normalizeConfig(config);
    if (startup.print !== '') {
        const io = { stdout: process.stdout, stderr: process.stderr };
        void runPrint(dshCtx, startup, io).then(exit, (error) => {
            process.stderr.write(`dsh-terminal: ${error instanceof Error ? error.message : String(error)}\n`);
            exit(1);
        });
        return;
    }
    const fullScreen = process.stdin.isTTY === true
        && process.stdout.isTTY === true
        && process.env['TERM'] !== 'dumb'
        && !startup.line;
    if (fullScreen) {
        startTui(dshCtx, startup, exit);
        return;
    }
    const io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };
    void runRepl(dshCtx, startup, io).then(exit, (error) => {
        process.stderr.write(`dsh-terminal: ${error instanceof Error ? error.message : String(error)}\n`);
        exit(1);
    });
}

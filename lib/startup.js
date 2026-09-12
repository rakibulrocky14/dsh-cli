/**
 * Terminal app command-line provider: parses flags and publishes
 * `terminalStartup` as an ordinary Cordis service.
 * @module dsh-terminal/startup
 */
import { Command } from 'commander';
/** Local parseCmdline — same contract as @deepseek-ai/dsh-cmdline, no runtime import. */
function parseCmdline(ctx, program) {
    const args = ctx.get('cmdlineArgs');
    const exit = ctx.get('appExit');
    if (args === undefined || typeof exit !== 'function') {
        throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`);
    }
    program.exitOverride();
    program.configureOutput({
        writeOut: text => { process.stdout.write(text); },
        writeErr: text => { process.stderr.write(text); },
    });
    try {
        program.parse([...args.get()], { from: 'user' });
    }
    catch (error) {
        const code = error?.code;
        const exitCode = error?.exitCode;
        if (typeof code === 'string' && code.startsWith('commander.') && typeof exitCode === 'number') {
            exit(exitCode);
            return;
        }
        throw error;
    }
}
/** Stable Cordis plugin name. */
export const name = 'terminal-startup';
/** Services required before flags can be resolved. */
export const inject = ['cmdlineArgs'];
/** Service provided by this plugin and injected by the TUI runner. */
export const TERMINAL_STARTUP_SERVICE = 'terminalStartup';
/** Build this app's command; fresh each parse so tests can re-run. */
function terminalCommand() {
    return new Command()
        .name('dsh --profile terminal')
        .description('Vanilla DSH in the terminal: chat, tools, plugins, settings — same product as the Web GUI.')
        .helpOption('-h, --help', 'show this help')
        .option('--resume <sessionId>', 'resume a persisted session')
        .option('--model <model>', 'override the model for this session')
        .option('--provider <provider>', 'override the provider route for this session')
        .option('--preset <preset>', 'agent preset to compose (e.g. standard, code, minimal, cordis)')
        .option('--print <task>', 'answer one task, print the final text, and exit')
        .option('--line', 'use the line REPL instead of the full-screen TUI')
        .addHelpText('after', `
Examples:
  dsh --profile terminal
  dsh --profile terminal --resume session-…
  dsh --profile terminal --model deepseek-reasoner
  dsh --profile terminal --preset code

Slash commands inside: /help /new /sessions /resume /fork /model /effort /title /tools
/commands /skills /agents /terminals /presets /plugins /settings /permissions
/jobs /todos /usage /stop /doctor /clear /quit (+ plugin commands)
`);
}
/**
 * Parse and provide terminal startup values.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
    const program = terminalCommand();
    program.action(() => {
        const opts = program.opts();
        ctx.provide(TERMINAL_STARTUP_SERVICE, {
            resume: opts.resume ?? '',
            model: opts.model ?? '',
            provider: opts.provider ?? '',
            preset: opts.preset ?? '',
            print: opts.print ?? '',
            line: opts.line ?? false,
        });
    });
    parseCmdline(ctx, program);
}

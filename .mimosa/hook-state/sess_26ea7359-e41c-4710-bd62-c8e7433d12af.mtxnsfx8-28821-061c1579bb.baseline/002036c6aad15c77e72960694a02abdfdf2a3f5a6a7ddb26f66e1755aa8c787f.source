/**
 * One-shot `--print` mode: answer a single task, stream reasoning to stderr,
 * print the final assistant text to stdout, and exit (headless-style, through
 * the same agent lifecycle as the interactive surfaces).
 *
 * @module dsh-terminal/print
 */
import { type StartupValues } from './core/dsh.js';
import { type DshContext } from './core/types.js';
/** Process IO for one-shot mode. */
export interface PrintIo {
    stdout: {
        write(chunk: string): unknown;
    };
    stderr: {
        write(chunk: string): unknown;
    };
}
/**
 * Run one task to quiescence.
 * @param ctx - plugin context.
 * @param startup - resolved CLI values (print carries the task).
 * @param io - process IO.
 * @returns the process exit code.
 */
export declare function runPrint(ctx: DshContext, startup: StartupValues, io: PrintIo): Promise<number>;

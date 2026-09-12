/**
 * Shared slash-command catalog and line parsers. Both surfaces (full-screen
 * TUI and line REPL) render help, palettes, and dispatch from this catalog
 * so the two can never disagree about the command set.
 *
 * @module dsh-terminal/core/commands
 */
/** One builtin slash command (plugin commands join dynamically). */
export interface BuiltinCommand {
    name: string;
    desc: string;
}
/** The complete builtin set both surfaces implement. */
export declare const BUILTINS: BuiltinCommand[];
/** Known reasoning-effort ids (the DeepSeek adapter vocabulary). */
export declare const EFFORT_LEVELS: readonly string[];
/**
 * Normalize an /effort argument to a selection value.
 * @param text - raw argument (empty shows current, `auto` clears).
 * @param allowed - acceptable level ids (resolved per model; static fallback).
 * @returns `{clear:true}` for `auto`, `{level}` for a known id, undefined for ''.
 * @throws on unknown ids.
 */
export declare function normalizeEffort(text: string, allowed?: readonly string[]): {
    clear: true;
} | {
    level: string;
} | undefined;
/** Parse `/model` selection text into provider/model parts. */
export declare function parseModelSelection(text: string): {
    provider: string;
    model: string;
} | undefined;
/** Parse `k=v` settings assignments (JSON values, string fallback). */
export declare function parseAssignments(args: string[]): Record<string, unknown>;
/** Shorten a path with `~` for status display. */
export declare function shortHome(path: string): string;
/** Short session id for chrome (`session-` + 8 chars, fixed width, no ellipsis). */
export declare function shortSession(id: string): string;

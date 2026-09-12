/**
 * Shared slash-command catalog and line parsers. Both surfaces (full-screen
 * TUI and line REPL) render help, palettes, and dispatch from this catalog
 * so the two can never disagree about the command set.
 *
 * @module dsh-terminal/core/commands
 */
import { homedir } from 'node:os';
/** The complete builtin set both surfaces implement. */
export const BUILTINS = [
    { name: 'help', desc: 'this list' },
    { name: 'new', desc: 'start a new session' },
    { name: 'sessions', desc: 'browse chats by project (also /session)' },
    { name: 'resume', desc: 'resume a session: /resume <id>' },
    { name: 'fork', desc: 'fork this session at the last turn boundary' },
    { name: 'model', desc: 'show or switch model' },
    { name: 'effort', desc: 'show or set reasoning effort: /effort [off|low|high|max|auto]' },
    { name: 'title', desc: 'rename this session: /title <text>' },
    { name: 'tools', desc: 'list tools from dsh-base + plugins' },
    { name: 'commands', desc: 'list plugin slash-commands' },
    { name: 'skills', desc: 'list available skills' },
    { name: 'agents', desc: 'list live agents' },
    { name: 'terminals', desc: 'list persistent terminal sessions' },
    { name: 'presets', desc: 'list agent presets (also /preset [id])' },
    { name: 'plugins', desc: 'list installed DSH bundles/plugins' },
    { name: 'settings', desc: 'inspect/edit the same settings web edits' },
    { name: 'permissions', desc: 'show or switch permission preset' },
    { name: 'jobs', desc: 'list background jobs' },
    { name: 'todos', desc: 'show the session task list' },
    { name: 'usage', desc: 'token usage and context pressure' },
    { name: 'stop', desc: 'cancel the running turn' },
    { name: 'doctor', desc: 'environment + service diagnostics' },
    { name: 'clear', desc: 'clear the screen' },
    { name: 'quit', desc: 'exit' },
];
/** Known reasoning-effort ids (the DeepSeek adapter vocabulary). */
export const EFFORT_LEVELS = ['off', 'low', 'high', 'max'];
/**
 * Normalize an /effort argument to a selection value.
 * @param text - raw argument (empty shows current, `auto` clears).
 * @param allowed - acceptable level ids (resolved per model; static fallback).
 * @returns `{clear:true}` for `auto`, `{level}` for a known id, undefined for ''.
 * @throws on unknown ids.
 */
export function normalizeEffort(text, allowed = EFFORT_LEVELS) {
    const trimmed = text.trim().toLowerCase();
    if (trimmed === '')
        return undefined;
    if (trimmed === 'auto' || trimmed === 'default')
        return { clear: true };
    const hit = allowed.find(level => level.toLowerCase() === trimmed);
    if (hit !== undefined)
        return { level: hit };
    throw new Error(`unknown effort "${text.trim()}" — use ${allowed.join('|')} or auto`);
}
/** Parse `/model` selection text into provider/model parts. */
export function parseModelSelection(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return undefined;
    const slash = trimmed.indexOf('/');
    if (slash < 0)
        return { provider: '', model: trimmed };
    return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() };
}
/** Parse `k=v` settings assignments (JSON values, string fallback). */
export function parseAssignments(args) {
    const patch = {};
    for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq <= 0)
            throw new Error(`expected k=v, got "${arg}"`);
        const key = arg.slice(0, eq);
        const raw = arg.slice(eq + 1);
        try {
            patch[key] = JSON.parse(raw);
        }
        catch {
            patch[key] = raw;
        }
    }
    return patch;
}
/** Shorten a path with `~` for status display. */
export function shortHome(path) {
    const home = homedir();
    return home !== '' && (path === home || path.startsWith(`${home}/`))
        ? `~${path.slice(home.length)}`
        : path;
}
/** Short session id for chrome (`session-` + 8 chars, fixed width, no ellipsis). */
export function shortSession(id) {
    if (id === '')
        return '(no session)';
    if (!id.startsWith('session-'))
        return id.length <= 16 ? id : id.slice(0, 16);
    const bare = id.slice('session-'.length);
    return bare.length <= 8 ? id : `session-${bare.slice(0, 8)}`;
}

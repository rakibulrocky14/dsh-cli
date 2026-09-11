/**
 * Full-screen terminal application root. The {@link Engine} owns every
 * behavior; this tree only subscribes to its version and renders.
 * History renders through Ink's `<Static>` region (native terminal
 * scrollback), while live blocks, panels, modals, and the composer render
 * dynamically below it.
 *
 * @module dsh-terminal/tui/app
 */
import React from 'react';
import type { StartupValues } from '../core/dsh.js';
import { type Block } from '../core/transcript.js';
import type { DshContext } from '../core/types.js';
import { Engine } from './engine.js';
/** Static-region item: a committed block, a clear-screen gap, or the boot banner. */
type StaticItem = Block | {
    kind: 'gap';
    id: string;
} | {
    kind: 'banner';
    id: string;
    model: string;
    effort: string;
    cwd: string;
    recent?: string;
};
/**
 * Static-region entry tagged with the generation it belongs to. A generation
 * bump (session switch or /clear) starts a fresh dedupe scope, so a new
 * session's `c1` block can never be swallowed by the old session's `c1` —
 * the failure mode where every message after `/new` silently vanished.
 */
export interface StaticEntry {
    gen: number;
    item: StaticItem;
}
/**
 * Append freshly committed blocks to the static region. Dedup runs within
 * the current generation only; transient running tool cards never enter
 * scrollback (their completed card lands when the result commits).
 * @returns the input array when nothing changed, so React can bail out.
 */
export declare function staticAppend(prev: StaticEntry[], gen: number, committed: readonly Block[]): StaticEntry[];
/**
 * Full-screen application.
 * @param engine - behavior owner (injected for tests).
 * @param startup - resolved CLI values for the boot sequence.
 */
export declare function App({ engine, startup }: {
    engine: Engine;
    startup: StartupValues;
}): React.JSX.Element;
/**
 * Render the full-screen surface over one DSH context.
 * @param ctx - plugin context carrying core services and appExit.
 * @param startup - resolved CLI values.
 * @param exit - the launcher's bounded exit request.
 */
export declare function startTui(ctx: DshContext, startup: StartupValues, exit: (code: number) => void): void;
export {};

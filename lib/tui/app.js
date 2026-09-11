import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Full-screen terminal application root. The {@link Engine} owns every
 * behavior; this tree only subscribes to its version and renders.
 * History renders through Ink's `<Static>` region (native terminal
 * scrollback), while live blocks, panels, modals, and the composer render
 * dynamically below it.
 *
 * @module dsh-terminal/tui/app
 */
import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, render, useInput, useStdout } from 'ink';
import { shortHome } from '../core/commands.js';
import { isLiveBlock } from '../core/transcript.js';
import { Engine, spinnerGlyph } from './engine.js';
import { ApprovalDialog, Banner, BlockView, Composer, Footer, MAX_CONTENT, Palette, Panel, QuestionsDialog, SessionBar, shortSession, terminalWidth, TextDialog, Toasts, } from './widgets.js';
/** Cap for retained static entries (index-shift re-render past this). */
const STATIC_CAP = 5000;
/** Monotonic counter for unique gap ids. */
let gapSeq = 0;
/**
 * Append freshly committed blocks to the static region. Dedup runs within
 * the current generation only; transient running tool cards never enter
 * scrollback (their completed card lands when the result commits).
 * @returns the input array when nothing changed, so React can bail out.
 */
export function staticAppend(prev, gen, committed) {
    const fresh = committed.filter(block => {
        if (isLiveBlock(block))
            return false;
        if (block.kind === 'tool' && block.status === 'running')
            return false;
        return !prev.some(entry => entry.gen === gen && entry.item.id === block.id);
    });
    if (fresh.length === 0)
        return prev;
    return [...prev.slice(-STATIC_CAP), ...fresh.map(item => ({ gen, item }))];
}
function panelTitle(engine) {
    const view = engine.view;
    switch (view.name) {
        case 'sessions': return 'sessions';
        case 'model': return view.provider === undefined ? 'model' : `models · ${view.provider}`;
        case 'effort': return 'reasoning effort';
        case 'tools': return 'tools';
        case 'commands': return 'commands';
        case 'skills': return 'skills';
        case 'agents': return 'live agents';
        case 'terminals': return 'terminals';
        case 'todos': return 'task list';
        case 'usage': return 'usage';
        case 'presets': return 'presets';
        case 'plugins': return 'plugins';
        case 'settings': return view.ns === undefined ? 'settings' : `settings · ${view.ns}`;
        case 'permissions': return 'permissions';
        case 'jobs': return 'jobs';
        case 'doctor': return 'doctor';
        case 'help': return 'help';
        case 'chat': return '';
    }
}
/**
 * Static (scrollback) region. Memoized on the entries array: the engine
 * re-renders several times a second while a turn runs (spinner, stream
 * chunks), and without the memo every tick re-reconciled the whole history.
 *
 * `repaintSeq` keys the Static element: on a terminal resize the resync
 * clears the screen, and the key remount forces Ink's Static to re-flush
 * every committed block at the fresh width (Static otherwise writes each
 * item exactly once and would leave the screen empty after the clear).
 */
const HistoryRegion = memo(function HistoryRegion({ entries, repaintSeq, width, expanded }) {
    return (_jsx(Static, { items: entries, children: (entry) => entry.item.kind === 'gap'
            ? _jsx(Text, { children: '\n'.repeat(24) }, entry.item.id)
            : entry.item.kind === 'banner'
                ? _jsx(Banner, { model: entry.item.model, effort: entry.item.effort, cwd: entry.item.cwd, recent: entry.item.recent, width: width }, entry.item.id)
                : _jsx(BlockView, { block: entry.item, width: width, expanded: expanded }, entry.item.id) }, repaintSeq));
});
/**
 * Full-screen application.
 * @param engine - behavior owner (injected for tests).
 * @param startup - resolved CLI values for the boot sequence.
 */
export function App({ engine, startup }) {
    useSyncExternalStore(engine.subscribe, engine.getVersion);
    const [staticEntries, setStaticEntries] = useState([]);
    const lastSessionRef = useRef('');
    const genRef = useRef(0);
    const bannerShownRef = useRef(false);
    useEffect(() => {
        void engine.boot(startup);
        // Boot exactly once; the engine owns retries and shutdown.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useInput((input, key) => {
        engine.handleKey(input, key);
    });
    const { stdout } = useStdout();
    const columns = terminalWidth(stdout?.columns);
    // Cap the whole frame: everything (rules included) lives inside one
    // readable column instead of sprawling across a 200-col terminal.
    const frameWidth = Math.min(Math.max(24, columns), MAX_CONTENT);
    const contentWidth = Math.max(24, frameWidth - 2);
    // Sync committed blocks into the append-only static region.
    useEffect(() => {
        const sessionId = engine.agent?.id ?? '';
        const sessionChanged = sessionId !== lastSessionRef.current;
        const wasCleared = engine.cleared;
        if (sessionChanged)
            lastSessionRef.current = sessionId;
        if (wasCleared)
            engine.cleared = false;
        const snapshot = engine.feed.snapshot();
        const showBanner = !bannerShownRef.current;
        if (sessionChanged || wasCleared) {
            bannerShownRef.current = true;
            genRef.current += 1;
            const gen = genRef.current;
            let mark;
            if (wasCleared) {
                mark = { kind: 'gap', id: `gap-${String(++gapSeq)}` };
            }
            else if (showBanner) {
                // First adoption opens the transcript with the boot banner instead
                // of a session divider (there is nothing above to separate yet).
                const selection = engine.selection;
                mark = {
                    kind: 'banner',
                    id: 'banner',
                    model: selection.provider === '' && selection.model === ''
                        ? ''
                        : selection.provider === '' ? selection.model : `${selection.provider}/${selection.model}`,
                    effort: engine.effectiveEffort(),
                    cwd: shortHome(process.cwd()),
                    recent: engine.recentActivity,
                };
            }
            else {
                mark = { kind: 'divider', id: `div-${sessionId === '' ? 'closed' : sessionId}`, label: sessionId === '' ? 'session closed' : shortSession(sessionId) };
            }
            setStaticEntries(prev => staticAppend([...prev.slice(-STATIC_CAP), { gen, item: mark }], gen, snapshot));
            return;
        }
        setStaticEntries(prev => staticAppend(prev, genRef.current, snapshot));
    });
    if (engine.status === 'booting') {
        return (_jsx(Box, { flexDirection: "column", padding: 1, children: _jsxs(Text, { dimColor: true, children: [spinnerGlyph(engine.spinnerFrame), " starting dsh-terminal\u2026"] }) }));
    }
    if (engine.status === 'error') {
        return (_jsxs(Box, { flexDirection: "column", padding: 1, children: [_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "red", paddingX: 1, children: [_jsx(Text, { bold: true, color: "red", children: "dsh-terminal failed to start" }), _jsx(Text, { dimColor: true, children: engine.bootError })] }), _jsx(Text, { dimColor: true, children: "esc quits" })] }));
    }
    if (engine.quitting) {
        return (_jsx(Box, { padding: 1, children: _jsx(Text, { dimColor: true, children: "bye" }) }));
    }
    const snapshot = engine.feed.snapshot();
    const live = snapshot.filter(b => isLiveBlock(b));
    const modal = engine.modal;
    const inPanel = engine.view.name !== 'chat';
    const selection = engine.selection;
    const palette = modal === undefined && !inPanel ? engine.paletteEntries() : [];
    const modelLabel = selection.provider === '' && selection.model === ''
        ? ''
        : selection.provider === ''
            ? selection.model
            : `${selection.provider}/${selection.model}`;
    const sessionId = engine.agent?.id ?? '';
    const sessionLabel = `${shortSession(sessionId)} · ${engine.running ? `working ${String(engine.runSeconds())}s` : 'idle'}${engine.preset === '' ? '' : ` · preset ${engine.preset}`}`;
    return (_jsxs(Box, { flexDirection: "column", width: frameWidth, children: [_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(HistoryRegion, { entries: staticEntries, repaintSeq: engine.repaintSeq, width: contentWidth, expanded: engine.toolsExpanded }), live.map(block => _jsx(BlockView, { block: block, width: contentWidth, expanded: engine.toolsExpanded, spinnerFrame: engine.spinnerFrame }, block.id))] }), _jsxs(Box, { flexDirection: "column", paddingX: 1, marginTop: 1, children: [_jsx(SessionBar, { label: sessionLabel }), modal?.kind === 'approval' ? _jsx(ApprovalDialog, { modal: modal, width: contentWidth }) : undefined, modal?.kind === 'questions' ? _jsx(QuestionsDialog, { modal: modal, width: contentWidth }) : undefined, modal?.kind === 'text' ? _jsx(TextDialog, { modal: modal, width: contentWidth }) : undefined, inPanel && modal === undefined ? (_jsx(Panel, { title: panelTitle(engine), rows: engine.rows, loading: engine.rowsLoading, hint: engine.rowsHint, index: engine.rowIndex, spinnerFrame: engine.spinnerFrame, width: contentWidth })) : undefined, _jsx(Toasts, { items: engine.toasts, width: contentWidth }), _jsx(Palette, { entries: palette, index: engine.paletteIndex, width: contentWidth }), !inPanel && modal === undefined ? (_jsx(Composer, { field: engine.composer, focused: true, running: engine.running, spinnerFrame: engine.spinnerFrame, runSeconds: engine.runSeconds(), width: contentWidth })) : undefined] }), _jsx(Box, { flexDirection: "column", paddingX: 1, marginTop: 1, children: _jsx(Footer, { model: modelLabel, effort: engine.effectiveEffort(), cwd: shortHome(process.cwd()), ctxTokens: engine.ctxTokens, ctxWindow: engine.ctxWindow, mode: engine.mode, running: engine.running, modalOpen: modal !== undefined, inPanel: inPanel, width: contentWidth }) })] }));
}
/**
 * Keep stray plugin logs off the framebuffer: stdout belongs to Ink.
 * stderr stays untouched so diagnostics remain visible.
 */
function patchConsole() {
    const stderr = process.stderr;
    console.log = (...args) => { stderr.write(`${args.map(String).join(' ')}\n`); };
    console.info = (...args) => { stderr.write(`${args.map(String).join(' ')}\n`); };
    console.debug = (...args) => { stderr.write(`${args.map(String).join(' ')}\n`); };
}
/**
 * Render the full-screen surface over one DSH context.
 * @param ctx - plugin context carrying core services and appExit.
 * @param startup - resolved CLI values.
 * @param exit - the launcher's bounded exit request.
 */
export function startTui(ctx, startup, exit) {
    patchConsole();
    const engine = new Engine(ctx, exit);
    const app = render(_jsx(App, { engine: engine, startup: startup }));
    engine.onFullRepaint = (wipeScrollback) => {
        // 2J erases the viewport. 3J also drops scrollback — needed after a
        // resize, where wrapped leftover rows of the old banner sit above the
        // new frame (the "second welcome box on top" bug). ctrl+o keeps
        // native scrollback so history is not thrown away.
        process.stdout.write(wipeScrollback ? '\x1b[2J\x1b[3J\x1b[H' : '\x1b[2J\x1b[H');
        app.clear();
    };
    armResizeResync(engine);
}
/**
 * Converge the fullscreen frame after terminal resizes. A paint computed at
 * the pre-resize width can land after the resize, wrap, and desync the
 * repaint accounting (wrapped rows are never erased, so residue accumulates
 * on every later repaint). Debounced past the resize burst and any deferred
 * commits, then hard-clear and repaint once at the fresh width.
 *
 * Listens on stdout AND stderr (plugin hosts may own either TTY), plus a
 * one-second poll fallback for hosts that never emit the `resize` event.
 * @param engine - version bump schedules the fresh repaint (which wipes).
 */
function armResizeResync(engine) {
    const stdout = process.stdout;
    if (typeof stdout.on !== 'function')
        return;
    let lastWidth = stdout.columns ?? 0;
    let lastHeight = stdout.rows ?? 0;
    let timer;
    const schedule = () => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            if (engine.quitting)
                return;
            const nowW = stdout.columns ?? 0;
            const nowH = stdout.rows ?? 0;
            if (nowW === lastWidth && nowH === lastHeight)
                return;
            lastWidth = nowW;
            lastHeight = nowH;
            engine.requestRepaint(true);
        }, 120);
        timer.unref?.();
    };
    stdout.on('resize', schedule);
    const stderr = process.stderr;
    if (typeof stderr?.on === 'function') {
        ;
        stderr.on.call(stderr, 'resize', schedule);
    }
    const poll = setInterval(schedule, 1000);
    poll.unref?.();
}

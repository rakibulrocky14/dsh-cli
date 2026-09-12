import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Full-screen terminal application root. The {@link Engine} owns every
 * behavior; this tree only subscribes to its version and renders.
 * The transcript and chrome share one terminal-height-bounded frame. The
 * transcript is clipped into the rows above the composer, so resize and clear
 * never leave append-only scrollback holes or duplicate wrapped banners.
 *
 * @module dsh-terminal/tui/app
 */
import React, { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, measureElement, render, useInput, useStdout } from 'ink';
import { shortHome } from '../core/commands.js';
import { presetDisplayText } from '../core/dsh.js';
import { isLiveBlock } from '../core/transcript.js';
import { Engine, spinnerGlyph } from './engine.js';
import { DISABLE_MOUSE_REPORTING, ENABLE_MOUSE_REPORTING, parseMouseReport, wheelDirection } from './mouse.js';
import { ApprovalDialog, Banner, BlockView, Composer, Footer, Palette, Panel, QuestionsDialog, SessionBar, shortSession, terminalHeight, terminalWidth, TextDialog, Toasts, } from './widgets.js';
/** Cap for retained transcript entries. */
const STATIC_CAP = 5000;
/**
 * Append freshly committed blocks to the transcript. Dedup runs within
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
        case 'sessions': return view.workspace === undefined ? 'projects' : `chats · ${engine.sessionWorkspaceTitle() ?? view.workspace}`;
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
/** Memoized transcript body measured and clipped by the parent viewport. */
const HistoryRegion = memo(function HistoryRegion({ entries, width, expanded }) {
    return (_jsx(Box, { flexDirection: "column", flexShrink: 0, children: entries.map(entry => entry.item.kind === 'banner'
            ? _jsx(Banner, { model: entry.item.model, effort: entry.item.effort, cwd: entry.item.cwd, recent: entry.item.recent, width: width }, `${String(entry.gen)}:${entry.item.id}`)
            : _jsx(BlockView, { block: entry.item, width: width, expanded: expanded }, `${String(entry.gen)}:${entry.item.id}`)) }));
});
/**
 * Full-screen application.
 * @param engine - behavior owner (injected for tests).
 * @param startup - resolved CLI values for the boot sequence.
 */
export function App({ engine, startup, mouse = true }) {
    const version = useSyncExternalStore(engine.subscribe, engine.getVersion);
    const [staticEntries, setStaticEntries] = useState([]);
    const [chromeRows, setChromeRows] = useState(8);
    const [historyRows, setHistoryRows] = useState(0);
    const lastSessionRef = useRef('');
    const genRef = useRef(0);
    const bannerShownRef = useRef(false);
    const clearedBlockIdsRef = useRef(new Set());
    const historyRef = useRef(null);
    const chromeRef = useRef(null);
    useEffect(() => {
        void engine.boot(startup);
        // Boot exactly once; the engine owns retries and shutdown.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useInput((input, key) => {
        const report = parseMouseReport(input);
        const direction = report === undefined ? undefined : wheelDirection(report);
        if (direction === 0) {
            engine.scrollTranscript(3);
            return;
        }
        if (direction === 1) {
            engine.scrollTranscript(-3);
            return;
        }
        if (report !== undefined)
            return;
        engine.handleKey(input, key);
    });
    const { stdout } = useStdout();
    useEffect(() => {
        if (!mouse || stdout === undefined || stdout.isTTY !== true)
            return;
        try {
            stdout.write(ENABLE_MOUSE_REPORTING);
        }
        catch {
            return;
        }
        return () => {
            try {
                stdout.write(DISABLE_MOUSE_REPORTING);
            }
            catch {
                // The stream may already be closed during process teardown.
            }
        };
    }, [mouse, stdout]);
    const [dimensions, setDimensions] = useState(() => ({
        columns: terminalWidth(stdout?.columns),
        rows: terminalHeight(stdout?.rows),
    }));
    useEffect(() => {
        const handleResize = () => {
            const nextCols = terminalWidth(stdout?.columns);
            const nextRows = terminalHeight(stdout?.rows);
            setDimensions(prev => {
                if (prev.columns === nextCols && prev.rows === nextRows)
                    return prev;
                return { columns: nextCols, rows: nextRows };
            });
        };
        if (stdout && typeof stdout.on === 'function') {
            stdout.on('resize', handleResize);
        }
        const procStdout = process.stdout;
        if (procStdout && procStdout !== stdout && typeof procStdout.on === 'function') {
            procStdout.on('resize', handleResize);
        }
        const stderr = process.stderr;
        if (typeof stderr?.on === 'function') {
            ;
            stderr.on.call(stderr, 'resize', handleResize);
        }
        return () => {
            if (stdout && typeof stdout.off === 'function') {
                stdout.off('resize', handleResize);
            }
            if (procStdout && procStdout !== stdout && typeof procStdout.off === 'function') {
                procStdout.off('resize', handleResize);
            }
            if (typeof stderr?.off === 'function') {
                ;
                stderr.off.call(stderr, 'resize', handleResize);
            }
        };
    }, [stdout]);
    const liveColumns = terminalWidth(stdout?.columns);
    const liveRows = terminalHeight(stdout?.rows);
    const columns = (dimensions.columns !== liveColumns && stdout?.columns !== undefined) ? liveColumns : (dimensions.columns || liveColumns);
    const frameRows = (dimensions.rows !== liveRows && stdout?.rows !== undefined) ? liveRows : (dimensions.rows || liveRows);
    const frameWidth = Math.max(24, columns);
    const contentWidth = Math.max(24, frameWidth - 2);
    const transcriptRows = Math.max(1, frameRows - chromeRows);
    const maxTranscriptScroll = Math.max(0, historyRows - transcriptRows);
    const transcriptScroll = Math.min(engine.transcriptScroll, maxTranscriptScroll);
    // Sync committed blocks into the append-only static region.
    useEffect(() => {
        const sessionId = engine.agent?.id ?? '';
        const sessionChanged = sessionId !== lastSessionRef.current;
        const wasCleared = engine.cleared;
        if (sessionChanged)
            lastSessionRef.current = sessionId;
        if (wasCleared)
            engine.cleared = false;
        const wholeSnapshot = engine.feed.snapshot();
        if (sessionChanged)
            clearedBlockIdsRef.current.clear();
        if (wasCleared) {
            clearedBlockIdsRef.current = new Set(wholeSnapshot.filter(block => !isLiveBlock(block)).map(block => block.id));
        }
        const snapshot = wholeSnapshot.filter(block => !clearedBlockIdsRef.current.has(block.id));
        const showBanner = !bannerShownRef.current;
        if (sessionChanged || wasCleared) {
            bannerShownRef.current = true;
            genRef.current += 1;
            const gen = genRef.current;
            let mark;
            const selection = engine.selection;
            if (wasCleared || showBanner || snapshot.length === 0) {
                // Clear begins a genuinely fresh visible frame. Empty sessions still
                // show the whale and getting-started help instead of a black void.
                mark = {
                    kind: 'banner',
                    id: `banner-${sessionId === '' ? 'boot' : sessionId}`,
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
            setStaticEntries(prev => {
                const base = wasCleared ? [] : prev.slice(-STATIC_CAP);
                return staticAppend([...base, { gen, item: mark }], gen, snapshot);
            });
            return;
        }
        setStaticEntries(prev => staticAppend(prev, genRef.current, snapshot));
    }, [engine, version]);
    useEffect(() => {
        const nextHistoryRows = historyRef.current === null ? 0 : measureElement(historyRef.current).height;
        const nextChromeRows = chromeRef.current === null ? 0 : measureElement(chromeRef.current).height;
        if (nextHistoryRows !== historyRows)
            setHistoryRows(nextHistoryRows);
        if (nextChromeRows > 0 && nextChromeRows !== chromeRows)
            setChromeRows(nextChromeRows);
        const maxScroll = Math.max(0, nextHistoryRows - transcriptRows);
        if (engine.transcriptScroll > maxScroll)
            engine.setTranscriptScroll(maxScroll);
    }, [chromeRows, engine, frameRows, frameWidth, historyRows, staticEntries, transcriptRows, version]);
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
    const presetName = engine.preset === '' ? '' : presetDisplayText({ id: engine.preset }).name;
    const sessionLabel = `${shortSession(sessionId)} · ${engine.running ? `working ${String(engine.runSeconds())}s` : 'idle'}${presetName === '' ? '' : ` · ${presetName}`}`;
    return (_jsxs(Box, { flexDirection: "column", width: frameWidth, height: frameRows, overflow: "hidden", children: [_jsx(Box, { flexDirection: "column", height: transcriptRows, overflowY: "hidden", justifyContent: "flex-end", paddingX: 1, children: _jsxs(Box, { ref: historyRef, flexDirection: "column", flexShrink: 0, marginBottom: -transcriptScroll, children: [_jsx(HistoryRegion, { entries: staticEntries, width: contentWidth, expanded: engine.toolsExpanded }), live.map(block => _jsx(BlockView, { block: block, width: contentWidth, expanded: engine.toolsExpanded, spinnerFrame: engine.spinnerFrame }, block.id))] }) }), _jsxs(Box, { ref: chromeRef, flexDirection: "column", flexShrink: 0, children: [_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(SessionBar, { label: sessionLabel }), modal?.kind === 'approval' ? _jsx(ApprovalDialog, { modal: modal, width: contentWidth }) : undefined, modal?.kind === 'questions' ? _jsx(QuestionsDialog, { modal: modal, width: contentWidth }) : undefined, modal?.kind === 'text' ? _jsx(TextDialog, { modal: modal, width: contentWidth }) : undefined, inPanel && modal === undefined ? (_jsx(Panel, { title: panelTitle(engine), rows: engine.rows, loading: engine.rowsLoading, hint: engine.rowsHint, index: engine.rowIndex, maxRows: Math.max(3, frameRows - 10), spinnerFrame: engine.spinnerFrame, width: contentWidth })) : undefined, _jsx(Toasts, { items: engine.toasts, width: contentWidth }), _jsx(Palette, { entries: palette, index: engine.paletteIndex, width: contentWidth }), !inPanel && modal === undefined ? (_jsx(Composer, { field: engine.composer, focused: true, running: engine.running, spinnerFrame: engine.spinnerFrame, runSeconds: engine.runSeconds(), width: contentWidth, model: modelLabel, effort: engine.effectiveEffort() })) : undefined] }), _jsx(Box, { flexDirection: "column", paddingX: 1, children: _jsx(Footer, { model: modelLabel, effort: engine.effectiveEffort(), cwd: shortHome(process.cwd()), ctxTokens: engine.ctxTokens, ctxWindow: engine.ctxWindow, mode: engine.mode, running: engine.running, modalOpen: modal !== undefined, inPanel: inPanel, width: contentWidth }) })] })] }));
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
    const app = render(_jsx(App, { engine: engine, startup: startup }), { alternateScreen: true });
    engine.onFullRepaint = () => {
        app.rerender(_jsx(App, { engine: engine, startup: startup }));
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

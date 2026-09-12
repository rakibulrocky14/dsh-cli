/**
 * Full-screen TUI engine: owns the agent lifecycle, transcript feed, views,
 * modals, composer, and key handling behind a versioned snapshot. React is a
 * thin renderer over this state, so every behavior here is drivable from
 * plain Node (and covered by smoke tests) without a TTY.
 *
 * @module dsh-terminal/tui/engine
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { BUILTINS, normalizeEffort, parseModelSelection, shortSession } from '../core/commands.js';
import { Dsh, attachLiveStream, dshHome, installModelOverride, listProfilePlugins, presetDisplayText, sendFollowup, sendSteer } from '../core/dsh.js';
import { LiveFeed, foldTodos, foldUsage } from '../core/transcript.js';
import { readSessionEvents } from '../core/types.js';
export function emptyField(value = '') {
    return { value, cursor: value.length };
}
/** Braille frames for in-progress indicators (boot, running turn, loading). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Resolve one frame index to a spinner glyph. */
export function spinnerGlyph(frame) {
    return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length] ?? '⠋';
}
function age(createdAt) {
    if (createdAt === undefined || createdAt <= 0)
        return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
    if (seconds < 60)
        return `${String(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${String(minutes)}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48)
        return `${String(hours)}h`;
    return `${String(Math.floor(hours / 24))}d`;
}
/** Apply one key to a single-line field. Returns 'submit' on Enter. */
export function editField(field, input, key) {
    if (key.return === true)
        return 'submit';
    // Terminals may bundle bytes: a newline inside the input chunk submits
    // (text before it lands in the field). Never let a bundled Enter vanish.
    if (input !== '' && key.ctrl !== true && key.meta !== true && key.escape !== true
        && key.upArrow !== true && key.downArrow !== true && key.tab !== true) {
        const cut = input.search(/[\r\n]/u);
        if (cut >= 0) {
            const before = [...input.slice(0, cut)].filter(ch => ch >= ' ' && ch !== '\x7f').join('');
            field.value = field.value.slice(0, field.cursor) + before + field.value.slice(field.cursor);
            field.cursor += before.length;
            return 'submit';
        }
    }
    if (key.leftArrow === true) {
        field.cursor = Math.max(0, field.cursor - 1);
        return 'continue';
    }
    if (key.rightArrow === true) {
        field.cursor = Math.min(field.value.length, field.cursor + 1);
        return 'continue';
    }
    if (key.home === true || (key.ctrl === true && input === 'a')) {
        field.cursor = 0;
        return 'continue';
    }
    if (key.end === true || (key.ctrl === true && input === 'e')) {
        field.cursor = field.value.length;
        return 'continue';
    }
    if (key.backspace === true || (key.ctrl === true && input === 'h')) {
        if (field.cursor > 0) {
            field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor);
            field.cursor--;
        }
        return 'continue';
    }
    if (key.delete === true) {
        field.value = field.value.slice(0, field.cursor) + field.value.slice(field.cursor + 1);
        return 'continue';
    }
    if (key.ctrl === true && input === 'u') {
        field.value = field.value.slice(field.cursor);
        field.cursor = 0;
        return 'continue';
    }
    if (key.ctrl === true && input === 'k') {
        field.value = field.value.slice(0, field.cursor);
        return 'continue';
    }
    if (key.ctrl === true && input === 'w') {
        const left = field.value.slice(0, field.cursor).replace(/[^\s]*\s*$/u, '');
        field.value = left + field.value.slice(field.cursor);
        field.cursor = left.length;
        return 'continue';
    }
    if (key.ctrl === true || key.meta === true || key.escape === true || key.tab === true)
        return 'continue';
    if (input === '')
        return 'continue';
    // Filter control characters; keep printable runs (paste-safe).
    const clean = [...input].filter(ch => ch >= ' ' && ch !== '\x7f').join('');
    if (clean === '')
        return 'continue';
    field.value = field.value.slice(0, field.cursor) + clean + field.value.slice(field.cursor);
    field.cursor += clean.length;
    return 'continue';
}
/** TUI engine: DSH lifecycle plus all interaction state. */
export class Engine {
    dsh;
    feed = new LiveFeed();
    exitFn;
    listeners = new Set();
    toastSeq = 0;
    modalSeq = 0;
    version = 0;
    status = 'booting';
    bootError = '';
    quitting = false;
    cleared = false;
    /** Monotonic spinner frame; advances only while something is in flight. */
    spinnerFrame = 0;
    /**
     * Bumped on every full-repaint request (terminal resize). The renderer
     * keys the static region with it: Ink's `<Static>` never re-flushes items
     * it already wrote, so without a remount a resize-clear would erase the
     * whole transcript history and never bring it back.
     */
    repaintSeq = 0;
    /**
     * Optional wipe run immediately before the remount. The TUI host writes
     * CSI erase-screen (and erase-scrollback on resize) so a Static remount
     * cannot stack a second copy of the banner on leftover wrapped rows.
     * Tests leave this unset.
     */
    onFullRepaint = undefined;
    runningFlag = false;
    runStartValue = undefined;
    spinnerTimer;
    /** A running turn drives the spinner and the elapsed-seconds chrome. */
    get running() {
        return this.runningFlag;
    }
    set running(value) {
        this.runningFlag = value;
        if (!value)
            this.runStartValue = undefined;
    }
    view = { name: 'chat' };
    rows = [];
    rowsLoading = false;
    rowsHint = '';
    rowIndex = 0;
    /** Cached, filtered session corpus backing the sessions browser. */
    sessionRecordsCache = [];
    /** Workspace rows when the sessions browser is at root (id → display data). */
    sessionWorkspaces = [];
    /** Fixed-frame transcript offset: 0 follows bottom, positive scrolls upward. */
    transcriptScroll = 0;
    modals = [];
    toasts = [];
    composer = emptyField();
    history = [];
    historyIndex = -1;
    draft = '';
    paletteIndex = 0;
    paletteDismissed = '';
    ctxTokens = undefined;
    /** Resolved context window of the current model (drives the ctx % meter). */
    ctxWindow = undefined;
    /** One-line label of the most recent persisted session (welcome banner). */
    recentActivity = undefined;
    /** Tool outputs expand by default when true (ctrl+o toggles + repaints). */
    toolsExpanded = false;
    /** Cached session names ('' = known untitled); filled in the background. */
    titleCache = new Map();
    mode = '';
    preset = '';
    owned;
    detachStream;
    detachModel;
    modelRef = { current: undefined, assembled: undefined };
    ctxWindowKey = '';
    pluginCommands = [];
    historyFile;
    constructor(ctx, exitFn) {
        this.dsh = new Dsh(ctx);
        this.exitFn = exitFn;
        this.historyFile = join(dshHome(), 'terminal-history');
        try {
            this.history = readFileSync(this.historyFile, 'utf8').split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-500);
        }
        catch {
            this.history = [];
        }
        // New committed/live output never touches transcriptScroll: a reader at
        // the bottom (0) keeps following, and a scrolled-up reader keeps their
        // place until they jump back with Ctrl+End. App clamps to measured max.
        this.feed.subscribe(() => { this.emit(); });
    }
    get agent() {
        return this.owned?.agent;
    }
    get modal() {
        return this.modals[0];
    }
    get selection() {
        return this.modelRef.current ?? this.dsh.currentModel();
    }
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    getVersion = () => this.version;
    /** Elapsed whole seconds of the running turn (0 when idle). */
    runSeconds() {
        return this.runStartValue === undefined ? 0 : Math.max(0, Math.floor((Date.now() - this.runStartValue) / 1000));
    }
    /**
     * Keep the spinner interval alive exactly while something is in flight
     * (boot, panel load, running turn). Called from emit() so every state
     * change re-arms it; the tick itself re-emits through the same path.
     */
    ensureSpinner() {
        const want = this.status === 'booting' || this.rowsLoading || (this.running && !this.quitting);
        if (want && this.spinnerTimer === undefined) {
            const timer = setInterval(() => {
                this.spinnerFrame++;
                this.emit();
            }, 110);
            timer.unref?.();
            this.spinnerTimer = timer;
        }
        else if (!want && this.spinnerTimer !== undefined) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = undefined;
        }
    }
    emit() {
        this.ensureSpinner();
        this.version++;
        for (const listener of this.listeners)
            listener();
    }
    /**
     * Force a full frame repaint: the host wipes the screen, and the static
     * region remounts and re-flushes every committed block at the new width.
     * Used by the resize resync (`wipeScrollback`) and the ctrl+o expand toggle.
     */
    requestRepaint(wipeScrollback = false) {
        this.repaintSeq++;
        this.onFullRepaint?.(wipeScrollback);
        this.emit();
    }
    /** Clamp and set the transcript scroll offset (App clamps to measured max). */
    setTranscriptScroll(value) {
        const next = !Number.isFinite(value) ? 0 : Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
        if (next === this.transcriptScroll)
            return;
        this.transcriptScroll = next;
        this.emit();
    }
    /** Scroll the transcript by a delta (positive = rows older, away from bottom). */
    scrollTranscript(delta) {
        if (!Number.isFinite(delta) || delta === 0)
            return;
        this.setTranscriptScroll(this.transcriptScroll + delta);
    }
    /** Best-effort one-liner about the most recent persisted session. */
    async loadRecentActivity() {
        try {
            const rows = await this.dsh.listPersistedSessions();
            const first = rows[0];
            if (first === undefined)
                return;
            const cwd = first.cwd ?? '';
            const base = cwd === '' ? '' : cwd.slice(cwd.lastIndexOf('/') + 1);
            this.recentActivity = `${age(first.createdAt)}${base === '' ? '' : ` · ${base}`}`;
            this.emit();
        }
        catch {
            // Banner simply shows "no recent activity".
        }
    }
    /** Flip the tool-output expansion and repaint the whole frame. */
    toggleToolsExpanded() {
        this.toolsExpanded = !this.toolsExpanded;
        this.toast(this.toolsExpanded ? 'tool output expanded' : 'tool output collapsed', 'info', 2000);
        this.requestRepaint();
    }
    toast(text, tone = 'info', ms = 4500) {
        const id = ++this.toastSeq;
        this.toasts.push({ id, text, tone });
        if (this.toasts.length > 4)
            this.toasts = this.toasts.slice(-4);
        const timer = setTimeout(() => {
            this.toasts = this.toasts.filter(t => t.id !== id);
            this.emit();
        }, ms);
        timer.unref?.();
        this.emit();
    }
    saveHistory() {
        try {
            mkdirSync(dshHome(), { recursive: true });
            writeFileSync(this.historyFile, `${this.history.slice(-500).join('\n')}\n`);
        }
        catch {
            // Best-effort.
        }
    }
    commitHistory(line) {
        const trimmed = line.trim();
        if (trimmed === '')
            return;
        if (this.history[this.history.length - 1] !== line)
            this.history.push(line);
        if (this.history.length > 500)
            this.history = this.history.slice(-500);
        this.saveHistory();
    }
    /** Boot: settle the tree, open the agent, wire surface handlers. */
    async boot(startup) {
        try {
            await this.dsh.awaitReady();
            void this.loadRecentActivity();
            this.preset = startup.preset ?? this.dsh.defaultPresetId() ?? '';
            await this.reopen(startup);
            this.dsh.onApproval((request) => this.askApproval(request.toolName, request.reason ?? '', request.callId), (candidate) => candidate.id === this.agent?.id);
            this.dsh.registerQuestions((questions) => this.askQuestions(questions), (candidate) => candidate !== undefined && candidate.id === this.agent?.id);
            this.status = 'ready';
        }
        catch (error) {
            this.status = 'error';
            this.bootError = error instanceof Error ? error.message : String(error);
        }
        this.emit();
    }
    /** (Re)open the agent and rewire stream + model listeners. */
    async reopen(startup) {
        this.detachStream?.();
        this.detachStream = undefined;
        this.detachModel?.();
        this.detachModel = undefined;
        if (this.owned !== undefined)
            await this.owned.dispose();
        const wantedPreset = (startup.preset ?? '') !== '' ? startup.preset : (this.preset === '' ? undefined : this.preset);
        this.owned = await this.dsh.openAgent(startup, wantedPreset);
        await this.adopt(this.owned);
    }
    /** Wire stream + model listeners around an adopted handle. */
    async adopt(handle) {
        this.owned = handle;
        const agent = handle.agent;
        await agent.whenIdle();
        this.detachModel = installModelOverride(agent.ctx, agent, this.modelRef);
        this.feed.reset();
        this.feed.notifyCommitted(readSessionEvents(agent.session));
        this.detachStream = attachLiveStream(this.dsh.ctx, agent, this.feed, () => {
            this.feed.notifyCommitted(readSessionEvents(agent.session));
            this.emit();
        });
        this.pluginCommands = this.dsh.listCommands(agent).map(c => ({ name: c.name, desc: c.description }));
        this.refreshStatus();
        void this.refreshCtxWindow();
        const sessionPreset = this.dsh.sessionPreset(agent.session);
        if (sessionPreset !== undefined && sessionPreset !== '') {
            this.preset = sessionPreset;
        }
        this.emit();
    }
    /** Refresh cached status-bar readings (context pressure, mode). */
    refreshStatus() {
        const agent = this.agent;
        if (agent === undefined) {
            this.ctxTokens = undefined;
            this.mode = '';
            return;
        }
        this.ctxTokens = this.dsh.measureTokens(agent.session)?.totalTokens;
        this.mode = this.dsh.permissionCurrent(readSessionEvents(agent.session));
    }
    /**
     * Resolve the current model's context window for the ctx % meter. Cached
     * per provider/model; a failed or unresolvable lookup keeps the meter off.
     */
    async refreshCtxWindow() {
        const selection = this.selection;
        const key = `${selection.provider}/${selection.model}`;
        if (key === this.ctxWindowKey)
            return;
        this.ctxWindowKey = key;
        this.ctxWindow = undefined;
        const info = await this.dsh.resolveModel(selection.provider, selection.model).catch(() => undefined);
        if (this.ctxWindowKey !== key || this.quitting)
            return;
        this.ctxWindow = info?.contextWindow;
        this.emit();
    }
    /** Effective reasoning effort for the status line. */
    effectiveEffort() {
        return this.dsh.currentEffort(this.agent, this.modelRef.current?.reasoningEffort);
    }
    /** Selectable efforts for the current model (resolved, static fallback). */
    async effortOptions() {
        const selection = this.selection;
        return this.dsh.effortOptions(selection.provider, selection.model);
    }
    /** Switch the session model, keeping effort on the same provider. */
    switchModel(provider, model) {
        const current = this.modelRef.current;
        const effort = current !== undefined && current.provider === provider ? current.reasoningEffort : undefined;
        this.modelRef.current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) };
        void this.refreshCtxWindow();
        this.toast(`model → ${provider}/${model}${effort === undefined ? '' : ` · effort ${effort}`}`, 'ok');
        this.view = { name: 'chat' };
        this.emit();
    }
    /** Submit the composer line. */
    submitComposer() {
        const line = this.composer.value;
        const trimmed = line.trim();
        if (trimmed === '')
            return;
        this.commitHistory(line);
        this.historyIndex = -1;
        this.draft = '';
        this.composer = emptyField();
        this.paletteIndex = 0;
        this.paletteDismissed = '';
        if (trimmed.startsWith('/')) {
            // Slash input never commits a log event — echo it so the transcript
            // shows what was asked (Claude-Code-style input bar).
            this.feed.pushEcho(trimmed);
            void this.submitSlash(trimmed);
            return;
        }
        const agent = this.agent;
        if (agent === undefined) {
            this.toast('no agent is open — try /new or restart', 'error');
            this.emit();
            return;
        }
        if (this.running) {
            sendSteer(agent, trimmed);
            this.toast('steering sent', 'info', 2000);
            this.emit();
            return;
        }
        this.running = true;
        this.runStartValue = Date.now();
        const current = agent;
        sendFollowup(current, trimmed);
        void current.whenIdle().then(async () => {
            if (this.agent !== current || this.quitting)
                return;
            this.running = false;
            // Persist the completed turn immediately so on-disk sessions are always up to date.
            await this.dsh.flush(current.session).catch(() => false);
            this.refreshStatus();
            this.emit();
        });
        this.emit();
    }
    /** Palette entries for the current composer value. */
    paletteEntries() {
        const value = this.composer.value;
        if (!value.startsWith('/') || value.includes(' '))
            return [];
        if (this.paletteDismissed === value)
            return [];
        const query = value.slice(1).toLowerCase();
        const builtins = BUILTINS.filter(b => b.name.startsWith(query)).map(b => ({ ...b, plugin: false }));
        const builtinNames = new Set(BUILTINS.map(b => b.name));
        // `/session` is the sessions-browser alias; never let a plugin of that
        // name steal the palette (or dump tool-call traces into the panel).
        builtinNames.add('session');
        const plugins = this.pluginCommands
            .filter(c => c.name.startsWith(query) && !builtinNames.has(c.name))
            .map(c => ({ name: c.name, desc: c.desc, plugin: true }));
        return [...builtins, ...plugins].slice(0, 12);
    }
    /** Dispatch one slash line (views, actions, or plugin commands). */
    async submitSlash(line) {
        const agent = this.agent;
        const parts = line.slice(1).trim().split(/\s+/u);
        const cmd = parts[0] ?? '';
        const rest = parts.slice(1).join(' ');
        switch (cmd) {
            case 'help':
            case '?':
                this.openView({ name: 'help' });
                return;
            case 'quit':
            case 'exit':
            case 'q':
                void this.quit();
                return;
            case 'clear':
                this.cleared = true;
                this.setTranscriptScroll(0);
                this.emit();
                return;
            case 'new': {
                if (agent === undefined)
                    return;
                agent.cancel('user');
                await agent.whenIdle();
                this.running = false;
                this.cleared = false;
                await this.reopen({ resume: '', model: '', provider: '', print: '' });
                this.toast(`new session ${this.agent?.id ?? ''}`, 'ok');
                return;
            }
            case 'sessions':
            case 'session': {
                // Singular `/session` is the same DSH session browser as `/sessions`.
                // A trailing id resumes, matching `/resume <id>` — never fall through
                // to a plugin that dumps tool-call traces.
                if (rest !== '') {
                    const id = await this.resolveSessionPrefix(rest);
                    if (id === undefined)
                        return;
                    agent?.cancel('user');
                    if (agent !== undefined)
                        await agent.whenIdle();
                    this.running = false;
                    this.cleared = false;
                    await this.reopen({ resume: id, model: '', provider: '', print: '' });
                    this.view = { name: 'chat' };
                    this.toast(`resumed ${id}`, 'ok');
                    return;
                }
                this.openView({ name: 'sessions' });
                return;
            }
            case 'resume': {
                if (rest === '') {
                    this.openView({ name: 'sessions' });
                    return;
                }
                const id = await this.resolveSessionPrefix(rest);
                if (id === undefined)
                    return;
                agent?.cancel('user');
                if (agent !== undefined)
                    await agent.whenIdle();
                this.running = false;
                this.cleared = false;
                await this.reopen({ resume: id, model: '', provider: '', print: '' });
                this.view = { name: 'chat' };
                this.toast(`resumed ${id}`, 'ok');
                return;
            }
            case 'fork': {
                if (agent === undefined)
                    return;
                agent.cancel('user');
                await agent.whenIdle();
                this.running = false;
                try {
                    await this.dsh.flush(agent.session);
                    const child = await this.dsh.forkAgent(agent);
                    this.detachStream?.();
                    this.detachStream = undefined;
                    this.detachModel?.();
                    this.detachModel = undefined;
                    if (this.owned !== undefined)
                        await this.owned.dispose();
                    this.cleared = false;
                    await this.adopt(child);
                    this.view = { name: 'chat' };
                    this.toast(`forked → ${child.agent.id}`, 'ok');
                }
                catch (error) {
                    this.toast(error instanceof Error ? error.message : String(error), 'warn');
                }
                return;
            }
            case 'stop': {
                if (agent === undefined || !this.running) {
                    this.toast('no turn is running', 'info', 2000);
                    return;
                }
                agent.cancel('user');
                this.toast('cancelling turn…', 'warn', 2000);
                return;
            }
            case 'title': {
                if (agent === undefined)
                    return;
                if (rest === '') {
                    this.toast('usage: /title <text>', 'warn');
                    return;
                }
                try {
                    const title = this.dsh.renameSession(agent.session, rest);
                    this.toast(`renamed → ${title}`, 'ok');
                }
                catch (error) {
                    this.toast(error instanceof Error ? error.message : String(error), 'error');
                }
                return;
            }
            case 'effort': {
                if (rest === '') {
                    this.openView({ name: 'effort' });
                    return;
                }
                try {
                    const options = await this.effortOptions();
                    const parsed = normalizeEffort(rest, options.map(o => o.id));
                    if (parsed === undefined) {
                        this.openView({ name: 'effort' });
                        return;
                    }
                    this.applyEffort(parsed);
                }
                catch (error) {
                    this.toast(error instanceof Error ? error.message : String(error), 'warn');
                }
                return;
            }
            case 'model':
            case 'tools':
            case 'commands':
            case 'skills':
            case 'agents':
            case 'terminals':
            case 'todos':
            case 'usage':
            case 'plugins':
            case 'settings':
            case 'permissions':
            case 'jobs':
            case 'doctor':
                this.openView({ name: cmd });
                return;
            case 'preset':
            case 'presets': {
                if (rest !== '') {
                    const presets = await this.dsh.listPresets();
                    const target = rest.trim().toLowerCase();
                    const found = presets.find(p => p.id.toLowerCase() === target || presetDisplayText(p).name.toLowerCase() === target);
                    if (found === undefined) {
                        this.toast(`unknown preset "${rest}"`, 'warn');
                        return;
                    }
                    if (found.broken !== undefined) {
                        this.toast(`preset "${rest}" is broken: ${found.broken}`, 'error');
                        return;
                    }
                    this.view = { name: 'chat' };
                    this.emit();
                    try {
                        agent?.cancel('user');
                        if (agent !== undefined)
                            await agent.whenIdle();
                        this.running = false;
                        this.preset = found.id;
                        this.cleared = false;
                        await this.reopen({ resume: '', model: '', provider: '', print: '' });
                        const text = presetDisplayText(found);
                        this.toast(`session composed with preset "${text.name}"`, 'ok');
                    }
                    catch (error) {
                        this.toast(`preset switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                    }
                    return;
                }
                this.openView({ name: 'presets' });
                return;
            }
            default: {
                if (agent === undefined) {
                    this.toast(`unknown command /${cmd}`, 'warn');
                    return;
                }
                try {
                    const outcome = await this.dsh.executeCommand(agent, line, AbortSignal.timeout(120000));
                    if (outcome === undefined)
                        this.toast(`unknown command /${cmd} — try /help`, 'warn');
                    else if (outcome.kind === 'error')
                        this.toast(`/${cmd} failed: ${outcome.text}`, 'error');
                    else if (outcome.text !== undefined && outcome.text !== '')
                        this.toast(outcome.text.slice(0, 300), 'ok', 8000);
                    else
                        this.toast(`/${cmd} done`, 'ok');
                }
                catch (error) {
                    this.toast(`/${cmd} failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                }
                return;
            }
        }
    }
    /** Open a panel view and load its rows. */
    openView(view) {
        this.view = view;
        this.rowIndex = 0;
        this.rows = [];
        this.rowsHint = '';
        if (view.name === 'chat') {
            this.emit();
            return;
        }
        const key = JSON.stringify(view);
        this.rowsLoading = true;
        this.emit();
        void this.loadView(view).then(() => {
            if (JSON.stringify(this.view) === key) {
                this.rowsLoading = false;
                this.emit();
            }
        }, (error) => {
            if (JSON.stringify(this.view) === key) {
                this.rowsLoading = false;
                this.rowsHint = error instanceof Error ? error.message : String(error);
                this.emit();
            }
        });
    }
    async loadView(view) {
        const agent = this.agent;
        switch (view.name) {
            case 'chat':
                return;
            case 'sessions': {
                await this.loadSessionsView(view.workspace);
                return;
            }
            case 'model': {
                if (view.provider !== undefined) {
                    const provider = view.provider;
                    const models = await this.dsh.listModels(provider);
                    const current = this.selection;
                    this.rows = [
                        ...models.map(m => ({
                            id: m.id,
                            primary: m.id,
                            secondary: m.name === m.id ? m.description.slice(0, 100) : m.name,
                            badge: current.provider === provider && current.model === m.id ? 'active' : undefined,
                        })),
                        { id: '__type', primary: 'type an id…', secondary: `unlisted ids may still route on ${provider}` },
                    ];
                    this.rowsHint = models.length === 0
                        ? `no advertised models on ${provider} · type one · esc back`
                        : 'enter switches (session only, next step) · esc back';
                    return;
                }
                const current = this.selection;
                const providers = this.dsh.listProviders();
                this.rows = [
                    { id: '__current', primary: `session: ${current.provider}/${current.model}`, badge: this.modelRef.current === undefined ? 'default' : 'override' },
                    ...providers.map(p => ({ id: `provider:${p.id}`, primary: p.id, secondary: p.name })),
                    { id: '__custom', primary: 'custom…', secondary: 'type provider/model' },
                ];
                this.rowsHint = 'enter lists a provider\u2019s models · esc back';
                return;
            }
            case 'effort': {
                const current = this.effectiveEffort();
                const options = await this.effortOptions();
                this.rows = [
                    { id: '__auto', primary: 'auto', secondary: 'provider default', badge: current === '' ? 'active' : undefined },
                    ...options.map(o => ({
                        id: o.id,
                        primary: o.name === o.id ? o.id : `${o.id} — ${o.name}`,
                        secondary: o.description.slice(0, 100),
                        badge: o.id === current ? 'active' : undefined,
                    })),
                ];
                this.rowsHint = 'enter sets effort · esc back';
                return;
            }
            case 'skills': {
                const skills = await this.dsh.listSkills();
                this.rows = skills.map(s => ({ id: s.name, primary: s.name, secondary: s.description.slice(0, 120) }));
                this.rowsHint = this.rows.length === 0 ? 'no skills discovered · esc back' : `${String(this.rows.length)} skills · esc back`;
                return;
            }
            case 'agents': {
                const mine = this.agent?.id;
                this.rows = this.dsh.listAgents().map(a => ({
                    id: a.id,
                    primary: a.id,
                    badge: a.id === mine ? 'this surface' : a.status,
                }));
                this.rowsHint = this.rows.length === 0 ? 'no live agents · esc back' : 'esc back';
                return;
            }
            case 'terminals': {
                this.rows = this.dsh.listTerminals(agent ?? undefined).map(t => ({
                    id: t.id,
                    primary: t.id,
                    secondary: t.label,
                    badge: t.status,
                }));
                this.rowsHint = this.rows.length === 0 ? 'no persistent terminals · esc back' : 'esc back';
                return;
            }
            case 'todos': {
                const todos = agent === undefined ? undefined : foldTodos(readSessionEvents(agent.session));
                this.rows = (todos ?? []).map((todo, i) => ({
                    id: String(i),
                    primary: todo.text.slice(0, 140),
                    badge: todo.status,
                }));
                this.rowsHint = this.rows.length === 0 ? 'no task list in this session · esc back' : 'esc back';
                return;
            }
            case 'usage': {
                if (agent === undefined) {
                    this.rows = [];
                    return;
                }
                const totals = foldUsage(readSessionEvents(agent.session));
                const meter = this.dsh.measureTokens(agent.session);
                this.rows = [
                    { id: 'responses', primary: 'responses', secondary: String(totals.responses) },
                    { id: 'in', primary: 'input tokens', secondary: String(totals.input) },
                    { id: 'out', primary: 'output tokens', secondary: String(totals.output) },
                    { id: 'ctx', primary: 'context pressure', secondary: meter === undefined ? '–' : `${String(meter.totalTokens)} tok` },
                ];
                this.rowsHint = 'esc back';
                return;
            }
            case 'tools': {
                if (agent === undefined) {
                    this.rows = [];
                    return;
                }
                this.rows = this.dsh.listTools(agent)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(t => ({ id: t.name, primary: t.name, secondary: (t.description ?? '').split('\n')[0]?.slice(0, 120) }));
                this.rowsHint = `${String(this.rows.length)} tools · esc back`;
                return;
            }
            case 'commands': {
                const plugin = agent === undefined ? [] : this.dsh.listCommands(agent);
                this.rows = [
                    ...BUILTINS.map(b => ({ id: b.name, primary: `/${b.name}`, secondary: b.desc })),
                    ...plugin.map(c => ({ id: c.name, primary: `/${c.name}`, secondary: c.description, badge: 'plugin' })),
                ];
                this.rowsHint = 'enter inserts into composer · esc back';
                return;
            }
            case 'presets': {
                const presets = await this.dsh.listPresets();
                this.rows = presets.map(p => {
                    const text = presetDisplayText(p);
                    return {
                        id: p.id,
                        primary: text.name !== p.id ? `${text.name} (${p.id})` : p.id,
                        secondary: text.description ?? '',
                        badge: p.id === this.preset ? 'active' : p.broken === undefined ? undefined : `broken: ${p.broken}`,
                    };
                });
                this.rowsHint = this.rows.length === 0 ? 'no agent presets configured · esc back' : 'enter starts a session with this preset · esc back';
                return;
            }
            case 'plugins': {
                const { rows, profile, home } = listProfilePlugins();
                this.rows = rows.map(r => ({ id: r.name, primary: r.name, secondary: r.version, badge: r.source }));
                this.rowsHint = `profile ${profile} · ${home} · add: dsh plugin --profile ${profile} add <pkg> · esc back`;
                return;
            }
            case 'settings': {
                const descriptors = this.dsh.describeSettings();
                if (view.ns === undefined) {
                    this.rows = descriptors.map(d => {
                        const keys = d.user === undefined ? 0 : Object.keys(d.user).length;
                        return { id: d.ns, primary: d.ns, badge: keys === 0 ? 'defaults' : `${String(keys)} user` };
                    });
                    this.rowsHint = `file: ${this.dsh.settingsPath() ?? '(non-file)'} · enter drills in · esc back`;
                    return;
                }
                const descriptor = descriptors.find(d => d.ns === view.ns);
                const section = (descriptor?.user ?? descriptor?.resolved ?? {});
                this.rows = Object.entries(section).map(([k, v]) => ({
                    id: k,
                    primary: k,
                    secondary: JSON.stringify(v)?.slice(0, 160) ?? '',
                    badge: descriptor?.user !== undefined && Object.hasOwn(descriptor.user, k) ? 'user' : 'base',
                }));
                this.rowsHint = `${view.ns} · enter edits · esc back`;
                return;
            }
            case 'permissions': {
                const names = this.dsh.permissionNames();
                const current = agent === undefined ? '' : this.dsh.permissionCurrent(readSessionEvents(agent.session));
                this.rows = names.map(n => ({ id: n, primary: n, badge: n === current ? 'active' : undefined }));
                this.rowsHint = current === '' ? 'esc back' : `current: ${current} · enter switches · esc back`;
                return;
            }
            case 'jobs': {
                this.rows = this.dsh.listJobs(agent ?? undefined).map(j => ({
                    id: j.id,
                    primary: j.id,
                    secondary: j.label ?? j.detail ?? '',
                    badge: j.status,
                }));
                this.rowsHint = this.rows.length === 0 ? 'no background jobs · esc back' : 'esc back';
                return;
            }
            case 'doctor': {
                const selection = this.selection;
                const present = (value) => value === undefined ? 'missing' : 'ok';
                this.rows = [
                    { id: 'node', primary: 'node', secondary: process.version },
                    { id: 'profile', primary: 'profile', secondary: `${process.env['DSH_PROFILE'] ?? 'terminal'} · ${dshHome()}` },
                    { id: 'session', primary: 'session', secondary: this.agent?.id ?? '(none)' },
                    { id: 'model', primary: 'model', secondary: `${selection.provider}/${selection.model}` },
                    { id: 'services', primary: 'services', secondary: `agents:${present(this.dsh.ctx.get('agents'))} tools:${present(this.dsh.ctx.get('tools'))} commands:${present(this.dsh.ctx.get('commands'))} questions:${present(this.dsh.ctx.get('userQuestions'))} settings:${present(this.dsh.ctx.get('settings'))} presets:${present(this.dsh.ctx.get('agentPresets'))} jobs:${present(this.dsh.ctx.get('jobs'))} meter:${present(this.dsh.ctx.get('tokenMeter'))}` },
                ];
                this.rowsHint = 'esc back';
                return;
            }
            case 'help': {
                this.rows = [
                    ...BUILTINS.map(b => ({ id: b.name, primary: `/${b.name}`, secondary: b.desc })),
                    { id: 'keys', primary: 'keys', secondary: 'enter send · wheel or pgup/pgdn scroll · shift+↑↓ fine scroll · ctrl+home/end top/bottom · ctrl-d quit · esc back' },
                ];
                this.rowsHint = 'enter inserts into composer · esc back';
                return;
            }
        }
    }
    /** Registry workspace record shape the facade may expose (all fields optional-tolerant). */
    workspaceRegistry() {
        const dsh = this.dsh;
        if (typeof dsh.listWorkspaces !== 'function')
            return undefined;
        let raw;
        try {
            raw = dsh.listWorkspaces();
        }
        catch {
            return undefined;
        }
        if (raw === undefined || !Array.isArray(raw.workspaces))
            return undefined;
        const workspaces = [];
        for (const w of raw.workspaces) {
            if (typeof w !== 'object' || w === null)
                continue;
            const id = typeof w.id === 'string' && w.id !== '' ? w.id : undefined;
            if (id === undefined)
                continue;
            const path = typeof w.path === 'string' ? w.path : '';
            const title = typeof w.title === 'string' && w.title !== ''
                ? w.title
                : path === '' ? id : path.slice(path.lastIndexOf('/') + 1) || path;
            const sessionIds = Array.isArray(w.sessionIds) ? w.sessionIds.filter((s) => typeof s === 'string') : [];
            workspaces.push({ id, path, title, sessionIds });
        }
        const archived = Array.isArray(raw.archivedSessionIds)
            ? raw.archivedSessionIds.filter((s) => typeof s === 'string')
            : [];
        return { workspaces, archivedSessionIds: archived };
    }
    workspaceForSession(sessionId) {
        const dsh = this.dsh;
        if (typeof dsh.findWorkspaceForSession === 'function') {
            try {
                const found = dsh.findWorkspaceForSession(sessionId);
                if (found !== undefined && typeof found.id === 'string' && found.id !== '')
                    return found.id;
            }
            catch {
                // Fall through to registry scan.
            }
        }
        return undefined;
    }
    /** Live-preferred session corpus, newest first (sessionQuery, else manual merge). */
    async sessionRecords() {
        // Flush the active session so persistence & query have the latest events & title.
        if (this.agent !== undefined) {
            await this.dsh.flush(this.agent.session).catch(() => false);
        }
        const fromQuery = await this.dsh.listSessionRecords();
        const liveSessions = this.dsh.listLiveSessions();
        const currentAgent = this.agent;
        const base = fromQuery ?? (await this.dsh.listPersistedSessions()).map(header => ({
            id: header.id,
            createdAt: header.createdAt,
            cwd: header.cwd,
            live: false,
        }));
        const recordsById = new Map();
        for (const r of base)
            recordsById.set(r.id, { ...r });
        // Merge live sessions from ctx.sessions
        for (const s of liveSessions) {
            const existing = recordsById.get(s.id);
            recordsById.set(s.id, {
                id: s.id,
                createdAt: s.header?.createdAt ?? existing?.createdAt,
                cwd: s.header?.cwd ?? existing?.cwd,
                live: true,
            });
        }
        // ALWAYS ensure the current active agent session is present and marked live!
        if (currentAgent !== undefined) {
            const existing = recordsById.get(currentAgent.id);
            recordsById.set(currentAgent.id, {
                id: currentAgent.id,
                createdAt: currentAgent.session.header?.createdAt ?? existing?.createdAt ?? Date.now(),
                cwd: currentAgent.session.header?.cwd ?? existing?.cwd,
                live: true,
            });
        }
        const currentId = currentAgent?.id;
        // Sort order:
        // 1. Current active session ([this]) ALWAYS at row #0!
        // 2. Other live sessions next
        // 3. Newest createdAt next
        return [...recordsById.values()].sort((a, b) => {
            if (currentId !== undefined) {
                if (a.id === currentId)
                    return -1;
                if (b.id === currentId)
                    return 1;
            }
            if (a.live !== b.live)
                return a.live ? -1 : 1;
            return (b.createdAt ?? 0) - (a.createdAt ?? 0);
        });
    }
    sessionOrigin(record) {
        const withOrigin = record;
        return typeof withOrigin.origin === 'string' ? withOrigin.origin : undefined;
    }
    /** Best-known name for one session: live log fold, else the cached read. */
    sessionTitle(record) {
        // If it's the current active session, read directly from live in-memory events!
        if (this.agent !== undefined && record.id === this.agent.id) {
            const events = readSessionEvents(this.agent.session);
            const title = this.dsh.foldTitle(events) ?? this.dsh.firstPrompt(events);
            if (title !== undefined) {
                this.titleCache.set(record.id, title);
                return title;
            }
        }
        if (record.live) {
            const session = this.dsh.listLiveSessions().find(s => s.id === record.id);
            if (session !== undefined) {
                const events = readSessionEvents(session);
                const title = this.dsh.foldTitle(events) ?? this.dsh.firstPrompt(events);
                if (title !== undefined)
                    this.titleCache.set(record.id, title);
                return title;
            }
        }
        const cached = this.titleCache.get(record.id);
        return cached !== undefined && cached !== '' ? cached : undefined;
    }
    /**
     * Filter records for the browser: drop archived sessions and subagent
     * transcripts. SessionListRecord currently lacks `origin`, so read it
     * defensively — the facade may add it later.
     */
    visibleSessionRecords(records, archived) {
        return records.filter(r => !archived.has(r.id) && this.sessionOrigin(r) !== 'subagent');
    }
    /**
     * Name-first child row: primary title (or 'New Session' fallback), short
     * id only as the secondary, current/live badge. No age, cwd, or full id.
     */
    sessionRow(record) {
        const title = this.sessionTitle(record) ?? 'New Session';
        return {
            id: record.id,
            primary: title,
            secondary: shortSession(record.id),
            badge: record.id === this.agent?.id ? 'this' : record.live ? 'live' : undefined,
        };
    }
    /** Group visible records into project rows in durable registry order. */
    sessionProjectRows(records) {
        const registry = this.workspaceRegistry();
        const archived = new Set(registry?.archivedSessionIds ?? []);
        const visible = this.visibleSessionRecords(records, archived);
        const byId = new Map(visible.map(r => [r.id, r]));
        const assigned = new Set();
        const rows = [];
        const order = [];
        const byKey = new Map();
        const currentId = this.agent?.id;
        const currentWorkspaceId = currentId === undefined ? undefined : this.workspaceForSession(currentId);
        const pushProject = (key, title, ordered) => {
            const children = ordered.filter(r => byId.has(r.id));
            for (const r of children)
                assigned.add(r.id);
            // Always show registry workspaces, even when all children filter out.
            byKey.set(key, children);
            order.push(key);
            const current = key === currentWorkspaceId || children.some(r => r.id === currentId);
            rows.push({
                id: `workspace:${key}`,
                primary: title,
                secondary: children.length === 1 ? '1 chat' : `${String(children.length)} chats`,
                badge: current ? 'current' : undefined,
            });
        };
        if (registry !== undefined) {
            // Durable registry order is authoritative; never re-sort by recency.
            for (const w of registry.workspaces) {
                const ordered = w.sessionIds
                    .map(id => byId.get(id))
                    .filter((r) => r !== undefined);
                // Registry members discovered through findWorkspaceForSession but
                // missing from sessionIds still belong to the project.
                for (const r of visible) {
                    if (assigned.has(r.id) || ordered.includes(r))
                        continue;
                    if (this.workspaceForSession(r.id) === w.id)
                        ordered.push(r);
                }
                pushProject(w.id, w.title, ordered);
            }
        }
        else {
            // Fallback: group by cwd, first-seen order (stable, durable enough).
            const groups = new Map();
            for (const r of visible)
                groups.set(r.cwd ?? '', [...(groups.get(r.cwd ?? '') ?? []), r]);
            for (const [cwd, children] of groups) {
                const title = cwd === '' ? 'Ungrouped' : cwd.slice(cwd.lastIndexOf('/') + 1) || cwd;
                pushProject(`cwd:${cwd}`, title, children);
            }
        }
        const leftovers = visible.filter(r => !assigned.has(r.id));
        if (leftovers.length > 0) {
            // Only unattached records land here; registry/cwd grouping claimed the rest.
            const key = 'ungrouped';
            byKey.set(key, leftovers);
            order.push(key);
            const current = leftovers.some(r => r.id === currentId);
            rows.push({
                id: `workspace:${key}`,
                primary: 'Ungrouped',
                secondary: leftovers.length === 1 ? '1 chat' : `${String(leftovers.length)} chats`,
                badge: current ? 'current' : undefined,
            });
        }
        return { rows, order, byKey };
    }
    /** Load the sessions browser: root project rows or one workspace's chats. */
    async loadSessionsView(workspace) {
        const records = await this.sessionRecords();
        this.sessionRecordsCache = records;
        if (workspace === undefined) {
            const { rows, order, byKey } = this.sessionProjectRows(records);
            this.sessionWorkspaces = order.map(key => {
                const row = rows.find(r => r.id === `workspace:${key}`);
                return {
                    key,
                    title: row?.primary ?? key,
                    count: byKey.get(key)?.length ?? 0,
                    current: row?.badge === 'current',
                };
            });
            this.rows = rows.slice(0, 60);
            this.rowsHint = `${String(records.length)} sessions · enter opens · esc back`;
            void this.fillSessionTitles(records);
            return;
        }
        const grouped = this.sessionProjectRows(records);
        const children = grouped.byKey.get(workspace) ?? [];
        this.sessionWorkspaces = [];
        this.rows = children.map(r => this.sessionRow(r)).slice(0, 60);
        this.rowsHint = `${String(children.length)} chats · enter resumes · esc back`;
        void this.fillSessionTitles(records);
    }
    /** Re-render child rows after async titles land, without touching root rows. */
    refreshSessionChildRows(records, selected) {
        const view = this.view;
        if (view.name !== 'sessions' || view.workspace === undefined)
            return;
        const grouped = this.sessionProjectRows(records);
        const children = grouped.byKey.get(view.workspace) ?? [];
        this.rows = children.map(r => this.sessionRow(r)).slice(0, 60);
        const next = selected === undefined ? -1 : this.rows.findIndex(r => r.id === selected);
        this.rowIndex = next >= 0 ? next : 0;
    }
    /**
     * Read persisted-session names in one batched background call (cached
     * across opens, '' = known untitled); rows update once when it lands.
     * Selection follows the session id, never a row index. Root project rows
     * are never rewritten by title fills — only child rows re-render.
     */
    async fillSessionTitles(records) {
        const viewKey = JSON.stringify(this.view);
        const visible = this.visibleSessionRecords(records, new Set(this.workspaceRegistry()?.archivedSessionIds ?? []));
        const pending = visible.filter(r => !r.live && !this.titleCache.has(r.id)).slice(0, 60).map(r => r.id);
        if (pending.length === 0)
            return;
        let titles;
        try {
            titles = await this.dsh.readSessionTitles(pending);
        }
        catch {
            return;
        }
        for (const [id, title] of titles)
            this.titleCache.set(id, title);
        for (const id of pending)
            if (!this.titleCache.has(id))
                this.titleCache.set(id, '');
        if (JSON.stringify(this.view) !== viewKey || this.quitting)
            return;
        const selected = this.rows[this.rowIndex]?.id;
        // Root rows are project aggregates: counts/titles never depend on chat titles.
        if (this.view.name === 'sessions' && this.view.workspace === undefined)
            return;
        this.refreshSessionChildRows(records, selected);
        this.emit();
    }
    /** Human project title for the active sessions child view. */
    sessionWorkspaceTitle() {
        if (this.view.name !== 'sessions' || this.view.workspace === undefined)
            return undefined;
        const key = this.view.workspace;
        const cached = this.sessionWorkspaces.find(workspace => workspace.key === key)?.title;
        if (cached !== undefined)
            return cached;
        const registry = this.workspaceRegistry();
        const durable = registry?.workspaces.find(workspace => workspace.id === key)?.title;
        if (durable !== undefined)
            return durable;
        if (key === 'ungrouped')
            return 'Ungrouped';
        if (key.startsWith('cwd:')) {
            const cwd = key.slice('cwd:'.length);
            return cwd === '' ? 'Ungrouped' : cwd.slice(cwd.lastIndexOf('/') + 1) || cwd;
        }
        return key;
    }
    /** Activate the selected panel row. */
    activateRow() {
        const row = this.rows[this.rowIndex];
        if (row === undefined || this.rowsLoading)
            return;
        const agent = this.agent;
        const view = this.view;
        switch (view.name) {
            case 'sessions': {
                // Root project rows drill in; child session rows resume.
                if (row.id.startsWith('workspace:')) {
                    this.openView({ name: 'sessions', workspace: row.id.slice('workspace:'.length) });
                    return;
                }
                void (async () => {
                    agent?.cancel('user');
                    if (agent !== undefined)
                        await agent.whenIdle();
                    this.running = false;
                    this.cleared = false;
                    await this.reopen({ resume: row.id, model: '', provider: '', print: '' });
                    this.view = { name: 'chat' };
                    this.toast(`resumed ${row.id}`, 'ok');
                })();
                return;
            }
            case 'effort': {
                if (row.id === '__auto')
                    this.applyEffort({ clear: true });
                else
                    this.applyEffort({ level: row.id });
                return;
            }
            case 'model': {
                if (view.provider !== undefined) {
                    const provider = view.provider;
                    if (row.id === '__type') {
                        this.openTextModal('model', `model id on provider ${provider}`, '', (value) => {
                            if (value !== undefined && value.trim() !== '')
                                this.switchModel(provider, value.trim());
                        });
                        return;
                    }
                    this.switchModel(provider, row.id);
                    return;
                }
                if (row.id === '__current')
                    return;
                if (row.id === '__custom') {
                    this.openTextModal('model', 'provider/model, e.g. deepseek/deepseek-chat', `${this.selection.provider}/${this.selection.model}`, (value) => {
                        if (value !== undefined)
                            this.applyModelText(value);
                    });
                    return;
                }
                this.openView({ name: 'model', provider: row.id.slice('provider:'.length) });
                return;
            }
            case 'commands':
            case 'help': {
                if (row.id === 'keys')
                    return;
                this.view = { name: 'chat' };
                this.composer = { value: `/${row.id} `, cursor: row.id.length + 2 };
                this.emit();
                return;
            }
            case 'presets': {
                this.view = { name: 'chat' };
                this.emit();
                void (async () => {
                    try {
                        agent?.cancel('user');
                        if (agent !== undefined)
                            await agent.whenIdle();
                        this.running = false;
                        this.preset = row.id;
                        this.cleared = false;
                        await this.reopen({ resume: '', model: '', provider: '', print: '' });
                        const text = presetDisplayText({ id: row.id });
                        this.toast(`session composed with preset "${text.name}"`, 'ok');
                    }
                    catch (error) {
                        this.toast(`preset switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                    }
                })();
                return;
            }
            case 'settings': {
                if (view.ns === undefined) {
                    this.openView({ name: 'settings', ns: row.id });
                    return;
                }
                const ns = view.ns;
                const key = row.id;
                this.openTextModal(`${ns}.${key}`, 'JSON value (strings may be bare)', row.secondary ?? '', (value) => {
                    if (value === undefined)
                        return;
                    let parsed = value;
                    try {
                        parsed = JSON.parse(value);
                    }
                    catch {
                        parsed = value;
                    }
                    void this.dsh.updateSetting(ns, { [key]: parsed }).then(() => {
                        this.toast(`${ns}.${key} updated`, 'ok');
                        this.openView({ name: 'settings', ns });
                    }, (error) => { this.toast(`settings write failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); });
                });
                return;
            }
            case 'permissions': {
                if (agent === undefined)
                    return;
                try {
                    this.dsh.permissionSet(agent.session, row.id);
                    this.toast(`permission preset → ${row.id}`, 'ok');
                    this.openView({ name: 'permissions' });
                }
                catch (error) {
                    this.toast(`permission switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
                }
                return;
            }
            default:
                return;
        }
    }
    /**
     * Apply a normalized effort selection to the session override, then
     * return to chat — picking from the panel commits and closes it (the
     * composer must come back), matching the model-panel flow.
     */
    applyEffort(parsed) {
        if ('clear' in parsed) {
            const current = this.modelRef.current;
            if (current === undefined || current.reasoningEffort === undefined) {
                this.toast('effort already auto (provider default)', 'info', 2500);
            }
            else {
                const { reasoningEffort: _dropped, ...rest } = current;
                const fallback = this.dsh.currentModel();
                this.modelRef.current = rest.provider === fallback.provider && rest.model === fallback.model
                    ? undefined
                    : rest;
                this.toast('effort → auto (provider default)', 'ok');
            }
        }
        else {
            const base = this.modelRef.current ?? this.dsh.currentModel();
            if (base.provider === '' || base.model === '') {
                this.toast('no model selected — pick a model first', 'warn');
                return;
            }
            this.modelRef.current = { ...base, reasoningEffort: parsed.level };
            this.toast(`effort → ${parsed.level}`, 'ok');
        }
        this.view = { name: 'chat' };
        this.emit();
    }
    applyModelText(text) {
        const parsed = parseModelSelection(text);
        if (parsed === undefined || parsed.model === '') {
            this.toast('usage: <model> or <provider>/<model>', 'warn');
            return;
        }
        const provider = parsed.provider === '' ? this.selection.provider : parsed.provider;
        if (provider === '') {
            this.toast('no provider selected — use <provider>/<model>', 'warn');
            return;
        }
        this.switchModel(provider, parsed.model);
    }
    async resolveSessionPrefix(prefix) {
        const ids = new Set();
        for (const session of this.dsh.listLiveSessions())
            ids.add(session.id);
        for (const header of await this.dsh.listPersistedSessions())
            ids.add(header.id);
        if (ids.has(prefix))
            return prefix;
        const matches = [...ids].filter(id => id.startsWith(prefix));
        if (matches.length === 1)
            return matches[0];
        if (matches.length === 0)
            this.toast(`no session matches "${prefix}"`, 'warn');
        else
            this.toast(`${String(matches.length)} sessions match "${prefix}" — be more specific`, 'warn');
        return undefined;
    }
    /** Queue an approval dialog; resolves the DSH waterfall. */
    askApproval(toolName, reason, callId) {
        const agent = this.agent;
        const args = agent === undefined ? '' : this.dsh.findToolArgs(agent.session, callId);
        return new Promise((resolve) => {
            this.modalSeq++;
            this.modals.push({ kind: 'approval', toolName, reason, args, resolve });
            this.emit();
        });
    }
    /** Queue a user-questions dialog; resolves the awaiting tool call. */
    askQuestions(items) {
        if (items.length === 0)
            return Promise.resolve({ answers: [] });
        return new Promise((resolve) => {
            this.modalSeq++;
            this.modals.push({
                kind: 'questions',
                items,
                index: 0,
                selected: items.map(() => []),
                customs: items.map(() => ''),
                optIndex: 0,
                custom: emptyField(),
                editingCustom: items[0] !== undefined && (items[0].options ?? []).length === 0,
                resolve: (answers) => { resolve({ answers }); },
            });
            this.emit();
        });
    }
    /** Queue a free-text dialog. */
    openTextModal(title, hint, initial, resolve) {
        this.modalSeq++;
        this.modals.push({ kind: 'text', title, hint, field: emptyField(initial), resolve });
        this.emit();
    }
    /** Resolve and drop the active modal. */
    settleModal(index) {
        this.modals.splice(index, 1);
        this.emit();
    }
    /** Recall composer history. */
    recallHistory(delta) {
        if (this.history.length === 0)
            return;
        if (this.historyIndex === -1) {
            if (delta === 1)
                return;
            this.draft = this.composer.value;
            this.historyIndex = this.history.length - 1;
        }
        else {
            const next = this.historyIndex + delta;
            if (next < 0 || next >= this.history.length) {
                if (delta === 1 && this.historyIndex === this.history.length - 1) {
                    this.historyIndex = -1;
                    this.composer = { value: this.draft, cursor: this.draft.length };
                    this.emit();
                }
                return;
            }
            this.historyIndex = next;
        }
        const value = this.historyIndex === -1 ? this.draft : this.history[this.historyIndex];
        this.composer = { value, cursor: value.length };
        this.emit();
    }
    /** Central key router (called from the renderer's useInput). */
    handleKey(input, key) {
        if (this.quitting)
            return;
        if (this.status === 'error') {
            if (key.escape === true || (key.ctrl === true && (input === 'c' || input === 'd')))
                void this.quit();
            return;
        }
        if (this.status !== 'ready')
            return;
        const modal = this.modal;
        if (modal !== undefined) {
            this.handleModalKey(modal, input, key);
            return;
        }
        if (this.view.name !== 'chat') {
            this.handlePanelKey(input, key);
            return;
        }
        // Chat view. Fixed-frame transcript offset: PgUp/PgDn move ~10 rows,
        // Ctrl+Home jumps to the top, Ctrl+End follows the bottom. Plain
        // Home/End stay with the composer field (cursor semantics preserved).
        if (key.pageUp === true) {
            this.scrollTranscript(10);
            return;
        }
        if (key.pageDown === true) {
            this.scrollTranscript(-10);
            return;
        }
        if (key.shift === true && key.upArrow === true) {
            this.scrollTranscript(3);
            return;
        }
        if (key.shift === true && key.downArrow === true) {
            this.scrollTranscript(-3);
            return;
        }
        if (key.ctrl === true && key.home === true) {
            this.setTranscriptScroll(Number.MAX_SAFE_INTEGER);
            return;
        }
        if (key.ctrl === true && key.end === true) {
            this.setTranscriptScroll(0);
            return;
        }
        if (key.f1 === true) {
            this.openView({ name: 'help' });
            return;
        }
        if (key.ctrl === true && input === 'c') {
            const agent = this.agent;
            if (this.running && agent !== undefined) {
                agent.cancel('user');
                this.toast('cancelling turn…', 'warn', 2000);
                return;
            }
            if (this.composer.value !== '') {
                this.composer = emptyField();
                this.emit();
                return;
            }
            void this.quit();
            return;
        }
        if (key.ctrl === true && input === 'd') {
            void this.quit();
            return;
        }
        if (key.ctrl === true && input === 'l') {
            this.cleared = true;
            this.setTranscriptScroll(0);
            this.emit();
            return;
        }
        if (key.ctrl === true && input === 'o') {
            this.toggleToolsExpanded();
            return;
        }
        const palette = this.paletteEntries();
        if (palette.length > 0) {
            if (this.paletteIndex >= palette.length)
                this.paletteIndex = 0;
            if (key.escape === true) {
                this.paletteDismissed = this.composer.value;
                this.emit();
                return;
            }
            if (key.upArrow === true) {
                this.paletteIndex = (this.paletteIndex + palette.length - 1) % palette.length;
                this.emit();
                return;
            }
            if (key.downArrow === true) {
                this.paletteIndex = (this.paletteIndex + 1) % palette.length;
                this.emit();
                return;
            }
            if (key.tab === true) {
                const entry = palette[this.paletteIndex];
                if (entry !== undefined) {
                    this.composer = { value: `/${entry.name} `, cursor: entry.name.length + 2 };
                    this.paletteIndex = 0;
                    this.emit();
                }
                return;
            }
            if (key.return === true) {
                const entry = palette[this.paletteIndex];
                const exactSingle = entry !== undefined && palette.length === 1 && this.composer.value === `/${entry.name}`;
                if (entry !== undefined && !exactSingle) {
                    this.composer = { value: `/${entry.name} `, cursor: entry.name.length + 2 };
                    this.paletteIndex = 0;
                    this.emit();
                    return;
                }
                // An exact single match (or no selection) submits the line as typed.
            }
        }
        else if (key.upArrow === true || key.downArrow === true) {
            this.recallHistory(key.upArrow === true ? -1 : 1);
            return;
        }
        if (key.escape === true)
            return;
        const result = editField(this.composer, input, key);
        if (result === 'submit')
            this.submitComposer();
        else {
            this.paletteIndex = 0;
            if (this.paletteDismissed !== '' && this.composer.value !== this.paletteDismissed)
                this.paletteDismissed = '';
            this.emit();
        }
    }
    handlePanelKey(input, key) {
        if (key.escape === true) {
            if (this.view.name === 'settings' && this.view.ns !== undefined)
                this.openView({ name: 'settings' });
            else if (this.view.name === 'model' && this.view.provider !== undefined)
                this.openView({ name: 'model' });
            else if (this.view.name === 'sessions' && this.view.workspace !== undefined)
                this.openView({ name: 'sessions' });
            else
                this.view = { name: 'chat' };
            this.emit();
            return;
        }
        if (key.upArrow === true || (key.ctrl === true && input === 'p')) {
            this.rowIndex = Math.max(0, this.rowIndex - 1);
            this.emit();
            return;
        }
        if (key.downArrow === true || (key.ctrl === true && input === 'n')) {
            this.rowIndex = Math.min(Math.max(0, this.rows.length - 1), this.rowIndex + 1);
            this.emit();
            return;
        }
        if (key.return === true) {
            this.activateRow();
            return;
        }
    }
    handleModalKey(modal, input, key) {
        const index = this.modals.indexOf(modal);
        if (modal.kind === 'approval') {
            const lower = input.toLowerCase();
            if (lower === 'a' || lower === 'y') {
                modal.resolve('allowed-once');
                this.settleModal(index);
            }
            else if (lower === 'r' || lower === 'n' || key.escape === true) {
                modal.resolve('rejected');
                this.settleModal(index);
            }
            return;
        }
        if (modal.kind === 'text') {
            if (key.escape === true) {
                modal.resolve(undefined);
                this.settleModal(index);
                return;
            }
            if (editField(modal.field, input, key) === 'submit') {
                modal.resolve(modal.field.value);
                this.settleModal(index);
            }
            else {
                this.emit();
            }
            return;
        }
        // Questions wizard.
        const item = modal.items[modal.index];
        const options = item.options ?? [];
        const finish = () => {
            modal.customs[modal.index] = modal.custom.value.trim();
            const answers = modal.items.map((entry, i) => {
                const custom = modal.customs[i].trim();
                return {
                    id: entry.id,
                    selected: modal.selected[i],
                    ...(custom === '' ? {} : { custom }),
                };
            });
            modal.resolve(answers);
            this.settleModal(index);
        };
        const advance = (delta) => {
            modal.customs[modal.index] = modal.custom.value.trim();
            const next = modal.index + delta;
            if (next < 0 || next >= modal.items.length) {
                if (delta === 1)
                    finish();
                return;
            }
            modal.index = next;
            modal.optIndex = 0;
            const nextOptions = modal.items[next].options ?? [];
            modal.editingCustom = nextOptions.length === 0;
            modal.custom = emptyField(modal.customs[next]);
            this.emit();
        };
        if (modal.editingCustom) {
            if (key.escape === true) {
                if (options.length === 0) {
                    // Nothing to fall back to: keep editing.
                    return;
                }
                modal.editingCustom = false;
                this.emit();
                return;
            }
            if (key.tab === true && key.shift !== true) {
                advance(1);
                return;
            }
            if (editField(modal.custom, input, key) === 'submit')
                advance(1);
            else
                this.emit();
            return;
        }
        if (key.escape === true) {
            // Fail soft: resolve progress so far with empty answers.
            const answers = modal.items.map((entry, i) => ({ id: entry.id, selected: i < modal.index ? modal.selected[i] : [] }));
            modal.resolve(answers);
            this.settleModal(index);
            this.toast('questions skipped', 'warn');
            return;
        }
        if (key.upArrow === true) {
            modal.optIndex = options.length === 0 ? 0 : (modal.optIndex + options.length - 1) % options.length;
            this.emit();
            return;
        }
        if (key.downArrow === true) {
            modal.optIndex = options.length === 0 ? 0 : (modal.optIndex + 1) % options.length;
            this.emit();
            return;
        }
        if (input === ' ' && options.length > 0) {
            const label = options[modal.optIndex].label;
            const current = modal.selected[modal.index];
            if (item.multiSelect === true) {
                modal.selected[modal.index] = current.includes(label) ? current.filter(l => l !== label) : [...current, label];
            }
            else {
                modal.selected[modal.index] = [label];
            }
            this.emit();
            return;
        }
        const digit = Number.parseInt(input, 10);
        if (Number.isInteger(digit) && digit >= 1 && digit <= options.length && input.trim() !== '') {
            const label = options[digit - 1].label;
            if (item.multiSelect === true) {
                const current = modal.selected[modal.index];
                modal.selected[modal.index] = current.includes(label) ? current.filter(l => l !== label) : [...current, label];
                this.emit();
            }
            else {
                modal.selected[modal.index] = [label];
                advance(1);
            }
            return;
        }
        if (input === 'e' || key.rightArrow === true) {
            modal.editingCustom = true;
            this.emit();
            return;
        }
        if (key.tab === true && key.shift === true) {
            advance(-1);
            return;
        }
        if (key.tab === true || key.return === true) {
            const current = modal.selected[modal.index];
            if (current.length === 0 && options.length > 0) {
                // Default to the highlighted option on confirm.
                modal.selected[modal.index] = [options[modal.optIndex].label];
            }
            advance(1);
            return;
        }
    }
    /** Cancel, flush, dispose, and request process exit. */
    async quit() {
        if (this.quitting)
            return;
        this.quitting = true;
        this.running = false;
        this.emit();
        this.detachStream?.();
        const agent = this.agent;
        try {
            agent?.cancel('user');
            if (agent !== undefined)
                await agent.whenIdle().catch(() => undefined);
            if (agent !== undefined)
                await this.dsh.flush(agent.session);
            await this.owned?.dispose();
        }
        catch {
            // Shutdown is best-effort.
        }
        // Settle any pending modals so DSH promises never hang the dispose.
        for (const modal of this.modals.splice(0)) {
            if (modal.kind === 'approval')
                modal.resolve('rejected');
            else if (modal.kind === 'text')
                modal.resolve(undefined);
            else
                modal.resolve(modal.items.map(entry => ({ id: entry.id, selected: [] })));
        }
        this.exitFn(0);
    }
}

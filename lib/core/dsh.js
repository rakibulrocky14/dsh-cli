/**
 * UI-agnostic facade over the live DSH services. Every accessor tolerates a
 * missing service (different profile composition or dsh release) by returning
 * `undefined`/empty, so surfaces degrade to honest empty states instead of
 * crashing.
 *
 * @module dsh-terminal/core/dsh
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createModelSwitchNotice, createUserMessage } from './messages.js';
import { LiveFeed } from './transcript.js';
import { hasMethod, readSessionEvents, service, } from './types.js';
/**
 * Fork boundary for a log: the last `turn/end` seq. A fork seed must end at
 * a completed turn — never inside an open one.
 * @param events - the session log in seq order.
 * @returns the inclusive boundary seq, or undefined when unforkable.
 */
export function forkBoundary(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'turn/end')
            return events[i].seq;
    }
    return undefined;
}
/** Harness home directory (DSH_HOME or ~/.dsh). */
export function dshHome() {
    const env = process.env['DSH_HOME'];
    return env !== undefined && env !== '' ? env : join(homedir(), '.dsh');
}
/** Active profile name (DSH_PROFILE or 'terminal'). */
export function dshProfile() {
    const env = process.env['DSH_PROFILE'];
    return env !== undefined && env !== '' ? env : 'terminal';
}
/** Read installed plugin rows from the active profile's package.json. */
export function listProfilePlugins() {
    const home = dshHome();
    const profile = dshProfile();
    const rows = [];
    try {
        const raw = readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8');
        const doc = JSON.parse(raw);
        for (const [name, version] of Object.entries(doc.dependencies ?? {})) {
            if (name === 'dsh-terminal')
                continue;
            rows.push({ name, version: String(version), source: 'profile dependency' });
        }
    }
    catch {
        // Missing/unreadable profile manifest: honest empty list.
    }
    return { rows, profile, home };
}
/**
 * Install an upstream-style mutable model selection on one agent scope:
 * prompt assembly snapshots the selection into `{{provider}}`/`{{model}}`,
 * the request waterfall routes by it, and a durable notice marks switches.
 * @param agentCtx - the agent's scoped context.
 * @param agent - the live agent (for header comparison).
 * @param ref - mutable selection owned by the surface.
 * @returns disposer for the three scoped listeners.
 */
export function installModelOverride(agentCtx, agent, ref) {
    const disposeAssembly = agentCtx.on('system-prompt/assemble', (async (...args) => {
        const next = args[2];
        const selected = ref.current;
        const assembled = await next();
        ref.assembled = selected;
        if (selected === undefined)
            return assembled;
        const variables = assembled.variables ?? {};
        return { ...assembled, variables: { ...variables, provider: selected.provider, model: selected.model } };
    }));
    const disposeRequest = agentCtx.on('agent/request', (async (...args) => {
        const next = args[1];
        const resolved = await next();
        const selected = ref.assembled ?? ref.current;
        if (selected === undefined)
            return resolved;
        ref.assembled = selected;
        const { reasoningEffort: _inherited, ...rest } = resolved;
        return {
            ...rest,
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        };
    }));
    const disposeNotice = agentCtx.on('agent/pre-step', (async (...args) => {
        const payload = args[0];
        const next = args[1];
        const decision = await next();
        if (decision.kind === 'reject' || payload.signal.aborted)
            return decision;
        if (decision.messages.length === 0)
            return decision;
        const selected = ref.assembled;
        const previous = payload.agent.session.requestHeader?.()?.config;
        if (selected === undefined || previous === undefined)
            return decision;
        if (selected.provider === previous.provider && selected.model === previous.model)
            return decision;
        const from = previous.provider === selected.provider
            ? String(previous.model ?? '')
            : `${String(previous.provider ?? '')}/${String(previous.model ?? '')}`;
        const to = previous.provider === selected.provider
            ? selected.model
            : `${selected.provider}/${selected.model}`;
        return {
            ...decision,
            messages: [...decision.messages, createModelSwitchNotice(from, to)],
        };
    }), { prepend: true });
    return () => {
        disposeAssembly();
        disposeRequest();
        disposeNotice();
    };
}
/** Send one user message, waking the driver. */
export function sendFollowup(agent, text) {
    agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
    }));
}
/** Steer the nearest step boundary. */
export function sendSteer(agent, text) {
    agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
    }));
}
/**
 * Attach live-stream ingestion for one agent across dsh releases: newer
 * servers emit `agent/assistant-stream` frames, older ones log top-level
 * `assistant/chunk` events on `session/event`. First chunk source wins, so a
 * server emitting both can never double-render.
 * @param ctx - plugin context carrying the feeds.
 * @param agent - the exact agent to follow.
 * @param feed - overlay receiving chunks.
 * @param onSessionEvent - every committed event for our session.
 * @returns disposer detaching both listeners.
 */
export function attachLiveStream(ctx, agent, feed, onSessionEvent) {
    let mode;
    const disposeFrames = ctx.on('agent/assistant-stream', ((...args) => {
        const payload = args[0];
        if (payload.agent !== agent)
            return;
        const frame = payload.frame;
        if (frame === undefined || frame.type === 'start' || frame.type === 'end')
            return;
        if (mode === 'chunks')
            return;
        mode = 'frames';
        if (frame.chunk !== undefined)
            feed.pushChunk(frame.chunk);
    }));
    const disposeSession = ctx.on('session/event', ((...args) => {
        const session = args[0];
        const event = args[1];
        if (session?.id !== agent.id || event === undefined)
            return;
        if (event.type === 'assistant/chunk') {
            if (mode === 'frames')
                return;
            mode = 'chunks';
            const chunk = event.data.chunk;
            if (chunk !== undefined)
                feed.pushChunk(chunk);
            return;
        }
        onSessionEvent(event);
    }));
    return () => {
        disposeFrames();
        disposeSession();
    };
}
/** Facade over the live DSH services reachable from one context. */
export class Dsh {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** Await loader settlement so agent scopes compose completely. */
    async awaitReady() {
        const loader = service(this.ctx, 'loader');
        try {
            await loader?.await();
        }
        catch {
            // A failed sibling boot surfaces through its own error path.
        }
    }
    /**
     * Create (or resume) the process-wide interactive agent.
     * @param startup - resolved CLI values.
     * @param preset - preset id to compose, when the user applied one.
     */
    async openAgent(startup, preset) {
        const agents = service(this.ctx, 'agents');
        if (agents === undefined)
            throw new Error('terminal: ctx.agents is unavailable in this composition');
        const selection = this.currentModel();
        const provider = startup.provider === '' ? selection.provider : startup.provider;
        const model = startup.model === '' ? selection.model : startup.model;
        const targetPreset = preset !== undefined && preset !== ''
            ? preset
            : startup.preset !== undefined && startup.preset !== ''
                ? startup.preset
                : this.defaultPresetId();
        const setup = targetPreset === undefined || targetPreset === ''
            ? undefined
            : async (agentCtx) => {
                await this.mountPreset(agentCtx, targetPreset);
            };
        if (startup.resume !== '') {
            // Resumes rejoin an existing session: never reattach, so a resumed
            // session keeps whatever workspace it already belongs to (or none).
            return agents.resume({ resumeSessionId: startup.resume, agentOptions: { provider, model }, ...(setup === undefined ? {} : { setup }) });
        }
        const handle = await agents.create({
            sessionId: `session-${randomUUID()}`,
            meta: {
                cwd: process.cwd(),
                ...(targetPreset === undefined || targetPreset === '' ? {} : { agentPreset: targetPreset }),
            },
            agentOptions: { provider, model },
            ...(setup === undefined ? {} : { setup }),
        });
        // Normal terminal new sessions belong to the cwd's workspace, like web's
        // session.create. An attach failure must not break the new chat: the
        // session was created fine, it is just ungrouped (the browser shows it
        // under Ungrouped) until something attaches it later.
        try {
            await this.resolveWorkspaceForPath(process.cwd())
                .then(async (workspace) => {
                if (workspace !== undefined)
                    await this.attachSessionToWorkspace(handle.agent.id, workspace.id);
            });
        }
        catch {
            // Fresh session stands: unattached, visible, usable.
        }
        return handle;
    }
    /**
     * Create (or open) an agent for one explicit canonical cwd — the workspace
     * flow for "open this directory": resolve-or-create the path's workspace,
     * create the session there, and attach it. Attachment failure disposes the
     * newly created handle (the session log itself is untouched — the user can
     * still resume it) and rejects honestly.
     * @param cwd - canonical directory owning the new session.
     * @param startup - resolved CLI values (resume/model/provider).
     * @param preset - preset id to compose, when the user applied one.
     */
    async openAgentInWorkspace(cwd, startup, preset) {
        const agents = service(this.ctx, 'agents');
        if (agents === undefined)
            throw new Error('terminal: ctx.agents is unavailable in this composition');
        const selection = this.currentModel();
        const provider = startup.provider === '' ? selection.provider : startup.provider;
        const model = startup.model === '' ? selection.model : startup.model;
        const targetPreset = preset !== undefined && preset !== ''
            ? preset
            : startup.preset !== undefined && startup.preset !== ''
                ? startup.preset
                : this.defaultPresetId();
        const setup = targetPreset === undefined || targetPreset === ''
            ? undefined
            : async (agentCtx) => {
                await this.mountPreset(agentCtx, targetPreset);
            };
        if (startup.resume !== '') {
            return agents.resume({ resumeSessionId: startup.resume, agentOptions: { provider, model }, ...(setup === undefined ? {} : { setup }) });
        }
        const workspace = await this.resolveWorkspaceForPath(cwd);
        if (workspace === undefined) {
            throw new Error(`terminal: no workspace owns "${cwd}" and none could be created in this composition`);
        }
        const handle = await agents.create({
            sessionId: `session-${randomUUID()}`,
            meta: {
                cwd: workspace.path,
                ...(targetPreset === undefined || targetPreset === '' ? {} : { agentPreset: targetPreset }),
            },
            agentOptions: { provider, model },
            ...(setup === undefined ? {} : { setup }),
        });
        try {
            await this.attachSessionToWorkspace(handle.agent.id, workspace.id);
        }
        catch (error) {
            // Honest failure: release the fresh handle (the durable log survives
            // and stays resumable) and report the attach miss, like web's
            // workspace-attach-failed.
            await handle.dispose().catch(() => { });
            throw new Error(`terminal: session "${handle.agent.id}" was created but could not attach to workspace "${workspace.id}": ${error instanceof Error ? error.message : String(error)}`);
        }
        return handle;
    }
    /** Current default provider/model selection. */
    currentModel() {
        const defaults = service(this.ctx, 'agentDefaultModel');
        try {
            const selection = defaults?.currentSelection();
            if (selection !== undefined && selection.provider !== '' && selection.model !== '')
                return selection;
        }
        catch {
            // Fall through to the empty selection.
        }
        return { provider: '', model: '' };
    }
    /** Persist the default selection (same keys the Web Models page writes). */
    async saveDefaultModel(selection) {
        const defaults = service(this.ctx, 'agentDefaultModel');
        if (defaults === undefined || !hasMethod(defaults, 'saveSelection')) {
            throw new Error('default-model service cannot save in this composition');
        }
        await defaults.saveSelection(selection);
    }
    /** One provider's advertised models (advisory: unlisted ids may still route). */
    async listModels(provider) {
        const llm = service(this.ctx, 'llm');
        if (llm === undefined || !hasMethod(llm, 'listModels'))
            return [];
        const models = await llm.listModels.call(llm, provider);
        if (!Array.isArray(models))
            return [];
        return models
            .filter((m) => {
            if (typeof m !== 'object' || m === null)
                return false;
            const id = m.id;
            return typeof id === 'string' && id !== '';
        })
            .map(m => ({
            id: m.id,
            name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
            description: typeof m.description === 'string' ? m.description : '',
        }));
    }
    /**
     * Resolved model metadata: selectable reasoning efforts plus context facts.
     * @param provider - registered provider route.
     * @param model - exact model id.
     * @returns efforts and context, or undefined when unresolvable.
     */
    async resolveModel(provider, model) {
        const llm = service(this.ctx, 'llm');
        if (llm === undefined || !hasMethod(llm, 'resolveModelInfo'))
            return undefined;
        try {
            const info = await llm.resolveModelInfo.call(llm, provider, model, AbortSignal.timeout(15000));
            if (typeof info !== 'object' || info === null)
                return undefined;
            const reasoning = info.reasoning;
            const efforts = Array.isArray(reasoning?.efforts)
                ? reasoning.efforts
                    .filter(e => typeof e === 'object' && e !== null && typeof e.id === 'string' && e.id !== '')
                    .map(e => ({
                    id: e.id,
                    name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id,
                    description: typeof e.description === 'string' ? e.description : '',
                }))
                : [];
            const context = info.context;
            return {
                efforts,
                defaultEffort: typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : '',
                contextWindow: typeof context?.contextWindow === 'number' ? context.contextWindow : undefined,
            };
        }
        catch {
            return undefined;
        }
    }
    /** Provider routes with a registered adapter. */
    listProviders() {
        const llm = service(this.ctx, 'llm');
        if (llm === undefined || !hasMethod(llm, 'listProviders'))
            return [];
        try {
            const rows = llm.listProviders();
            return Array.isArray(rows) ? rows.filter(r => typeof r.id === 'string') : [];
        }
        catch {
            return [];
        }
    }
    /** Live sessions in this process. */
    listLiveSessions() {
        const sessions = service(this.ctx, 'sessions');
        if (sessions === undefined || !hasMethod(sessions, 'list'))
            return [];
        try {
            const rows = sessions.list();
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /**
     * The whole session corpus, newest first: the base bundle's session-query
     * service merged over live + persisted. Returns undefined when the service
     * is absent (older compositions) so callers can fall back to manual merges.
     */
    async listSessionRecords() {
        const query = service(this.ctx, 'sessionQuery');
        if (query === undefined || !hasMethod(query, 'listSessions'))
            return undefined;
        try {
            const rows = await query.listSessions();
            if (!Array.isArray(rows))
                return undefined;
            const records = [];
            for (const row of rows) {
                const id = row?.header?.id;
                if (typeof id !== 'string' || id === '')
                    continue;
                records.push({
                    id,
                    createdAt: typeof row.header?.createdAt === 'number' ? row.header.createdAt : undefined,
                    cwd: typeof row.header?.cwd === 'string' ? row.header.cwd : undefined,
                    live: row.live === true,
                });
            }
            return records;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Batch-read durable session titles through the base bundle's
     * session-query service: `readTitleSnapshots` on the installed release,
     * `observeSession` on newer checkouts. Returns id → title, omitting
     * sessions that have none or failed to read.
     */
    async readSessionTitles(ids) {
        const titles = new Map();
        if (ids.length === 0)
            return titles;
        const query = service(this.ctx, 'sessionQuery');
        if (query === undefined)
            return titles;
        if (hasMethod(query, 'readTitleSnapshots')) {
            try {
                const results = await query.readTitleSnapshots.call(query, ids);
                for (const result of Array.isArray(results) ? results : []) {
                    if (result === null || typeof result !== 'object' || result.status !== 'fulfilled')
                        continue;
                    const id = result.sessionId;
                    const title = result.value?.title?.title;
                    if (typeof id === 'string' && typeof title === 'string' && title !== '')
                        titles.set(id, title);
                }
            }
            catch {
                // Titles stay unknown.
            }
            return titles;
        }
        if (hasMethod(query, 'observeSession')) {
            try {
                for (const id of ids) {
                    const observation = await query.observeSession.call(query, id);
                    const events = Array.isArray(observation?.events) ? observation.events : [];
                    const title = this.foldTitle(events) ?? this.firstPrompt(events);
                    if (title !== undefined)
                        titles.set(id, title);
                }
            }
            catch {
                // Titles stay unknown.
            }
        }
        return titles;
    }
    /** Persisted session headers across processes. */
    async listPersistedSessions() {
        const persistence = service(this.ctx, 'sessionPersistence');
        if (persistence === undefined || !hasMethod(persistence, 'list'))
            return [];
        try {
            const rows = await persistence.list.call(persistence);
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /** Fold the latest `session/title` event from a log. */
    foldTitle(events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.type === 'session/title') {
                const title = event.data.title;
                if (typeof title === 'string' && title !== '')
                    return title;
            }
        }
        return undefined;
    }
    /** First human message, truncated — title fallback for the browser. */
    firstPrompt(events, max = 60) {
        for (const event of events) {
            if (event.type !== 'user/message')
                continue;
            const source = event.data.source;
            if (source?.kind !== 'user')
                continue;
            const content = event.data.content;
            const text = Array.isArray(content)
                ? content.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
                : '';
            const flat = text.replace(/\s+/g, ' ').trim();
            if (flat !== '')
                return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
        }
        return undefined;
    }
    /** Flush one session to durable storage; resolves false when unavailable. */
    async flush(session) {
        const sessions = service(this.ctx, 'sessions');
        if (sessions === undefined || !hasMethod(sessions, 'flush'))
            return false;
        try {
            return await sessions.flush.call(sessions, session);
        }
        catch {
            return false;
        }
    }
    /** Tool schemas visible to one agent (global view when scopes fail). */
    listTools(agent) {
        const tools = service(this.ctx, 'tools')
            ?? service(agent?.ctx, 'tools');
        if (tools === undefined || !hasMethod(tools, 'schemas'))
            return [];
        const schemas = tools.schemas;
        for (const scope of [agent, undefined]) {
            try {
                const rows = schemas.call(tools, scope);
                if (Array.isArray(rows))
                    return rows.filter(r => typeof r?.name === 'string' && r.name !== '');
            }
            catch {
                // Try the next scope.
            }
        }
        return [];
    }
    /** Human-command descriptors effective for one agent. */
    listCommands(agent) {
        const commands = service(this.ctx, 'commands');
        if (commands === undefined || !hasMethod(commands, 'list'))
            return [];
        try {
            const rows = commands.list.call(commands, agent);
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /**
     * Dispatch one slash-command line to the plugin registry.
     * @param agent - exact receiving agent.
     * @param line - complete `/name …` line.
     * @param signal - cancellation for the dispatching request.
     * @returns the settled outcome, or undefined for an admission miss.
     */
    async executeCommand(agent, line, signal) {
        const commands = service(this.ctx, 'commands');
        if (commands === undefined)
            return undefined;
        const run = hasMethod(commands, 'execute') ? commands.execute : hasMethod(commands, 'dispatch') ? commands.dispatch : undefined;
        if (run === undefined)
            return undefined;
        const settled = await run.call(commands, agent, line, [], signal);
        return settled?.result;
    }
    /** Register the surface's user-question provider. */
    registerQuestions(answerer, isOurs) {
        const questions = service(this.ctx, 'userQuestions');
        if (questions === undefined || !hasMethod(questions, 'registerProvider'))
            return () => { };
        return questions.registerProvider.call(questions, {
            ask: async (request) => {
                if (!isOurs(request.agent))
                    throw new Error('terminal: question for an agent this surface does not own');
                return answerer(request.questions, request.agent);
            },
        });
    }
    /** Answer approval requests for our agent through the surface handler. */
    onApproval(answerer, isOurs) {
        return this.ctx.on('approval/request', (async (...args) => {
            const request = args[0];
            const next = args[1];
            if (!isOurs(request.agent))
                return next();
            if (request.signal?.aborted === true)
                return 'cancelled';
            return answerer(request);
        }));
    }
    /** Find a tool/call's argument string in the log for approval cards. */
    findToolArgs(session, callId) {
        if (callId === undefined || callId === '')
            return '';
        for (const event of readSessionEvents(session)) {
            if (event.type === 'tool/call' && event.data.callId === callId) {
                const args = event.data.arguments;
                return typeof args === 'string' ? args : '';
            }
        }
        return '';
    }
    /** Default preset id configured in agentPresets, if present. */
    defaultPresetId() {
        const presets = service(this.ctx, 'agentPresets');
        if (presets === undefined)
            return undefined;
        if (typeof presets.defaultId === 'string' && presets.defaultId !== '')
            return presets.defaultId;
        const cfg = presets.config;
        if (typeof cfg?.default === 'string' && cfg.default !== '')
            return cfg.default;
        return undefined;
    }
    /** Agent presets from every configured root. */
    async listPresets() {
        const presets = service(this.ctx, 'agentPresets');
        if (presets === undefined || !hasMethod(presets, 'list'))
            return [];
        try {
            const rows = await presets.list.call(presets);
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /** Compose one agent scope from a preset (call from factory setup). */
    async mountPreset(agentCtx, id) {
        const presets = service(this.ctx, 'agentPresets');
        if (presets === undefined || !hasMethod(presets, 'mount')) {
            throw new Error(`preset "${id}" cannot mount: no preset roster in this composition`);
        }
        await presets.mount.call(presets, agentCtx, id);
    }
    /** Background-job snapshots visible to one agent. */
    listJobs(agent) {
        const jobs = service(this.ctx, 'jobs');
        if (jobs === undefined || !hasMethod(jobs, 'list'))
            return [];
        try {
            const rows = jobs.list.call(jobs, agent);
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /** Describe every registered settings namespace for configuration UI. */
    describeSettings() {
        const settings = service(this.ctx, 'settings');
        if (settings === undefined || !hasMethod(settings, 'describe'))
            return [];
        try {
            const describe = settings.describe;
            const rows = describe.call(settings);
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    /** Merge a patch into one settings namespace's user layer. */
    async updateSetting(ns, patch) {
        const settings = service(this.ctx, 'settings');
        if (settings === undefined || !hasMethod(settings, 'update')) {
            throw new Error('settings service cannot update in this composition');
        }
        await settings.update.call(settings, ns, patch);
    }
    /** Absolute settings-document path, when file-backed. */
    settingsPath() {
        const settings = service(this.ctx, 'settings');
        return typeof settings?.documentPath === 'string' ? settings.documentPath : join(dshHome(), 'settings.yaml');
    }
    /** Measure request pressure for the status bar. */
    measureTokens(session) {
        const meter = service(this.ctx, 'tokenMeter');
        if (meter === undefined || !hasMethod(meter, 'measure'))
            return undefined;
        try {
            const reading = meter.measure.call(meter, session);
            if (typeof reading?.totalTokens !== 'number')
                return undefined;
            return {
                totalTokens: reading.totalTokens,
                surfaceTokens: typeof reading.surfaceTokens === 'number' ? reading.surfaceTokens : 0,
            };
        }
        catch {
            return undefined;
        }
    }
    /** Permission-preset service across ctx-key spellings. */
    permissionService() {
        return service(this.ctx, 'permissionPresets')
            ?? service(this.ctx, 'permission')
            ?? service(this.ctx, 'permissions');
    }
    /** Permission-preset names in declaration order. */
    permissionNames() {
        const permissions = this.permissionService();
        return Array.isArray(permissions?.names) ? [...permissions.names] : [];
    }
    /** Effective permission preset for one session's log. */
    permissionCurrent(events) {
        const permissions = this.permissionService();
        if (permissions === undefined || !hasMethod(permissions, 'current'))
            return '';
        try {
            const name = permissions.current.call(permissions, events);
            return typeof name === 'string' ? name : '';
        }
        catch {
            return '';
        }
    }
    /** Switch one session's permission preset. */
    permissionSet(session, name) {
        const permissions = this.permissionService();
        if (permissions === undefined || !hasMethod(permissions, 'set')) {
            throw new Error('permission presets cannot switch in this composition');
        }
        ;
        permissions.set.call(permissions, session, name);
    }
    /**
     * The preset id a session runs under, newest selection winning: the
     * creation header's value, superseded by any `agent-preset/selected`
     * event. Terminal sessions (rosterless composition) resolve undefined.
     * @param session - live session with header and log.
     */
    sessionPreset(session) {
        let preset = session.header?.agentPreset;
        for (const event of readSessionEvents(session)) {
            if (event.type === 'agent-preset/selected') {
                const next = event.data.agentPreset;
                if (typeof next === 'string' && next !== '')
                    preset = next;
            }
        }
        return typeof preset === 'string' && preset !== '' ? preset : undefined;
    }
    /**
     * Fork a live agent's session at its last turn boundary and create the
     * child agent. The caller flushes and disposes the source handle, then
     * adopts the returned one. The agent must be idle (no open turn).
     * @param agent - the exact live agent to fork.
     * @returns the owned child handle.
     */
    async forkAgent(agent) {
        const events = readSessionEvents(agent.session);
        if (!events.some(e => e.type === 'turn/start')) {
            throw new Error('nothing to fork yet — the session has no turns');
        }
        const boundary = forkBoundary(events);
        if (boundary === undefined) {
            throw new Error('no completed turn to fork at — wait for the turn to finish');
        }
        const agents = service(this.ctx, 'agents');
        if (agents === undefined)
            throw new Error('terminal: ctx.agents is unavailable in this composition');
        const handle = await agents.create({
            sessionId: `session-${randomUUID()}`,
            seed: events.filter(e => e.seq <= boundary),
            meta: { cwd: process.cwd(), parentSession: agent.id, seedLength: boundary + 1 },
            agentOptions: { ...agent.options },
        });
        // Forks inherit the source's workspace, like web's forkWorkspace. The
        // forked session is valid regardless — an attach miss leaves it
        // ungrouped rather than failing the fork.
        try {
            const owner = this.findWorkspaceForSession(agent.id);
            if (owner !== undefined)
                await this.attachSessionToWorkspace(handle.agent.id, owner.id);
        }
        catch {
            // Fork stands: unattached, visible, usable.
        }
        return handle;
    }
    /** Rename one live session (pins the title; auto-generation stops). */
    renameSession(session, title) {
        const titles = service(this.ctx, 'sessionTitle');
        if (titles === undefined || !hasMethod(titles, 'rename')) {
            throw new Error('session titles cannot rename in this composition');
        }
        const snapshot = titles.rename
            .call(titles, session, title);
        return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : title;
    }
    /**
     * The workspace registry, when the composition mounts it: feature-detected
     * structurally so older profiles (no workspace row) degrade to undefined
     * and the sessions browser falls back to cwd grouping.
     */
    workspaces() {
        const registry = service(this.ctx, 'workspaceRegistry');
        if (registry === undefined || !hasMethod(registry, 'list'))
            return undefined;
        return registry;
    }
    /**
     * Workspace listing for the sessions browser: plain records in durable
     * registry order plus the archived set, or undefined when the registry is
     * absent. Malformed rows are skipped, never thrown.
     */
    listWorkspaces() {
        const registry = this.workspaces();
        if (registry === undefined)
            return undefined;
        let rows;
        try {
            rows = registry.list();
        }
        catch {
            return undefined;
        }
        if (!Array.isArray(rows))
            return undefined;
        const workspaces = [];
        for (const w of rows) {
            if (typeof w !== 'object' || w === null)
                continue;
            if (typeof w.id !== 'string' || w.id === '')
                continue;
            workspaces.push({
                id: w.id,
                path: typeof w.path === 'string' ? w.path : '',
                title: typeof w.title === 'string' && w.title !== '' ? w.title : w.id,
                sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.filter((s) => typeof s === 'string') : [],
                createdAt: typeof w.createdAt === 'string' ? w.createdAt : '',
                updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : '',
            });
        }
        const archived = Array.isArray(registry.archivedSessionIds)
            ? registry.archivedSessionIds.filter((s) => typeof s === 'string')
            : [];
        return { workspaces, archivedSessionIds: archived };
    }
    /**
     * Resolve (or create) the workspace owning one directory: existing owner
     * first, else a create through `fs.realpath` canonicalization. Returns
     * undefined — never throws for registry absence — so ordinary session
     * creation stays total.
     * @param path - directory in any spelling; must exist.
     */
    async resolveWorkspaceForPath(path) {
        const registry = this.workspaces();
        if (registry === undefined)
            return undefined;
        try {
            const existing = await registry.resolveByPath(path);
            const workspace = existing ?? await registry.create(path);
            return {
                id: workspace.id,
                path: workspace.path,
                title: workspace.title,
                sessionIds: [...workspace.sessionIds],
                createdAt: workspace.createdAt,
                updatedAt: workspace.updatedAt,
            };
        }
        catch {
            return undefined;
        }
    }
    /**
     * Attach an existing session to a workspace by id. Throws honestly when the
     * registry or workspace is absent (or the attach rejects) — callers decide
     * whether that failure is fatal. Never deletes a session.
     * @param sessionId - live or persisted session to record.
     * @param workspaceId - owning workspace.
     */
    async attachSessionToWorkspace(sessionId, workspaceId) {
        const registry = this.workspaces();
        if (registry === undefined)
            throw new Error('terminal: no workspace registry in this composition');
        const workspace = registry.get(workspaceId);
        if (workspace === undefined)
            throw new Error(`terminal: workspace "${workspaceId}" not found`);
        await workspace.attachSession(sessionId);
    }
    /**
     * Find the workspace owning a session: the registry projection's `sessionIds`
     * membership, probed synchronously so the browser can call it per row.
     * Returns undefined when absent or unowned (older compositions, Ungrouped).
     * @param sessionId - session whose owner to find.
     */
    findWorkspaceForSession(sessionId) {
        const listed = this.listWorkspaces();
        return listed?.workspaces.find(w => w.sessionIds.includes(sessionId));
    }
    /**
     * Selectable efforts for one model: adapter-resolved, else the static
     * DeepSeek vocabulary fallback.
     */
    async effortOptions(provider, model) {
        const fallback = ['off', 'low', 'high', 'max'].map(level => ({ id: level, name: level, description: '' }));
        if (provider === '' || model === '')
            return fallback;
        const resolved = await this.resolveModel(provider, model);
        return resolved !== undefined && resolved.efforts.length > 0 ? resolved.efforts : fallback;
    }
    /** Effective reasoning effort: override, live header, default, or ''. */
    currentEffort(agent, override) {
        if (override !== undefined && override !== '')
            return override;
        const header = agent?.session.requestHeader?.()?.config?.reasoningEffort;
        if (typeof header === 'string' && header !== '')
            return header;
        const fallback = this.currentModel().reasoningEffort;
        return typeof fallback === 'string' ? fallback : '';
    }
    /** Live agents in registration order. */
    listAgents() {
        const agents = service(this.ctx, 'agents');
        if (agents === undefined || !hasMethod(agents, 'list'))
            return [];
        try {
            const list = agents.list;
            const rows = list.call(agents);
            if (!Array.isArray(rows))
                return [];
            return rows
                .filter(r => typeof r?.id === 'string')
                .map(r => ({ id: r.id, status: typeof r.status === 'string' ? r.status : 'unknown' }));
        }
        catch {
            return [];
        }
    }
    /** Skill catalog summaries. */
    async listSkills() {
        const skills = service(this.ctx, 'skills');
        if (skills === undefined || !hasMethod(skills, 'list'))
            return [];
        try {
            const rows = await skills.list.call(skills);
            if (!Array.isArray(rows))
                return [];
            return rows
                .filter(r => typeof r?.name === 'string' && r.name !== '')
                .map(r => ({ name: r.name, description: typeof r.description === 'string' ? r.description : '' }));
        }
        catch {
            return [];
        }
    }
    /** Persistent terminal sessions owned by one agent. */
    listTerminals(agent) {
        const terminals = service(this.ctx, 'terminals');
        if (terminals === undefined || agent === undefined || !hasMethod(terminals, 'list'))
            return [];
        try {
            const rows = terminals.list.call(terminals, agent);
            if (!Array.isArray(rows))
                return [];
            return rows.map((r, i) => {
                const id = [r.id, r.sessionId, r.name].find(v => typeof v === 'string' && v !== '');
                const status = [r.status, r.state].find(v => typeof v === 'string' && v !== '');
                const label = [r.label, r.title, r.command].find(v => typeof v === 'string' && v !== '');
                return {
                    id: typeof id === 'string' ? id : `terminal-${String(i)}`,
                    status: typeof status === 'string' ? status : 'unknown',
                    label: typeof label === 'string' ? label : '',
                };
            });
        }
        catch {
            return [];
        }
    }
}
/**
 * Canonical English copy for shipped presets, matching `@deepseek-ai/dsh-client-ui-agent-preset`.
 * Raw disk metadata in DSH defaults to Chinese; this lookup aligns the terminal TUI with Web DSH.
 */
export const BUILT_IN_PRESET_COPY = {
    standard: {
        name: 'Standard mode',
        description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.',
    },
    code: {
        name: 'PTC mode',
        description: 'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.',
    },
    minimal: {
        name: 'Minimal mode',
        description: 'Two-tool coding agent with persistent bash and str_replace_editor.',
    },
    cordis: {
        name: 'Creator mode',
        description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.',
    },
};
/**
 * Resolve display copy for an agent preset. Shipped / system presets use
 * Web DSH's English copy; user-authored presets keep their authored metadata.
 */
export function presetDisplayText(preset) {
    const builtin = preset.trust === 'system' || preset.trust === undefined
        ? BUILT_IN_PRESET_COPY[preset.id]
        : undefined;
    if (builtin !== undefined)
        return builtin;
    return {
        name: (preset.name ?? '') !== '' ? preset.name : preset.id,
        ...(preset.description !== undefined && preset.description !== '' ? { description: preset.description } : {}),
    };
}

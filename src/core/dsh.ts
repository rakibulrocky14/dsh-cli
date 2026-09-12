/**
 * UI-agnostic facade over the live DSH services. Every accessor tolerates a
 * missing service (different profile composition or dsh release) by returning
 * `undefined`/empty, so surfaces degrade to honest empty states instead of
 * crashing.
 *
 * @module dsh-terminal/core/dsh
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createModelSwitchNotice, createUserMessage } from './messages.js'
import { LiveFeed } from './transcript.js'
import {
  hasMethod,
  readSessionEvents,
  service,
  type AgentPresetInfo,
  type ApprovalOutcome,
  type ApprovalRequest,
  type AskAnswer,
  type AskItem,
  type CommandDescriptorInfo,
  type CommandResultInfo,
  type DshAgent,
  type DshAgentHandle,
  type DshContext,
  type DshSession,
  type JobSnapshotInfo,
  type ModelSelection,
  type ModelSelectionRef,
  type ProviderInfo,
  type SessionEvent,
  type SessionHeaderInfo,
  type SettingsDescriptorInfo,
  type StreamChunk,
  type ToolSchemaInfo,
} from './types.js'

/** Values the runner reads from the `terminalStartup` service. */
export interface StartupValues {
  resume: string
  model: string
  provider: string
  print: string
  preset?: string
}

/** Async approval answer supplied by the active surface. */
export type ApprovalAnswerer = (request: ApprovalRequest) => Promise<ApprovalOutcome>

/** Async user-question answer supplied by the active surface. */
export type QuestionAnswerer = (questions: AskItem[], agent: DshAgent | undefined) => Promise<AskAnswer>

/** One installed profile plugin row. */
export interface PluginRow {
  name: string
  version: string
  source: string
}

/**
 * Fork boundary for a log: the last `turn/end` seq. A fork seed must end at
 * a completed turn — never inside an open one.
 * @param events - the session log in seq order.
 * @returns the inclusive boundary seq, or undefined when unforkable.
 */
export function forkBoundary(events: readonly SessionEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'turn/end') return events[i]!.seq
  }
  return undefined
}

/** Harness home directory (DSH_HOME or ~/.dsh). */
export function dshHome(): string {
  const env = process.env['DSH_HOME']
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

/** Active profile name (DSH_PROFILE or 'terminal'). */
export function dshProfile(): string {
  const env = process.env['DSH_PROFILE']
  return env !== undefined && env !== '' ? env : 'terminal'
}

/** Read installed plugin rows from the active profile's package.json. */
export function listProfilePlugins(): { rows: PluginRow[]; profile: string; home: string } {
  const home = dshHome()
  const profile = dshProfile()
  const rows: PluginRow[] = []
  try {
    const raw = readFileSync(join(home, 'profiles', profile, 'package.json'), 'utf8')
    const doc = JSON.parse(raw) as { dependencies?: Record<string, string> }
    for (const [name, version] of Object.entries(doc.dependencies ?? {})) {
      if (name === 'dsh-terminal') continue
      rows.push({ name, version: String(version), source: 'profile dependency' })
    }
  } catch {
    // Missing/unreadable profile manifest: honest empty list.
  }
  return { rows, profile, home }
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
export function installModelOverride(agentCtx: DshContext, agent: DshAgent, ref: ModelSelectionRef): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', (async (...args: never[]) => {
    const next = args[2] as () => Promise<Record<string, unknown>>
    const selected = ref.current
    const assembled = await next()
    ref.assembled = selected
    if (selected === undefined) return assembled
    const variables = (assembled as { variables?: Record<string, unknown> }).variables ?? {}
    return { ...assembled, variables: { ...variables, provider: selected.provider, model: selected.model } }
  }) as (...args: never[]) => unknown)

  const disposeRequest = agentCtx.on('agent/request', (async (...args: never[]) => {
    const next = args[1] as () => Promise<Record<string, unknown>>
    const resolved = await next()
    const selected = ref.assembled ?? ref.current
    if (selected === undefined) return resolved
    ref.assembled = selected
    const { reasoningEffort: _inherited, ...rest } = resolved
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  }) as (...args: never[]) => unknown)

  const disposeNotice = agentCtx.on('agent/pre-step', (async (...args: never[]) => {
    const payload = args[0] as {
      agent: DshAgent
      messages: unknown[]
      signal: AbortSignal
      step?: number
    }
    const next = args[1] as () => Promise<{ kind: string; messages: unknown[] }>
    const decision = await next()
    if (decision.kind === 'reject' || payload.signal.aborted) return decision
    if (decision.messages.length === 0) return decision
    const selected = ref.assembled
    const previous = payload.agent.session.requestHeader?.()?.config
    if (selected === undefined || previous === undefined) return decision
    if (selected.provider === previous.provider && selected.model === previous.model) return decision
    const from = previous.provider === selected.provider
      ? String(previous.model ?? '')
      : `${String(previous.provider ?? '')}/${String(previous.model ?? '')}`
    const to = previous.provider === selected.provider
      ? selected.model
      : `${selected.provider}/${selected.model}`
    return {
      ...decision,
      messages: [...decision.messages, createModelSwitchNotice(from, to)],
    }
  }) as (...args: never[]) => unknown, { prepend: true })

  return () => {
    disposeAssembly()
    disposeRequest()
    disposeNotice()
  }
}

/** Send one user message, waking the driver. */
export function sendFollowup(agent: DshAgent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/** Steer the nearest step boundary. */
export function sendSteer(agent: DshAgent, text: string): void {
  agent.steer(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
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
export function attachLiveStream(
  ctx: DshContext,
  agent: DshAgent,
  feed: LiveFeed,
  onSessionEvent: (event: SessionEvent) => void,
): () => void {
  let mode: 'frames' | 'chunks' | undefined

  const disposeFrames = ctx.on('agent/assistant-stream', ((...args: never[]) => {
    const payload = args[0] as { agent?: DshAgent; frame?: { type?: string; chunk?: StreamChunk } }
    if (payload.agent !== agent) return
    const frame = payload.frame
    if (frame === undefined || frame.type === 'start' || frame.type === 'end') return
    if (mode === 'chunks') return
    mode = 'frames'
    if (frame.chunk !== undefined) feed.pushChunk(frame.chunk)
  }) as (...args: never[]) => unknown)

  const disposeSession = ctx.on('session/event', ((...args: never[]) => {
    const session = args[0] as DshSession
    const event = args[1] as SessionEvent
    if (session?.id !== agent.id || event === undefined) return
    if (event.type === 'assistant/chunk') {
      if (mode === 'frames') return
      mode = 'chunks'
      const chunk = (event.data as { chunk?: StreamChunk }).chunk
      if (chunk !== undefined) feed.pushChunk(chunk)
      return
    }
    onSessionEvent(event)
  }) as (...args: never[]) => unknown)

  return () => {
    disposeFrames()
    disposeSession()
  }
}

/** One live-preferred corpus record for the sessions browser. */
export interface SessionListRecord {
  id: string
  createdAt: number | undefined
  cwd: string | undefined
  live: boolean
}

/**
 * Workspace projection mirroring `ctx.workspaceRegistry`: plain data (never
 * the live entity) in durable registry order, so the sessions browser can
 * render without holding Cordis services. Absence of the registry service
 * yields undefined, and the browser falls back to cwd grouping.
 */
export interface WorkspaceRecord {
  id: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** Structural workspace entity (subset of dsh-workspace's Workspace). */
interface WorkspaceEntityShape {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Structural workspace registry (subset of dsh-workspace's WorkspaceRegistry). */
interface WorkspaceRegistryShape {
  list(): WorkspaceEntityShape[]
  get(id: string): WorkspaceEntityShape | undefined
  create(path: string, title?: string): Promise<WorkspaceEntityShape>
  resolveByPath(path: string): Promise<WorkspaceEntityShape | undefined>
  readonly archivedSessionIds: readonly string[]
}

/** Facade over the live DSH services reachable from one context. */
export class Dsh {
  constructor(readonly ctx: DshContext) {}

  /** Await loader settlement so agent scopes compose completely. */
  async awaitReady(): Promise<void> {
    const loader = service<{ await(): Promise<void> }>(this.ctx, 'loader')
    try {
      await loader?.await()
    } catch {
      // A failed sibling boot surfaces through its own error path.
    }
  }

  /**
   * Create (or resume) the process-wide interactive agent.
   * @param startup - resolved CLI values.
   * @param preset - preset id to compose, when the user applied one.
   */
  async openAgent(startup: StartupValues, preset?: string): Promise<DshAgentHandle> {
    const agents = service<{
      create(options: Record<string, unknown>): Promise<DshAgentHandle>
      resume(options: Record<string, unknown>): Promise<DshAgentHandle>
    }>(this.ctx, 'agents')
    if (agents === undefined) throw new Error('terminal: ctx.agents is unavailable in this composition')
    const selection = this.currentModel()
    const provider = startup.provider === '' ? selection.provider : startup.provider
    const model = startup.model === '' ? selection.model : startup.model
    const targetPreset = preset !== undefined && preset !== ''
      ? preset
      : startup.preset !== undefined && startup.preset !== ''
        ? startup.preset
        : this.defaultPresetId()
    const setup = targetPreset === undefined || targetPreset === ''
      ? undefined
      : async (agentCtx: DshContext): Promise<void> => {
        await this.mountPreset(agentCtx, targetPreset)
      }
    if (startup.resume !== '') {
      // Resumes rejoin an existing session: never reattach, so a resumed
      // session keeps whatever workspace it already belongs to (or none).
      return agents.resume({ resumeSessionId: startup.resume, agentOptions: { provider, model }, ...(setup === undefined ? {} : { setup }) })
    }
    const handle = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: {
        cwd: process.cwd(),
        ...(targetPreset === undefined || targetPreset === '' ? {} : { agentPreset: targetPreset }),
      },
      agentOptions: { provider, model },
      ...(setup === undefined ? {} : { setup }),
    })
    // Normal terminal new sessions belong to the cwd's workspace, like web's
    // session.create. An attach failure must not break the new chat: the
    // session was created fine, it is just ungrouped (the browser shows it
    // under Ungrouped) until something attaches it later.
    try {
      await this.resolveWorkspaceForPath(process.cwd())
        .then(async workspace => {
          if (workspace !== undefined) await this.attachSessionToWorkspace(handle.agent.id, workspace.id)
        })
    } catch {
      // Fresh session stands: unattached, visible, usable.
    }
    return handle
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
  async openAgentInWorkspace(cwd: string, startup: StartupValues, preset?: string): Promise<DshAgentHandle> {
    const agents = service<{
      create(options: Record<string, unknown>): Promise<DshAgentHandle>
      resume(options: Record<string, unknown>): Promise<DshAgentHandle>
    }>(this.ctx, 'agents')
    if (agents === undefined) throw new Error('terminal: ctx.agents is unavailable in this composition')
    const selection = this.currentModel()
    const provider = startup.provider === '' ? selection.provider : startup.provider
    const model = startup.model === '' ? selection.model : startup.model
    const targetPreset = preset !== undefined && preset !== ''
      ? preset
      : startup.preset !== undefined && startup.preset !== ''
        ? startup.preset
        : this.defaultPresetId()
    const setup = targetPreset === undefined || targetPreset === ''
      ? undefined
      : async (agentCtx: DshContext): Promise<void> => {
        await this.mountPreset(agentCtx, targetPreset)
      }
    if (startup.resume !== '') {
      return agents.resume({ resumeSessionId: startup.resume, agentOptions: { provider, model }, ...(setup === undefined ? {} : { setup }) })
    }
    const workspace = await this.resolveWorkspaceForPath(cwd)
    if (workspace === undefined) {
      throw new Error(`terminal: no workspace owns "${cwd}" and none could be created in this composition`)
    }
    const handle = await agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: {
        cwd: workspace.path,
        ...(targetPreset === undefined || targetPreset === '' ? {} : { agentPreset: targetPreset }),
      },
      agentOptions: { provider, model },
      ...(setup === undefined ? {} : { setup }),
    })
    try {
      await this.attachSessionToWorkspace(handle.agent.id, workspace.id)
    } catch (error) {
      // Honest failure: release the fresh handle (the durable log survives
      // and stays resumable) and report the attach miss, like web's
      // workspace-attach-failed.
      await handle.dispose().catch(() => {})
      throw new Error(`terminal: session "${handle.agent.id}" was created but could not attach to workspace "${workspace.id}": ${error instanceof Error ? error.message : String(error)}`)
    }
    return handle
  }

  /** Current default provider/model selection. */
  currentModel(): ModelSelection {
    const defaults = service<{ currentSelection(): ModelSelection }>(this.ctx, 'agentDefaultModel')
    try {
      const selection = defaults?.currentSelection()
      if (selection !== undefined && selection.provider !== '' && selection.model !== '') return selection
    } catch {
      // Fall through to the empty selection.
    }
    return { provider: '', model: '' }
  }

  /** Persist the default selection (same keys the Web Models page writes). */
  async saveDefaultModel(selection: ModelSelection): Promise<void> {
    const defaults = service<{ saveSelection(next: ModelSelection): Promise<void> }>(this.ctx, 'agentDefaultModel')
    if (defaults === undefined || !hasMethod(defaults, 'saveSelection')) {
      throw new Error('default-model service cannot save in this composition')
    }
    await (defaults.saveSelection as (next: ModelSelection) => Promise<void>)(selection)
  }

  /** One provider's advertised models (advisory: unlisted ids may still route). */
  async listModels(provider: string): Promise<{ id: string; name: string; description: string }[]> {
    const llm = service<Record<string, unknown>>(this.ctx, 'llm')
    if (llm === undefined || !hasMethod(llm, 'listModels')) return []
    const models = await (llm.listModels as (provider: string) => Promise<unknown[]>).call(llm, provider)
    if (!Array.isArray(models)) return []
    return models
      .filter((m): m is Record<string, unknown> => {
        if (typeof m !== 'object' || m === null) return false
        const id = (m as Record<string, unknown>).id
        return typeof id === 'string' && id !== ''
      })
      .map(m => ({
        id: m.id as string,
        name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id as string,
        description: typeof m.description === 'string' ? m.description : '',
      }))
  }

  /**
   * Resolved model metadata: selectable reasoning efforts plus context facts.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @returns efforts and context, or undefined when unresolvable.
   */
  async resolveModel(provider: string, model: string): Promise<{
    efforts: { id: string; name: string; description: string }[]
    defaultEffort: string
    contextWindow: number | undefined
  } | undefined> {
    const llm = service<Record<string, unknown>>(this.ctx, 'llm')
    if (llm === undefined || !hasMethod(llm, 'resolveModelInfo')) return undefined
    try {
      const info = await (llm.resolveModelInfo as (
        provider: string, model: string, signal?: AbortSignal,
      ) => Promise<Record<string, unknown>>).call(llm, provider, model, AbortSignal.timeout(15000))
      if (typeof info !== 'object' || info === null) return undefined
      const reasoning = info.reasoning as { efforts?: unknown; defaultEffort?: unknown } | undefined
      const efforts = Array.isArray(reasoning?.efforts)
        ? (reasoning.efforts as Record<string, unknown>[])
          .filter(e => typeof e === 'object' && e !== null && typeof e.id === 'string' && e.id !== '')
          .map(e => ({
            id: e.id as string,
            name: typeof e.name === 'string' && e.name !== '' ? e.name : e.id as string,
            description: typeof e.description === 'string' ? e.description : '',
          }))
        : []
      const context = info.context as { contextWindow?: unknown } | undefined
      return {
        efforts,
        defaultEffort: typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : '',
        contextWindow: typeof context?.contextWindow === 'number' ? context.contextWindow : undefined,
      }
    } catch {
      return undefined
    }
  }

  /** Provider routes with a registered adapter. */
  listProviders(): ProviderInfo[] {
    const llm = service<Record<string, unknown>>(this.ctx, 'llm')
    if (llm === undefined || !hasMethod(llm, 'listProviders')) return []
    try {
      const rows = (llm.listProviders as () => ProviderInfo[])()
      return Array.isArray(rows) ? rows.filter(r => typeof r.id === 'string') : []
    } catch {
      return []
    }
  }

  /** Live sessions in this process. */
  listLiveSessions(): DshSession[] {
    const sessions = service<{ list(): DshSession[] }>(this.ctx, 'sessions')
    if (sessions === undefined || !hasMethod(sessions, 'list')) return []
    try {
      const rows = (sessions.list as () => DshSession[])()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /**
   * The whole session corpus, newest first: the base bundle's session-query
   * service merged over live + persisted. Returns undefined when the service
   * is absent (older compositions) so callers can fall back to manual merges.
   */
  async listSessionRecords(): Promise<SessionListRecord[] | undefined> {
    const query = service<{
      listSessions(signal?: AbortSignal): Promise<{ header?: { id?: unknown; createdAt?: unknown; cwd?: unknown }; live?: unknown }[]>
    }>(this.ctx, 'sessionQuery')
    if (query === undefined || !hasMethod(query, 'listSessions')) return undefined
    try {
      const rows = await query.listSessions()
      if (!Array.isArray(rows)) return undefined
      const records: SessionListRecord[] = []
      for (const row of rows) {
        const id = row?.header?.id
        if (typeof id !== 'string' || id === '') continue
        records.push({
          id,
          createdAt: typeof row.header?.createdAt === 'number' ? row.header.createdAt : undefined,
          cwd: typeof row.header?.cwd === 'string' ? row.header.cwd : undefined,
          live: row.live === true,
        })
      }
      return records
    } catch {
      return undefined
    }
  }

  /**
   * Batch-read durable session titles through the base bundle's
   * session-query service: `readTitleSnapshots` on the installed release,
   * `observeSession` on newer checkouts. Returns id → title, omitting
   * sessions that have none or failed to read.
   */
  async readSessionTitles(ids: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    if (ids.length === 0) return titles
    const query = service<Record<string, unknown>>(this.ctx, 'sessionQuery')
    if (query === undefined) return titles
    if (hasMethod(query, 'readTitleSnapshots')) {
      try {
        const results = await (query.readTitleSnapshots as (
          ids: readonly string[],
        ) => Promise<Array<{ sessionId?: unknown; status?: unknown; value?: { title?: { title?: unknown } } }>>).call(query, ids)
        for (const result of Array.isArray(results) ? results : []) {
          if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue
          const id = result.sessionId
          const title = result.value?.title?.title
          if (typeof id === 'string' && typeof title === 'string' && title !== '') titles.set(id, title)
        }
      } catch {
        // Titles stay unknown.
      }
      return titles
    }
    if (hasMethod(query, 'observeSession')) {
      try {
        for (const id of ids) {
          const observation = await (query.observeSession as (id: string) => Promise<{ events?: unknown }>).call(query, id)
          const events = Array.isArray(observation?.events) ? observation.events as SessionEvent[] : []
          const title = this.foldTitle(events) ?? this.firstPrompt(events)
          if (title !== undefined) titles.set(id, title)
        }
      } catch {
        // Titles stay unknown.
      }
    }
    return titles
  }

  /** Persisted session headers across processes. */
  async listPersistedSessions(): Promise<SessionHeaderInfo[]> {
    const persistence = service<Record<string, unknown>>(this.ctx, 'sessionPersistence')
    if (persistence === undefined || !hasMethod(persistence, 'list')) return []
    try {
      const rows = await (persistence.list as () => Promise<SessionHeaderInfo[]>).call(persistence)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Fold the latest `session/title` event from a log. */
  foldTitle(events: readonly SessionEvent[]): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event.type === 'session/title') {
        const title = (event.data as { title?: unknown }).title
        if (typeof title === 'string' && title !== '') return title
      }
    }
    return undefined
  }

  /** First human message, truncated — title fallback for the browser. */
  firstPrompt(events: readonly SessionEvent[], max = 60): string | undefined {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: unknown } }).source
      if (source?.kind !== 'user') continue
      const content = (event.data as { content?: { type?: unknown; text?: unknown }[] }).content
      const text = Array.isArray(content)
        ? content.filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('')
        : ''
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat !== '') return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
    }
    return undefined
  }

  /** Flush one session to durable storage; resolves false when unavailable. */
  async flush(session: DshSession): Promise<boolean> {
    const sessions = service<Record<string, unknown>>(this.ctx, 'sessions')
    if (sessions === undefined || !hasMethod(sessions, 'flush')) return false
    try {
      return await (sessions.flush as (s: DshSession) => Promise<boolean>).call(sessions, session)
    } catch {
      return false
    }
  }

  /** Tool schemas visible to one agent (global view when scopes fail). */
  listTools(agent: DshAgent | undefined): ToolSchemaInfo[] {
    const tools = service<Record<string, unknown>>(this.ctx, 'tools')
      ?? service<Record<string, unknown>>(agent?.ctx as DshContext, 'tools')
    if (tools === undefined || !hasMethod(tools, 'schemas')) return []
    const schemas = tools.schemas as (scope?: unknown) => ToolSchemaInfo[]
    for (const scope of [agent, undefined]) {
      try {
        const rows = schemas.call(tools, scope)
        if (Array.isArray(rows)) return rows.filter(r => typeof r?.name === 'string' && r.name !== '')
      } catch {
        // Try the next scope.
      }
    }
    return []
  }

  /** Human-command descriptors effective for one agent. */
  listCommands(agent: DshAgent): CommandDescriptorInfo[] {
    const commands = service<Record<string, unknown>>(this.ctx, 'commands')
    if (commands === undefined || !hasMethod(commands, 'list')) return []
    try {
      const rows = (commands.list as (agent: DshAgent) => CommandDescriptorInfo[]).call(commands, agent)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /**
   * Dispatch one slash-command line to the plugin registry.
   * @param agent - exact receiving agent.
   * @param line - complete `/name …` line.
   * @param signal - cancellation for the dispatching request.
   * @returns the settled outcome, or undefined for an admission miss.
   */
  async executeCommand(agent: DshAgent, line: string, signal: AbortSignal): Promise<CommandResultInfo | undefined> {
    const commands = service<Record<string, unknown>>(this.ctx, 'commands')
    if (commands === undefined) return undefined
    const run = hasMethod(commands, 'execute') ? commands.execute : hasMethod(commands, 'dispatch') ? commands.dispatch : undefined
    if (run === undefined) return undefined
    const settled = await (run as (
      agent: DshAgent, line: string, images: readonly unknown[], signal: AbortSignal,
    ) => Promise<{ result?: CommandResultInfo } | undefined>).call(commands, agent, line, [], signal)
    return settled?.result
  }

  /** Register the surface's user-question provider. */
  registerQuestions(answerer: QuestionAnswerer, isOurs: (agent: DshAgent | undefined) => boolean): () => void {
    const questions = service<{
      registerProvider(provider: { ask(request: { questions: AskItem[]; agent?: DshAgent; signal?: AbortSignal }): Promise<AskAnswer> }): () => void
    }>(this.ctx, 'userQuestions')
    if (questions === undefined || !hasMethod(questions, 'registerProvider')) return () => {}
    return (questions.registerProvider as (
      provider: { ask(request: { questions: AskItem[]; agent?: DshAgent; signal?: AbortSignal }): Promise<AskAnswer> },
    ) => () => void).call(questions, {
      ask: async (request) => {
        if (!isOurs(request.agent)) throw new Error('terminal: question for an agent this surface does not own')
        return answerer(request.questions, request.agent)
      },
    })
  }

  /** Answer approval requests for our agent through the surface handler. */
  onApproval(answerer: ApprovalAnswerer, isOurs: (agent: { id: string }) => boolean): () => void {
    return this.ctx.on('approval/request', (async (...args: never[]) => {
      const request = args[0] as ApprovalRequest
      const next = args[1] as () => Promise<ApprovalOutcome>
      if (!isOurs(request.agent)) return next()
      if (request.signal?.aborted === true) return 'cancelled' as ApprovalOutcome
      return answerer(request)
    }) as (...args: never[]) => unknown)
  }

  /** Find a tool/call's argument string in the log for approval cards. */
  findToolArgs(session: DshSession, callId: string | undefined): string {
    if (callId === undefined || callId === '') return ''
    for (const event of readSessionEvents(session)) {
      if (event.type === 'tool/call' && (event.data as { callId?: unknown }).callId === callId) {
        const args = (event.data as { arguments?: unknown }).arguments
        return typeof args === 'string' ? args : ''
      }
    }
    return ''
  }

  /** Default preset id configured in agentPresets, if present. */
  defaultPresetId(): string | undefined {
    const presets = service<Record<string, unknown>>(this.ctx, 'agentPresets')
    if (presets === undefined) return undefined
    if (typeof presets.defaultId === 'string' && presets.defaultId !== '') return presets.defaultId
    const cfg = presets.config as { default?: unknown } | undefined
    if (typeof cfg?.default === 'string' && cfg.default !== '') return cfg.default
    return undefined
  }

  /** Agent presets from every configured root. */
  async listPresets(): Promise<AgentPresetInfo[]> {
    const presets = service<Record<string, unknown>>(this.ctx, 'agentPresets')
    if (presets === undefined || !hasMethod(presets, 'list')) return []
    try {
      const rows = await (presets.list as () => Promise<AgentPresetInfo[]>).call(presets)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Compose one agent scope from a preset (call from factory setup). */
  async mountPreset(agentCtx: DshContext, id: string): Promise<void> {
    const presets = service<Record<string, unknown>>(this.ctx, 'agentPresets')
    if (presets === undefined || !hasMethod(presets, 'mount')) {
      throw new Error(`preset "${id}" cannot mount: no preset roster in this composition`)
    }
    await (presets.mount as (agentCtx: DshContext, id: string) => Promise<unknown>).call(presets, agentCtx, id)
  }

  /** Background-job snapshots visible to one agent. */
  listJobs(agent: DshAgent | undefined): JobSnapshotInfo[] {
    const jobs = service<Record<string, unknown>>(this.ctx, 'jobs')
    if (jobs === undefined || !hasMethod(jobs, 'list')) return []
    try {
      const rows = (jobs.list as (caller?: DshAgent) => JobSnapshotInfo[]).call(jobs, agent)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Describe every registered settings namespace for configuration UI. */
  describeSettings(): SettingsDescriptorInfo[] {
    const settings = service<Record<string, unknown>>(this.ctx, 'settings')
    if (settings === undefined || !hasMethod(settings, 'describe')) return []
    try {
      const describe = settings.describe as (this: Record<string, unknown>) => SettingsDescriptorInfo[]
      const rows = describe.call(settings)
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /** Merge a patch into one settings namespace's user layer. */
  async updateSetting(ns: string, patch: Record<string, unknown>): Promise<void> {
    const settings = service<Record<string, unknown>>(this.ctx, 'settings')
    if (settings === undefined || !hasMethod(settings, 'update')) {
      throw new Error('settings service cannot update in this composition')
    }
    await (settings.update as (ns: string, patch: Record<string, unknown>) => Promise<void>).call(settings, ns, patch)
  }

  /** Absolute settings-document path, when file-backed. */
  settingsPath(): string | undefined {
    const settings = service<{ documentPath?: string }>(this.ctx, 'settings')
    return typeof settings?.documentPath === 'string' ? settings.documentPath : join(dshHome(), 'settings.yaml')
  }

  /** Measure request pressure for the status bar. */
  measureTokens(session: DshSession): { totalTokens: number; surfaceTokens: number } | undefined {
    const meter = service<Record<string, unknown>>(this.ctx, 'tokenMeter')
    if (meter === undefined || !hasMethod(meter, 'measure')) return undefined
    try {
      const reading = (meter.measure as (session: DshSession) => {
        totalTokens?: unknown
        surfaceTokens?: unknown
      }).call(meter, session)
      if (typeof reading?.totalTokens !== 'number') return undefined
      return {
        totalTokens: reading.totalTokens,
        surfaceTokens: typeof reading.surfaceTokens === 'number' ? reading.surfaceTokens : 0,
      }
    } catch {
      return undefined
    }
  }

  /** Cumulative token usage from durable projections (parity with Web GUI). */
  readTokenUsage(session: DshSession): { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined {
    const projections = service<Record<string, unknown>>(this.ctx, 'sessionProjections')
    if (projections === undefined) return undefined
    try {
      if (hasMethod(projections, 'stateOf')) {
        const state = (projections.stateOf as (s: DshSession, key: string) => unknown).call(projections, session, 'tokenUsage') as {
          totals?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
        } | undefined
        if (state?.totals !== undefined && typeof state.totals.uncachedInputTokens === 'number') {
          return {
            uncachedInputTokens: state.totals.uncachedInputTokens,
            outputTokens: Number(state.totals.outputTokens) || 0,
            cacheReadTokens: Number(state.totals.cacheReadTokens) || 0,
            cacheWriteTokens: Number(state.totals.cacheWriteTokens) || 0,
          }
        }
      }
      if (hasMethod(projections, 'snapshot')) {
        const snap = (projections.snapshot as (s: DshSession) => unknown).call(projections, session) as {
          values?: { tokenUsage?: { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
        } | undefined
        const u = snap?.values?.tokenUsage
        if (u !== undefined && typeof u.uncachedInputTokens === 'number') {
          return {
            uncachedInputTokens: u.uncachedInputTokens,
            outputTokens: Number(u.outputTokens) || 0,
            cacheReadTokens: Number(u.cacheReadTokens) || 0,
            cacheWriteTokens: Number(u.cacheWriteTokens) || 0,
          }
        }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** Decode throughput / session stats from durable projections (parity with Web GUI). */
  readSessionStats(session: DshSession): { decodeMs?: number; decodeTokens?: number; tps?: number } | undefined {
    const projections = service<Record<string, unknown>>(this.ctx, 'sessionProjections')
    if (projections === undefined) return undefined
    try {
      let stats: { decodeMs?: number; decodeTokens?: number } | undefined
      if (hasMethod(projections, 'stateOf')) {
        stats = (projections.stateOf as (s: DshSession, key: string) => unknown).call(projections, session, 'sessionStats') as typeof stats
      } else if (hasMethod(projections, 'snapshot')) {
        const snap = (projections.snapshot as (s: DshSession) => unknown).call(projections, session) as {
          values?: { sessionStats?: typeof stats }
        }
        stats = snap?.values?.sessionStats
      }
      if (stats !== undefined && typeof stats.decodeMs === 'number' && typeof stats.decodeTokens === 'number') {
        const tps = stats.decodeMs > 0 ? Math.round(stats.decodeTokens / (stats.decodeMs / 1000)) : undefined
        return { decodeMs: stats.decodeMs, decodeTokens: stats.decodeTokens, tps }
      }
    } catch {
      return undefined
    }
    return undefined
  }

  /** Permission-preset service across ctx-key spellings. */
  private permissionService(): Record<string, unknown> | undefined {
    return service<Record<string, unknown>>(this.ctx, 'permissionPresets')
      ?? service<Record<string, unknown>>(this.ctx, 'permission')
      ?? service<Record<string, unknown>>(this.ctx, 'permissions')
  }

  /** Permission-preset names in declaration order. */
  permissionNames(): string[] {
    const permissions = this.permissionService() as { names?: readonly string[] } | undefined
    return Array.isArray(permissions?.names) ? [...permissions.names] : []
  }

  /** Effective permission preset for one session's log. */
  permissionCurrent(events: readonly SessionEvent[]): string {
    const permissions = this.permissionService()
    if (permissions === undefined || !hasMethod(permissions, 'current')) return ''
    try {
      const name = (permissions.current as (events: readonly SessionEvent[]) => unknown).call(permissions, events)
      return typeof name === 'string' ? name : ''
    } catch {
      return ''
    }
  }

  /** Switch one session's permission preset. */
  permissionSet(session: DshSession, name: string): void {
    const permissions = this.permissionService()
    if (permissions === undefined || !hasMethod(permissions, 'set')) {
      throw new Error('permission presets cannot switch in this composition')
    }
    ;(permissions.set as (session: DshSession, name: string) => void).call(permissions, session, name)
  }

  /**
   * The preset id a session runs under, newest selection winning: the
   * creation header's value, superseded by any `agent-preset/selected`
   * event. Terminal sessions (rosterless composition) resolve undefined.
   * @param session - live session with header and log.
   */
  sessionPreset(session: DshSession): string | undefined {
    let preset = (session.header as { agentPreset?: unknown } | undefined)?.agentPreset
    for (const event of readSessionEvents(session)) {
      if (event.type === 'agent-preset/selected') {
        const next = (event.data as { agentPreset?: unknown }).agentPreset
        if (typeof next === 'string' && next !== '') preset = next
      }
    }
    return typeof preset === 'string' && preset !== '' ? preset : undefined
  }

  /**
   * Fork a live agent's session at its last turn boundary and create the
   * child agent. The caller flushes and disposes the source handle, then
   * adopts the returned one. The agent must be idle (no open turn).
   * @param agent - the exact live agent to fork.
   * @returns the owned child handle.
   */
  async forkAgent(agent: DshAgent): Promise<DshAgentHandle> {
    const events = readSessionEvents(agent.session)
    if (!events.some(e => e.type === 'turn/start')) {
      throw new Error('nothing to fork yet — the session has no turns')
    }
    const boundary = forkBoundary(events)
    if (boundary === undefined) {
      throw new Error('no completed turn to fork at — wait for the turn to finish')
    }
    const agents = service<{
      create(options: Record<string, unknown>): Promise<DshAgentHandle>
    }>(this.ctx, 'agents')
    if (agents === undefined) throw new Error('terminal: ctx.agents is unavailable in this composition')
    const handle = await agents.create({
      sessionId: `session-${randomUUID()}`,
      seed: events.filter(e => e.seq <= boundary),
      meta: { cwd: process.cwd(), parentSession: agent.id, seedLength: boundary + 1 },
      agentOptions: { ...agent.options },
    })
    // Forks inherit the source's workspace, like web's forkWorkspace. The
    // forked session is valid regardless — an attach miss leaves it
    // ungrouped rather than failing the fork.
    try {
      const owner = this.findWorkspaceForSession(agent.id)
      if (owner !== undefined) await this.attachSessionToWorkspace(handle.agent.id, owner.id)
    } catch {
      // Fork stands: unattached, visible, usable.
    }
    return handle
  }

  /** Rename one live session (pins the title; auto-generation stops). */
  renameSession(session: DshSession, title: string): string {
    const titles = service<Record<string, unknown>>(this.ctx, 'sessionTitle')
    if (titles === undefined || !hasMethod(titles, 'rename')) {
      throw new Error('session titles cannot rename in this composition')
    }
    const snapshot = (titles.rename as (session: DshSession, title: string) => { title?: unknown })
      .call(titles, session, title)
    return typeof snapshot?.title === 'string' && snapshot.title !== '' ? snapshot.title : title
  }

  /**
   * The workspace registry, when the composition mounts it: feature-detected
   * structurally so older profiles (no workspace row) degrade to undefined
   * and the sessions browser falls back to cwd grouping.
   */
  private workspaces(): WorkspaceRegistryShape | undefined {
    const registry = service<Record<string, unknown>>(this.ctx, 'workspaceRegistry')
    if (registry === undefined || !hasMethod(registry, 'list')) return undefined
    return registry as unknown as WorkspaceRegistryShape
  }

  /**
   * Workspace listing for the sessions browser: plain records in durable
   * registry order plus the archived set, or undefined when the registry is
   * absent. Malformed rows are skipped, never thrown.
   */
  listWorkspaces(): { workspaces: WorkspaceRecord[]; archivedSessionIds: string[] } | undefined {
    const registry = this.workspaces()
    if (registry === undefined) return undefined
    let rows: WorkspaceEntityShape[]
    try {
      rows = registry.list()
    } catch {
      return undefined
    }
    if (!Array.isArray(rows)) return undefined
    const workspaces: WorkspaceRecord[] = []
    for (const w of rows) {
      if (typeof w !== 'object' || w === null) continue
      if (typeof w.id !== 'string' || w.id === '') continue
      workspaces.push({
        id: w.id,
        path: typeof w.path === 'string' ? w.path : '',
        title: typeof w.title === 'string' && w.title !== '' ? w.title : w.id,
        sessionIds: Array.isArray(w.sessionIds) ? (w.sessionIds as unknown[]).filter((s): s is string => typeof s === 'string') : [],
        createdAt: typeof w.createdAt === 'string' ? w.createdAt : '',
        updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : '',
      })
    }
    const archived = Array.isArray(registry.archivedSessionIds)
      ? (registry.archivedSessionIds as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    return { workspaces, archivedSessionIds: archived }
  }

  /**
   * Resolve (or create) the workspace owning one directory: existing owner
   * first, else a create through `fs.realpath` canonicalization. Returns
   * undefined — never throws for registry absence — so ordinary session
   * creation stays total.
   * @param path - directory in any spelling; must exist.
   */
  async resolveWorkspaceForPath(path: string): Promise<WorkspaceRecord | undefined> {
    const registry = this.workspaces()
    if (registry === undefined) return undefined
    try {
      const existing = await registry.resolveByPath(path)
      const workspace = existing ?? await registry.create(path)
      return {
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessionIds: [...workspace.sessionIds],
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Attach an existing session to a workspace by id. Throws honestly when the
   * registry or workspace is absent (or the attach rejects) — callers decide
   * whether that failure is fatal. Never deletes a session.
   * @param sessionId - live or persisted session to record.
   * @param workspaceId - owning workspace.
   */
  async attachSessionToWorkspace(sessionId: string, workspaceId: string): Promise<void> {
    const registry = this.workspaces()
    if (registry === undefined) throw new Error('terminal: no workspace registry in this composition')
    const workspace = registry.get(workspaceId)
    if (workspace === undefined) throw new Error(`terminal: workspace "${workspaceId}" not found`)
    await workspace.attachSession(sessionId)
  }

  /**
   * Find the workspace owning a session: the registry projection's `sessionIds`
   * membership, probed synchronously so the browser can call it per row.
   * Returns undefined when absent or unowned (older compositions, Ungrouped).
   * @param sessionId - session whose owner to find.
   */
  findWorkspaceForSession(sessionId: string): WorkspaceRecord | undefined {
    const listed = this.listWorkspaces()
    return listed?.workspaces.find(w => w.sessionIds.includes(sessionId))
  }

  /**
   * Selectable efforts for one model: adapter-resolved, else the static
   * DeepSeek vocabulary fallback.
   */
  async effortOptions(provider: string, model: string): Promise<{ id: string; name: string; description: string }[]> {
    const fallback = ['off', 'low', 'high', 'max'].map(level => ({ id: level, name: level, description: '' }))
    if (provider === '' || model === '') return fallback
    const resolved = await this.resolveModel(provider, model)
    return resolved !== undefined && resolved.efforts.length > 0 ? resolved.efforts : fallback
  }

  /** Effective reasoning effort: override, live header, default, or ''. */
  currentEffort(agent: DshAgent | undefined, override?: string): string {
    if (override !== undefined && override !== '') return override
    const header = agent?.session.requestHeader?.()?.config?.reasoningEffort
    if (typeof header === 'string' && header !== '') return header
    const fallback = this.currentModel().reasoningEffort
    return typeof fallback === 'string' ? fallback : ''
  }

  /** Live agents in registration order. */
  listAgents(): { id: string; status: string }[] {
    const agents = service<Record<string, unknown>>(this.ctx, 'agents')
    if (agents === undefined || !hasMethod(agents, 'list')) return []
    try {
      const list = agents.list as (this: Record<string, unknown>) => { id?: unknown; status?: unknown }[]
      const rows = list.call(agents)
      if (!Array.isArray(rows)) return []
      return rows
        .filter(r => typeof r?.id === 'string')
        .map(r => ({ id: r.id as string, status: typeof r.status === 'string' ? r.status : 'unknown' }))
    } catch {
      return []
    }
  }

  /** Skill catalog summaries. */
  async listSkills(): Promise<{ name: string; description: string }[]> {
    const skills = service<Record<string, unknown>>(this.ctx, 'skills')
    if (skills === undefined || !hasMethod(skills, 'list')) return []
    try {
      const rows = await (skills.list as () => Promise<{ name?: unknown; description?: unknown }[]>).call(skills)
      if (!Array.isArray(rows)) return []
      return rows
        .filter(r => typeof r?.name === 'string' && r.name !== '')
        .map(r => ({ name: r.name as string, description: typeof r.description === 'string' ? r.description : '' }))
    } catch {
      return []
    }
  }

  /** Persistent terminal sessions owned by one agent. */
  listTerminals(agent: DshAgent | undefined): { id: string; status: string; label: string }[] {
    const terminals = service<Record<string, unknown>>(this.ctx, 'terminals')
    if (terminals === undefined || agent === undefined || !hasMethod(terminals, 'list')) return []
    try {
      const rows = (terminals.list as (owner: DshAgent) => Record<string, unknown>[]).call(terminals, agent)
      if (!Array.isArray(rows)) return []
      return rows.map((r, i) => {
        const id = [r.id, r.sessionId, r.name].find(v => typeof v === 'string' && v !== '')
        const status = [r.status, r.state].find(v => typeof v === 'string' && v !== '')
        const label = [r.label, r.title, r.command].find(v => typeof v === 'string' && v !== '')
        return {
          id: typeof id === 'string' ? id : `terminal-${String(i)}`,
          status: typeof status === 'string' ? status : 'unknown',
          label: typeof label === 'string' ? label : '',
        }
      })
    } catch {
      return []
    }
  }
}

/**
 * Canonical English copy for shipped presets, matching `@deepseek-ai/dsh-client-ui-agent-preset`.
 * Raw disk metadata in DSH defaults to Chinese; this lookup aligns the terminal TUI with Web DSH.
 */
export const BUILT_IN_PRESET_COPY: Record<string, { name: string; description: string }> = {
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
}

/**
 * Resolve display copy for an agent preset. Shipped / system presets use
 * Web DSH's English copy; user-authored presets keep their authored metadata.
 */
export function presetDisplayText(preset: { id: string; name?: string; description?: string; trust?: 'system' | 'user' }): {
  name: string
  description?: string
} {
  const builtin = preset.trust === 'system' || preset.trust === undefined
    ? BUILT_IN_PRESET_COPY[preset.id]
    : undefined
  if (builtin !== undefined) return builtin
  return {
    name: (preset.name ?? '') !== '' ? preset.name! : preset.id,
    ...(preset.description !== undefined && preset.description !== '' ? { description: preset.description } : {}),
  }
}


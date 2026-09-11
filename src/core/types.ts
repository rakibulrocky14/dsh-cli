/**
 * Structural DSH types used by the terminal surface.
 *
 * The surface loads zero `@deepseek-ai/*` runtime modules: every value below
 * describes a shape received through the Cordis context, so the code runs
 * against any installed dsh whose services match these fields. Members that
 * differ between releases are optional and probed at runtime.
 *
 * @module dsh-terminal/core/types
 */

/** Opaque Cordis plugin context (structural subset). */
export interface DshContext {
  get(name: string): unknown
  on(event: string, listener: (...args: never[]) => unknown, options?: unknown): () => void
  effect(fn: () => unknown): void
  provide(name: string, value: unknown): void
  [key: string]: unknown
}

/** Session identity (branded upstream, plain string here). */
export type SessionId = string

/** One durable session-log envelope. */
export interface SessionEvent {
  seq: number
  time: number
  type: string
  data: Record<string, unknown>
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

/** Live session handle (structural subset of dsh-session's Session). */
export interface DshSession {
  readonly id: SessionId
  /** Log length; the next event's seq. */
  readonly seq: number
  /** Immutable log snapshot (preferred history read). */
  readonly events?: readonly SessionEvent[]
  /** Legacy indexed read (newer releases). */
  eventAt?(seq: number): SessionEvent | undefined
  /** Creation metadata. */
  readonly header?: {
    readonly id: SessionId
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
  }
  /** Folded request header for the next call, when any request ran. */
  requestHeader?(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
}

/** Durable-session metadata for the session browser. */
export interface SessionHeaderInfo {
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
}

/** Live agent handle (structural subset of dsh-agent's Agent). */
export interface DshAgent {
  readonly id: SessionId
  readonly options: { provider?: string; model?: string; maxTokens?: number }
  readonly session: DshSession
  readonly status: 'idle' | 'running'
  readonly ctx: DshContext
  cancel(cause: string, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  followup(message: unknown): void
  steer(message: unknown): void
}

/** Owned agent plus its teardown capability. */
export interface DshAgentHandle {
  agent: DshAgent
  dispose(): Promise<void>
}

/** Provider/model (and effort) selection for one agent or the default. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Mutable selection consumed by the request waterfall (mirrors upstream). */
export interface ModelSelectionRef {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

/** One provider-neutral stream chunk (dsh-llm StreamChunk subset). */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'finish'; reason: { kind: string } }

/** Model-facing content block (subset). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: unknown }
  | { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError: boolean }
  | { type: string; [key: string]: unknown }

/** One model-facing tool schema (subset). */
export interface ToolSchemaInfo {
  readonly name: string
  readonly description?: string
}

/** One human command descriptor (subset). */
export interface CommandDescriptorInfo {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string; readonly placeholder?: string; [key: string]: unknown }
}

/** Settled human-command outcome. */
export type CommandResultInfo =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** One user-question option / item / answer (mirrors dsh-user-questions). */
export interface AskOption {
  label: string
  description?: string
}
export interface AskItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskOption[]
  multiSelect?: boolean
}
export interface AskAnswerItem {
  id: string
  selected: string[]
  custom?: string
}
export interface AskAnswer {
  answers: AskAnswerItem[]
}

/** Approval decision vocabulary (closed upstream). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One approval request (subset). */
export interface ApprovalRequest {
  readonly agent: { readonly id: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** One settings-namespace descriptor (subset). */
export interface SettingsDescriptorInfo {
  readonly ns: string
  readonly revision?: number
  readonly user?: Record<string, unknown>
  readonly base?: Record<string, unknown>
  readonly resolved?: unknown
}

/** One agent preset row (subset). */
export interface AgentPresetInfo {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

/** One background-job snapshot (subset). */
export interface JobSnapshotInfo {
  readonly id: string
  readonly label?: string
  readonly status?: string
  readonly detail?: string
}

/** One provider route (subset). */
export interface ProviderInfo {
  readonly id: string
  readonly name: string
}

/** Read a service through the context, tolerating absence. */
export function service<T>(ctx: DshContext, name: string): T | undefined {
  try {
    const value = ctx.get(name)
    return (value === undefined || value === null ? undefined : value) as T | undefined
  } catch {
    return undefined
  }
}

/** True when `value` is an object with a callable `method`. */
export function hasMethod(value: unknown, method: string): value is Record<string, (...args: never[]) => unknown> {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>)[method] === 'function'
}

/** Read the durable log across releases (events snapshot, else indexed read). */
export function readSessionEvents(session: DshSession): readonly SessionEvent[] {
  if (Array.isArray(session.events)) return session.events
  if (typeof session.eventAt === 'function') {
    const out: SessionEvent[] = []
    const length = session.seq
    for (let seq = 0; seq < length; seq++) {
      const event = session.eventAt(seq)
      if (event !== undefined) out.push(event)
    }
    return out
  }
  return []
}

/**
 * Full-screen TUI engine: owns the agent lifecycle, transcript feed, views,
 * modals, composer, and key handling behind a versioned snapshot. React is a
 * thin renderer over this state, so every behavior here is drivable from
 * plain Node (and covered by smoke tests) without a TTY.
 *
 * @module dsh-terminal/tui/engine
 */

import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { BUILTINS, normalizeEffort, parseModelSelection, shortSession } from '../core/commands.js'
import { Dsh, attachLiveStream, dshHome, installModelOverride, listProfilePlugins, sendFollowup, sendSteer, type SessionListRecord, type StartupValues } from '../core/dsh.js'
import { LiveFeed, foldTodos, foldUsage } from '../core/transcript.js'
import { readSessionEvents, type AskItem, type DshAgent, type DshAgentHandle, type DshContext, type ModelSelection, type ModelSelectionRef } from '../core/types.js'

/** Panel views; settings drills into one namespace. */
export type View = { name: 'chat' }
  | { name: 'sessions' } | { name: 'model'; provider?: string } | { name: 'effort' } | { name: 'tools' } | { name: 'commands' }
  | { name: 'skills' } | { name: 'agents' } | { name: 'terminals' } | { name: 'todos' } | { name: 'usage' }
  | { name: 'presets' } | { name: 'plugins' } | { name: 'settings'; ns?: string }
  | { name: 'permissions' } | { name: 'jobs' } | { name: 'doctor' } | { name: 'help' }

/** One selectable panel row. */
export interface Row {
  id: string
  primary: string
  secondary?: string
  badge?: string
}

/** Single-line edit state (composer, text modal, custom answers). */
export interface Field {
  value: string
  cursor: number
}

export function emptyField(value = ''): Field {
  return { value, cursor: value.length }
}

/** Modal dialogs; resolvers settle the underlying DSH promise. */
export type Modal =
  | { kind: 'approval'; toolName: string; reason: string; args: string; resolve: (outcome: 'allowed-once' | 'rejected') => void }
  | {
    kind: 'questions'
    items: AskItem[]
    index: number
    selected: string[][]
    customs: string[]
    optIndex: number
    custom: Field
    editingCustom: boolean
    resolve: (answers: { id: string; selected: string[]; custom?: string }[]) => void
  }
  | { kind: 'text'; title: string; hint: string; field: Field; resolve: (value: string | undefined) => void }

/** Braille frames for in-progress indicators (boot, running turn, loading). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Resolve one frame index to a spinner glyph. */
export function spinnerGlyph(frame: number): string {
  return SPINNER_FRAMES[((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length] ?? '⠋'
}

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'ok' | 'warn' | 'error'
}

/** Key event subset (mirrors Ink's useInput key). */
export interface TuiKey {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
  home?: boolean
  end?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  f1?: boolean
}

function age(createdAt: number | undefined): string {
  if (createdAt === undefined || createdAt <= 0) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)}h`
  return `${String(Math.floor(hours / 24))}d`
}

/** Apply one key to a single-line field. Returns 'submit' on Enter. */
export function editField(field: Field, input: string, key: TuiKey): 'submit' | 'continue' {
  if (key.return === true) return 'submit'
  // Terminals may bundle bytes: a newline inside the input chunk submits
  // (text before it lands in the field). Never let a bundled Enter vanish.
  if (input !== '' && key.ctrl !== true && key.meta !== true && key.escape !== true
    && key.upArrow !== true && key.downArrow !== true && key.tab !== true) {
    const cut = input.search(/[\r\n]/u)
    if (cut >= 0) {
      const before = [...input.slice(0, cut)].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
      field.value = field.value.slice(0, field.cursor) + before + field.value.slice(field.cursor)
      field.cursor += before.length
      return 'submit'
    }
  }
  if (key.leftArrow === true) {
    field.cursor = Math.max(0, field.cursor - 1)
    return 'continue'
  }
  if (key.rightArrow === true) {
    field.cursor = Math.min(field.value.length, field.cursor + 1)
    return 'continue'
  }
  if (key.home === true || (key.ctrl === true && input === 'a')) {
    field.cursor = 0
    return 'continue'
  }
  if (key.end === true || (key.ctrl === true && input === 'e')) {
    field.cursor = field.value.length
    return 'continue'
  }
  if (key.backspace === true || (key.ctrl === true && input === 'h')) {
    if (field.cursor > 0) {
      field.value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor)
      field.cursor--
    }
    return 'continue'
  }
  if (key.delete === true) {
    field.value = field.value.slice(0, field.cursor) + field.value.slice(field.cursor + 1)
    return 'continue'
  }
  if (key.ctrl === true && input === 'u') {
    field.value = field.value.slice(field.cursor)
    field.cursor = 0
    return 'continue'
  }
  if (key.ctrl === true && input === 'k') {
    field.value = field.value.slice(0, field.cursor)
    return 'continue'
  }
  if (key.ctrl === true && input === 'w') {
    const left = field.value.slice(0, field.cursor).replace(/[^\s]*\s*$/u, '')
    field.value = left + field.value.slice(field.cursor)
    field.cursor = left.length
    return 'continue'
  }
  if (key.ctrl === true || key.meta === true || key.escape === true || key.tab === true) return 'continue'
  if (input === '') return 'continue'
  // Filter control characters; keep printable runs (paste-safe).
  const clean = [...input].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
  if (clean === '') return 'continue'
  field.value = field.value.slice(0, field.cursor) + clean + field.value.slice(field.cursor)
  field.cursor += clean.length
  return 'continue'
}

/** TUI engine: DSH lifecycle plus all interaction state. */
export class Engine {
  readonly dsh: Dsh
  readonly feed = new LiveFeed()
  private readonly exitFn: (code: number) => void
  private listeners = new Set<() => void>()
  private toastSeq = 0
  private modalSeq = 0

  version = 0
  status: 'booting' | 'ready' | 'error' = 'booting'
  bootError = ''
  quitting = false
  cleared = false
  /** Monotonic spinner frame; advances only while something is in flight. */
  spinnerFrame = 0
  /**
   * Bumped on every full-repaint request (terminal resize). The renderer
   * keys the static region with it: Ink's `<Static>` never re-flushes items
   * it already wrote, so without a remount a resize-clear would erase the
   * whole transcript history and never bring it back.
   */
  repaintSeq = 0
  /**
   * Optional wipe run immediately before the remount. The TUI host writes
   * CSI erase-screen (and erase-scrollback on resize) so a Static remount
   * cannot stack a second copy of the banner on leftover wrapped rows.
   * Tests leave this unset.
   */
  onFullRepaint: ((wipeScrollback: boolean) => void) | undefined = undefined
  private runningFlag = false
  private runStartValue: number | undefined = undefined
  private spinnerTimer: ReturnType<typeof setInterval> | undefined

  /** A running turn drives the spinner and the elapsed-seconds chrome. */
  get running(): boolean {
    return this.runningFlag
  }

  set running(value: boolean) {
    this.runningFlag = value
    if (!value) this.runStartValue = undefined
  }

  view: View = { name: 'chat' }
  rows: Row[] = []
  rowsLoading = false
  rowsHint = ''
  rowIndex = 0

  modals: Modal[] = []
  toasts: Toast[] = []

  composer: Field = emptyField()
  history: string[] = []
  private historyIndex = -1
  private draft = ''
  paletteIndex = 0
  private paletteDismissed = ''

  ctxTokens: number | undefined = undefined
  /** Resolved context window of the current model (drives the ctx % meter). */
  ctxWindow: number | undefined = undefined
  /** One-line label of the most recent persisted session (welcome banner). */
  recentActivity: string | undefined = undefined
  /** Tool outputs expand by default when true (ctrl+o toggles + repaints). */
  toolsExpanded = false
  /** Cached session names ('' = known untitled); filled in the background. */
  private readonly titleCache = new Map<string, string>()
  mode = ''
  preset = ''

  private owned: DshAgentHandle | undefined
  private detachStream: (() => void) | undefined
  private detachModel: (() => void) | undefined
  private readonly modelRef: ModelSelectionRef = { current: undefined, assembled: undefined }
  private ctxWindowKey = ''
  private pluginCommands: { name: string; desc: string }[] = []
  private readonly historyFile: string

  constructor(ctx: DshContext, exitFn: (code: number) => void) {
    this.dsh = new Dsh(ctx)
    this.exitFn = exitFn
    this.historyFile = join(dshHome(), 'terminal-history')
    try {
      this.history = readFileSync(this.historyFile, 'utf8').split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-500)
    } catch {
      this.history = []
    }
    this.feed.subscribe(() => { this.emit() })
  }

  get agent(): DshAgent | undefined {
    return this.owned?.agent
  }

  get modal(): Modal | undefined {
    return this.modals[0]
  }

  get selection(): ModelSelection {
    return this.modelRef.current ?? this.dsh.currentModel()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getVersion = (): number => this.version

  /** Elapsed whole seconds of the running turn (0 when idle). */
  runSeconds(): number {
    return this.runStartValue === undefined ? 0 : Math.max(0, Math.floor((Date.now() - this.runStartValue) / 1000))
  }

  /**
   * Keep the spinner interval alive exactly while something is in flight
   * (boot, panel load, running turn). Called from emit() so every state
   * change re-arms it; the tick itself re-emits through the same path.
   */
  private ensureSpinner(): void {
    const want = this.status === 'booting' || this.rowsLoading || (this.running && !this.quitting)
    if (want && this.spinnerTimer === undefined) {
      const timer = setInterval(() => {
        this.spinnerFrame++
        this.emit()
      }, 110)
      timer.unref?.()
      this.spinnerTimer = timer
    } else if (!want && this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = undefined
    }
  }

  emit(): void {
    this.ensureSpinner()
    this.version++
    for (const listener of this.listeners) listener()
  }

  /**
   * Force a full frame repaint: the host wipes the screen, and the static
   * region remounts and re-flushes every committed block at the new width.
   * Used by the resize resync (`wipeScrollback`) and the ctrl+o expand toggle.
   */
  requestRepaint(wipeScrollback = false): void {
    this.repaintSeq++
    this.onFullRepaint?.(wipeScrollback)
    this.emit()
  }

  /** Best-effort one-liner about the most recent persisted session. */
  private async loadRecentActivity(): Promise<void> {
    try {
      const rows = await this.dsh.listPersistedSessions()
      const first = rows[0]
      if (first === undefined) return
      const cwd = first.cwd ?? ''
      const base = cwd === '' ? '' : cwd.slice(cwd.lastIndexOf('/') + 1)
      this.recentActivity = `${age(first.createdAt)}${base === '' ? '' : ` · ${base}`}`
      this.emit()
    } catch {
      // Banner simply shows "no recent activity".
    }
  }

  /** Flip the tool-output expansion and repaint the whole frame. */
  toggleToolsExpanded(): void {
    this.toolsExpanded = !this.toolsExpanded
    this.toast(this.toolsExpanded ? 'tool output expanded' : 'tool output collapsed', 'info', 2000)
    this.requestRepaint()
  }

  toast(text: string, tone: Toast['tone'] = 'info', ms = 4500): void {
    const id = ++this.toastSeq
    this.toasts.push({ id, text, tone })
    if (this.toasts.length > 4) this.toasts = this.toasts.slice(-4)
    const timer = setTimeout(() => {
      this.toasts = this.toasts.filter(t => t.id !== id)
      this.emit()
    }, ms)
    timer.unref?.()
    this.emit()
  }

  private saveHistory(): void {
    try {
      mkdirSync(dshHome(), { recursive: true })
      writeFileSync(this.historyFile, `${this.history.slice(-500).join('\n')}\n`)
    } catch {
      // Best-effort.
    }
  }

  private commitHistory(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    if (this.history[this.history.length - 1] !== line) this.history.push(line)
    if (this.history.length > 500) this.history = this.history.slice(-500)
    this.saveHistory()
  }

  /** Boot: settle the tree, open the agent, wire surface handlers. */
  async boot(startup: StartupValues): Promise<void> {
    try {
      await this.dsh.awaitReady()
      void this.loadRecentActivity()
      await this.reopen(startup)
      this.dsh.onApproval(
        (request) => this.askApproval(request.toolName, request.reason ?? '', request.callId),
        (candidate) => candidate.id === this.agent?.id,
      )
      this.dsh.registerQuestions(
        (questions) => this.askQuestions(questions),
        (candidate) => candidate !== undefined && candidate.id === this.agent?.id,
      )
      this.status = 'ready'
    } catch (error) {
      this.status = 'error'
      this.bootError = error instanceof Error ? error.message : String(error)
    }
    this.emit()
  }

  /** (Re)open the agent and rewire stream + model listeners. */
  async reopen(startup: StartupValues): Promise<void> {
    this.detachStream?.()
    this.detachStream = undefined
    this.detachModel?.()
    this.detachModel = undefined
    if (this.owned !== undefined) await this.owned.dispose()
    this.owned = await this.dsh.openAgent(startup, this.preset === '' ? undefined : this.preset)
    await this.adopt(this.owned)
  }

  /** Wire stream + model listeners around an adopted handle. */
  private async adopt(handle: DshAgentHandle): Promise<void> {
    this.owned = handle
    const agent = handle.agent
    await agent.whenIdle()
    this.detachModel = installModelOverride(agent.ctx, agent, this.modelRef)
    this.feed.reset()
    this.feed.notifyCommitted(readSessionEvents(agent.session))
    this.detachStream = attachLiveStream(this.dsh.ctx, agent, this.feed, () => {
      this.feed.notifyCommitted(readSessionEvents(agent.session))
      this.emit()
    })
    this.pluginCommands = this.dsh.listCommands(agent).map(c => ({ name: c.name, desc: c.description }))
    this.refreshStatus()
    void this.refreshCtxWindow()
    const preset = this.dsh.sessionPreset(agent.session)
    if (preset !== undefined) {
      this.toast(`note: this session runs preset "${preset}" on web; the terminal composes the base tool set`, 'warn', 8000)
    }
    this.emit()
  }

  /** Refresh cached status-bar readings (context pressure, mode). */
  private refreshStatus(): void {
    const agent = this.agent
    if (agent === undefined) {
      this.ctxTokens = undefined
      this.mode = ''
      return
    }
    this.ctxTokens = this.dsh.measureTokens(agent.session)?.totalTokens
    this.mode = this.dsh.permissionCurrent(readSessionEvents(agent.session))
  }

  /**
   * Resolve the current model's context window for the ctx % meter. Cached
   * per provider/model; a failed or unresolvable lookup keeps the meter off.
   */
  private async refreshCtxWindow(): Promise<void> {
    const selection = this.selection
    const key = `${selection.provider}/${selection.model}`
    if (key === this.ctxWindowKey) return
    this.ctxWindowKey = key
    this.ctxWindow = undefined
    const info = await this.dsh.resolveModel(selection.provider, selection.model).catch(() => undefined)
    if (this.ctxWindowKey !== key || this.quitting) return
    this.ctxWindow = info?.contextWindow
    this.emit()
  }

  /** Effective reasoning effort for the status line. */
  effectiveEffort(): string {
    return this.dsh.currentEffort(this.agent, this.modelRef.current?.reasoningEffort)
  }

  /** Selectable efforts for the current model (resolved, static fallback). */
  async effortOptions(): Promise<{ id: string; name: string; description: string }[]> {
    const selection = this.selection
    return this.dsh.effortOptions(selection.provider, selection.model)
  }

  /** Switch the session model, keeping effort on the same provider. */
  private switchModel(provider: string, model: string): void {
    const current = this.modelRef.current
    const effort = current !== undefined && current.provider === provider ? current.reasoningEffort : undefined
    this.modelRef.current = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    void this.refreshCtxWindow()
    this.toast(
      `model → ${provider}/${model}${effort === undefined ? '' : ` · effort ${effort}`}`,
      'ok',
    )
    this.view = { name: 'chat' }
    this.emit()
  }

  /** Submit the composer line. */
  submitComposer(): void {
    const line = this.composer.value
    const trimmed = line.trim()
    if (trimmed === '') return
    this.commitHistory(line)
    this.historyIndex = -1
    this.draft = ''
    this.composer = emptyField()
    this.paletteIndex = 0
    this.paletteDismissed = ''
    if (trimmed.startsWith('/')) {
      // Slash input never commits a log event — echo it so the transcript
      // shows what was asked (Claude-Code-style input bar).
      this.feed.pushEcho(trimmed)
      void this.submitSlash(trimmed)
      return
    }
    const agent = this.agent
    if (agent === undefined) {
      this.toast('no agent is open — try /new or restart', 'error')
      this.emit()
      return
    }
    if (this.running) {
      sendSteer(agent, trimmed)
      this.toast('steering sent', 'info', 2000)
      this.emit()
      return
    }
    this.running = true
    this.runStartValue = Date.now()
    const current = agent
    sendFollowup(current, trimmed)
    void current.whenIdle().then(() => {
      if (this.agent !== current || this.quitting) return
      this.running = false
      this.refreshStatus()
      this.emit()
    })
    this.emit()
  }

  /** Palette entries for the current composer value. */
  paletteEntries(): { name: string; desc: string; plugin: boolean }[] {
    const value = this.composer.value
    if (!value.startsWith('/') || value.includes(' ')) return []
    if (this.paletteDismissed === value) return []
    const query = value.slice(1).toLowerCase()
    const builtins = BUILTINS.filter(b => b.name.startsWith(query)).map(b => ({ ...b, plugin: false }))
    const plugins = this.pluginCommands.filter(c => c.name.startsWith(query)).map(c => ({ name: c.name, desc: c.desc, plugin: true }))
    return [...builtins, ...plugins].slice(0, 12)
  }

  /** Dispatch one slash line (views, actions, or plugin commands). */
  async submitSlash(line: string): Promise<void> {
    const agent = this.agent
    const parts = line.slice(1).trim().split(/\s+/u)
    const cmd = parts[0] ?? ''
    const rest = parts.slice(1).join(' ')
    switch (cmd) {
      case 'help':
      case '?':
        this.openView({ name: 'help' })
        return
      case 'quit':
      case 'exit':
      case 'q':
        void this.quit()
        return
      case 'clear':
        this.cleared = true
        this.emit()
        return
      case 'new': {
        if (agent === undefined) return
        agent.cancel('user')
        await agent.whenIdle()
        this.running = false
        this.cleared = false
        await this.reopen({ resume: '', model: '', provider: '', print: '' })
        this.toast(`new session ${this.agent?.id ?? ''}`, 'ok')
        return
      }
      case 'sessions':
        this.openView({ name: 'sessions' })
        return
      case 'resume': {
        if (rest === '') {
          this.openView({ name: 'sessions' })
          return
        }
        const id = await this.resolveSessionPrefix(rest)
        if (id === undefined) return
        agent?.cancel('user')
        if (agent !== undefined) await agent.whenIdle()
        this.running = false
        this.cleared = false
        await this.reopen({ resume: id, model: '', provider: '', print: '' })
        this.view = { name: 'chat' }
        this.toast(`resumed ${id}`, 'ok')
        return
      }
      case 'fork': {
        if (agent === undefined) return
        agent.cancel('user')
        await agent.whenIdle()
        this.running = false
        try {
          await this.dsh.flush(agent.session)
          const child = await this.dsh.forkAgent(agent)
          this.detachStream?.()
          this.detachStream = undefined
          this.detachModel?.()
          this.detachModel = undefined
          if (this.owned !== undefined) await this.owned.dispose()
          this.cleared = false
          await this.adopt(child)
          this.view = { name: 'chat' }
          this.toast(`forked → ${child.agent.id}`, 'ok')
        } catch (error) {
          this.toast(error instanceof Error ? error.message : String(error), 'warn')
        }
        return
      }
      case 'stop': {
        if (agent === undefined || !this.running) {
          this.toast('no turn is running', 'info', 2000)
          return
        }
        agent.cancel('user')
        this.toast('cancelling turn…', 'warn', 2000)
        return
      }
      case 'title': {
        if (agent === undefined) return
        if (rest === '') {
          this.toast('usage: /title <text>', 'warn')
          return
        }
        try {
          const title = this.dsh.renameSession(agent.session, rest)
          this.toast(`renamed → ${title}`, 'ok')
        } catch (error) {
          this.toast(error instanceof Error ? error.message : String(error), 'error')
        }
        return
      }
      case 'effort': {
        if (rest === '') {
          this.openView({ name: 'effort' })
          return
        }
        try {
          const options = await this.effortOptions()
          const parsed = normalizeEffort(rest, options.map(o => o.id))
          if (parsed === undefined) {
            this.openView({ name: 'effort' })
            return
          }
          this.applyEffort(parsed)
        } catch (error) {
          this.toast(error instanceof Error ? error.message : String(error), 'warn')
        }
        return
      }
      case 'model':
      case 'tools':
      case 'commands':
      case 'skills':
      case 'agents':
      case 'terminals':
      case 'todos':
      case 'usage':
      case 'presets':
      case 'plugins':
      case 'settings':
      case 'permissions':
      case 'jobs':
      case 'doctor':
        this.openView({ name: cmd })
        return
      default: {
        if (agent === undefined) {
          this.toast(`unknown command /${cmd}`, 'warn')
          return
        }
        try {
          const outcome = await this.dsh.executeCommand(agent, line, AbortSignal.timeout(120000))
          if (outcome === undefined) this.toast(`unknown command /${cmd} — try /help`, 'warn')
          else if (outcome.kind === 'error') this.toast(`/${cmd} failed: ${outcome.text}`, 'error')
          else if (outcome.text !== undefined && outcome.text !== '') this.toast(outcome.text.slice(0, 300), 'ok', 8000)
          else this.toast(`/${cmd} done`, 'ok')
        } catch (error) {
          this.toast(`/${cmd} failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
        return
      }
    }
  }

  /** Open a panel view and load its rows. */
  openView(view: View): void {
    this.view = view
    this.rowIndex = 0
    this.rows = []
    this.rowsHint = ''
    if (view.name === 'chat') {
      this.emit()
      return
    }
    const key = JSON.stringify(view)
    this.rowsLoading = true
    this.emit()
    void this.loadView(view).then(
      () => {
        if (JSON.stringify(this.view) === key) {
          this.rowsLoading = false
          this.emit()
        }
      },
      (error: unknown) => {
        if (JSON.stringify(this.view) === key) {
          this.rowsLoading = false
          this.rowsHint = error instanceof Error ? error.message : String(error)
          this.emit()
        }
      },
    )
  }

  private async loadView(view: View): Promise<void> {
    const agent = this.agent
    switch (view.name) {
      case 'chat':
        return
      case 'sessions': {
        const records = await this.sessionRecords()
        this.rows = this.buildSessionRows(records).slice(0, 60)
        this.rowsHint = `${String(records.length)} sessions · enter resumes · esc back`
        void this.fillSessionTitles(records)
        return
      }
      case 'model': {
        if (view.provider !== undefined) {
          const provider = view.provider
          const models = await this.dsh.listModels(provider)
          const current = this.selection
          this.rows = [
            ...models.map(m => ({
              id: m.id,
              primary: m.id,
              secondary: m.name === m.id ? m.description.slice(0, 100) : m.name,
              badge: current.provider === provider && current.model === m.id ? 'active' : undefined,
            })),
            { id: '__type', primary: 'type an id…', secondary: `unlisted ids may still route on ${provider}` },
          ]
          this.rowsHint = models.length === 0
            ? `no advertised models on ${provider} · type one · esc back`
            : 'enter switches (session only, next step) · esc back'
          return
        }
        const current = this.selection
        const providers = this.dsh.listProviders()
        this.rows = [
          { id: '__current', primary: `session: ${current.provider}/${current.model}`, badge: this.modelRef.current === undefined ? 'default' : 'override' },
          ...providers.map(p => ({ id: `provider:${p.id}`, primary: p.id, secondary: p.name })),
          { id: '__custom', primary: 'custom…', secondary: 'type provider/model' },
        ]
        this.rowsHint = 'enter lists a provider\u2019s models · esc back'
        return
      }
      case 'effort': {
        const current = this.effectiveEffort()
        const options = await this.effortOptions()
        this.rows = [
          { id: '__auto', primary: 'auto', secondary: 'provider default', badge: current === '' ? 'active' : undefined },
          ...options.map(o => ({
            id: o.id,
            primary: o.name === o.id ? o.id : `${o.id} — ${o.name}`,
            secondary: o.description.slice(0, 100),
            badge: o.id === current ? 'active' : undefined,
          })),
        ]
        this.rowsHint = 'enter sets effort · esc back'
        return
      }
      case 'skills': {
        const skills = await this.dsh.listSkills()
        this.rows = skills.map(s => ({ id: s.name, primary: s.name, secondary: s.description.slice(0, 120) }))
        this.rowsHint = this.rows.length === 0 ? 'no skills discovered · esc back' : `${String(this.rows.length)} skills · esc back`
        return
      }
      case 'agents': {
        const mine = this.agent?.id
        this.rows = this.dsh.listAgents().map(a => ({
          id: a.id,
          primary: a.id,
          badge: a.id === mine ? 'this surface' : a.status,
        }))
        this.rowsHint = this.rows.length === 0 ? 'no live agents · esc back' : 'esc back'
        return
      }
      case 'terminals': {
        this.rows = this.dsh.listTerminals(agent ?? undefined).map(t => ({
          id: t.id,
          primary: t.id,
          secondary: t.label,
          badge: t.status,
        }))
        this.rowsHint = this.rows.length === 0 ? 'no persistent terminals · esc back' : 'esc back'
        return
      }
      case 'todos': {
        const todos = agent === undefined ? undefined : foldTodos(readSessionEvents(agent.session))
        this.rows = (todos ?? []).map((todo, i) => ({
          id: String(i),
          primary: todo.text.slice(0, 140),
          badge: todo.status,
        }))
        this.rowsHint = this.rows.length === 0 ? 'no task list in this session · esc back' : 'esc back'
        return
      }
      case 'usage': {
        if (agent === undefined) {
          this.rows = []
          return
        }
        const totals = foldUsage(readSessionEvents(agent.session))
        const meter = this.dsh.measureTokens(agent.session)
        this.rows = [
          { id: 'responses', primary: 'responses', secondary: String(totals.responses) },
          { id: 'in', primary: 'input tokens', secondary: String(totals.input) },
          { id: 'out', primary: 'output tokens', secondary: String(totals.output) },
          { id: 'ctx', primary: 'context pressure', secondary: meter === undefined ? '–' : `${String(meter.totalTokens)} tok` },
        ]
        this.rowsHint = 'esc back'
        return
      }
      case 'tools': {
        if (agent === undefined) {
          this.rows = []
          return
        }
        this.rows = this.dsh.listTools(agent)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(t => ({ id: t.name, primary: t.name, secondary: (t.description ?? '').split('\n')[0]?.slice(0, 120) }))
        this.rowsHint = `${String(this.rows.length)} tools · esc back`
        return
      }
      case 'commands': {
        const plugin = agent === undefined ? [] : this.dsh.listCommands(agent)
        this.rows = [
          ...BUILTINS.map(b => ({ id: b.name, primary: `/${b.name}`, secondary: b.desc })),
          ...plugin.map(c => ({ id: c.name, primary: `/${c.name}`, secondary: c.description, badge: 'plugin' })),
        ]
        this.rowsHint = 'enter inserts into composer · esc back'
        return
      }
      case 'presets': {
        const presets = await this.dsh.listPresets()
        this.rows = presets.map(p => ({
          id: p.id,
          primary: p.id,
          secondary: p.description ?? p.name ?? '',
          badge: p.id === this.preset ? 'active' : p.broken === undefined ? undefined : `broken: ${p.broken}`,
        }))
        this.rowsHint = this.rows.length === 0 ? 'no agent presets configured · esc back' : 'enter starts a session with this preset · esc back'
        return
      }
      case 'plugins': {
        const { rows, profile, home } = listProfilePlugins()
        this.rows = rows.map(r => ({ id: r.name, primary: r.name, secondary: r.version, badge: r.source }))
        this.rowsHint = `profile ${profile} · ${home} · add: dsh plugin --profile ${profile} add <pkg> · esc back`
        return
      }
      case 'settings': {
        const descriptors = this.dsh.describeSettings()
        if (view.ns === undefined) {
          this.rows = descriptors.map(d => {
            const keys = d.user === undefined ? 0 : Object.keys(d.user).length
            return { id: d.ns, primary: d.ns, badge: keys === 0 ? 'defaults' : `${String(keys)} user` }
          })
          this.rowsHint = `file: ${this.dsh.settingsPath() ?? '(non-file)'} · enter drills in · esc back`
          return
        }
        const descriptor = descriptors.find(d => d.ns === view.ns)
        const section = (descriptor?.user ?? descriptor?.resolved ?? {}) as Record<string, unknown>
        this.rows = Object.entries(section).map(([k, v]) => ({
          id: k,
          primary: k,
          secondary: JSON.stringify(v)?.slice(0, 160) ?? '',
          badge: descriptor?.user !== undefined && Object.hasOwn(descriptor.user, k) ? 'user' : 'base',
        }))
        this.rowsHint = `${view.ns} · enter edits · esc back`
        return
      }
      case 'permissions': {
        const names = this.dsh.permissionNames()
        const current = agent === undefined ? '' : this.dsh.permissionCurrent(readSessionEvents(agent.session))
        this.rows = names.map(n => ({ id: n, primary: n, badge: n === current ? 'active' : undefined }))
        this.rowsHint = current === '' ? 'esc back' : `current: ${current} · enter switches · esc back`
        return
      }
      case 'jobs': {
        this.rows = this.dsh.listJobs(agent ?? undefined).map(j => ({
          id: j.id,
          primary: j.id,
          secondary: j.label ?? j.detail ?? '',
          badge: j.status,
        }))
        this.rowsHint = this.rows.length === 0 ? 'no background jobs · esc back' : 'esc back'
        return
      }
      case 'doctor': {
        const selection = this.selection
        const present = (value: unknown): string => value === undefined ? 'missing' : 'ok'
        this.rows = [
          { id: 'node', primary: 'node', secondary: process.version },
          { id: 'profile', primary: 'profile', secondary: `${process.env['DSH_PROFILE'] ?? 'terminal'} · ${dshHome()}` },
          { id: 'session', primary: 'session', secondary: this.agent?.id ?? '(none)' },
          { id: 'model', primary: 'model', secondary: `${selection.provider}/${selection.model}` },
          { id: 'services', primary: 'services', secondary: `agents:${present(this.dsh.ctx.get('agents'))} tools:${present(this.dsh.ctx.get('tools'))} commands:${present(this.dsh.ctx.get('commands'))} questions:${present(this.dsh.ctx.get('userQuestions'))} settings:${present(this.dsh.ctx.get('settings'))} presets:${present(this.dsh.ctx.get('agentPresets'))} jobs:${present(this.dsh.ctx.get('jobs'))} meter:${present(this.dsh.ctx.get('tokenMeter'))}` },
        ]
        this.rowsHint = 'esc back'
        return
      }
      case 'help': {
        this.rows = [
          ...BUILTINS.map(b => ({ id: b.name, primary: `/${b.name}`, secondary: b.desc })),
          { id: 'keys', primary: 'keys', secondary: 'enter send · ctrl-c stop/quit · ctrl-d quit · pgup/pgdn scroll · esc back · tab complete' },
        ]
        this.rowsHint = 'enter inserts into composer · esc back'
        return
      }
    }
  }

  /** Live-preferred session corpus, newest first (sessionQuery, else manual merge). */
  private async sessionRecords(): Promise<SessionListRecord[]> {
    const fromQuery = await this.dsh.listSessionRecords()
    if (fromQuery !== undefined) {
      return [...fromQuery].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    }
    const live = this.dsh.listLiveSessions().map(session => ({
      id: session.id,
      createdAt: session.header?.createdAt,
      cwd: session.header?.cwd,
      live: true,
    }))
    const persisted = (await this.dsh.listPersistedSessions()).map(header => ({
      id: header.id,
      createdAt: header.createdAt,
      cwd: header.cwd,
      live: false,
    }))
    const byId = new Map<string, SessionListRecord>()
    for (const record of [...persisted, ...live]) byId.set(record.id, record)
    return [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  /** Best-known name for one session: live log fold, else the cached read. */
  private sessionTitle(record: SessionListRecord): string | undefined {
    if (record.live) {
      const session = this.dsh.listLiveSessions().find(s => s.id === record.id)
      if (session !== undefined) {
        const events = readSessionEvents(session)
        const title = this.dsh.foldTitle(events) ?? this.dsh.firstPrompt(events)
        if (title !== undefined) this.titleCache.set(record.id, title)
        return title
      }
    }
    const cached = this.titleCache.get(record.id)
    return cached !== undefined && cached !== '' ? cached : undefined
  }

  /**
   * Name-first row, web-parity labeling: durable title, else the project
   * basename (what the web shows for untitled sessions), with the short id,
   * age, and project as the detail line.
   */
  private sessionRow(record: SessionListRecord): Row {
    const title = this.sessionTitle(record)
    const dir = record.cwd === undefined ? '' : record.cwd.slice(record.cwd.lastIndexOf('/') + 1)
    const project = dir === '' ? `${shortSession(record.id)} (untitled)` : dir
    return {
      id: record.id,
      primary: title ?? project,
      secondary: `${shortSession(record.id)} · ${age(record.createdAt)}${record.live ? ' · live' : ''}${title === undefined ? '' : ` · ${dir}`}`,
      badge: record.id === this.agent?.id ? 'this' : record.live ? 'live' : undefined,
    }
  }

  private buildSessionRows(records: SessionListRecord[]): Row[] {
    return records.map(record => this.sessionRow(record))
  }

  /**
   * Read persisted-session names in one batched background call (cached
   * across opens, '' = known untitled); rows update once when it lands.
   * Selection follows the session id, never a row index.
   */
  private async fillSessionTitles(records: SessionListRecord[]): Promise<void> {
    const viewKey = JSON.stringify(this.view)
    const pending = records.filter(r => !r.live && !this.titleCache.has(r.id)).slice(0, 60).map(r => r.id)
    if (pending.length === 0) return
    let titles: Map<string, string>
    try {
      titles = await this.dsh.readSessionTitles(pending)
    } catch {
      return
    }
    for (const [id, title] of titles) this.titleCache.set(id, title)
    for (const id of pending) if (!this.titleCache.has(id)) this.titleCache.set(id, '')
    if (JSON.stringify(this.view) !== viewKey || this.quitting) return
    const selected = this.rows[this.rowIndex]?.id
    this.rows = this.buildSessionRows(records).slice(0, 60)
    const next = this.rows.findIndex(r => r.id === selected)
    this.rowIndex = next >= 0 ? next : 0
    this.emit()
  }

  /** Activate the selected panel row. */
  activateRow(): void {
    const row = this.rows[this.rowIndex]
    if (row === undefined || this.rowsLoading) return
    const agent = this.agent
    const view = this.view
    switch (view.name) {
      case 'sessions': {
        void (async () => {
          agent?.cancel('user')
          if (agent !== undefined) await agent.whenIdle()
          this.running = false
          this.cleared = false
          await this.reopen({ resume: row.id, model: '', provider: '', print: '' })
          this.view = { name: 'chat' }
          this.toast(`resumed ${row.id}`, 'ok')
        })()
        return
      }
      case 'effort': {
        if (row.id === '__auto') this.applyEffort({ clear: true })
        else this.applyEffort({ level: row.id })
        return
      }
      case 'model': {
        if (view.provider !== undefined) {
          const provider = view.provider
          if (row.id === '__type') {
            this.openTextModal('model', `model id on provider ${provider}`, '', (value) => {
              if (value !== undefined && value.trim() !== '') this.switchModel(provider, value.trim())
            })
            return
          }
          this.switchModel(provider, row.id)
          return
        }
        if (row.id === '__current') return
        if (row.id === '__custom') {
          this.openTextModal('model', 'provider/model, e.g. deepseek/deepseek-chat', `${this.selection.provider}/${this.selection.model}`, (value) => {
            if (value !== undefined) this.applyModelText(value)
          })
          return
        }
        this.openView({ name: 'model', provider: row.id.slice('provider:'.length) })
        return
      }
      case 'commands':
      case 'help': {
        if (row.id === 'keys') return
        this.view = { name: 'chat' }
        this.composer = { value: `/${row.id} `, cursor: row.id.length + 2 }
        this.emit()
        return
      }
      case 'presets': {
        void (async () => {
          agent?.cancel('user')
          if (agent !== undefined) await agent.whenIdle()
          this.running = false
          this.preset = row.id
          this.cleared = false
          await this.reopen({ resume: '', model: '', provider: '', print: '' })
          this.view = { name: 'chat' }
          this.toast(`session composed with preset "${row.id}"`, 'ok')
        })()
        return
      }
      case 'settings': {
        if (view.ns === undefined) {
          this.openView({ name: 'settings', ns: row.id })
          return
        }
        const ns = view.ns
        const key = row.id
        this.openTextModal(`${ns}.${key}`, 'JSON value (strings may be bare)', row.secondary ?? '', (value) => {
          if (value === undefined) return
          let parsed: unknown = value
          try {
            parsed = JSON.parse(value) as unknown
          } catch {
            parsed = value
          }
          void this.dsh.updateSetting(ns, { [key]: parsed }).then(
            () => {
              this.toast(`${ns}.${key} updated`, 'ok')
              this.openView({ name: 'settings', ns })
            },
            (error: unknown) => { this.toast(`settings write failed: ${error instanceof Error ? error.message : String(error)}`, 'error') },
          )
        })
        return
      }
      case 'permissions': {
        if (agent === undefined) return
        try {
          this.dsh.permissionSet(agent.session, row.id)
          this.toast(`permission preset → ${row.id}`, 'ok')
          this.openView({ name: 'permissions' })
        } catch (error) {
          this.toast(`permission switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Apply a normalized effort selection to the session override, then
   * return to chat — picking from the panel commits and closes it (the
   * composer must come back), matching the model-panel flow.
   */
  private applyEffort(parsed: { clear: true } | { level: string }): void {
    if ('clear' in parsed) {
      const current = this.modelRef.current
      if (current === undefined || current.reasoningEffort === undefined) {
        this.toast('effort already auto (provider default)', 'info', 2500)
      } else {
        const { reasoningEffort: _dropped, ...rest } = current
        const fallback = this.dsh.currentModel()
        this.modelRef.current = rest.provider === fallback.provider && rest.model === fallback.model
          ? undefined
          : rest
        this.toast('effort → auto (provider default)', 'ok')
      }
    } else {
      const base = this.modelRef.current ?? this.dsh.currentModel()
      if (base.provider === '' || base.model === '') {
        this.toast('no model selected — pick a model first', 'warn')
        return
      }
      this.modelRef.current = { ...base, reasoningEffort: parsed.level }
      this.toast(`effort → ${parsed.level}`, 'ok')
    }
    this.view = { name: 'chat' }
    this.emit()
  }

  private applyModelText(text: string): void {
    const parsed = parseModelSelection(text)
    if (parsed === undefined || parsed.model === '') {
      this.toast('usage: <model> or <provider>/<model>', 'warn')
      return
    }
    const provider = parsed.provider === '' ? this.selection.provider : parsed.provider
    if (provider === '') {
      this.toast('no provider selected — use <provider>/<model>', 'warn')
      return
    }
    this.switchModel(provider, parsed.model)
  }

  private async resolveSessionPrefix(prefix: string): Promise<string | undefined> {
    const ids = new Set<string>()
    for (const session of this.dsh.listLiveSessions()) ids.add(session.id)
    for (const header of await this.dsh.listPersistedSessions()) ids.add(header.id)
    if (ids.has(prefix)) return prefix
    const matches = [...ids].filter(id => id.startsWith(prefix))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) this.toast(`no session matches "${prefix}"`, 'warn')
    else this.toast(`${String(matches.length)} sessions match "${prefix}" — be more specific`, 'warn')
    return undefined
  }

  /** Queue an approval dialog; resolves the DSH waterfall. */
  askApproval(toolName: string, reason: string, callId: string | undefined): Promise<'allowed-once' | 'rejected'> {
    const agent = this.agent
    const args = agent === undefined ? '' : this.dsh.findToolArgs(agent.session, callId)
    return new Promise<'allowed-once' | 'rejected'>((resolve) => {
      this.modalSeq++
      this.modals.push({ kind: 'approval', toolName, reason, args, resolve })
      this.emit()
    })
  }

  /** Queue a user-questions dialog; resolves the awaiting tool call. */
  askQuestions(items: AskItem[]): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
    if (items.length === 0) return Promise.resolve({ answers: [] })
    return new Promise((resolve) => {
      this.modalSeq++
      this.modals.push({
        kind: 'questions',
        items,
        index: 0,
        selected: items.map(() => []),
        customs: items.map(() => ''),
        optIndex: 0,
        custom: emptyField(),
        editingCustom: items[0] !== undefined && (items[0].options ?? []).length === 0,
        resolve: (answers) => { resolve({ answers }) },
      })
      this.emit()
    })
  }

  /** Queue a free-text dialog. */
  openTextModal(title: string, hint: string, initial: string, resolve: (value: string | undefined) => void): void {
    this.modalSeq++
    this.modals.push({ kind: 'text', title, hint, field: emptyField(initial), resolve })
    this.emit()
  }

  /** Resolve and drop the active modal. */
  private settleModal(index: number): void {
    this.modals.splice(index, 1)
    this.emit()
  }

  /** Recall composer history. */
  private recallHistory(delta: -1 | 1): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      if (delta === 1) return
      this.draft = this.composer.value
      this.historyIndex = this.history.length - 1
    } else {
      const next = this.historyIndex + delta
      if (next < 0 || next >= this.history.length) {
        if (delta === 1 && this.historyIndex === this.history.length - 1) {
          this.historyIndex = -1
          this.composer = { value: this.draft, cursor: this.draft.length }
          this.emit()
        }
        return
      }
      this.historyIndex = next
    }
    const value = this.historyIndex === -1 ? this.draft : this.history[this.historyIndex]!
    this.composer = { value, cursor: value.length }
    this.emit()
  }

  /** Central key router (called from the renderer's useInput). */
  handleKey(input: string, key: TuiKey): void {
    if (this.quitting) return
    if (this.status === 'error') {
      if (key.escape === true || (key.ctrl === true && (input === 'c' || input === 'd'))) void this.quit()
      return
    }
    if (this.status !== 'ready') return

    const modal = this.modal
    if (modal !== undefined) {
      this.handleModalKey(modal, input, key)
      return
    }
    if (this.view.name !== 'chat') {
      this.handlePanelKey(input, key)
      return
    }

    // Chat view. History scrolls through the terminal's native scrollback
    // (the transcript renders through Ink's static region).
    if (key.f1 === true) {
      this.openView({ name: 'help' })
      return
    }
    if (key.ctrl === true && input === 'c') {
      const agent = this.agent
      if (this.running && agent !== undefined) {
        agent.cancel('user')
        this.toast('cancelling turn…', 'warn', 2000)
        return
      }
      if (this.composer.value !== '') {
        this.composer = emptyField()
        this.emit()
        return
      }
      void this.quit()
      return
    }
    if (key.ctrl === true && input === 'd') {
      void this.quit()
      return
    }
    if (key.ctrl === true && input === 'l') {
      this.cleared = true
      this.emit()
      return
    }
    if (key.ctrl === true && input === 'o') {
      this.toggleToolsExpanded()
      return
    }

    const palette = this.paletteEntries()
    if (palette.length > 0) {
      if (this.paletteIndex >= palette.length) this.paletteIndex = 0
      if (key.escape === true) {
        this.paletteDismissed = this.composer.value
        this.emit()
        return
      }
      if (key.upArrow === true) {
        this.paletteIndex = (this.paletteIndex + palette.length - 1) % palette.length
        this.emit()
        return
      }
      if (key.downArrow === true) {
        this.paletteIndex = (this.paletteIndex + 1) % palette.length
        this.emit()
        return
      }
      if (key.tab === true) {
        const entry = palette[this.paletteIndex]
        if (entry !== undefined) {
          this.composer = { value: `/${entry.name} `, cursor: entry.name.length + 2 }
          this.paletteIndex = 0
          this.emit()
        }
        return
      }
      if (key.return === true) {
        const entry = palette[this.paletteIndex]
        const exactSingle = entry !== undefined && palette.length === 1 && this.composer.value === `/${entry.name}`
        if (entry !== undefined && !exactSingle) {
          this.composer = { value: `/${entry.name} `, cursor: entry.name.length + 2 }
          this.paletteIndex = 0
          this.emit()
          return
        }
        // An exact single match (or no selection) submits the line as typed.
      }
    } else if (key.upArrow === true || key.downArrow === true) {
      this.recallHistory(key.upArrow === true ? -1 : 1)
      return
    }

    if (key.escape === true) return
    const result = editField(this.composer, input, key)
    if (result === 'submit') this.submitComposer()
    else {
      this.paletteIndex = 0
      if (this.paletteDismissed !== '' && this.composer.value !== this.paletteDismissed) this.paletteDismissed = ''
      this.emit()
    }
  }

  private handlePanelKey(input: string, key: TuiKey): void {
    if (key.escape === true) {
      if (this.view.name === 'settings' && this.view.ns !== undefined) this.openView({ name: 'settings' })
      else if (this.view.name === 'model' && this.view.provider !== undefined) this.openView({ name: 'model' })
      else this.view = { name: 'chat' }
      this.emit()
      return
    }
    if (key.upArrow === true || (key.ctrl === true && input === 'p')) {
      this.rowIndex = Math.max(0, this.rowIndex - 1)
      this.emit()
      return
    }
    if (key.downArrow === true || (key.ctrl === true && input === 'n')) {
      this.rowIndex = Math.min(Math.max(0, this.rows.length - 1), this.rowIndex + 1)
      this.emit()
      return
    }
    if (key.return === true) {
      this.activateRow()
      return
    }
  }

  private handleModalKey(modal: Modal, input: string, key: TuiKey): void {
    const index = this.modals.indexOf(modal)
    if (modal.kind === 'approval') {
      const lower = input.toLowerCase()
      if (lower === 'a' || lower === 'y') {
        modal.resolve('allowed-once')
        this.settleModal(index)
      } else if (lower === 'r' || lower === 'n' || key.escape === true) {
        modal.resolve('rejected')
        this.settleModal(index)
      }
      return
    }
    if (modal.kind === 'text') {
      if (key.escape === true) {
        modal.resolve(undefined)
        this.settleModal(index)
        return
      }
      if (editField(modal.field, input, key) === 'submit') {
        modal.resolve(modal.field.value)
        this.settleModal(index)
      } else {
        this.emit()
      }
      return
    }
    // Questions wizard.
    const item = modal.items[modal.index]!
    const options = item.options ?? []
    const finish = (): void => {
      modal.customs[modal.index] = modal.custom.value.trim()
      const answers = modal.items.map((entry, i) => {
        const custom = modal.customs[i]!.trim()
        return {
          id: entry.id,
          selected: modal.selected[i]!,
          ...(custom === '' ? {} : { custom }),
        }
      })
      modal.resolve(answers)
      this.settleModal(index)
    }
    const advance = (delta: 1 | -1): void => {
      modal.customs[modal.index] = modal.custom.value.trim()
      const next = modal.index + delta
      if (next < 0 || next >= modal.items.length) {
        if (delta === 1) finish()
        return
      }
      modal.index = next
      modal.optIndex = 0
      const nextOptions = modal.items[next]!.options ?? []
      modal.editingCustom = nextOptions.length === 0
      modal.custom = emptyField(modal.customs[next]!)
      this.emit()
    }
    if (modal.editingCustom) {
      if (key.escape === true) {
        if (options.length === 0) {
          // Nothing to fall back to: keep editing.
          return
        }
        modal.editingCustom = false
        this.emit()
        return
      }
      if (key.tab === true && key.shift !== true) {
        advance(1)
        return
      }
      if (editField(modal.custom, input, key) === 'submit') advance(1)
      else this.emit()
      return
    }
    if (key.escape === true) {
      // Fail soft: resolve progress so far with empty answers.
      const answers = modal.items.map((entry, i) => ({ id: entry.id, selected: i < modal.index ? modal.selected[i]! : [] as string[] }))
      modal.resolve(answers)
      this.settleModal(index)
      this.toast('questions skipped', 'warn')
      return
    }
    if (key.upArrow === true) {
      modal.optIndex = options.length === 0 ? 0 : (modal.optIndex + options.length - 1) % options.length
      this.emit()
      return
    }
    if (key.downArrow === true) {
      modal.optIndex = options.length === 0 ? 0 : (modal.optIndex + 1) % options.length
      this.emit()
      return
    }
    if (input === ' ' && options.length > 0) {
      const label = options[modal.optIndex]!.label
      const current = modal.selected[modal.index]!
      if (item.multiSelect === true) {
        modal.selected[modal.index] = current.includes(label) ? current.filter(l => l !== label) : [...current, label]
      } else {
        modal.selected[modal.index] = [label]
      }
      this.emit()
      return
    }
    const digit = Number.parseInt(input, 10)
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length && input.trim() !== '') {
      const label = options[digit - 1]!.label
      if (item.multiSelect === true) {
        const current = modal.selected[modal.index]!
        modal.selected[modal.index] = current.includes(label) ? current.filter(l => l !== label) : [...current, label]
        this.emit()
      } else {
        modal.selected[modal.index] = [label]
        advance(1)
      }
      return
    }
    if (input === 'e' || key.rightArrow === true) {
      modal.editingCustom = true
      this.emit()
      return
    }
    if (key.tab === true && key.shift === true) {
      advance(-1)
      return
    }
    if (key.tab === true || key.return === true) {
      const current = modal.selected[modal.index]!
      if (current.length === 0 && options.length > 0) {
        // Default to the highlighted option on confirm.
        modal.selected[modal.index] = [options[modal.optIndex]!.label]
      }
      advance(1)
      return
    }
  }

  /** Cancel, flush, dispose, and request process exit. */
  async quit(): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    this.running = false
    this.emit()
    this.detachStream?.()
    const agent = this.agent
    try {
      agent?.cancel('user')
      if (agent !== undefined) await agent.whenIdle().catch(() => undefined)
      if (agent !== undefined) await this.dsh.flush(agent.session)
      await this.owned?.dispose()
    } catch {
      // Shutdown is best-effort.
    }
    // Settle any pending modals so DSH promises never hang the dispose.
    for (const modal of this.modals.splice(0)) {
      if (modal.kind === 'approval') modal.resolve('rejected')
      else if (modal.kind === 'text') modal.resolve(undefined)
      else modal.resolve(modal.items.map(entry => ({ id: entry.id, selected: [] as string[] })))
    }
    this.exitFn(0)
  }
}

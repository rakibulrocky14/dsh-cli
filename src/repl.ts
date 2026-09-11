/**
 * Line-oriented terminal surface: the non-TTY fallback (pipes, CI, dumb
 * terminals) and the scripting path. Shares the agent lifecycle, transcript
 * projection, and service facades with the full-screen TUI.
 *
 * @module dsh-terminal/repl
 */

import { join } from 'node:path'
import { BUILTINS, normalizeEffort, parseAssignments, parseModelSelection, shortHome, shortSession } from './core/commands.js'
import { Dsh, attachLiveStream, dshHome, dshProfile, installModelOverride, listProfilePlugins, sendFollowup, sendSteer, type StartupValues } from './core/dsh.js'
import { CookedInput, LineEditor } from './core/lineinput.js'
import { LiveFeed, foldTodos, foldUsage, isLiveBlock, renderBlockText, summarizeArgs, type Block } from './core/transcript.js'
import { readSessionEvents, type ApprovalOutcome, type AskItem, type DshAgent, type DshAgentHandle, type DshContext, type ModelSelectionRef } from './core/types.js'
import { bold, clearScreen, cyan, dim, green, magenta, red, rule, statusBar, yellow } from './ui.js'

/** Process IO for the REPL. */
export interface ReplIo {
  stdin: NodeJS.ReadStream
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
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

function modelLabel(provider: string, model: string): string {
  if (provider === '' && model === '') return 'unknown'
  if (provider === '') return model
  return `${provider}/${model}`
}

/** Interactive line surface over one DSH context. */
export class Repl {
  private readonly dsh: Dsh
  private readonly io: ReplIo
  private readonly raw: boolean
  private readonly editor: LineEditor | undefined
  private readonly cooked: CookedInput | undefined
  private owned: DshAgentHandle | undefined
  private detachStream: (() => void) | undefined
  private detachModel: (() => void) | undefined
  private readonly feed = new LiveFeed()
  private readonly modelRef: ModelSelectionRef = { current: undefined, assembled: undefined }
  private running = false
  private quitting = false
  private preset = ''
  private lastCtrlC = 0
  private lineResolver: ((line: string | undefined) => void) | undefined
  private textOpen = false
  private reasoningOpen = false
  private echoedText = false
  private echoedReasoning = false
  private printedIds = new Set<string>()

  constructor(ctx: DshContext, io: ReplIo) {
    this.dsh = new Dsh(ctx)
    this.io = io
    this.raw = io.stdin.isTTY === true && io.stdout !== undefined && process.stdout.isTTY === true
    if (this.raw) {
      this.editor = new LineEditor(io.stdin, io.stdout, join(dshHome(), 'terminal-history'), {
        onSubmit: (line) => { this.lineResolver?.(line); this.lineResolver = undefined },
        onCtrlC: () => { this.handleCtrlC() },
        onCtrlD: () => { this.lineResolver?.(undefined); this.lineResolver = undefined },
      })
      this.cooked = undefined
    } else {
      this.editor = undefined
      this.cooked = new CookedInput(io.stdin, io.stdout)
    }
  }

  private get agent(): DshAgent | undefined {
    return this.owned?.agent
  }

  private out(text: string): void {
    if (this.editor !== undefined) this.editor.printAbove(text)
    else this.io.stdout.write(text)
  }

  private closeStreamLine(): void {
    if (this.textOpen || this.reasoningOpen) this.out('\n')
    this.textOpen = false
    this.reasoningOpen = false
  }

  private handleCtrlC(): void {
    const agent = this.agent
    if (this.running && agent !== undefined) {
      agent.cancel('user')
      this.out(yellow('\n(interrupted — cancelling turn; Ctrl-C again to quit)\n'))
      return
    }
    const now = Date.now()
    if (now - this.lastCtrlC < 1500) {
      this.lineResolver?.(undefined)
      this.lineResolver = undefined
      return
    }
    this.lastCtrlC = now
    this.editor?.activate(this.promptLabel())
  }

  private promptLabel(): string {
    return this.running ? dim('(running) › ') : cyan('you › ')
  }

  private waitLine(): Promise<string | undefined> {
    if (this.editor !== undefined) {
      this.editor.activate(this.promptLabel())
      return new Promise<string | undefined>((resolve) => { this.lineResolver = resolve })
    }
    return this.cooked!.question(this.promptLabel(), this.io.stdout, false).then(
      line => line as string | undefined,
      () => undefined,
    )
  }

  private modalLine(prompt: string): Promise<string> {
    if (this.editor !== undefined) return this.editor.oneshotLine(prompt)
    return this.cooked!.question(prompt, this.io.stdout, true).then(
      line => {
        this.io.stdout.write('\n')
        return line
      },
      () => '',
    )
  }

  private paintHeader(): void {
    const agent = this.agent
    const selection = this.modelRef.current ?? this.dsh.currentModel()
    const effort = this.dsh.currentEffort(agent ?? undefined, this.modelRef.current?.reasoningEffort)
    const mode = agent === undefined ? '' : this.dsh.permissionCurrent(readSessionEvents(agent.session))
    this.out('\n')
    this.out(`${bold(magenta('dsh-terminal'))}${dim(' — vanilla DSH in the terminal')}\n`)
    this.out(`${statusBar([
      { label: 'session', value: agent === undefined ? '(none)' : agent.id },
      { label: 'model', value: modelLabel(selection.provider, selection.model) },
      { label: 'effort', value: effort === '' ? 'auto' : effort },
      { label: 'cwd', value: shortHome(process.cwd()) },
      { label: 'mode', value: mode === '' ? '–' : mode.toUpperCase() },
    ])}\n`)
    this.out(`${rule()}\n`)
  }

  private printStatusTail(): void {
    const agent = this.agent
    if (agent === undefined) return
    const tokens = this.feed.tokens
    const meter = this.dsh.measureTokens(agent.session)
    const parts: string[] = []
    if (tokens !== undefined) parts.push(`tokens in=${String(tokens.inputTokens)} out=${String(tokens.outputTokens)}`)
    if (meter !== undefined) parts.push(`ctx ${String(meter.totalTokens)} tok`)
    if (parts.length > 0) this.out(dim(`  ${parts.join(' · ')}\n`))
  }

  private printBlocks(blocks: Block[]): void {
    for (const block of blocks) {
      const text = renderBlockText(block)
      if (block.kind === 'user') this.out(`${green('you ›')} ${text.slice('you › '.length)}\n`)
      else if (block.kind === 'notice') this.out(block.tone === 'info' ? `${dim(text)}\n` : block.tone === 'warn' ? `${yellow(text)}\n` : `${red(text)}\n`)
      else if (block.kind === 'command') this.out(block.ok ? `${dim(text)}\n` : `${red(text)}\n`)
      else if (block.kind === 'reasoning') this.out(`${dim(text)}\n`)
      else this.out(`${text}\n`)
    }
  }

  /** (Re)open the agent and rewire stream + model listeners. */
  private async reopen(startup: StartupValues): Promise<void> {
    this.detachStream?.()
    this.detachStream = undefined
    this.detachModel?.()
    this.detachModel = undefined
    if (this.owned !== undefined) await this.owned.dispose()
    await this.adopt(await this.dsh.openAgent(startup, this.preset === '' ? undefined : this.preset))
  }

  /** Wire stream + model listeners around an adopted handle. */
  private async adopt(handle: { agent: DshAgent; dispose(): Promise<void> }): Promise<void> {
    this.owned = handle
    const agent = handle.agent
    await agent.whenIdle()
    this.detachModel = installModelOverride(agent.ctx, agent, this.modelRef)
    this.feed.reset()
    this.textOpen = false
    this.reasoningOpen = false
    this.echoedText = false
    this.echoedReasoning = false
    this.printedIds = new Set<string>()
    this.detachStream = attachLiveStream(this.dsh.ctx, agent, this.feed, (event) => {
      this.feed.notifyCommitted(readSessionEvents(agent.session))
      this.printFreshCommitted(event.type)
    })
    // Live chunk echo (incremental text/reasoning/tool lines).
    // Subscription is per-feed; chunks from other agents never reach it.
    this.paintHeader()
    this.feed.notifyCommitted(readSessionEvents(agent.session))
    const committed = this.feed.committedBlocks()
    for (const block of committed) this.printedIds.add(block.id)
    if (committed.length > 0) {
      this.out(dim(`  — resumed with ${String(committed.length)} blocks, showing recent —\n`))
      this.printBlocks(committed.slice(-30))
    }
    const preset = this.dsh.sessionPreset(agent.session)
    if (preset !== undefined) {
      this.out(yellow(`  note: this session runs preset "${preset}" on web; the terminal composes the base tool set instead\n`))
    }
  }

  /**
   * Print newly committed blocks after one log append. Pairing (tool
   * calls/results, command run/done) needs full-log context, so the diff
   * runs over the feed's projection rather than the single event.
   * @param triggerType - the committed event type (drives line closing).
   */
  private printFreshCommitted(triggerType: string): void {
    if (triggerType === 'assistant/message' || triggerType === 'tool/result'
      || triggerType === 'turn/end' || triggerType === 'assistant/attempt') {
      this.closeStreamLine()
    }
    const fresh = this.feed.committedBlocks().filter(b => !this.printedIds.has(b.id))
    for (const block of fresh) this.printedIds.add(block.id)
    const show = fresh.filter(b => {
      // Own typed text is already on screen; live tool heads print from
      // chunks; echoed assistant text/reasoning would double-print.
      if (b.kind === 'user' || b.kind === 'divider') return false
      if (b.kind === 'tool' && b.status === 'running') return false
      if (b.kind === 'assistant' && this.echoedText) return false
      if (b.kind === 'reasoning' && this.echoedReasoning) return false
      return true
    })
    this.printBlocks(show)
    if (triggerType === 'assistant/message') {
      this.echoedText = false
      this.echoedReasoning = false
    }
  }

  private watchChunks(): void {
    // Incremental echo: poll-free — the feed emits on every push.
    let lastText = ''
    let lastReasoning = ''
    let toolCount = 0
    this.feed.subscribe(() => {
      const snapshot = this.feed.snapshot()
      for (const block of snapshot) {
        if (block.kind === 'assistant' && block.live && block.text.length > lastText.length && block.id === 'live-text') {
          if (!this.textOpen) {
            if (this.reasoningOpen) { this.out('\n'); this.reasoningOpen = false }
            this.out(`${green('assistant')} `)
            this.textOpen = true
          }
          this.out(block.text.slice(lastText.length))
          lastText = block.text
          this.echoedText = true
        }
        if (block.kind === 'reasoning' && block.live && block.text.length > lastReasoning.length && block.id === 'live-reasoning') {
          if (!this.reasoningOpen) {
            if (this.textOpen) { this.out('\n'); this.textOpen = false }
            this.out(dim('thinking '))
            this.reasoningOpen = true
          }
          this.out(dim(block.text.slice(lastReasoning.length)))
          lastReasoning = block.text
          this.echoedReasoning = true
        }
      }
      const liveTools = snapshot.filter(b => b.kind === 'tool' && b.live)
      if (liveTools.length > toolCount) {
        this.closeStreamLine()
        for (const tool of liveTools.slice(toolCount)) {
          if (tool.kind !== 'tool') continue
          const args = summarizeArgs(tool.args)
          this.out(dim(`  tool: ${tool.name}${args === '' ? '' : ` ${args}`}\n`))
        }
      }
      toolCount = liveTools.length
      if (liveTools.length === 0 && toolCount !== 0) toolCount = 0
      // Reset incremental cursors when the feed resets (agent switch).
      if (snapshot.every(b => !isLiveBlock(b))) {
        lastText = ''
        lastReasoning = ''
        toolCount = 0
      }
    })
  }

  private async answerApproval(request: {
    agent: { id: string }
    toolName: string
    reason?: string
    callId?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome> {
    const agent = this.agent
    if (agent === undefined || request.agent.id !== agent.id) return 'unavailable'
    if (request.signal?.aborted === true) return 'cancelled'
    this.closeStreamLine()
    this.out('\n')
    this.out(`${yellow('approval ')}${bold(request.toolName)}\n`)
    if (request.reason !== undefined && request.reason !== '') this.out(dim(`  ${request.reason}\n`))
    const args = this.dsh.findToolArgs(agent.session, request.callId)
    if (args !== '') this.out(dim(`  args: ${summarizeArgs(args, 300)}\n`))
    const answer = (await this.modalLine(dim('  [a]llow / [r]eject > '))).trim().toLowerCase()
    if (answer === 'a' || answer === 'allow' || answer === 'y' || answer === 'yes') return 'allowed-once'
    return 'rejected'
  }

  private async answerQuestions(questions: AskItem[]): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> {
    const answers: { id: string; selected: string[]; custom?: string }[] = []
    this.closeStreamLine()
    this.out('\n')
    this.out(`${yellow('questions ')}${dim('from the agent')}\n`)
    for (const item of questions) {
      if (item.header !== undefined && item.header !== '') this.out(bold(`${item.header}\n`))
      this.out(`${item.question}\n`)
      if (item.detail !== undefined && item.detail !== '') this.out(dim(`${item.detail}\n`))
      const options = item.options ?? []
      for (let i = 0; i < options.length; i++) {
        const option = options[i]!
        this.out(`  ${cyan(String(i + 1))}  ${option.label}${option.description === undefined || option.description === '' ? '' : dim(` — ${option.description}`)}\n`)
      }
      const hint = options.length === 0
        ? 'type an answer'
        : item.multiSelect === true ? 'numbers (1,3) or text' : 'number or text'
      const raw = (await this.modalLine(dim(`  ${hint} > `))).trim()
      if (options.length === 0) {
        answers.push({ id: item.id, selected: [], custom: raw })
        continue
      }
      const picks = raw.split(/[,\s]+/u).map(p => Number.parseInt(p, 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= options.length)
      if (picks.length > 0) {
        const labels = (item.multiSelect === true ? picks : picks.slice(0, 1)).map(n => options[n - 1]!.label)
        answers.push({ id: item.id, selected: labels })
      } else {
        answers.push({ id: item.id, selected: [], custom: raw })
      }
    }
    return { answers }
  }

  private helpText(): string {
    const agent = this.agent
    const pluginCommands = agent === undefined ? [] : this.dsh.listCommands(agent)
    const width = Math.max(...BUILTINS.map(b => b.name.length))
    const lines = [
      bold('Vanilla DSH terminal — commands'),
      '',
      `${cyan('  chat')}  ${' '.repeat(width)}  type a message and press Enter`,
      ...BUILTINS.map(b => `  ${cyan(`/${b.name}`)}${' '.repeat(width - b.name.length)}  ${dim(b.desc)}`),
    ]
    if (pluginCommands.length > 0) {
      lines.push('', bold('Plugin commands (dispatched, never sent to the model):'))
      for (const command of pluginCommands.slice(0, 30)) {
        lines.push(`  ${cyan(`/${command.name}`)}${command.description === '' ? '' : dim(` — ${command.description}`)}`)
      }
    }
    lines.push('', dim('While a turn runs: type to steer · Ctrl-C cancels the turn.'))
    return lines.join('\n')
  }

  private async handleSlash(line: string, startup: StartupValues): Promise<'continue' | 'quit'> {
    const agent = this.agent
    const parts = line.slice(1).trim().split(/\s+/u)
    const cmd = parts[0] ?? ''
    const rest = parts.slice(1).join(' ')
    switch (cmd) {
      case 'help':
      case '?':
        this.out(`${this.helpText()}\n`)
        return 'continue'
      case 'quit':
      case 'exit':
      case 'q':
        return 'quit'
      case 'clear':
        clearScreen(s => this.io.stdout.write(s))
        this.paintHeader()
        return 'continue'
      case 'new': {
        if (agent === undefined) return 'continue'
        agent.cancel('user')
        await agent.whenIdle()
        this.running = false
        await this.reopen({ ...startup, resume: '' })
        return 'continue'
      }
      case 'sessions': {
        await this.printSessions()
        return 'continue'
      }
      case 'resume': {
        if (rest === '') {
          this.out(yellow('usage: /resume <sessionId>\n'))
          return 'continue'
        }
        const id = await this.resolveSessionId(rest)
        if (id === undefined) return 'continue'
        agent?.cancel('user')
        if (agent !== undefined) await agent.whenIdle()
        this.running = false
        await this.reopen({ ...startup, resume: id })
        return 'continue'
      }
      case 'model': {
        await this.handleModel(rest)
        return 'continue'
      }
      case 'effort': {
        await this.handleEffort(rest)
        return 'continue'
      }
      case 'fork': {
        if (agent === undefined) return 'continue'
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
          await this.adopt(child)
          this.out(green(`  forked → ${child.agent.id}\n`))
        } catch (error) {
          this.out(yellow(`  fork failed: ${error instanceof Error ? error.message : String(error)}\n`))
        }
        return 'continue'
      }
      case 'stop': {
        if (agent === undefined || !this.running) {
          this.out(dim('  (no turn is running)\n'))
          return 'continue'
        }
        agent.cancel('user')
        this.out(yellow('  cancelling turn…\n'))
        return 'continue'
      }
      case 'title': {
        if (agent === undefined) return 'continue'
        if (rest === '') {
          this.out(yellow('usage: /title <text>\n'))
          return 'continue'
        }
        try {
          const title = this.dsh.renameSession(agent.session, rest)
          this.out(green(`  renamed → ${title}\n`))
        } catch (error) {
          this.out(red(`  rename failed: ${error instanceof Error ? error.message : String(error)}\n`))
        }
        return 'continue'
      }
      case 'skills': {
        for (const skill of await this.dsh.listSkills()) {
          this.out(`  ${cyan(skill.name)}${skill.description === '' ? '' : dim(` — ${skill.description.slice(0, 100)}`)}\n`)
        }
        return 'continue'
      }
      case 'agents': {
        const mine = agent?.id
        for (const entry of this.dsh.listAgents()) {
          this.out(`  ${entry.id === mine ? green('●') : ' '} ${cyan(entry.id)} ${dim(entry.status)}${entry.id === mine ? dim(' · this surface') : ''}\n`)
        }
        return 'continue'
      }
      case 'terminals': {
        const terminals = this.dsh.listTerminals(agent ?? undefined)
        if (terminals.length === 0) this.out(dim('  (no persistent terminals)\n'))
        for (const terminal of terminals) {
          this.out(`  ${cyan(terminal.id)} ${dim(terminal.status)}${terminal.label === '' ? '' : ` ${terminal.label}`}\n`)
        }
        return 'continue'
      }
      case 'todos': {
        if (agent === undefined) return 'continue'
        const todos = foldTodos(readSessionEvents(agent.session))
        if (todos === undefined || todos.length === 0) this.out(dim('  (no task list in this session)\n'))
        for (const todo of todos ?? []) {
          this.out(`  [${todo.status === 'done' || todo.status === 'completed' ? green('x') : dim(' ')}] ${todo.text}\n`)
        }
        return 'continue'
      }
      case 'usage': {
        if (agent === undefined) return 'continue'
        const totals = foldUsage(readSessionEvents(agent.session))
        const meter = this.dsh.measureTokens(agent.session)
        this.out(`  responses: ${String(totals.responses)} · in: ${String(totals.input)} · out: ${String(totals.output)}${meter === undefined ? '' : ` · ctx: ${String(meter.totalTokens)} tok`}\n`)
        return 'continue'
      }
      case 'tools': {
        if (agent === undefined) return 'continue'
        const tools = this.dsh.listTools(agent)
        if (tools.length === 0) this.out(dim('  (no tools visible)\n'))
        for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
          const description = (tool.description ?? '').split('\n')[0] ?? ''
          this.out(`  ${cyan(tool.name)}${description === '' ? '' : dim(` — ${description.slice(0, 100)}`)}\n`)
        }
        return 'continue'
      }
      case 'commands': {
        if (agent === undefined) return 'continue'
        const commands = this.dsh.listCommands(agent)
        if (commands.length === 0) this.out(dim('  (no plugin commands registered)\n'))
        for (const command of commands) {
          this.out(`  ${cyan(`/${command.name}`)}${command.description === '' ? '' : dim(` — ${command.description}`)}\n`)
        }
        return 'continue'
      }
      case 'presets': {
        await this.handlePresets(rest, startup)
        return 'continue'
      }
      case 'plugins': {
        const { rows, profile, home } = listProfilePlugins()
        this.out(dim(`  profile: ${profile}  home: ${home}\n`))
        if (rows.length === 0) this.out(dim('  (no extra plugins in this profile)\n'))
        for (const row of rows) this.out(`  ${cyan(row.name)} ${dim(row.version)}\n`)
        this.out(dim(`  Add more: dsh plugin --profile ${profile} add <pkg>\n`))
        this.out(dim('  Backend contributions (tools/commands/jobs/llm) load; web-only UI is ignored here.\n'))
        return 'continue'
      }
      case 'settings': {
        await this.handleSettings(parts.slice(1))
        return 'continue'
      }
      case 'permissions': {
        await this.handlePermissions(rest)
        return 'continue'
      }
      case 'jobs': {
        const jobs = this.dsh.listJobs(agent ?? undefined)
        if (jobs.length === 0) this.out(dim('  (no background jobs)\n'))
        for (const job of jobs) {
          this.out(`  ${cyan(job.id)} ${dim(job.status ?? '')}${job.label === undefined || job.label === '' ? '' : ` ${job.label}`}\n`)
        }
        return 'continue'
      }
      case 'doctor': {
        this.printDoctor()
        return 'continue'
      }
      default: {
        // Plugin command dispatch: never sent to the model. The outcome
        // prints through the committed command/done card, so a settled
        // dispatch stays silent here.
        if (agent !== undefined) {
          try {
            const outcome = await this.dsh.executeCommand(agent, line, AbortSignal.timeout(120000))
            if (outcome !== undefined) return 'continue'
          } catch (error) {
            this.out(`${red(`/${cmd} failed: ${error instanceof Error ? error.message : String(error)}`)}\n`)
            return 'continue'
          }
        }
        this.out(yellow(`  unknown command /${cmd} — try /help\n`))
        return 'continue'
      }
    }
  }

  private async printSessions(): Promise<void> {
    const fromQuery = await this.dsh.listSessionRecords()
    const rows: { id: string; live: boolean; createdAt: number | undefined; cwd: string | undefined; title: string | undefined }[] = []
    if (fromQuery !== undefined) {
      for (const record of fromQuery) {
        rows.push({ id: record.id, live: record.live, createdAt: record.createdAt, cwd: record.cwd, title: undefined })
      }
    } else {
      for (const header of await this.dsh.listPersistedSessions()) {
        rows.push({ id: header.id, live: false, createdAt: header.createdAt, cwd: header.cwd, title: undefined })
      }
    }
    for (const session of this.dsh.listLiveSessions()) {
      const events = readSessionEvents(session)
      const title = this.dsh.foldTitle(events) ?? this.dsh.firstPrompt(events)
      const existing = rows.find(r => r.id === session.id)
      if (existing !== undefined) {
        existing.live = true
        existing.createdAt = session.header?.createdAt ?? existing.createdAt
        existing.cwd = session.header?.cwd ?? existing.cwd
        existing.title = title
      } else {
        rows.push({ id: session.id, live: true, createdAt: session.header?.createdAt, cwd: session.header?.cwd, title })
      }
    }
    if (rows.length === 0) {
      this.out(dim('  (no sessions)\n'))
      return
    }
    const sorted = rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 30)
    for (const row of sorted) {
      const current = row.id === this.agent?.id ? green(' ●') : '  '
      const name = row.title ?? `${shortSession(row.id)} (untitled)`
      const detail = dim(`${shortSession(row.id)} · ${age(row.createdAt)}${row.live ? ' · live' : ''}${row.cwd === undefined ? '' : ` · ${row.cwd.slice(row.cwd.lastIndexOf('/') + 1)}`}`)
      this.out(`${current} ${name}\n      ${detail}\n`)
    }
  }

  private async resolveSessionId(prefix: string): Promise<string | undefined> {
    const ids = new Set<string>()
    for (const session of this.dsh.listLiveSessions()) ids.add(session.id)
    for (const header of await this.dsh.listPersistedSessions()) ids.add(header.id)
    if (ids.has(prefix)) return prefix
    const matches = [...ids].filter(id => id.startsWith(prefix))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) this.out(yellow(`  no session matches "${prefix}"\n`))
    else {
      this.out(yellow(`  ambiguous prefix — ${String(matches.length)} matches:\n`))
      for (const id of matches.slice(0, 10)) this.out(`    ${dim(id)}\n`)
    }
    return undefined
  }

  private async handleEffort(rest: string): Promise<void> {
    const agent = this.agent
    const selection = this.modelRef.current ?? this.dsh.currentModel()
    const options = await this.dsh.effortOptions(selection.provider, selection.model)
    const effective = this.dsh.currentEffort(agent ?? undefined, this.modelRef.current?.reasoningEffort)
    let parsed: { clear: true } | { level: string } | undefined
    try {
      parsed = normalizeEffort(rest, options.map(o => o.id))
    } catch (error) {
      this.out(yellow(`  ${error instanceof Error ? error.message : String(error)}\n`))
      return
    }
    if (parsed === undefined) {
      this.out(`  effort: ${effective === '' ? dim('auto (provider default)') : effective}\n`)
      for (const option of options) {
        const marker = option.id === effective ? green(' ●') : '  '
        this.out(`${marker} ${cyan(option.id)}${option.name === option.id ? '' : ` (${option.name})`}${option.description === '' ? '' : dim(` — ${option.description.slice(0, 80)}`)}\n`)
      }
      this.out(dim('  set: /effort <level> · clear: /effort auto\n'))
      return
    }
    if ('clear' in parsed) {
      const current = this.modelRef.current
      if (current === undefined || current.reasoningEffort === undefined) {
        this.out(dim('  effort already auto (provider default)\n'))
        return
      }
      const { reasoningEffort: _dropped, ...remaining } = current
      const fallback = this.dsh.currentModel()
      this.modelRef.current = remaining.provider === fallback.provider && remaining.model === fallback.model
        ? undefined
        : remaining
      this.out(green('  effort → auto (provider default)\n'))
      return
    }
    const base = this.modelRef.current ?? this.dsh.currentModel()
    if (base.provider === '' || base.model === '') {
      this.out(yellow('  no model selected — pick a model first\n'))
      return
    }
    this.modelRef.current = { ...base, reasoningEffort: parsed.level }
    this.out(green(`  effort → ${parsed.level} (takes effect on the next step)\n`))
  }

  private async handleModel(rest: string): Promise<void> {
    const current = this.modelRef.current ?? this.dsh.currentModel()
    const providers = this.dsh.listProviders()
    if (rest === '') {
      const effort = this.dsh.currentEffort(this.agent ?? undefined, this.modelRef.current?.reasoningEffort)
      this.out(`  session: ${modelLabel(current.provider, current.model)}${this.modelRef.current === undefined ? dim(' (profile default)') : dim(' (session override)')}${effort === '' ? '' : ` · effort ${effort}`}\n`)
      if (providers.length > 0) {
        this.out(dim(`  providers: ${providers.map(p => p.id).join(', ')}\n`))
      }
      this.out(dim('  list: /model <provider> · switch: /model <model> | /model <provider>/<model>\n'))
      return
    }
    // A bare provider id lists its advertised models instead of switching.
    const providerHit = providers.find(p => p.id.toLowerCase() === rest.trim().toLowerCase())
    if (providerHit !== undefined && !rest.includes('/')) {
      let models: { id: string; name: string; description: string }[]
      try {
        models = await this.dsh.listModels(providerHit.id)
      } catch (error) {
        this.out(red(`  discovery failed: ${error instanceof Error ? error.message : String(error)}\n`))
        return
      }
      if (models.length === 0) {
        this.out(dim(`  (no advertised models on ${providerHit.id} — unlisted ids may still route)\n`))
        return
      }
      for (const model of models) {
        const active = current.provider === providerHit.id && current.model === model.id
        this.out(`${active ? green(' ●') : '  '} ${cyan(model.id)}${model.name === model.id ? '' : ` (${model.name})`}${model.description === '' ? '' : dim(` — ${model.description.slice(0, 80)}`)}\n`)
      }
      return
    }
    const parsed = parseModelSelection(rest)
    if (parsed === undefined || parsed.model === '') {
      this.out(yellow('usage: /model <model> | /model <provider>/<model>\n'))
      return
    }
    const provider = parsed.provider === '' ? current.provider : parsed.provider
    if (provider === '') {
      this.out(yellow('  no provider selected — use /model <provider>/<model>\n'))
      return
    }
    const previous = this.modelRef.current
    const effort = previous !== undefined && previous.provider === provider ? previous.reasoningEffort : undefined
    this.modelRef.current = { provider, model: parsed.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    this.out(`  model → ${modelLabel(provider, parsed.model)}${effort === undefined ? '' : ` · effort ${effort}`}${dim(' (takes effect on the next step)')}\n`)
  }

  private async handlePresets(rest: string, startup: StartupValues): Promise<void> {
    const presets = await this.dsh.listPresets()
    if (rest === '') {
      if (presets.length === 0) {
        this.out(dim('  (no agent presets configured in this deployment)\n'))
        return
      }
      for (const preset of presets) {
        const marker = preset.id === this.preset ? green(' ●') : '  '
        this.out(`${marker} ${cyan(preset.id)}${preset.name === undefined || preset.name === preset.id ? '' : ` (${preset.name})`}${preset.broken === undefined ? '' : red(` — broken: ${preset.broken}`)}${preset.description === undefined ? '' : `\n      ${dim(preset.description)}`}\n`)
      }
      this.out(dim('  apply: /presets <id> starts a new session composed with that preset\n'))
      return
    }
    const found = presets.find(p => p.id === rest)
    if (found === undefined) {
      this.out(yellow(`  unknown preset "${rest}"\n`))
      return
    }
    if (found.broken !== undefined) {
      this.out(red(`  preset "${rest}" is broken: ${found.broken}\n`))
      return
    }
    const agent = this.agent
    agent?.cancel('user')
    if (agent !== undefined) await agent.whenIdle()
    this.running = false
    this.preset = rest
    await this.reopen({ ...startup, resume: '' })
    this.out(dim(`  session composed with preset "${rest}"\n`))
  }

  private async handleSettings(args: string[]): Promise<void> {
    const descriptors = this.dsh.describeSettings()
    if (args.length === 0) {
      this.out(`  file: ${this.dsh.settingsPath() ?? '(non-file storage)'}\n`)
      if (descriptors.length === 0) {
        this.out(dim('  (no settings namespaces registered)\n'))
        return
      }
      for (const descriptor of descriptors) {
        const keys = descriptor.user === undefined ? 0 : Object.keys(descriptor.user).length
        this.out(`  ${cyan(descriptor.ns)} ${dim(keys === 0 ? '(defaults)' : `(${String(keys)} user ${keys === 1 ? 'key' : 'keys'})`)}\n`)
      }
      this.out(dim('  inspect: /settings <namespace> · write: /settings <namespace> <k=v>…\n'))
      return
    }
    const ns = args[0]!
    const descriptor = descriptors.find(d => d.ns === ns)
    if (descriptor === undefined) {
      this.out(yellow(`  unknown settings namespace "${ns}"\n`))
      return
    }
    if (args.length === 1) {
      const shown = descriptor.user ?? descriptor.resolved ?? descriptor.base ?? {}
      this.out(`  ${cyan(ns)}\n`)
      this.out(`${JSON.stringify(shown, undefined, 2).split('\n').map(l => `  ${dim(l)}`).join('\n')}\n`)
      return
    }
    try {
      const patch = parseAssignments(args.slice(1))
      await this.dsh.updateSetting(ns, patch)
      this.out(green(`  ${ns} updated\n`))
    } catch (error) {
      this.out(red(`  settings write failed: ${error instanceof Error ? error.message : String(error)}\n`))
    }
  }

  private async handlePermissions(name: string): Promise<void> {
    const agent = this.agent
    if (agent === undefined) return
    const names = this.dsh.permissionNames()
    const current = this.dsh.permissionCurrent(readSessionEvents(agent.session))
    if (name === '') {
      this.out(`  preset: ${current === '' ? dim('(unknown)') : current}\n`)
      if (names.length > 0) this.out(dim(`  available: ${names.join(', ')}\n`))
      this.out(dim('  switch: /permissions <name>\n'))
      return
    }
    try {
      this.dsh.permissionSet(agent.session, name)
      this.out(green(`  permission preset → ${name}\n`))
    } catch (error) {
      this.out(red(`  permission switch failed: ${error instanceof Error ? error.message : String(error)}\n`))
    }
  }

  private printDoctor(): void {
    const agent = this.agent
    const selection = this.modelRef.current ?? this.dsh.currentModel()
    const present = (value: unknown): string => value === undefined ? red('missing') : green('ok')
    this.out(bold('doctor\n'))
    this.out(`  node: ${process.version} · profile: ${dshProfile()} · home: ${dshHome()}\n`)
    this.out(`  session: ${agent?.id ?? '(none)'} · model: ${modelLabel(selection.provider, selection.model)}\n`)
    this.out(`  agents: ${present(this.dsh.ctx.get('agents'))} · tools: ${present(this.dsh.ctx.get('tools'))} · commands: ${present(this.dsh.ctx.get('commands'))}\n`)
    this.out(`  questions: ${present(this.dsh.ctx.get('userQuestions'))} · settings: ${present(this.dsh.ctx.get('settings'))} · presets: ${present(this.dsh.ctx.get('agentPresets'))}\n`)
    this.out(`  jobs: ${present(this.dsh.ctx.get('jobs'))} · meter: ${present(this.dsh.ctx.get('tokenMeter'))} · permission: ${present(this.dsh.ctx.get('permissionPresets') ?? this.dsh.ctx.get('permission'))}\n`)
  }

  /** Run until quit; resolves the process exit code. */
  async start(startup: StartupValues): Promise<number> {
    try {
      await this.dsh.awaitReady()
    } catch (error) {
      this.io.stderr.write(`dsh-terminal: boot failed: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    try {
      await this.reopen(startup)
    } catch (error) {
      this.io.stderr.write(`dsh-terminal: cannot open agent: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    this.watchChunks()
    this.dsh.onApproval(
      (request) => this.answerApproval(request),
      (candidate) => candidate.id === this.agent?.id,
    )
    this.dsh.registerQuestions(
      (questions) => this.answerQuestions(questions),
      (candidate) => candidate !== undefined && candidate.id === this.agent?.id,
    )
    this.out(dim('Type /help for commands.\n\n'))

    for (;;) {
      if (this.quitting) break
      const line = await this.waitLine()
      if (line === undefined) break
      const trimmed = line.trim()
      if (trimmed === '') continue
      const agent = this.agent
      if (agent === undefined) break

      if (trimmed.startsWith('/')) {
        const action = await this.handleSlash(trimmed, startup)
        if (action === 'quit') break
        continue
      }

      if (this.running) {
        sendSteer(agent, trimmed)
        continue
      }
      this.running = true
      const current = agent
      sendFollowup(current, trimmed)
      void current.whenIdle().then(() => {
        if (this.agent !== current) return
        this.running = false
        this.closeStreamLine()
        this.out('\n')
        this.printStatusTail()
        this.editor?.setPrompt(this.promptLabel())
      })
    }

    this.quitting = true
    this.detachStream?.()
    this.editor?.close()
    this.cooked?.close()
    const agent = this.agent
    try {
      agent?.cancel('user')
      if (agent !== undefined) await agent.whenIdle().catch(() => undefined)
      if (agent !== undefined) await this.dsh.flush(agent.session)
      await this.owned?.dispose()
    } catch {
      // Shutdown best-effort; the exit code still reports clean quit.
    }
    this.io.stdout.write(dim('\nbye\n'))
    return 0
  }
}

/**
 * Run the line surface to completion.
 * @param ctx - plugin context.
 * @param startup - resolved CLI values.
 * @param io - process IO.
 * @returns the process exit code.
 */
export async function runRepl(ctx: DshContext, startup: StartupValues, io: ReplIo): Promise<number> {
  return new Repl(ctx, io).start(startup)
}

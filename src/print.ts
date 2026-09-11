/**
 * One-shot `--print` mode: answer a single task, stream reasoning to stderr,
 * print the final assistant text to stdout, and exit (headless-style, through
 * the same agent lifecycle as the interactive surfaces).
 *
 * @module dsh-terminal/print
 */

import { Dsh, attachLiveStream, sendFollowup, type StartupValues } from './core/dsh.js'
import { LiveFeed, summarizeInterval } from './core/transcript.js'
import { readSessionEvents, type DshContext } from './core/types.js'

/** Process IO for one-shot mode. */
export interface PrintIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/**
 * Run one task to quiescence.
 * @param ctx - plugin context.
 * @param startup - resolved CLI values (print carries the task).
 * @param io - process IO.
 * @returns the process exit code.
 */
export async function runPrint(ctx: DshContext, startup: StartupValues, io: PrintIo): Promise<number> {
  const dsh = new Dsh(ctx)
  try {
    await dsh.awaitReady()
  } catch (error) {
    io.stderr.write(`dsh-terminal: boot failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  let owned: { agent: { session: { seq: number } }; dispose(): Promise<void> } | undefined
  try {
    owned = await dsh.openAgent({ ...startup, resume: startup.resume })
  } catch (error) {
    io.stderr.write(`dsh-terminal: cannot open agent: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const agent = owned.agent as import('./core/types.js').DshAgent
  await agent.whenIdle()
  const firstSeq = agent.session.seq
  const feed = new LiveFeed()
  let reasoningOpen = false
  let printedReasoning = 0
  feed.subscribe(() => {
    const live = feed.snapshot().find(b => b.kind === 'reasoning' && b.live)
    if (live === undefined || live.kind !== 'reasoning') {
      printedReasoning = 0
      return
    }
    if (live.text.length <= printedReasoning) return
    if (!reasoningOpen) {
      io.stderr.write('dsh-terminal: reasoning:\n')
      reasoningOpen = true
    }
    io.stderr.write(live.text.slice(printedReasoning))
    printedReasoning = live.text.length
  })
  const detach = attachLiveStream(ctx, agent, feed, (event) => {
    if (event.type !== 'assistant/chunk') feed.notifyCommitted(readSessionEvents(agent.session))
  })
  dsh.onApproval(async (request) => {
    io.stderr.write(`dsh-terminal: rejecting approval for ${request.toolName} (--print is non-interactive)\n`)
    return 'rejected'
  }, (candidate) => candidate.id === agent.id)
  dsh.registerQuestions(async () => {
    throw new Error('--print is non-interactive: cannot answer agent questions')
  }, (candidate) => candidate !== undefined && candidate.id === agent.id)

  try {
    sendFollowup(agent, startup.print)
    await agent.whenIdle()
  } finally {
    detach()
  }
  if (reasoningOpen) io.stderr.write('\n')
  await dsh.flush(agent.session)
  const outcome = summarizeInterval(readSessionEvents(agent.session), firstSeq)
  await owned.dispose()
  io.stdout.write(`${outcome.text}\n`)
  if (outcome.reasonKind === 'error') {
    io.stderr.write('dsh-terminal: turn ended with an error\n')
    return 1
  }
  return outcome.reasonKind === 'completed' ? 0 : 1
}

/**
 * Single-reader terminal input for the line REPL. Exactly one owner reads
 * stdin at a time: the composer holds it while idle/running, and approval or
 * question modals borrow it with priority, so a modal answer can never leak
 * into chat as a steering message.
 *
 * Two transports: a raw-mode single-line editor (TTY stdin, with history and
 * Emacs keys) and a serialized cooked line queue (piped stdin).
 *
 * @module dsh-terminal/core/lineinput
 */

import { createInterface, type Interface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Minimal writer so tests can capture output. */
export interface Writer {
  write(chunk: string): unknown
}

interface Waiter {
  modal: boolean
  resolve: (line: string) => void
  reject: (error: Error) => void
}

/**
 * Cooked-stdin line pump: one readline, modal-first dispatch.
 * Used when stdin is piped (raw mode unavailable).
 */
export class CookedInput {
  private readonly rl: Interface
  private readonly queue: string[] = []
  private readonly waiters: Waiter[] = []
  private ended = false

  constructor(stdin: NodeJS.ReadableStream, stdout: Writer) {
    this.rl = createInterface({ input: stdin, output: stdout as NodeJS.WritableStream, terminal: false })
    this.rl.on('line', (line) => {
      const modal = this.waiters.findIndex(w => w.modal)
      const waiter = modal >= 0 ? this.waiters.splice(modal, 1)[0]! : this.waiters.shift()
      if (waiter !== undefined) waiter.resolve(line)
      else this.queue.push(line)
    })
    this.rl.on('close', () => {
      this.ended = true
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('stdin closed'))
    })
  }

  /** Ask one line; modal waiters jump the queue. */
  question(prompt: string, stdout: Writer, modal = false): Promise<string> {
    stdout.write(prompt)
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.ended) return Promise.reject(new Error('stdin closed'))
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ modal, resolve, reject })
    })
  }

  close(): void {
    this.rl.close()
  }
}

/** Callbacks driving one raw editing session. */
export interface EditorCallbacks {
  onSubmit(line: string): void
  onCtrlC(): void
  onCtrlD(): void
  onInterruptHint?(): void
}

/**
 * Raw-mode single-line editor with history, Emacs keys, and safe output
 * interleaving (`printAbove` redraws the prompt after every write).
 */
export class LineEditor {
  private readonly stdin: NodeJS.ReadStream
  private readonly stdout: Writer
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private cursor = 0
  private prompt = ''
  private history: string[] = []
  private historyIndex = -1
  private draft = ''
  private active = false
  private oneshot: { resolve: (line: string) => void; prompt: string } | undefined
  private readonly historyFile: string | undefined
  private readonly cbs: EditorCallbacks
  private readonly onData: (chunk: Buffer) => void

  constructor(stdin: NodeJS.ReadStream, stdout: Writer, historyFile: string | undefined, cbs: EditorCallbacks) {
    this.stdin = stdin
    this.stdout = stdout
    this.historyFile = historyFile
    this.cbs = cbs
    this.onData = (chunk: Buffer) => { this.handle(chunk) }
    if (historyFile !== undefined) {
      try {
        this.history = readFileSync(historyFile, 'utf8').split('\n').map(l => l.trimEnd()).filter(l => l !== '').slice(-500)
      } catch {
        this.history = []
      }
    }
  }

  private saveHistory(): void {
    if (this.historyFile === undefined) return
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true })
      writeFileSync(this.historyFile, `${this.history.slice(-500).join('\n')}\n`)
    } catch {
      // History is best-effort.
    }
  }

  /** Begin editing a fresh line under `prompt`. */
  activate(prompt: string): void {
    this.prompt = prompt
    this.buffer = ''
    this.cursor = 0
    this.historyIndex = -1
    this.draft = ''
    if (!this.active) {
      this.active = true
      if (this.stdin.isTTY === true && typeof this.stdin.setRawMode === 'function') {
        this.stdin.setRawMode(true)
      }
      this.stdin.resume()
      this.stdin.on('data', this.onData)
    }
    this.redraw()
  }

  /** Change the prompt label without touching the buffer. */
  setPrompt(prompt: string): void {
    this.prompt = prompt
    this.redraw()
  }

  /** Suspend editing (a modal borrows the reader). */
  deactivate(): void {
    if (!this.active) return
    this.active = false
    this.stdin.off('data', this.onData)
    if (this.stdin.isTTY === true && typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(false)
    }
    this.stdin.pause()
    this.stdout.write('\n')
  }

  /** Release stdin entirely. */
  close(): void {
    this.saveHistory()
    if (!this.active) return
    this.active = false
    this.stdin.off('data', this.onData)
    if (this.stdin.isTTY === true && typeof this.stdin.setRawMode === 'function') {
      this.stdin.setRawMode(false)
    }
    this.stdin.pause()
  }

  /** Write output above the editing line, then redraw the prompt. */
  printAbove(text: string): void {
    if (!this.active) {
      this.stdout.write(text)
      return
    }
    const normalized = text.endsWith('\n') ? text : `${text}\n`
    this.stdout.write(`\r\x1b[K${normalized}`)
    this.redraw()
  }

  /** Borrow the reader for one modal line (history-free). */
  oneshotLine(prompt: string): Promise<string> {
    if (!this.active) return Promise.reject(new Error('editor is not active'))
    this.stdout.write(`\r\x1b[K${prompt}`)
    return new Promise<string>((resolve) => {
      this.oneshot = { resolve, prompt }
      this.buffer = ''
      this.cursor = 0
    })
  }

  private redraw(): void {
    if (!this.active) return
    const label = this.oneshot?.prompt ?? this.prompt
    this.stdout.write(`\r\x1b[K${label}${this.buffer}`)
    const col = label.length + this.cursor + 1
    if (col > 1) this.stdout.write(`\x1b[${String(col)}G`)
  }

  private commitHistory(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    if (this.history[this.history.length - 1] !== line) this.history.push(line)
    if (this.history.length > 500) this.history = this.history.slice(-500)
    this.saveHistory()
  }

  private recall(delta: -1 | 1): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      if (delta === 1) return
      this.draft = this.buffer
      this.historyIndex = this.history.length - 1
    } else {
      const next = this.historyIndex + delta
      if (next < 0 || next >= this.history.length) {
        if (delta === 1 && this.historyIndex === this.history.length - 1) {
          this.historyIndex = -1
          this.buffer = this.draft
          this.cursor = this.buffer.length
          this.redraw()
        }
        return
      }
      this.historyIndex = next
    }
    this.buffer = this.historyIndex === -1 ? this.draft : this.history[this.historyIndex]!
    this.cursor = this.buffer.length
    this.redraw()
  }

  private killWordBack(): void {
    const left = this.buffer.slice(0, this.cursor)
    const cut = left.replace(/[^\s]*\s*$/u, '')
    this.buffer = cut + this.buffer.slice(this.cursor)
    this.cursor = cut.length
    this.redraw()
  }

  private moveWord(delta: -1 | 1): void {
    if (delta === -1) {
      const left = this.buffer.slice(0, this.cursor)
      const match = left.match(/[^\s]+\s*$/u)
      this.cursor = match !== null && match.index !== undefined ? match.index : 0
    } else {
      const right = this.buffer.slice(this.cursor)
      const match = right.match(/^\s*[^\s]+/u)
      this.cursor += match !== null ? match[0].length : right.length
    }
    this.redraw()
  }

  private handle(chunk: Buffer): void {
    const text = this.decoder.write(chunk)
    let i = 0
    while (i < text.length) {
      const char = text[i]!
      // Escape sequences.
      if (char === '\x1b') {
        const seq = text.slice(i)
        const arrow = seq.match(/^\x1b\[([ABCD])/u)?.[1]
        const word = seq.match(/^\x1b\[1;5([CD])/u)?.[1]
        const del = seq.startsWith('\x1b[3~')
        const home = seq.startsWith('\x1b[H') || seq.startsWith('\x1b[1~')
        const end = seq.startsWith('\x1b[F') || seq.startsWith('\x1b[4~')
        if (arrow !== undefined) {
          if (arrow === 'A' && this.oneshot === undefined) this.recall(-1)
          else if (arrow === 'B' && this.oneshot === undefined) this.recall(1)
          else if (arrow === 'C' && this.cursor < this.buffer.length) { this.cursor++; this.redraw() }
          else if (arrow === 'D' && this.cursor > 0) { this.cursor--; this.redraw() }
          i += 3
          continue
        }
        if (word !== undefined) {
          this.moveWord(word === 'C' ? 1 : -1)
          i += 6
          continue
        }
        if (del) {
          if (this.cursor < this.buffer.length) {
            this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1)
            this.redraw()
          }
          i += 4
          continue
        }
        if (home) { this.cursor = 0; this.redraw(); i += seq.startsWith('\x1b[1~') ? 4 : 2; continue }
        if (end) { this.cursor = this.buffer.length; this.redraw(); i += seq.startsWith('\x1b[4~') ? 4 : 2; continue }
        // Lone escape: clear line (oneshot) or hint.
        if (this.oneshot !== undefined) {
          this.buffer = ''
          this.cursor = 0
          this.redraw()
        } else {
          this.cbs.onInterruptHint?.()
        }
        i += 1
        continue
      }
      // Control keys.
      if (char === '\r' || char === '\n') {
        const line = this.buffer
        const one = this.oneshot
        this.oneshot = undefined
        this.stdout.write('\n')
        if (one !== undefined) {
          one.resolve(line)
        } else {
          this.commitHistory(line)
          this.cbs.onSubmit(line)
        }
        // Callback may deactivate; reset defensively.
        this.buffer = ''
        this.cursor = 0
        this.historyIndex = -1
        i += 1
        continue
      }
      if (char === '\x03') { // Ctrl-C
        if (this.oneshot !== undefined) {
          const one = this.oneshot
          this.oneshot = undefined
          this.stdout.write('\n')
          one.resolve('')
        } else {
          this.cbs.onCtrlC()
        }
        i += 1
        continue
      }
      if (char === '\x04') { // Ctrl-D
        if (this.buffer === '' && this.oneshot === undefined) this.cbs.onCtrlD()
        i += 1
        continue
      }
      if (char === '\x7f' || char === '\b') {
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor)
          this.cursor--
          this.redraw()
        }
        i += 1
        continue
      }
      if (char === '\x01') { this.cursor = 0; this.redraw(); i += 1; continue } // Ctrl-A
      if (char === '\x05') { this.cursor = this.buffer.length; this.redraw(); i += 1; continue } // Ctrl-E
      if (char === '\x15') { // Ctrl-U
        this.buffer = this.buffer.slice(this.cursor)
        this.cursor = 0
        this.redraw()
        i += 1
        continue
      }
      if (char === '\x0b') { // Ctrl-K
        this.buffer = this.buffer.slice(0, this.cursor)
        this.redraw()
        i += 1
        continue
      }
      if (char === '\x17') { this.killWordBack(); i += 1; continue } // Ctrl-W
      if (char === '\x0c') { this.stdout.write('\x1b[2J\x1b[H'); this.redraw(); i += 1; continue } // Ctrl-L
      if (char === '\x0e' && this.oneshot === undefined) { this.recall(1); i += 1; continue } // Ctrl-N
      if (char === '\x10' && this.oneshot === undefined) { this.recall(-1); i += 1; continue } // Ctrl-P
      if (char < ' ' || char === '\x7f') { i += 1; continue }
      // Printable run.
      let j = i + 1
      while (j < text.length) {
        const next = text[j]!
        if (next === '\x1b' || next < ' ' || next === '\x7f') break
        j++
      }
      const run = text.slice(i, j)
      this.buffer = this.buffer.slice(0, this.cursor) + run + this.buffer.slice(this.cursor)
      this.cursor += run.length
      this.redraw()
      i = j
    }
  }
}

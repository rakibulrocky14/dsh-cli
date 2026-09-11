/**
 * Minimal ANSI chrome for the terminal surface. Colors degrade when
 * `NO_COLOR` is set or stdout is not a TTY.
 * @module dsh-terminal/ui
 */

const ESC = '\u001b['
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined

function wrap(open: number, close: number): (s: string) => string {
  if (!useColor) return s => s
  return s => `${ESC}${String(open)}m${s}${ESC}${String(close)}m`
}

export const dim = wrap(2, 22)
export const bold = wrap(1, 22)
export const cyan = wrap(36, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const red = wrap(31, 39)
export const magenta = wrap(35, 39)
export const gray = wrap(90, 39)

/** Truncate a string for one status line. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`
}

/** Render a horizontal rule sized to the terminal. */
export function rule(label?: string): string {
  const width = process.stdout.columns || 80
  if (label === undefined || label === '') return dim('─'.repeat(width))
  const head = ` ${label} `
  const pad = Math.max(0, width - head.length)
  return dim(head + '─'.repeat(pad))
}

/** Status chrome line under the header. */
export function statusBar(parts: { label: string; value: string }[]): string {
  return parts
    .filter(p => p.value !== '')
    .map(p => `${dim(p.label)} ${p.value}`)
    .join(dim(' · '))
}

/** Clear screen and home cursor (used by /clear). */
export function clearScreen(write: (s: string) => void): void {
  write(`${ESC}2J${ESC}H`)
}

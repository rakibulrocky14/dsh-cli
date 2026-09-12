/** SGR (1006) mouse reports forwarded by Ink's input parser. */
export interface MouseReport {
  button: number
  x: number
  y: number
  release: boolean
  shift: boolean
  meta: boolean
  ctrl: boolean
}

function parseDecimal(value: string, maxDigits: number): number | undefined {
  if (value.length === 0 || value.length > maxDigits) return undefined
  for (const character of value) {
    if (character < '0' || character > '9') return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Ink strips the leading escape byte from otherwise-unhandled CSI input, so
 * SGR mouse events arrive as `[<button;column;rowM` (or `m` on release).
 */
export function parseMouseReport(input: string): MouseReport | undefined {
  if (!input.startsWith('[<')) return undefined
  const suffix = input.at(-1)
  if (suffix !== 'M' && suffix !== 'm') return undefined
  const fields = input.slice(2, -1).split(';')
  if (fields.length !== 3) return undefined
  const button = parseDecimal(fields[0] ?? '', 4)
  const column = parseDecimal(fields[1] ?? '', 5)
  const row = parseDecimal(fields[2] ?? '', 5)
  if (button === undefined || column === undefined || row === undefined || column < 1 || row < 1) return undefined
  return {
    button,
    x: column - 1,
    y: row - 1,
    release: suffix === 'm',
    shift: (button & 4) !== 0,
    meta: (button & 8) !== 0,
    ctrl: (button & 16) !== 0,
  }
}

/** Wheel direction: 0 up, 1 down, 2 left, 3 right. */
export function wheelDirection(report: MouseReport): number | undefined {
  return (report.button & 64) === 0 ? undefined : report.button & 3
}

/** Enable button-event tracking with printable SGR coordinates. */
export const ENABLE_MOUSE_REPORTING = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'

/** Disable every mouse mode enabled above, in reverse order. */
export const DISABLE_MOUSE_REPORTING = '\x1b[?1006l\x1b[?1002l\x1b[?1000l'

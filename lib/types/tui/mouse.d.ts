/** SGR (1006) mouse reports forwarded by Ink's input parser. */
export interface MouseReport {
    button: number;
    x: number;
    y: number;
    release: boolean;
    shift: boolean;
    meta: boolean;
    ctrl: boolean;
}
/**
 * Ink strips the leading escape byte from otherwise-unhandled CSI input, so
 * SGR mouse events arrive as `[<button;column;rowM` (or `m` on release).
 */
export declare function parseMouseReport(input: string): MouseReport | undefined;
/** Wheel direction: 0 up, 1 down, 2 left, 3 right. */
export declare function wheelDirection(report: MouseReport): number | undefined;
/** Enable button-event tracking with printable SGR coordinates. */
export declare const ENABLE_MOUSE_REPORTING = "\u001B[?1000h\u001B[?1002h\u001B[?1006h";
/** Disable every mouse mode enabled above, in reverse order. */
export declare const DISABLE_MOUSE_REPORTING = "\u001B[?1006l\u001B[?1002l\u001B[?1000l";

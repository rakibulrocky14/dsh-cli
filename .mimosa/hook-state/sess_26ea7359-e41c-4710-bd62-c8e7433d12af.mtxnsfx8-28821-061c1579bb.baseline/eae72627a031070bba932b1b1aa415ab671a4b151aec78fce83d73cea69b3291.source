/**
 * Minimal ANSI chrome for the terminal surface. Colors degrade when
 * `NO_COLOR` is set or stdout is not a TTY.
 * @module dsh-terminal/ui
 */
export declare const dim: (s: string) => string;
export declare const bold: (s: string) => string;
export declare const cyan: (s: string) => string;
export declare const green: (s: string) => string;
export declare const yellow: (s: string) => string;
export declare const red: (s: string) => string;
export declare const magenta: (s: string) => string;
export declare const gray: (s: string) => string;
/** Truncate a string for one status line. */
export declare function clip(text: string, max: number): string;
/** Render a horizontal rule sized to the terminal. */
export declare function rule(label?: string): string;
/** Status chrome line under the header. */
export declare function statusBar(parts: {
    label: string;
    value: string;
}[]): string;
/** Clear screen and home cursor (used by /clear). */
export declare function clearScreen(write: (s: string) => void): void;

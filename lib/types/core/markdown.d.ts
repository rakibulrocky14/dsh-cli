/**
 * Block-level markdown for the terminal surface: headings, tables, lists,
 * quotes, rules, and paragraphs. Inline spans stay in transcript.parseInline.
 *
 * @module dsh-terminal/core/markdown
 */
/** One block-level markdown node after fence splitting. */
export type MdBlock = {
    kind: 'heading';
    level: number;
    text: string;
} | {
    kind: 'para';
    text: string;
} | {
    kind: 'list';
    ordered: boolean;
    items: string[];
} | {
    kind: 'quote';
    lines: string[];
} | {
    kind: 'hr';
} | {
    kind: 'table';
    headers: string[];
    rows: string[][];
};
/**
 * Parse block-level markdown. Fenced code is handled separately by
 * splitFences in the transcript module.
 */
export declare function parseMarkdown(text: string): MdBlock[];

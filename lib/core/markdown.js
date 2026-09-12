/**
 * Block-level markdown for the terminal surface: headings, tables, lists,
 * quotes, rules, and paragraphs. Inline spans stay in transcript.parseInline.
 *
 * @module dsh-terminal/core/markdown
 */
function isTableSep(line) {
    const t = line.trim();
    if (!t.includes('-') || !t.includes('|'))
        return false;
    for (const ch of t) {
        if (ch !== '|' && ch !== '-' && ch !== ':' && ch !== ' ')
            return false;
    }
    return true;
}
function isTableRow(line) {
    const t = line.trim();
    return t.startsWith('|') && t.includes('|', 1);
}
function splitCells(line) {
    let t = line.trim();
    if (t.startsWith('|'))
        t = t.slice(1);
    if (t.endsWith('|'))
        t = t.slice(0, -1);
    return t.split('|').map(c => c.trim());
}
function headingLevel(line) {
    let n = 0;
    while (n < line.length && n < 3 && line[n] === '#')
        n++;
    if (n === 0 || line[n] !== ' ')
        return 0;
    return line[n + 1] !== undefined && line[n + 1] !== ' ' ? n : (line.slice(n + 1).trim() === '' ? 0 : n);
}
function isRule(line) {
    if (line.length < 3)
        return false;
    const ch = line[0];
    if (ch !== '-' && ch !== '*' && ch !== '_')
        return false;
    for (const c of line)
        if (c !== ch)
            return false;
    return true;
}
function isBullet(line) {
    const mark = line[0];
    return (mark === '-' || mark === '*' || mark === '+') && line[1] === ' ' && line[2] !== undefined && line[2] !== ' ';
}
function orderedPrefix(line) {
    let i = 0;
    while (i < line.length && line[i] >= '0' && line[i] <= '9')
        i++;
    if (i === 0)
        return 0;
    const sep = line[i];
    if (sep !== '.' && sep !== ')')
        return 0;
    if (line[i + 1] !== ' ')
        return 0;
    if (line[i + 2] === undefined)
        return 0;
    return i + 2;
}
function isBlockStart(lines, idx) {
    const line = lines[idx]?.trim() ?? '';
    if (line === '')
        return true;
    if (headingLevel(line) > 0)
        return true;
    if (isRule(line))
        return true;
    if (isTableRow(line) && idx + 1 < lines.length && isTableSep(lines[idx + 1]))
        return true;
    if (isBullet(line) || orderedPrefix(line) > 0)
        return true;
    return line.startsWith('>');
}
/**
 * Parse block-level markdown. Fenced code is handled separately by
 * splitFences in the transcript module.
 */
export function parseMarkdown(text) {
    const lines = text.split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
        const start = i;
        const raw = lines[i];
        const trimmed = raw.trim();
        if (trimmed === '') {
            i++;
            continue;
        }
        const level = headingLevel(trimmed);
        if (level > 0) {
            blocks.push({ kind: 'heading', level, text: trimmed.slice(level + 1).trim() });
            i++;
            continue;
        }
        if (isRule(trimmed)) {
            blocks.push({ kind: 'hr' });
            i++;
            continue;
        }
        if (isTableRow(trimmed) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const headers = splitCells(trimmed);
            i += 2;
            const rows = [];
            while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
                rows.push(splitCells(lines[i]));
                i++;
            }
            blocks.push({ kind: 'table', headers, rows });
            continue;
        }
        const ordered = orderedPrefix(trimmed) > 0;
        if (ordered || isBullet(trimmed)) {
            const items = [];
            while (i < lines.length) {
                const t = lines[i].trim();
                if (ordered) {
                    const cut = orderedPrefix(t);
                    if (cut === 0)
                        break;
                    items.push(t.slice(cut));
                }
                else {
                    if (!isBullet(t))
                        break;
                    items.push(t.slice(2));
                }
                i++;
            }
            blocks.push({ kind: 'list', ordered, items });
            continue;
        }
        if (trimmed.startsWith('>')) {
            const quote = [];
            while (i < lines.length && lines[i].trim().startsWith('>')) {
                const body = lines[i].trim().slice(1);
                quote.push(body.startsWith(' ') ? body.slice(1) : body);
                i++;
            }
            blocks.push({ kind: 'quote', lines: quote });
            continue;
        }
        const para = [];
        while (i < lines.length) {
            const t = lines[i].trim();
            if (para.length > 0 && isBlockStart(lines, i))
                break;
            para.push(t);
            i++;
        }
        if (para.length > 0)
            blocks.push({ kind: 'para', text: para.join(' ') });
        if (i === start) {
            // Guaranteed forward progress fail-safe: never hang in an infinite loop.
            i++;
        }
    }
    return blocks;
}

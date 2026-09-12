/**
 * Structural DSH types used by the terminal surface.
 *
 * The surface loads zero `@deepseek-ai/*` runtime modules: every value below
 * describes a shape received through the Cordis context, so the code runs
 * against any installed dsh whose services match these fields. Members that
 * differ between releases are optional and probed at runtime.
 *
 * @module dsh-terminal/core/types
 */
/** Read a service through the context, tolerating absence. */
export function service(ctx, name) {
    try {
        const value = ctx.get(name);
        return (value === undefined || value === null ? undefined : value);
    }
    catch {
        return undefined;
    }
}
/** True when `value` is an object with a callable `method`. */
export function hasMethod(value, method) {
    return typeof value === 'object' && value !== null
        && typeof value[method] === 'function';
}
/** Read the durable log across releases (events snapshot, else indexed read). */
export function readSessionEvents(session) {
    if (Array.isArray(session.events))
        return session.events;
    if (typeof session.eventAt === 'function') {
        const out = [];
        const length = session.seq;
        for (let seq = 0; seq < length; seq++) {
            const event = session.eventAt(seq);
            if (event !== undefined)
                out.push(event);
        }
        return out;
    }
    return [];
}

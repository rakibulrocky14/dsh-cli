/**
 * Local message factories mirroring `@deepseek-ai/dsh-llm` (deep-frozen,
 * detached identities). The surface ships no llm runtime import, so these
 * stay byte-compatible with the loop's contract instead.
 *
 * @module dsh-terminal/core/messages
 */
/** User-role message input (role/id are minted here). */
export interface UserMessageInput {
    content: {
        type: string;
        text?: string;
    }[];
    source: {
        kind: string;
        plugin?: string;
        form?: string;
        summary?: string;
    };
}
/**
 * Create one identified, immutable user-role message.
 * @param input - content blocks and producer source.
 * @returns the frozen message the inbox accepts.
 */
export declare function createUserMessage(input: UserMessageInput): unknown;
/**
 * Create the durable model-switch notice upstream model-selection appends.
 * @param from - previous `provider/model` label.
 * @param to - selected `provider/model` label.
 * @returns the frozen notice message.
 */
export declare function createModelSwitchNotice(from: string, to: string): unknown;

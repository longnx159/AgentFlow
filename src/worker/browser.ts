import type { BrowserResult } from '../shared/types.js';
export interface SendReceipt {
  marker: string;
  baselineUserIds: string[];
  conversationId?: string;
  userMessageId?: string;
  error?: string;
}
export interface BrowserSession {
  ready?(): Promise<boolean>;
  prepare(prompt: string, marker: string): Promise<SendReceipt>;
  clickSend(receipt: SendReceipt, onReceipt: (receipt: SendReceipt) => void): Promise<SendReceipt>;
  read(receipt: SendReceipt): Promise<any>;
  close(): Promise<void>;
}
export interface BrowserDriver {
  ready?(): Promise<boolean>;
  prepare(prompt: string, marker: string): Promise<SendReceipt>;
  send(
    receipt: SendReceipt,
    beforeGesture: () => void,
    onReceipt: (receipt: SendReceipt) => void,
  ): Promise<SendReceipt>;
  observe(receipt: SendReceipt): Promise<BrowserResult>;
  close(): Promise<void>;
}
export function correlateConversation(tree: any, receipt: SendReceipt): BrowserResult {
  const uncertain = (error: string): BrowserResult => ({
    status: 'uncertain',
    conversationId: receipt.conversationId,
    userMessageId: receipt.userMessageId,
    error,
  });
  if (!receipt.userMessageId || !tree?.mapping || !tree.current_node)
    return uncertain('Missing submitted user receipt or conversation tree');
  let node = tree.mapping[tree.current_node];
  const seen = new Set<string>();
  let reply: any;
  while (node) {
    const m = node.message;
    if (m?.author?.role === 'user') {
      if (m.id !== receipt.userMessageId)
        return uncertain('Current branch belongs to another user message');
      if (!reply) return uncertain('No final assistant reply on submitted branch');
      const parts = reply.content?.parts;
      if (
        !Array.isArray(parts) ||
        parts.length === 0 ||
        parts.some((p: any) => typeof p !== 'string')
      )
        return uncertain('Non-text or missing raw parts require operator inspection');
      const text = parts.join('');
      if (text.length === 0) return uncertain('Empty response is not a synthetic success');
      const ended = reply.status === 'finished_successfully' && reply.end_turn === true;
      const finishDetails = reply.metadata?.finish_details ?? reply.finish_details ?? null;
      const clipped = ended && ['max_tokens', 'length'].includes(finishDetails?.type);
      return {
        status: ended && !clipped ? 'complete' : 'partial',
        text,
        parts,
        conversationId: receipt.conversationId,
        userMessageId: receipt.userMessageId,
        replyId: reply.id,
        metadata: {
          source: 'authenticated-conversation-tree',
          messageStatus: reply.status,
          endTurn: reply.end_turn,
          channel: reply.channel ?? null,
          finishDetails,
          messageMetadata: reply.metadata ?? {},
          terminal: ended,
        },
      };
    }
    if (
      !reply &&
      m?.author?.role === 'assistant' &&
      (!m.recipient || m.recipient === 'all') &&
      (!m.channel || m.channel === 'final') &&
      ['text', 'multimodal_text'].includes(m.content?.content_type)
    )
      reply = m;
    if (!node.parent || seen.has(node.parent)) break;
    seen.add(node.parent);
    node = tree.mapping[node.parent];
  }
  return uncertain('Submitted user ancestry could not be proven');
}
export class ChatGptDriver implements BrowserDriver {
  constructor(private session: BrowserSession) {}
  async ready() {
    return this.session.ready ? this.session.ready() : true;
  }
  async prepare(p: string, m: string) {
    return this.session.prepare(p, m);
  }
  async send(r: SendReceipt, before: () => void, onReceipt: (r: SendReceipt) => void) {
    let latest = r;
    // The durable commit must complete before the ONE gesture. An ambiguous click
    // is observation-only from this point; no Enter fallback or retry exists.
    before();
    try {
      return await this.session.clickSend(r, (next) => {
        latest = next;
        onReceipt(next);
      });
    } catch (error) {
      return { ...latest, error: String(error) };
    }
  }
  async observe(r: SendReceipt): Promise<BrowserResult> {
    if (!r.userMessageId)
      return { status: 'uncertain', error: 'No durable submitted-user receipt; never resubmit' };
    try {
      return correlateConversation(await this.session.read(r), r);
    } catch (error) {
      return {
        status: 'uncertain',
        error: String(error),
        userMessageId: r.userMessageId,
        conversationId: r.conversationId,
      };
    }
  }
  async close() {
    await this.session.close();
  }
}

/**
 * Tracks Copilot Studio conversations that need follow-up (e.g. consent flows).
 * When a tool call returns adaptive cards, the conversation is stored here so that
 * a subsequent invoke (user clicking Allow) can continue the same conversation.
 *
 * Shared via globalThis so the msteams plugin can signal when an invoke arrives.
 */

export type PendingConversation = {
  conversationId: string;
  toolName: string;
  timestamp: number;
};

export type PendingInvoke = {
  actionData: unknown;
  timestamp: number;
};

const CONVERSATIONS_KEY = "__openclaw_copilot_pending_conversations";
const INVOKES_KEY = "__openclaw_copilot_pending_invokes";

type GlobalStore = {
  [CONVERSATIONS_KEY]?: PendingConversation[];
  [INVOKES_KEY]?: PendingInvoke[];
};

function getConversations(): PendingConversation[] {
  const g = globalThis as unknown as GlobalStore;
  if (!g[CONVERSATIONS_KEY]) g[CONVERSATIONS_KEY] = [];
  return g[CONVERSATIONS_KEY];
}

function getInvokes(): PendingInvoke[] {
  const g = globalThis as unknown as GlobalStore;
  if (!g[INVOKES_KEY]) g[INVOKES_KEY] = [];
  return g[INVOKES_KEY];
}

/**
 * Store a conversation that may need follow-up (e.g. waiting for user consent).
 */
export function storePendingConversation(entry: PendingConversation): void {
  const store = getConversations();
  // Remove stale entries (> 10 min old)
  const cutoff = Date.now() - 10 * 60 * 1000;
  const fresh = store.filter((e) => e.timestamp > cutoff);
  fresh.push(entry);
  const g = globalThis as unknown as GlobalStore;
  g[CONVERSATIONS_KEY] = fresh;
}

/**
 * Pop the most recent pending conversation for a given tool.
 * Returns null if none found.
 */
export function popPendingConversation(toolName: string): PendingConversation | null {
  const store = getConversations();
  const cutoff = Date.now() - 10 * 60 * 1000;
  // Find most recent matching conversation
  for (let i = store.length - 1; i >= 0; i--) {
    const entry = store[i];
    if (entry.toolName === toolName && entry.timestamp > cutoff) {
      store.splice(i, 1);
      return entry;
    }
  }
  return null;
}

/**
 * Store invoke data from an adaptive card button click.
 * The copilot-studio tool will pick this up on next invocation.
 */
export function storeInvokeData(invoke: PendingInvoke): void {
  getInvokes().push(invoke);
}

/**
 * Pop the most recent pending invoke data.
 */
export function popPendingInvoke(): PendingInvoke | null {
  const store = getInvokes();
  if (store.length === 0) return null;
  return store.shift() ?? null;
}

/**
 * Process-global queue for adaptive cards that need to be forwarded to the
 * user's channel (e.g. Teams) as native attachments.
 *
 * Both the copilot-studio plugin (producer) and the msteams plugin (consumer)
 * run in the same Node.js process, so globalThis is a reliable transport.
 */

export type PendingAdaptiveCard = {
  contentType: string;
  content: unknown;
  name?: string;
};

export type PendingCardEntry = {
  cards: PendingAdaptiveCard[];
  conversationId: string;
  text?: string;
  timestamp: number;
};

const GLOBAL_KEY = "__openclaw_pending_adaptive_cards";

type GlobalStore = { [GLOBAL_KEY]?: PendingCardEntry[] };

function getStore(): PendingCardEntry[] {
  const g = globalThis as unknown as GlobalStore;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = [];
  }
  return g[GLOBAL_KEY];
}

/**
 * Enqueue adaptive cards for the channel to pick up and send natively.
 */
export function enqueuePendingCards(entry: PendingCardEntry): void {
  getStore().push(entry);
}

/**
 * Drain all pending cards from the queue (consumer side).
 * Returns the entries and removes them from the queue.
 */
export function drainPendingCards(): PendingCardEntry[] {
  const store = getStore();
  const entries = store.splice(0, store.length);
  return entries;
}

/**
 * Check if there are pending cards without draining.
 */
export function hasPendingCards(): boolean {
  return getStore().length > 0;
}

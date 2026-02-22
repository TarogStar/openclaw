import { afterEach, describe, expect, it } from "vitest";
import {
  drainPendingCards,
  enqueuePendingCards,
  hasPendingCards,
  type PendingCardEntry,
} from "./adaptive-card-queue.js";

const GLOBAL_KEY = "__openclaw_pending_adaptive_cards";

function clearQueue() {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = undefined;
}

function makeEntry(id = "conv-1"): PendingCardEntry {
  return {
    cards: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { body: [] } }],
    conversationId: id,
    timestamp: Date.now(),
  };
}

describe("adaptive-card-queue", () => {
  afterEach(() => {
    clearQueue();
  });

  it("starts empty", () => {
    expect(hasPendingCards()).toBe(false);
    expect(drainPendingCards()).toEqual([]);
  });

  it("enqueue makes hasPendingCards true", () => {
    enqueuePendingCards(makeEntry());
    expect(hasPendingCards()).toBe(true);
  });

  it("drain returns all enqueued entries", () => {
    const a = makeEntry("conv-a");
    const b = makeEntry("conv-b");
    enqueuePendingCards(a);
    enqueuePendingCards(b);

    const drained = drainPendingCards();
    expect(drained).toHaveLength(2);
    expect(drained[0].conversationId).toBe("conv-a");
    expect(drained[1].conversationId).toBe("conv-b");
  });

  it("drain empties the queue", () => {
    enqueuePendingCards(makeEntry());
    drainPendingCards();

    expect(hasPendingCards()).toBe(false);
    expect(drainPendingCards()).toEqual([]);
  });

  it("preserves card content and optional text", () => {
    const entry: PendingCardEntry = {
      cards: [
        { contentType: "application/vnd.microsoft.card.adaptive", content: { body: [1, 2] } },
      ],
      conversationId: "conv-x",
      text: "Please approve",
      timestamp: 1000,
    };
    enqueuePendingCards(entry);
    const [result] = drainPendingCards();
    expect(result.text).toBe("Please approve");
    expect(result.cards[0].content).toEqual({ body: [1, 2] });
  });
});

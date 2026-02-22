import { afterEach, describe, expect, it, vi } from "vitest";
import {
  popPendingConversation,
  popPendingInvoke,
  storePendingConversation,
  storeInvokeData,
} from "./pending-conversations.js";

const CONVERSATIONS_KEY = "__openclaw_copilot_pending_conversations";
const INVOKES_KEY = "__openclaw_copilot_pending_invokes";

function clearStore() {
  const g = globalThis as Record<string, unknown>;
  g[CONVERSATIONS_KEY] = undefined;
  g[INVOKES_KEY] = undefined;
}

describe("pending-conversations", () => {
  afterEach(() => {
    clearStore();
    vi.restoreAllMocks();
  });

  describe("storePendingConversation / popPendingConversation", () => {
    it("stores and pops a conversation by toolName", () => {
      storePendingConversation({
        conversationId: "conv-1",
        toolName: "email",
        timestamp: Date.now(),
      });

      const result = popPendingConversation("email");
      expect(result).not.toBeNull();
      expect(result!.conversationId).toBe("conv-1");
    });

    it("returns null when no matching toolName", () => {
      storePendingConversation({
        conversationId: "conv-1",
        toolName: "email",
        timestamp: Date.now(),
      });

      expect(popPendingConversation("calendar")).toBeNull();
    });

    it("returns most recent match (reverse scan)", () => {
      storePendingConversation({
        conversationId: "conv-old",
        toolName: "email",
        timestamp: Date.now() - 1000,
      });
      storePendingConversation({
        conversationId: "conv-new",
        toolName: "email",
        timestamp: Date.now(),
      });

      const result = popPendingConversation("email");
      expect(result!.conversationId).toBe("conv-new");
    });

    it("removes popped entry from store", () => {
      storePendingConversation({
        conversationId: "conv-1",
        toolName: "email",
        timestamp: Date.now(),
      });

      popPendingConversation("email");
      expect(popPendingConversation("email")).toBeNull();
    });

    it("removes stale entries older than 10 minutes on store", () => {
      const g = globalThis as Record<string, unknown>;
      // Pre-populate with a stale entry
      g[CONVERSATIONS_KEY] = [
        { conversationId: "stale", toolName: "email", timestamp: Date.now() - 11 * 60 * 1000 },
      ];

      storePendingConversation({
        conversationId: "fresh",
        toolName: "calendar",
        timestamp: Date.now(),
      });

      // Stale entry should have been cleaned up
      expect(popPendingConversation("email")).toBeNull();
      expect(popPendingConversation("calendar")).not.toBeNull();
    });

    it("ignores stale entries on pop", () => {
      const staleTimestamp = Date.now() - 11 * 60 * 1000;
      storePendingConversation({
        conversationId: "conv-stale",
        toolName: "email",
        timestamp: staleTimestamp,
      });

      // Manually set the stored timestamp to stale (storePendingConversation cleans on insert
      // but we need the entry to be stale at pop time)
      const g = globalThis as Record<string, unknown>;
      const store = g[CONVERSATIONS_KEY] as Array<{
        conversationId: string;
        toolName: string;
        timestamp: number;
      }>;
      store[0].timestamp = staleTimestamp;

      expect(popPendingConversation("email")).toBeNull();
    });
  });

  describe("storeInvokeData / popPendingInvoke", () => {
    it("stores and pops invoke data (FIFO)", () => {
      storeInvokeData({ actionData: { action: "allow" }, timestamp: 1000 });
      storeInvokeData({ actionData: { action: "deny" }, timestamp: 2000 });

      const first = popPendingInvoke();
      expect(first).not.toBeNull();
      expect((first!.actionData as Record<string, string>).action).toBe("allow");

      const second = popPendingInvoke();
      expect(second).not.toBeNull();
      expect((second!.actionData as Record<string, string>).action).toBe("deny");
    });

    it("returns null when empty", () => {
      expect(popPendingInvoke()).toBeNull();
    });

    it("returns null after all consumed", () => {
      storeInvokeData({ actionData: "x", timestamp: 1000 });
      popPendingInvoke();
      expect(popPendingInvoke()).toBeNull();
    });
  });
});

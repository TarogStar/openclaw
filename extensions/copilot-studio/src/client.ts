import type { CopilotStudioAuth } from "./auth.js";

export type CopilotStudioClientConfig = {
  directConnectUrl: string;
};

export type SSEActivity = {
  type?: string;
  text?: string;
  conversation?: { id?: string };
  channelData?: { streamType?: string; streamId?: string };
  entities?: Array<{ type?: string; streamType?: string }>;
  attachments?: Array<{
    contentType?: string;
    content?: unknown;
    name?: string;
  }>;
  name?: string;
  value?: unknown;
};

export type AdaptiveCard = {
  contentType: string;
  content: unknown;
  name?: string;
};

export type QueryResult = {
  text: string;
  activities: SSEActivity[];
  adaptiveCards: AdaptiveCard[];
  conversationId: string;
};

/**
 * Lightweight Node.js client for Copilot Studio Direct Connect API.
 * Matches the @microsoft/agents-copilotstudio-client SDK behavior:
 * 1. POST to /conversations with { emitStartConversationEvent } → get conversation ID from x-ms-conversationid header
 * 2. POST to /conversations/{id} with { activity: { type: "message", text } } → get SSE response
 */
export class CopilotStudioClient {
  private directConnectUrl: string;
  private auth: CopilotStudioAuth;
  private log: (msg: string) => void;

  constructor(
    config: CopilotStudioClientConfig,
    auth: CopilotStudioAuth,
    log?: (msg: string) => void,
  ) {
    this.directConnectUrl = config.directConnectUrl;
    this.auth = auth;
    this.log = log ?? console.log;
  }

  /**
   * Build the base conversations URL (strip any existing /conversations path + query params).
   */
  private getConversationsUrl(conversationId?: string): string {
    const url = new URL(this.directConnectUrl);
    // Strip existing /conversations path if present (SDK does this)
    const convIdx = url.pathname.indexOf("/conversations");
    if (convIdx !== -1) {
      url.pathname = url.pathname.substring(0, convIdx);
    }
    url.pathname = `${url.pathname}/conversations`;
    if (conversationId) {
      url.pathname = `${url.pathname}/${conversationId}`;
    }
    return url.href;
  }

  /**
   * Send a message to the Copilot Studio agent and get the full response.
   * Creates a new conversation per call (stateless tool gateway pattern).
   */
  async query(message: string, timeoutMs = 120_000): Promise<QueryResult> {
    const token = await this.auth.getToken();
    this.log(`[copilot-studio] query: ${message.slice(0, 100)}`);

    // Step 1: Start conversation (get ID from response header)
    const conversationId = await this.startConversation(token, timeoutMs);

    // Step 2: Send message and collect response
    return await this.sendMessage(token, conversationId, message, timeoutMs);
  }

  /**
   * Continue an existing conversation (e.g. to complete a consent flow).
   * Sends an activity to the same conversation and collects the response.
   * If activityValue is provided, it's included as the activity's value
   * field (for Action.Submit consent acknowledgments).
   */
  async continueConversation(
    conversationId: string,
    message: string,
    timeoutMs = 120_000,
    activityValue?: unknown,
  ): Promise<QueryResult> {
    const token = await this.auth.getToken();
    this.log(
      `[copilot-studio] continueConversation: ${conversationId.slice(0, 12)}... msg=${message.slice(0, 80)}${activityValue ? " +value" : ""}`,
    );
    return await this.sendMessage(token, conversationId, message, timeoutMs, activityValue);
  }

  /**
   * Start a new conversation. Returns the conversation ID from the
   * x-ms-conversationid response header (matching SDK behavior).
   */
  private async startConversation(token: string, timeoutMs: number): Promise<string> {
    const url = this.getConversationsUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ emitStartConversationEvent: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.log(
          `[copilot-studio] startConversation failed: ${res.status} ${detail || res.statusText}`,
        );
        throw new Error(`Start conversation failed (${res.status}): ${detail || res.statusText}`);
      }

      // Get conversation ID from response header (primary method per SDK)
      const conversationId = res.headers.get("x-ms-conversationid") || "";
      this.log(
        `[copilot-studio] startConversation: ${res.status}, conversationId=${conversationId || "(not in header)"}`,
      );

      // Drain the SSE stream so the connection closes cleanly
      if (res.body) {
        const reader = res.body.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* ok */
          }
        }
      }

      if (!conversationId) {
        throw new Error("No conversation ID in x-ms-conversationid header");
      }

      this.log(`[copilot-studio] Conversation started: ${conversationId.slice(0, 12)}...`);
      return conversationId;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a message to an existing conversation and collect the full response.
   * If activityValue is provided, it's sent as the activity's value field
   * (used for Action.Submit consent responses).
   */
  private async sendMessage(
    token: string,
    conversationId: string,
    message: string,
    timeoutMs: number,
    activityValue?: unknown,
  ): Promise<QueryResult> {
    const url = this.getConversationsUrl(conversationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // When activityValue is present (consent Action.Submit response), send
      // ONLY the value with empty text. Including the tool prompt text causes
      // Copilot Studio to treat it as a new query and restart the consent flow.
      const activity: Record<string, unknown> = {
        type: "message",
        text: activityValue !== undefined ? "" : message,
        conversation: { id: conversationId },
      };
      if (activityValue !== undefined) {
        activity.value = activityValue;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ activity }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.log(`[copilot-studio] sendMessage failed: ${res.status} ${detail || res.statusText}`);
        throw new Error(`Copilot Studio API error (${res.status}): ${detail || res.statusText}`);
      }

      this.log(`[copilot-studio] sendMessage: ${res.status}, collecting response...`);
      const result = await this.collectActivities(res, controller.signal, conversationId);
      this.log(
        `[copilot-studio] result (${result.text.length} chars, ${result.activities.length} activities, ${result.adaptiveCards.length} cards): ${result.text.slice(0, 200)}`,
      );

      if (!result.text && result.activities.length === 0 && result.adaptiveCards.length === 0) {
        throw new Error("Copilot Studio returned an empty response");
      }

      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Collect all activities from the SSE response stream and build a QueryResult.
   */
  private async collectActivities(
    res: Response,
    signal: AbortSignal,
    conversationId: string,
  ): Promise<QueryResult> {
    const emptyResult: QueryResult = {
      text: "",
      activities: [],
      adaptiveCards: [],
      conversationId,
    };
    if (!res.body) return emptyResult;

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const streamTexts = new Map<string, string>();
    const standaloneTexts: string[] = [];
    const allActivities: SSEActivity[] = [];
    const adaptiveCards: AdaptiveCard[] = [];

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ") || line.includes("data: end")) continue;
          const jsonStr = line.substring(6).trim();
          if (!jsonStr || jsonStr === "end") continue;

          try {
            const activity = JSON.parse(jsonStr) as SSEActivity;
            this.log(
              `[copilot-studio] SSE: type=${activity.type} name=${activity.name ?? "none"} stream=${activity.channelData?.streamType ?? "none"} text=${activity.text?.slice(0, 80) ?? "(none)"} attachments=${activity.attachments?.length ?? 0}`,
            );

            // Capture non-typing activities for inspection
            if (activity.type !== "typing" || activity.channelData?.streamType === "informative") {
              allActivities.push(activity);
            }

            // Extract adaptive cards from attachments
            if (activity.attachments) {
              for (const att of activity.attachments) {
                if (att.contentType === "application/vnd.microsoft.card.adaptive" && att.content) {
                  adaptiveCards.push({
                    contentType: att.contentType,
                    content: att.content,
                    name: att.name,
                  });
                  this.log(`[copilot-studio] Captured adaptive card: ${att.name ?? "(unnamed)"}`);
                }
              }
            }

            // Update conversation ID if activity carries one
            if (activity.conversation?.id) {
              conversationId = activity.conversation.id;
            }

            this.processActivity(activity, streamTexts, standaloneTexts);
          } catch {
            this.log(`[copilot-studio] SSE parse error: ${jsonStr.slice(0, 200)}`);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ok */
      }
    }

    let text: string;
    if (streamTexts.size > 0) {
      text = Array.from(streamTexts.values()).join("\n\n").trim();
    } else {
      text = standaloneTexts.join("\n\n").trim();
    }

    return { text, activities: allActivities, adaptiveCards, conversationId };
  }

  /**
   * Process a single SSE activity and accumulate text.
   */
  private processActivity(
    activity: SSEActivity,
    streamTexts: Map<string, string>,
    standaloneTexts: string[],
  ): void {
    if (!activity.text) return;

    const streamId = activity.channelData?.streamId || "_default";
    const isInformative = activity.channelData?.streamType === "informative";
    const isStreaming = activity.channelData?.streamType === "streaming";
    const isFinal = activity.entities?.some(
      (e) => e.type === "streaminfo" && e.streamType === "final",
    );

    if (activity.type === "typing" && !isInformative) {
      streamTexts.set(streamId, activity.text);
      return;
    }

    if (activity.type === "message") {
      if (isFinal) {
        // Final message — always capture (may or may not have prior streaming chunks)
        streamTexts.set(streamId, activity.text);
      } else if (isStreaming) {
        streamTexts.set(streamId, activity.text);
      } else if (!isInformative) {
        standaloneTexts.push(activity.text);
      }
    }
  }
}

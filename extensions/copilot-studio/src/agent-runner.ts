import { enqueuePendingCards } from "./adaptive-card-queue.js";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient } from "./client.js";

/** How long a conversation session stays valid before we start a fresh one. */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export type AgentRunnerParams = {
  sessionId: string;
  sessionKey?: string;
  agentId: string;
  prompt: string;
  timeoutMs: number;
  runId: string;
};

type ConversationSession = {
  conversationId: string;
  lastActiveAt: number;
};

export class CopilotStudioAgentRunner {
  private sessions = new Map<string, ConversationSession>();
  private client: CopilotStudioClient;
  private log: (msg: string) => void;

  constructor(client: CopilotStudioClient, log: (msg: string) => void) {
    this.client = client;
    this.log = log;
  }

  async run(params: AgentRunnerParams) {
    const startedAt = Date.now();
    const sessionKey = params.sessionKey ?? params.sessionId;

    try {
      const result = await this.executeQuery(sessionKey, params.prompt, params.timeoutMs);

      // Forward adaptive cards to the channel
      if (result.adaptiveCards.length > 0) {
        enqueuePendingCards({
          cards: result.adaptiveCards,
          conversationId: result.conversationId,
          text: result.text || undefined,
          timestamp: Date.now(),
        });
      }

      return {
        payloads: [{ text: result.text }],
        meta: {
          durationMs: Date.now() - startedAt,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "copilot-studio",
            model: "default",
          },
        },
      };
    } catch (err) {
      if (err instanceof DeviceCodeRequiredError) {
        enqueuePendingCards({
          cards: [
            {
              contentType: "application/vnd.microsoft.card.adaptive",
              content: {
                $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                type: "AdaptiveCard",
                version: "1.4",
                body: [
                  {
                    type: "TextBlock",
                    text: "Microsoft Authentication Required",
                    weight: "Bolder",
                    size: "Medium",
                  },
                  {
                    type: "TextBlock",
                    text: "To use Copilot Studio, please sign in:",
                    wrap: true,
                  },
                  {
                    type: "TextBlock",
                    text: `**Code:** ${err.userCode}`,
                    wrap: true,
                    size: "Large",
                    fontType: "Monospace",
                  },
                ],
                actions: [
                  {
                    type: "Action.OpenUrl",
                    title: "Sign in at microsoft.com/devicelogin",
                    url: err.verificationUri,
                  },
                ],
              },
            },
          ],
          conversationId: "auth-prompt",
          text: `Authenticate at ${err.verificationUri} with code: ${err.userCode}`,
          timestamp: Date.now(),
        });

        return {
          payloads: [
            {
              text:
                `Authentication is required. Please sign in at ${err.verificationUri} ` +
                `with code **${err.userCode}**, then send your message again.`,
            },
          ],
          meta: {
            durationMs: Date.now() - startedAt,
            agentMeta: {
              sessionId: params.sessionId,
              provider: "copilot-studio",
              model: "default",
            },
          },
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      this.log(`[copilot-studio] agent runner error: ${message}`);
      return {
        payloads: [{ text: `Copilot Studio error: ${message}`, isError: true }],
        meta: {
          durationMs: Date.now() - startedAt,
          agentMeta: {
            sessionId: params.sessionId,
            provider: "copilot-studio",
            model: "default",
          },
        },
      };
    }
  }

  /**
   * Execute a query, continuing an existing conversation if one exists and
   * hasn't expired. Falls back to a new conversation on failure.
   */
  private async executeQuery(sessionKey: string, prompt: string, timeoutMs: number) {
    const existing = this.sessions.get(sessionKey);
    const now = Date.now();

    if (existing && now - existing.lastActiveAt < SESSION_TTL_MS) {
      try {
        const result = await this.client.continueConversation(
          existing.conversationId,
          prompt,
          timeoutMs,
        );
        existing.lastActiveAt = now;
        // Update conversationId in case CS returned a new one
        existing.conversationId = result.conversationId;
        return result;
      } catch (err) {
        // If it's an auth error, let it propagate
        if (err instanceof DeviceCodeRequiredError) throw err;
        // Stale session — fall through to new conversation
        this.log(
          `[copilot-studio] continueConversation failed, starting new: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.sessions.delete(sessionKey);
      }
    }

    // Start a new conversation
    const result = await this.client.query(prompt, timeoutMs);
    this.sessions.set(sessionKey, {
      conversationId: result.conversationId,
      lastActiveAt: now,
    });
    return result;
  }

  /**
   * Clear conversation state for a session (called on session reset).
   */
  resetConversation(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

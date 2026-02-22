import { Type } from "@sinclair/typebox";
import { enqueuePendingCards } from "./adaptive-card-queue.js";
import { DeviceCodeRequiredError } from "./auth.js";
import type { CopilotStudioClient, QueryResult } from "./client.js";
import {
  popPendingConversation,
  popPendingInvoke,
  storePendingConversation,
} from "./pending-conversations.js";

// Max characters for tool result text to prevent blowing up local model context
const MAX_RESULT_CHARS = 3000;

function jsonResult(payload: unknown) {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [
      {
        type: "text" as const,
        text:
          text.length > MAX_RESULT_CHARS
            ? text.slice(0, MAX_RESULT_CHARS) + "\n...(truncated)"
            : text,
      },
    ],
    details: payload,
  };
}

/**
 * Build a tool result from a QueryResult. If the result contains adaptive cards
 * (e.g. consent prompts), returns them as structured data so the channel can
 * forward them natively instead of losing them.
 */
function buildQueryToolResult(
  result: QueryResult,
  meta: Record<string, unknown>,
  toolName: string,
) {
  if (result.adaptiveCards.length > 0) {
    // Enqueue cards for the channel to send natively (e.g. as Teams adaptive cards).
    // Consumer: msteams plugin's monitor-handler.ts drains these via drainPendingCards().
    enqueuePendingCards({
      cards: result.adaptiveCards,
      conversationId: result.conversationId,
      text: result.text || undefined,
      timestamp: Date.now(),
    });

    // Store conversation for follow-up (e.g. user clicks Allow on consent card)
    storePendingConversation({
      conversationId: result.conversationId,
      toolName,
      timestamp: Date.now(),
    });

    // Don't include card JSON in tool result — the cards are already enqueued
    // for native delivery. The LLM just needs to know a consent card was sent
    // and should wait for the user to respond.
    return jsonResult({
      ...meta,
      status: "consent_required",
      message:
        "A permission consent card has been sent to the user. " +
        "Wait for them to click Allow, then call this tool again with the same parameters.",
    });
  }

  // Check for event activities that carry structured data (e.g. DynamicPlan*)
  const eventActivities = result.activities.filter((a) => a.type === "event" && a.name);
  if (eventActivities.length > 0) {
    return jsonResult({
      ...meta,
      content: result.text,
      events: eventActivities.map((a) => ({
        name: a.name,
        value: a.value,
      })),
    });
  }

  return jsonResult({
    ...meta,
    content: result.text,
  });
}

/**
 * Execute a query, checking first for a pending conversation to continue
 * (e.g. after user clicked Allow on a consent card). If a pending conversation
 * exists for this tool, continues that conversation instead of starting new.
 *
 * Two-step consent flow:
 * 1. Send consent value (empty text) → Copilot Studio processes consent
 * 2. If consent response has actual data → return it
 *    If consent response is just a confirmation → send the original prompt
 */
async function queryOrContinue(
  client: CopilotStudioClient,
  prompt: string,
  toolName: string,
): Promise<QueryResult> {
  const pending = popPendingConversation(toolName);
  if (pending) {
    // Check for pending invoke data (e.g. user clicked Allow on consent card).
    // Send the Action.Submit value data back to Copilot Studio so it can
    // process the consent acknowledgment.
    const invoke = popPendingInvoke();
    const activityValue = invoke?.actionData;

    // Step 1: Send consent value with empty text
    const consentResult = await client.continueConversation(
      pending.conversationId,
      prompt,
      undefined,
      activityValue,
    );

    // If consent response already has substantive data or new cards, return it.
    // The 50-char threshold distinguishes brief "OK" / "Permission granted" acks
    // from actual data responses (email lists, search results, etc.).
    if (consentResult.text.length > 50 || consentResult.adaptiveCards.length > 0) {
      return consentResult;
    }

    // Step 2: Consent was acknowledged but Copilot Studio didn't auto-continue.
    // Send the original prompt in the same conversation to get actual data.
    return await client.continueConversation(consentResult.conversationId, prompt);
  }
  return await client.query(prompt);
}

/**
 * Handle errors from tool execution. If auth is needed, returns a
 * user-friendly message with the device code URL so the LLM can relay it.
 */
function handleToolError(err: unknown, toolName: string) {
  if (err instanceof DeviceCodeRequiredError) {
    // Send auth card directly to the user via the channel (bypasses the LLM).
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
                text: `To use ${toolName}, please sign in:`,
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

    return jsonResult({
      error: "auth_required",
      message:
        `Authentication is required. A sign-in card has been sent to the user. ` +
        `Wait for them to authenticate, then try the same request again. ` +
        `Do NOT use web_fetch or other tools as a workaround.`,
      verificationUri: err.verificationUri,
      userCode: err.userCode,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[copilot-studio] ${toolName} error:`, err instanceof Error ? err.stack : err);
  return jsonResult({
    error: "copilot_studio_error",
    message: `${toolName} failed: ${message}`,
  });
}

// Helper for string enums — avoid Type.Union per repo tool schema guidelines
function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Web Search Tool
// ---------------------------------------------------------------------------
const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
});

export function createCopilotWebSearchTool(client: CopilotStudioClient) {
  return {
    label: "Copilot Web Search",
    name: "copilot_web_search",
    description:
      "Search the web for current information. Returns a concise answer with source URLs.",
    parameters: WebSearchSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as { query?: string };
      try {
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          throw new Error("query required");
        }

        const prompt = [
          `Search the web for: ${query}`,
          "",
          "Return a concise 2-3 sentence answer followed by up to 5 source URLs.",
          "Be factual and brief. Format:",
          "[Answer]",
          "",
          "Sources:",
          "- [Title](URL)",
        ].join("\n");

        const result = await queryOrContinue(client, prompt, "copilot_web_search");

        return buildQueryToolResult(
          result,
          { query, provider: "copilot-studio" },
          "copilot_web_search",
        );
      } catch (err) {
        return handleToolError(err, "copilot_web_search");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Email Tool
// ---------------------------------------------------------------------------
const EMAIL_ACTIONS = ["read", "search", "send"] as const;

const EmailSchema = Type.Object({
  action: stringEnum(EMAIL_ACTIONS, {
    description:
      "Action to perform: 'read' (recent emails), 'search' (find specific emails), 'send' (compose and send).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "For 'read': optional filter (e.g. 'unread', 'from John'). For 'search': search terms. Not used for 'send'.",
    }),
  ),
  to: Type.Optional(Type.String({ description: "Recipient email address (required for 'send')." })),
  subject: Type.Optional(Type.String({ description: "Email subject (required for 'send')." })),
  body: Type.Optional(Type.String({ description: "Email body text (required for 'send')." })),
});

export function createCopilotEmailTool(client: CopilotStudioClient) {
  return {
    label: "Copilot Email",
    name: "copilot_email",
    description:
      "Read, search, or send email via Microsoft 365. Use action='read' for recent mail, 'search' to find specific emails, 'send' to compose and send.",
    parameters: EmailSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as {
        action?: string;
        query?: string;
        to?: string;
        subject?: string;
        body?: string;
      };
      try {
        const action = typeof params.action === "string" ? params.action.trim() : "";
        if (!action) {
          throw new Error("action required");
        }
        let prompt: string;

        switch (action) {
          case "read": {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            prompt = query
              ? `Check my recent emails. Filter: ${query}. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.`
              : "Check my recent emails. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.";
            break;
          }
          case "search": {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            if (!query) {
              throw new Error("query required for search");
            }
            prompt = `Search my emails for: ${query}. List up to 5 matches with sender, subject, date, and a brief summary. Do not include full email bodies.`;
            break;
          }
          case "send": {
            const to = typeof params.to === "string" ? params.to.trim() : "";
            const subject = typeof params.subject === "string" ? params.subject.trim() : "";
            const body = typeof params.body === "string" ? params.body.trim() : "";
            if (!to) throw new Error("to required");
            if (!subject) throw new Error("subject required");
            if (!body) throw new Error("body required");
            prompt = `Send an email to ${to} with subject "${subject}" and body:\n\n${body}\n\nConfirm when sent.`;
            break;
          }
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown email action: ${action}. Use 'read', 'search', or 'send'.`,
            });
        }

        const result = await queryOrContinue(client, prompt, "copilot_email");

        return buildQueryToolResult(
          result,
          { action, provider: "copilot-studio" },
          "copilot_email",
        );
      } catch (err) {
        return handleToolError(err, "copilot_email");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Calendar Tool
// ---------------------------------------------------------------------------
const CALENDAR_ACTIONS = ["check", "create", "search"] as const;

const CalendarSchema = Type.Object({
  action: stringEnum(CALENDAR_ACTIONS, {
    description:
      "Action to perform: 'check' (upcoming events), 'search' (find events), 'create' (new event).",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "For 'check': timeframe like 'today', 'tomorrow', 'this week'. For 'search': search terms. Not used for 'create'.",
    }),
  ),
  title: Type.Optional(Type.String({ description: "Event title (required for 'create')." })),
  datetime: Type.Optional(
    Type.String({
      description:
        "Event date/time in natural language, e.g. 'tomorrow at 2pm' (required for 'create').",
    }),
  ),
  duration: Type.Optional(
    Type.String({
      description: "Event duration, e.g. '30 minutes', '1 hour'. Defaults to 30 minutes.",
    }),
  ),
  attendees: Type.Optional(
    Type.String({ description: "Comma-separated attendee email addresses." }),
  ),
});

export function createCopilotCalendarTool(client: CopilotStudioClient) {
  return {
    label: "Copilot Calendar",
    name: "copilot_calendar",
    description:
      "Check, search, or create calendar events via Microsoft 365. Use action='check' for upcoming events, 'search' to find specific events, 'create' to schedule a new event.",
    parameters: CalendarSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as {
        action?: string;
        query?: string;
        title?: string;
        datetime?: string;
        duration?: string;
        attendees?: string;
      };
      try {
        const action = typeof params.action === "string" ? params.action.trim() : "";
        if (!action) {
          throw new Error("action required");
        }
        let prompt: string;

        switch (action) {
          case "check": {
            const query =
              (typeof params.query === "string" ? params.query.trim() : "") || "next 24 hours";
            prompt = `Check my calendar for ${query}. List each event with time, title, and attendees. Be concise.`;
            break;
          }
          case "search": {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            if (!query) {
              throw new Error("query required for search");
            }
            prompt = `Search my calendar for events matching: ${query}. List matching events with date, time, title, and attendees.`;
            break;
          }
          case "create": {
            const title = typeof params.title === "string" ? params.title.trim() : "";
            const datetime = typeof params.datetime === "string" ? params.datetime.trim() : "";
            if (!title) throw new Error("title required");
            if (!datetime) throw new Error("datetime required");
            const duration =
              (typeof params.duration === "string" ? params.duration.trim() : "") || "30 minutes";
            const attendees = typeof params.attendees === "string" ? params.attendees.trim() : "";
            prompt = attendees
              ? `Create a calendar event: "${title}" at ${datetime}, duration ${duration}, with attendees: ${attendees}. Confirm when created.`
              : `Create a calendar event: "${title}" at ${datetime}, duration ${duration}. Confirm when created.`;
            break;
          }
          default:
            return jsonResult({
              error: "invalid_action",
              message: `Unknown calendar action: ${action}. Use 'check', 'search', or 'create'.`,
            });
        }

        const result = await queryOrContinue(client, prompt, "copilot_calendar");

        return buildQueryToolResult(
          result,
          { action, provider: "copilot-studio" },
          "copilot_calendar",
        );
      } catch (err) {
        return handleToolError(err, "copilot_calendar");
      }
    },
  };
}

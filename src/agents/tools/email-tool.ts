import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { getPluginToolProvider } from "./plugin-tool-provider-registry.js";

const EMAIL_ACTIONS = ["read", "search", "send"] as const;

const EmailSchema = Type.Object({
  action: stringEnum([...EMAIL_ACTIONS], {
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

function resolveEmailConfig(config?: OpenClawConfig) {
  return config?.tools?.email;
}

function buildEmailPrompt(action: string, params: Record<string, unknown>): string {
  switch (action) {
    case "read": {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      return query
        ? `Check my recent emails. Filter: ${query}. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.`
        : "Check my recent emails. List up to 5 with sender, subject, and a brief summary. Do not include full email bodies.";
    }
    case "search": {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        throw new Error("query required for search");
      }
      return `Search my emails for: ${query}. List up to 5 matches with sender, subject, date, and a brief summary. Do not include full email bodies.`;
    }
    case "send": {
      const to = typeof params.to === "string" ? params.to.trim() : "";
      const subject = typeof params.subject === "string" ? params.subject.trim() : "";
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!to) {
        throw new Error("to required");
      }
      if (!subject) {
        throw new Error("subject required");
      }
      if (!body) {
        throw new Error("body required");
      }
      return `Send an email to ${to} with subject "${subject}" and body:\n\n${body}\n\nConfirm when sent.`;
    }
    default:
      throw new Error(`Unknown email action: ${action}. Use 'read', 'search', or 'send'.`);
  }
}

export function createEmailTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const emailConfig = resolveEmailConfig(options?.config);
  if (!emailConfig?.enabled || !emailConfig?.provider) {
    return null;
  }

  const provider = emailConfig.provider;

  return {
    label: "Email",
    name: "email",
    description:
      "Read, search, or send email via Microsoft 365. Use action='read' for recent mail, 'search' to find specific emails, 'send' to compose and send.",
    parameters: EmailSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const executor = getPluginToolProvider("email", provider);
      if (!executor) {
        return jsonResult({
          error: "provider_not_registered",
          message: `Email provider "${provider}" not registered. Enable the ${provider} plugin.`,
        });
      }

      try {
        const prompt = buildEmailPrompt(action, params);
        const { content, citations, structured } = await executor(prompt, {
          action,
          ...params,
        });

        return jsonResult({
          action,
          provider,
          content,
          ...(citations?.length ? { citations } : {}),
          ...(structured ? { structured } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: "email_error",
          message: `email (${action}) failed: ${message}`,
        });
      }
    },
  };
}

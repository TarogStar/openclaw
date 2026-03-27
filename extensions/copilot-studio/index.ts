import type { OpenClawPluginApi, PluginToolProviderFn } from "openclaw/plugin-sdk";
import { CopilotStudioAuth } from "./src/auth.js";
import { CopilotStudioClient } from "./src/client.js";
import { createCopilotStudioStreamFn, resetCopilotStudioConversation } from "./src/stream-fn.js";

type PluginConfig = {
  directConnectUrl: string;
  tenantId: string;
  clientId: string;
  scopes?: string[];
  agentMode?: boolean;
};

const DEFAULT_SCOPES = ["https://api.powerplatform.com/CopilotStudio.Copilots.Invoke"];

/**
 * Build a PluginToolProviderFn that queries Copilot Studio for a given tool domain.
 * CS does multi-step AI reasoning internally — we just send a natural language prompt.
 */
function buildToolProvider(
  client: CopilotStudioClient,
  _log: (msg: string) => void,
): PluginToolProviderFn {
  return async (prompt, _options) => {
    const result = await client.query(prompt);
    const citations = result.activities
      .filter((a) => a.type === "event" && a.name === "citation")
      .map((a) => String(a.value ?? ""))
      .filter(Boolean);
    return {
      content: result.text,
      ...(citations.length > 0 ? { citations } : {}),
    };
  };
}

const plugin = {
  id: "copilot-studio",
  name: "Copilot Studio Gateway",
  description:
    "Model provider and tool gateway for Microsoft Copilot Studio agents (web search, email, calendar)",

  register(api: OpenClawPluginApi) {
    const raw = api.pluginConfig as Partial<PluginConfig> | undefined;
    if (!raw?.directConnectUrl || !raw?.tenantId || !raw?.clientId) {
      api.logger.info(
        "[copilot-studio] Plugin disabled — configure directConnectUrl, tenantId, and clientId in the plugin config",
      );
      return;
    }

    const config: PluginConfig = {
      directConnectUrl: raw.directConnectUrl,
      tenantId: raw.tenantId,
      clientId: raw.clientId,
      scopes: raw.scopes,
      agentMode: raw.agentMode,
    };
    const scopes = config.scopes ?? DEFAULT_SCOPES;
    const log = (msg: string) => api.logger.info(msg);

    const auth = new CopilotStudioAuth(
      { clientId: config.clientId, tenantId: config.tenantId, scopes },
      log,
    );

    const client = new CopilotStudioClient(
      { directConnectUrl: config.directConnectUrl },
      auth,
      log,
    );

    // Register tool providers for core tools (web_search, email, calendar)
    const toolProvider = buildToolProvider(client, log);
    api.registerToolProvider("web_search", "copilot-studio", toolProvider);
    api.registerToolProvider("email", "copilot-studio", toolProvider);
    api.registerToolProvider("calendar", "copilot-studio", toolProvider);

    api.logger.info("[copilot-studio] Registered tool providers: web_search, email, calendar");

    // Agent mode: register CS as a full model provider routed through the Pi SDK pipeline
    if (config.agentMode) {
      api.registerProvider({
        id: "copilot-studio",
        label: "Copilot Studio",
        auth: [],
        catalog: {
          async run() {
            return {
              models: [
                {
                  id: "default",
                  name: "Copilot Studio Agent",
                  api: "copilot-studio" as any,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            } as any;
          },
        },
      });

      // Register stream function so the Pi SDK pipeline routes to CS
      api.registerStreamFn("copilot-studio", createCopilotStudioStreamFn(client, log));

      // Clear conversation state on session reset
      api.on("before_reset", (_event, ctx) => {
        if (ctx.sessionKey) {
          resetCopilotStudioConversation(ctx.sessionKey);
        }
      });

      api.logger.info(
        "[copilot-studio] Agent mode enabled — registered as model provider with stream function",
      );
    }
  },
};

export default plugin;

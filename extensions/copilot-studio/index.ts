import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CopilotStudioAgentRunner } from "./src/agent-runner.js";
import { CopilotStudioAuth } from "./src/auth.js";
import { CopilotStudioClient } from "./src/client.js";
import {
  createCopilotCalendarTool,
  createCopilotEmailTool,
  createCopilotWebSearchTool,
} from "./src/tools.js";

type PluginConfig = {
  directConnectUrl: string;
  tenantId: string;
  clientId: string;
  scopes?: string[];
  agentMode?: boolean;
};

const DEFAULT_SCOPES = ["https://api.powerplatform.com/CopilotStudio.Copilots.Invoke"];

const plugin = {
  id: "copilot-studio",
  name: "Copilot Studio Gateway",
  description: "Tool gateway to Microsoft Copilot Studio agents (web search, email, calendar)",

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

    // Always register tools — useful for LLM-orchestrated mode or when other agents
    // want CS capabilities
    api.registerTool(createCopilotWebSearchTool(client), { optional: true });
    api.registerTool(createCopilotEmailTool(client), { optional: true });
    api.registerTool(createCopilotCalendarTool(client), { optional: true });

    api.logger.info(
      "[copilot-studio] Registered tools: copilot_web_search, copilot_email, copilot_calendar",
    );

    // Agent mode: register CS as a full agent provider with direct passthrough
    if (config.agentMode) {
      api.registerProvider({
        id: "copilot-studio",
        label: "Copilot Studio",
        auth: [],
        models: {
          baseUrl: config.directConnectUrl,
          models: [
            {
              id: "default",
              name: "Copilot Studio Agent",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 0,
              maxTokens: 0,
            },
          ],
        },
      });

      const runner = new CopilotStudioAgentRunner(client, log);
      api.registerAgentRunner("copilot-studio", (params) => runner.run(params));

      // Clear conversation state on session reset
      api.on("before_reset", (_event, ctx) => {
        if (ctx.sessionKey) {
          runner.resetConversation(ctx.sessionKey);
        }
      });

      api.logger.info("[copilot-studio] Agent mode enabled — registered as provider");
    }
  },
};

export default plugin;

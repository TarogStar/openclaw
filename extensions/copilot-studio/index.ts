import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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

    api.registerTool(createCopilotWebSearchTool(client), { optional: true });
    api.registerTool(createCopilotEmailTool(client), { optional: true });
    api.registerTool(createCopilotCalendarTool(client), { optional: true });

    api.logger.info(
      "[copilot-studio] Registered tools: copilot_web_search, copilot_email, copilot_calendar",
    );
  },
};

export default plugin;

import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { CopilotStudioAuth } from "./src/auth.js";
import { CopilotStudioClient } from "./src/client.js";
import {
  createCopilotWebSearchTool,
  createCopilotEmailTool,
  createCopilotCalendarTool,
} from "./src/tools.js";

type PluginConfig = {
  directConnectUrl: string;
  tenantId: string;
  clientId: string;
  scopes: string[];
};

function loadConfig(logger: {
  info: (msg: string) => void;
  error: (msg: string) => void;
}): PluginConfig | null {
  const configPath = path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".openclaw",
    "copilot-studio.json",
  );

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginConfig>;

    if (!parsed.directConnectUrl || !parsed.tenantId || !parsed.clientId) {
      logger.error(
        `[copilot-studio] Missing required fields in ${configPath}. ` +
          `Need: directConnectUrl, tenantId, clientId, scopes`,
      );
      return null;
    }

    return {
      directConnectUrl: parsed.directConnectUrl,
      tenantId: parsed.tenantId,
      clientId: parsed.clientId,
      scopes: parsed.scopes || ["https://api.powerplatform.com/CopilotStudio.Copilots.Invoke"],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info(
        `[copilot-studio] No config found at ${configPath}. ` +
          `Create it with: { directConnectUrl, tenantId, clientId, scopes }`,
      );
    } else {
      logger.error(`[copilot-studio] Failed to load config: ${err}`);
    }
    return null;
  }
}

const plugin = {
  id: "copilot-studio",
  name: "Copilot Studio Gateway",
  description: "Tool gateway to Microsoft Copilot Studio agents (web search, email, calendar)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const config = loadConfig(api.logger);
    if (!config) {
      api.logger.info("[copilot-studio] Plugin disabled — no valid config");
      return;
    }

    const log = (msg: string) => api.logger.info(msg);

    const auth = new CopilotStudioAuth(
      {
        clientId: config.clientId,
        tenantId: config.tenantId,
        scopes: config.scopes,
      },
      log,
    );

    const client = new CopilotStudioClient(
      { directConnectUrl: config.directConnectUrl },
      auth,
      log,
    );

    // Register tools — these replace the built-in web_search
    // (set tools.web.search.enabled: false in openclaw.json to avoid name conflict)
    api.registerTool(createCopilotWebSearchTool(client));
    api.registerTool(createCopilotEmailTool(client));
    api.registerTool(createCopilotCalendarTool(client));

    api.logger.info("[copilot-studio] Registered tools: web_search, email, calendar");
  },
};

export default plugin;

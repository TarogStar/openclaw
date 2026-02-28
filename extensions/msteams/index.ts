import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { msteamsPlugin } from "./src/channel.js";
import {
  registerMSTeamsExecApprovalHooks,
  registerMSTeamsExecDeniedHandler,
} from "./src/exec-approvals.js";
import { setMSTeamsRuntime } from "./src/runtime.js";
import { registerMSTeamsSubagentHooks } from "./src/subagent-hooks.js";

const plugin = {
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMSTeamsRuntime(api.runtime);
    api.registerChannel({ plugin: msteamsPlugin });
    registerMSTeamsSubagentHooks(api);
    registerMSTeamsExecApprovalHooks(api);
    registerMSTeamsExecDeniedHandler(api);
  },
};

export default plugin;

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { msteamsPlugin } from "./src/channel.js";
import {
  registerMSTeamsExecApprovalHooks,
  registerMSTeamsExecDeniedHandler,
} from "./src/exec-approvals.js";
import { setMSTeamsRuntime } from "./src/runtime.js";
import { registerMSTeamsSubagentHooks } from "./src/subagent-hooks.js";

export { msteamsPlugin } from "./src/channel.js";
export { setMSTeamsRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  plugin: msteamsPlugin,
  setRuntime: setMSTeamsRuntime,
  registerFull(api) {
    registerMSTeamsSubagentHooks(api);
    registerMSTeamsExecApprovalHooks(api);
    registerMSTeamsExecDeniedHandler(api);
  },
});

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  registerMSTeamsExecApprovalHooks,
  registerMSTeamsExecDeniedHandler,
} from "./src/exec-approvals.js";
import { registerMSTeamsSubagentHooks } from "./src/subagent-hooks.js";

export default defineBundledChannelEntry({
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "msteamsPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMSTeamsRuntime",
  },
  registerFull(api) {
    registerMSTeamsSubagentHooks(api);
    registerMSTeamsExecApprovalHooks(api);
    registerMSTeamsExecDeniedHandler(api);
  },
});

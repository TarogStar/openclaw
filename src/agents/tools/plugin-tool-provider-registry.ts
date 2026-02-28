/**
 * Generic registry for plugin-provided tool backends (web search, email, calendar).
 * Plugins register executor functions keyed by "toolId:providerId" (e.g. "web_search:copilot-studio").
 * Core tools dispatch to these executors when the matching provider is configured.
 */
export type PluginToolProviderFn = (
  prompt: string,
  options?: Record<string, unknown>,
) => Promise<{ content: string; citations?: string[]; structured?: unknown }>;

const providers = new Map<string, PluginToolProviderFn>();

function providerKey(toolId: string, providerId: string): string {
  return `${toolId}:${providerId}`;
}

export function registerPluginToolProvider(
  toolId: string,
  providerId: string,
  fn: PluginToolProviderFn,
): void {
  providers.set(providerKey(toolId, providerId), fn);
}

export function getPluginToolProvider(
  toolId: string,
  providerId: string,
): PluginToolProviderFn | null {
  return providers.get(providerKey(toolId, providerId)) ?? null;
}

import type { StreamFn } from "@mariozechner/pi-agent-core";

const registry = new Map<string, StreamFn>();

export function registerPluginStreamFn(apiType: string, streamFn: StreamFn): void {
  registry.set(apiType, streamFn);
}

export function getPluginStreamFn(apiType: string): StreamFn | null {
  return registry.get(apiType) ?? null;
}

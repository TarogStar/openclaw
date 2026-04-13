import { z } from "zod";

/**
 * Zod schema for AutoContinueConfig. Mirrors the shape in
 * src/config/types.auto-continue.ts. Strict object; all fields optional so
 * operators can override a subset.
 */
export const AutoContinueSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxIterations: z.number().int().positive().optional(),
    prompt: z.string().min(1).optional(),
    stopOnSignals: z.array(z.string().min(1)).optional(),
    stopOnToolCall: z.array(z.string().min(1)).optional(),
    cooldownMs: z.number().int().nonnegative().optional(),
    continueOnEmpty: z.boolean().optional(),
    reviewerAgentId: z.string().min(1).optional(),
    reviewerPrompt: z.string().min(1).optional(),
    reviewerProcessPath: z.string().min(1).optional(),
    reviewerTimeoutMs: z.number().int().positive().optional(),
    reviewerHistoryTurns: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

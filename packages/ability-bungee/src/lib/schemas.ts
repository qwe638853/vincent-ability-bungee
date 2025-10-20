import { z } from 'zod';

export const KNOWN_ERRORS = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT', // Here for example purposes
  INVALID_CHAIN: 'INVALID_CHAIN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  NO_ROUTE_FOUND: 'NO_ROUTE_FOUND',
  ESTIMATION_TOO_LOW: 'ESTIMATION_TOO_LOW',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
} as const;

/**
 * Tool parameters schema - defines the input parameters for the native send tool
 */
export const abilityParamsSchema = z.object({
  rpcUrl: z.string().url('Invalid RPC URL format'),
  fromChainId: z.union([z.string(), z.number()]),
  toChainId: z.union([z.string(), z.number()]),
  fromToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  toToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  amount: z.string().regex(/^\d+$/, 'Amount must be integer string'),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid recipient address'),
  slippageBps: z.number().int().min(1).max(1000).optional().default(100),
});

/**
 * Precheck success result schema
 */
export const precheckSuccessSchema = z.object({
  bestRoute: z.any(), // 儲存 Bungee API 返回的最佳路由資訊
  estimatedToAmount: z.string(), // 預估到手金額
  fromChainId: z.union([z.string(), z.number()]),
  toChainId: z.union([z.string(), z.number()]),
});

/**
 * Precheck failure result schema
 */
export const precheckFailSchema = z.object({
  reason: z.union([
    z.literal(KNOWN_ERRORS.INVALID_CHAIN),
    z.literal(KNOWN_ERRORS.INVALID_TOKEN),
    z.literal(KNOWN_ERRORS.NO_ROUTE_FOUND),
    z.literal(KNOWN_ERRORS.ESTIMATION_TOO_LOW),
  ]),
  error: z.string(),
});

/**
 * Execute success result schema
 */
export const executeSuccessSchema = z.object({
  txHash: z.string(),
  routeSummary: z.any().optional(),
  fromChainId: z.union([z.string(), z.number()]),
  toChainId: z.union([z.string(), z.number()]),
  timestamp: z.number(),
});

/**
 * Execute failure result schema
 */
export const executeFailSchema = z.object({
  reason: z
    .union([z.literal(KNOWN_ERRORS.EXECUTION_FAILED), z.literal(KNOWN_ERRORS.NO_ROUTE_FOUND)])
    .optional(),
  error: z.string(),
});

// Type exports
export type AbilityParams = z.infer<typeof abilityParamsSchema>;
export type PrecheckSuccess = z.infer<typeof precheckSuccessSchema>;
export type PrecheckFail = z.infer<typeof precheckFailSchema>;
export type ExecuteSuccess = z.infer<typeof executeSuccessSchema>;
export type ExecuteFail = z.infer<typeof executeFailSchema>;

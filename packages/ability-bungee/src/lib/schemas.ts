import { z } from 'zod';

// NOTE:
// This ability is Permit2-only. We do NOT send raw transactions nor sponsored userOps here.
// The execute step either:
//  - returns EIP-712 typed data (client/server signs & submits), or
//  - signs inside the Lit Action and submits to Bungee, returning a requestHash for status polling.

export const KNOWN_ERRORS = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT', // Here for example purposes
  INVALID_CHAIN: 'INVALID_CHAIN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  NO_ROUTE_FOUND: 'NO_ROUTE_FOUND',
  ESTIMATION_TOO_LOW: 'ESTIMATION_TOO_LOW',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
} as const;

// Input params expected by the ability consumer.
// - amounts are strings in smallest unit
// - addresses must be valid EVM addresses
export const abilityParamsSchema = z.object({
  fromChainId: z.union([z.string(), z.number()]),
  toChainId: z.union([z.string(), z.number()]),
  fromToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  toToken: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid token address'),
  amount: z.string().regex(/^\d+$/, 'Amount must be integer string'),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid recipient address'),
  slippageBps: z.number().int().min(1).max(1000).optional().default(100),
  // Optional fast path: if provided, execute will only sign and return userSignature
  signTypedData: z.any().optional(),
  quoteId: z.string().optional(),
  requestType: z.string().optional(),
});

/**
 * Precheck success result schema
 */
// Precheck success: echo back the chosen route and a rough out-amount.
export const precheckSuccessSchema = z.object({
  bestRoute: z.any(),
  estimatedToAmount: z.string(),
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
    z.literal(KNOWN_ERRORS.EXECUTION_FAILED),
  ]),
  error: z.string(),
});

/**
 * Execute success result schema
 */
// Execute success has 2 shapes:
// 1) Return typed data for client/server-side signing and submit
// 2) Already signed & submitted inside the Lit Action, returning requestHash
export const executeSuccessSchema = z.union([
  z.object({
    requestType: z.string(),
    quoteId: z.string(),
    userSignature: z.string(),
    signTypedData: z.any(),
    witness: z.any().optional(),
    approvalData: z.any().optional(),
    fromChainId: z.union([z.string(), z.number()]),
    toChainId: z.union([z.string(), z.number()]),
    timestamp: z.number(),
    nextStep: z.literal('permit2-submit'),
  }),
  z.object({
    // Lit Action already signed & submitted → consumer should poll status using requestHash
    requestType: z.string(),
    quoteId: z.string(),
    requestHash: z.string(),
    fromChainId: z.union([z.string(), z.number()]),
    toChainId: z.union([z.string(), z.number()]),
    timestamp: z.number(),
    nextStep: z.literal('permit2-status'),
  }),
]);

/**
 * Execute failure result schema
 */
// Execute failure is intentionally small: a reason literal and a message.
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

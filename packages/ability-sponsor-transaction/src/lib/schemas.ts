import { z } from 'zod';

export const KNOWN_ERRORS = {
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT', // Here for example purposes
} as const;

/**
 * Tool parameters schema - defines the input parameters for the sponsored transaction tool
 */
export const abilityParamsSchema = z.object({
  // Sponsored call (EIP-7702) required params
  chainId: z.number(),
  sponsorApiKey: z.string(),
  sponsorPolicyId: z.string(),
  // Contract call details (when using sponsoredGasContractCall)
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid contract address'),
  functionName: z.string(),
  args: z.any().optional(),
  abi: z.any(),
  value: z.union([z.string(), z.number()]).optional(),
});

/**
 * Precheck success result schema
 */
export const precheckSuccessSchema = z.object({
  availableBalance: z.string(),
});

/**
 * Precheck failure result schema
 */
export const precheckFailSchema = z.object({
  reason: z.union([
    z.literal(KNOWN_ERRORS['INSUFFICIENT_BALANCE']),
    z.literal(KNOWN_ERRORS['INVALID_AMOUNT']), // Here for schema example purposes
  ]),
  error: z.string(),
});

/**
 * Execute success result schema - only sponsored transaction results
 */
export const executeSuccessSchema = z.object({
  useropHash: z.string(),
  contractAddress: z.string(),
  functionName: z.string(),
  chainId: z.number(),
  timestamp: z.number(),
  nextStep: z.literal('wait-userop'),
});

/**
 * Execute failure result schema
 */
export const executeFailSchema = z.object({
  error: z.string(),
});

// Type exports
export type AbilityParams = z.infer<typeof abilityParamsSchema>;
export type PrecheckSuccess = z.infer<typeof precheckSuccessSchema>;
export type PrecheckFail = z.infer<typeof precheckFailSchema>;
export type ExecuteSuccess = z.infer<typeof executeSuccessSchema>;
export type ExecuteFail = z.infer<typeof executeFailSchema>;

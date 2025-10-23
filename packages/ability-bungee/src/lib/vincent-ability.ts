import { ethers } from 'ethers';

import {
  createVincentAbility,
  supportedPoliciesForAbility,
} from '@lit-protocol/vincent-ability-sdk';

import type { LitNamespace } from '../Lit';
import type { AbilityParams } from './schemas';

import { validateChainId, validateAddress, NATIVE_TOKEN_ADDRESS, callBungeeAPI } from './helpers';
import {
  executeFailSchema,
  executeSuccessSchema,
  precheckFailSchema,
  precheckSuccessSchema,
  abilityParamsSchema,
  KNOWN_ERRORS,
} from './schemas';
declare const Lit: typeof LitNamespace;

// Only Permit2 flow is used; raw transaction helpers and sponsored helpers are removed.

/**
 * vincentAbility provides Bungee-powered cross-chain transfer using Permit2 approvals.
 *
 * - The `precheck` returns the best available quote and route from Bungee.
 * - The `execute` will fetch the best route, then if Permit2 EIP-712 data is available,
 *   sign it inside the Lit Action with the delegated PKP, and submit it to Bungee for execution.
 */
export const vincentAbility = createVincentAbility({
  packageName: '@lit-protocol/ability-bungee' as const,
  abilityParamsSchema: abilityParamsSchema,
  abilityDescription: 'Execute cross-chain transfers using Bungee API',
  precheckSuccessSchema,
  precheckFailSchema,
  supportedPolicies: supportedPoliciesForAbility([]),
  executeSuccessSchema,
  executeFailSchema,

  /**
   * Precheck: Validate params, get the best route and to-amount from Bungee.
   * Fails early on invalid addresses or if quote is unavailable.
   */
  precheck: async ({ abilityParams }: { abilityParams: AbilityParams }, context) => {
    const { fail, succeed, delegation } = context as any;
    const logPrefix = '[@lit-protocol/ability-bungee/precheck]';
    const {
      fromChainId,
      toChainId,
      fromToken,
      toToken,
      amount,
      recipient,
      slippageBps = 100,
    } = abilityParams;
    const sourceChain = String(fromChainId);
    const destinationChain = String(toChainId);
    const sourceTokenRaw = fromToken;
    const destinationTokenRaw = toToken;
    const pkpAddress = delegation.delegatorPkpInfo.ethAddress;
    try {
      // Chain ID checks
      if (!validateChainId(String(sourceChain))) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_CHAIN,
          error: `Invalid source chain ID: ${sourceChain}`,
        });
      }
      if (!validateChainId(String(destinationChain))) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_CHAIN,
          error: `Invalid destination chain ID: ${destinationChain}`,
        });
      }
      // Token address checks
      if (!validateAddress(sourceTokenRaw)) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_TOKEN,
          error: `Invalid source token address: ${sourceTokenRaw}`,
        });
      }
      // If the target token is native, use Bungee's native token placeholder address
      const destinationToken =
        destinationTokenRaw?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase()
          ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' // Bungee native token placeholder
          : destinationTokenRaw;
      const sourceTokenForQuote =
        sourceTokenRaw?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase()
          ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
          : sourceTokenRaw;
      if (!validateAddress(destinationToken)) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_TOKEN,
          error: `Invalid destination token address: ${destinationToken}`,
        });
      }
      if (String(sourceChain) === String(destinationChain)) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_CHAIN,
          error: 'Source and destination chains must be different for bridging',
        });
      }
      // Amount (in smallest unit) validation
      let amountWei;
      try {
        amountWei = ethers.BigNumber.from(String(amount));
      } catch {
        return fail({
          reason: KNOWN_ERRORS.INVALID_AMOUNT,
          error: `Invalid amount format: ${amount}`,
        });
      }

      // Prepare quote request params for Bungee
      const quoteParams = {
        originChainId: sourceChain,
        destinationChainId: destinationChain,
        inputToken: sourceTokenForQuote,
        outputToken: destinationToken,
        inputAmount: amountWei.toString(),
        userAddress: pkpAddress,
        receiverAddress: recipient,
        uniqueRoutesPerBridge: true,
        sort: 'output',
        singleTxOnly: true,
        isContractCall: false,
        slippage: String(Number(slippageBps) / 100),
      } as const;

      console.log(`${logPrefix} Getting quote from Bungee...`, quoteParams);
      // Call Bungee API to fetch optimal route/quotes
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      // Pick out available routes, prioritizing autoRoute if available
      const autoRoute = quoteData?.result?.autoRoute ?? quoteData?.autoRoute;
      const legacyRoutes = quoteData?.result?.routes ?? quoteData?.routes ?? [];
      const manualRoutes = quoteData?.result?.manualRoutes ?? quoteData?.manualRoutes ?? [];

      if (autoRoute) {
        // Success: autoRoute found, return output and route
        return succeed({
          fromChainId: sourceChain,
          toChainId: destinationChain,
          estimatedToAmount: String(autoRoute?.output?.amount ?? '0'),
          bestRoute: autoRoute,
        });
      }
      // If no autoRoute, try legacy or manual routes
      const candidates = legacyRoutes.length ? legacyRoutes : manualRoutes;
      if (!candidates.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
      // Pick the route with the highest output amount
      const best = [...candidates].sort((a: any, b: any) => {
        const av = BigInt(a?.toAmount ?? '0');
        const bv = BigInt(b?.toAmount ?? '0');
        return av === bv ? 0 : av > bv ? -1 : 1;
      })[0];

      return succeed({
        fromChainId: sourceChain,
        toChainId: destinationChain,
        estimatedToAmount: String(best?.toAmount ?? best?.output?.amount ?? '0'),
        bestRoute: best,
      });
    } catch (error) {
      return fail({
        reason: KNOWN_ERRORS.EXECUTION_FAILED,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * execute: Get best Bungee route, sign and submit with Permit2 if supported.
   *
   * - Validates chains and tokens.
   * - Fetches autoRoute as in precheck.
   * - If Permit2 signTypedData payload is returned, signs it using PKP and submits to Bungee.
   * - Returns requestHash for bridge transaction polling.
   */
  execute: async ({ abilityParams }: { abilityParams: AbilityParams }, context) => {
    const { succeed, fail, delegation } = context as any;
    const logPrefix = '[@lit-protocol/ability-bungee/execute]';
    try {
      const {
        fromChainId,
        toChainId,
        fromToken,
        toToken,
        amount,
        recipient,
        slippageBps = 100,
        signTypedData: providedSignTypedData,
        quoteId: providedQuoteId,
        requestType: providedRequestType,
      } = abilityParams;

      const sourceChain = String(fromChainId);
      const destinationChain = String(toChainId);
      const sourceTokenRaw = fromToken;
      const destinationTokenRaw = toToken;
      const pkpPublicKey = delegation.delegatorPkpInfo.publicKey;
      const pkpAddress = delegation.delegatorPkpInfo.ethAddress;

      // Validate basic params (chain IDs and token addresses)
      if (!validateChainId(sourceChain) || !validateChainId(destinationChain)) {
        return fail({ error: 'Invalid chain id(s)' });
      }
      if (!validateAddress(sourceTokenRaw)) {
        return fail({ error: `Invalid source token address: ${sourceTokenRaw}` });
      }
      // Map native token address for Bungee
      const destinationToken =
        destinationTokenRaw?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase()
          ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
          : destinationTokenRaw;
      const sourceTokenForQuote =
        sourceTokenRaw?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase()
          ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
          : sourceTokenRaw;
      if (!validateAddress(destinationToken)) {
        return fail({ error: `Invalid destination token address: ${destinationToken}` });
      }
      if (sourceChain === destinationChain) {
        return fail({ error: 'Source and destination chains must be different for bridging' });
      }

      // Parse and verify amount input (should be smallest units)
      const amountWei = ethers.BigNumber.from(String(amount));

      // Fast path: if signTypedData provided by caller, only sign & return
      if (providedSignTypedData) {
        try {
          const hash = ethers.utils._TypedDataEncoder.hash(
            providedSignTypedData.domain || {},
            providedSignTypedData.types || {},
            providedSignTypedData.values || {},
          );
          const sanitizedPublicKey = pkpPublicKey.startsWith('0x')
            ? pkpPublicKey.slice(2)
            : pkpPublicKey;
          const sigJson = await Lit.Actions.signAndCombineEcdsa({
            toSign: ethers.utils.arrayify(hash),
            publicKey: sanitizedPublicKey,
            sigName: 'alchemyTypedData',
          });
          const parsed = JSON.parse(sigJson);
          const userSignature = ethers.utils.joinSignature({
            r: '0x' + parsed.r.substring(2),
            s: '0x' + parsed.s,
            v: parsed.v,
          });
          console.log(`${logPrefix} Signed typed data (fast path)`, {
            quoteId: providedQuoteId,
            requestType: providedRequestType,
            sigPreview: `${userSignature.slice(0, 12)}...${userSignature.slice(-8)}`,
          });
          return succeed({
            requestType: providedRequestType ?? 'SINGLE_OUTPUT_REQUEST',
            quoteId: providedQuoteId ?? '',
            userSignature,
            signTypedData: providedSignTypedData,
            fromChainId: sourceChain,
            toChainId: destinationChain,
            timestamp: Date.now(),
            nextStep: 'permit2-submit',
          } as any);
        } catch (e) {
          return fail({
            reason: KNOWN_ERRORS.EXECUTION_FAILED,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      let best: any = undefined;
      let quoteId: any = undefined;
      // Prepare quote params as in precheck
      const quoteParams: Record<string, any> = {
        originChainId: sourceChain,
        destinationChainId: destinationChain,
        inputToken: sourceTokenForQuote,
        outputToken: destinationToken,
        inputAmount: amountWei.toString(),
        userAddress: recipient ?? pkpAddress,
        receiverAddress: recipient ?? pkpAddress,
        uniqueRoutesPerBridge: true,
        sort: 'output',
        singleTxOnly: true,
        isContractCall: false,
        slippage: String(Number(slippageBps) / 100),
      };
      console.log(`${logPrefix} Fetching quote`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      best = quoteData.result.autoRoute;
      quoteId = quoteData.result.autoRoute.quoteId;
      const requestType = quoteData.result.autoRoute.requestType;
      console.log('-Quote ID:', quoteId);
      console.log('-Request Type:', requestType);
      console.log('-Best:', best);
      // If Bungee returned a Permit2 signTypedData payload, sign it inside the Lit Action
      if (best?.signTypedData) {
        const signTypedData = best.signTypedData;
        const witness = signTypedData?.values?.witness ?? undefined;
        // EIP-712 signing: use ethers TypedDataEncoder plus Lit.Actions PKP signature
        try {
          const hash = ethers.utils._TypedDataEncoder.hash(
            signTypedData.domain || {},
            signTypedData.types || {},
            signTypedData.values || {},
          );
          // Sign with Lit PKP (`signAndCombineEcdsa` returns JSON with r,s,v)
          const sanitizedPublicKey = pkpPublicKey.startsWith('0x')
            ? pkpPublicKey.slice(2)
            : pkpPublicKey;
          const sigJson = await Lit.Actions.signAndCombineEcdsa({
            toSign: ethers.utils.arrayify(hash),
            publicKey: sanitizedPublicKey,
            sigName: 'alchemyTypedData',
          });
          const parsed = JSON.parse(sigJson);
          // Join into full Ethereum signature
          const userSignature = ethers.utils.joinSignature({
            r: '0x' + parsed.r.substring(2),
            s: '0x' + parsed.s,
            v: parsed.v,
          });
          // LOG: signed inside Lit (mask signature to avoid leaks)
          console.log(`${logPrefix} Signed typed data`, {
            quoteId,
            requestType,
            sigPreview: `${userSignature.slice(0, 12)}...${userSignature.slice(-8)}`,
          });
          // Return typed data + signature for client/server submission
          return succeed({
            requestType,
            quoteId,
            userSignature,
            signTypedData,
            witness,
            fromChainId: sourceChain,
            toChainId: destinationChain,
            timestamp: Date.now(),
            nextStep: 'permit2-submit',
          } as any);
        } catch (e) {
          // If signature or submission fails, return as execution failed
          return fail({
            reason: KNOWN_ERRORS.EXECUTION_FAILED,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Fail if no Permit2 signTypedData is available for this route
      return fail({
        reason: KNOWN_ERRORS.EXECUTION_FAILED,
        error: 'Permit2 signTypedData not available for this route',
      });
    } catch (error) {
      console.error(`${logPrefix} Execution failed`, error);
      return fail({
        reason: KNOWN_ERRORS.EXECUTION_FAILED,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

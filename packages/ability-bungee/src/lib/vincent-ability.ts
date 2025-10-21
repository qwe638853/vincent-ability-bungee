import { ethers } from 'ethers';

import {
  createVincentAbility,
  supportedPoliciesForAbility,
} from '@lit-protocol/vincent-ability-sdk';

import type { AbilityParams } from './schemas';

import {
  isNativeToken,
  validateChainId,
  validateAddress,
  NATIVE_TOKEN_ADDRESS,
  getTokenBalance,
  callBungeeAPI,
  checkAndApproveToken,
  getRpcUrl,
} from './helpers';
import {
  executeFailSchema,
  executeSuccessSchema,
  precheckFailSchema,
  precheckSuccessSchema,
  abilityParamsSchema,
  KNOWN_ERRORS,
} from './schemas';
//import { laUtils } from '@lit-protocol/vincent-scaffold-sdk';
import { sendErc20ApproveRunOnce } from './tx/approve';
import { sendBridgeRunOnce } from './tx/bridge';

// declare const Lit: typeof LitNamespace;

export const vincentAbility = createVincentAbility({
  packageName: '@lit-protocol/ability-bungee' as const,
  abilityParamsSchema: abilityParamsSchema,
  abilityDescription: 'Execute cross-chain transfers using Bungee API',
  precheckSuccessSchema,
  precheckFailSchema,
  supportedPolicies: supportedPoliciesForAbility([]),
  executeSuccessSchema,
  executeFailSchema,

  precheck: async ({ abilityParams }: { abilityParams: AbilityParams }, context) => {
    const { fail, succeed, delegation } = context as any;
    const logPrefix = '[@lit-protocol/ability-bungee/precheck]';
    const {
      rpcUrl,
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
      if (!validateAddress(sourceTokenRaw)) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_TOKEN,
          error: `Invalid source token address: ${sourceTokenRaw}`,
        });
      }
      const destinationToken =
        destinationTokenRaw?.toLowerCase?.() === NATIVE_TOKEN_ADDRESS.toLowerCase()
          ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' // Bungee 原生幣占位
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

      // 2) Provider / 網路一致性
      const rpcForPrecheck = rpcUrl || (await getRpcUrl(sourceChain));
      const provider = new ethers.providers.JsonRpcProvider(rpcForPrecheck);
      const network = await provider.getNetwork();
      if (String(network.chainId) !== String(sourceChain)) {
        return fail({
          reason: KNOWN_ERRORS.INVALID_CHAIN,
          error: `RPC URL chain ID (${network.chainId}) does not match source chain ID (${sourceChain})`,
        });
      }

      // 3) 金額（已為最小單位）+ 餘額檢查
      let amountWei;
      try {
        amountWei = ethers.BigNumber.from(String(amount));
      } catch {
        return fail({
          reason: KNOWN_ERRORS.INVALID_AMOUNT,
          error: `Invalid amount format: ${amount}`,
        });
      }

      const balance = await getTokenBalance(provider, sourceTokenRaw, pkpAddress);
      if (balance.lt(amountWei)) {
        return fail({
          reason: KNOWN_ERRORS.ESTIMATION_TOO_LOW,
          error: `Insufficient balance. Have: ${balance.toString()}, Need: ${amountWei.toString()}`,
        });
      }
      const quoteParams = {
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
        useInbox: true,
        slippage: String(Number(slippageBps) / 100),
      } as const;

      console.log(`${logPrefix} Getting quote from Bungee...`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      const autoRoute = quoteData?.result?.autoRoute ?? quoteData?.autoRoute;
      const legacyRoutes = quoteData?.result?.routes ?? quoteData?.routes ?? [];
      const manualRoutes = quoteData?.result?.manualRoutes ?? quoteData?.manualRoutes ?? [];

      if (autoRoute) {
        return succeed({
          fromChainId: sourceChain,
          toChainId: destinationChain,
          estimatedToAmount: String(autoRoute?.output?.amount ?? '0'),
          bestRoute: autoRoute,
        });
      }

      const candidates = legacyRoutes.length ? legacyRoutes : manualRoutes;
      if (!candidates.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
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

  execute: async ({ abilityParams }: { abilityParams: AbilityParams }, context) => {
    const { succeed, fail, delegation } = context as any;
    const logPrefix = '[@lit-protocol/ability-bungee/execute]';
    try {
      const {
        rpcUrl,
        fromChainId,
        toChainId,
        fromToken,
        toToken,
        amount,
        recipient,
        slippageBps = 100,
        separateApproval = true,
        bridgeTxData,
      } = abilityParams;

      const sourceChain = String(fromChainId);
      const destinationChain = String(toChainId);
      const sourceTokenRaw = fromToken;
      const destinationTokenRaw = toToken;
      const pkpPublicKey = delegation.delegatorPkpInfo.publicKey;
      const pkpAddress = delegation.delegatorPkpInfo.ethAddress;

      // Resolve provider
      const finalRpcUrl = rpcUrl || (await getRpcUrl(sourceChain));
      const provider = new ethers.providers.JsonRpcProvider(finalRpcUrl);

      // Validate basics (reuse helpers)
      if (!validateChainId(sourceChain) || !validateChainId(destinationChain)) {
        return fail({ error: 'Invalid chain id(s)' });
      }
      if (!validateAddress(sourceTokenRaw)) {
        return fail({ error: `Invalid source token address: ${sourceTokenRaw}` });
      }
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

      // Prepare amount（已為最小單位）
      const amountWei = ethers.BigNumber.from(String(amount));

      // If bridgeTxData is provided, skip quoting
      let best: any = undefined;
      let quoteId: any = undefined;
      let requestHash: any = undefined;
      let txData: any = bridgeTxData || undefined;
      if (!txData) {
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
          useInbox: true,
          slippage: String(Number(slippageBps) / 100),
        };
        console.log(`${logPrefix} Fetching quote`, quoteParams);
        const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
        best = quoteData.result.autoRoute;
        quoteId = quoteData.result.autoRoute.quoteId;
        const requestType = quoteData.result.autoRoute.requestType;
        requestHash = quoteData.result.autoRoute.requestHash;
        console.log('-Quote ID:', quoteId);
        console.log('-Request Type:', requestType);
        txData = best?.txData;
      }

      // Optional ERC20 approval (on-chain check). If insufficient, try building approval tx via API.
      const needsApproval = !isNativeToken(sourceTokenRaw)
        ? (
            await checkAndApproveToken(
              provider,
              sourceTokenRaw,
              pkpAddress,
              best?.approvalData?.allowanceTarget || best?.txTarget || pkpAddress,
              amountWei,
            )
          ).needsApproval
        : false;
      if (needsApproval && best?.approvalData) {
        console.log(`${logPrefix} Building approval tx from approvalData`);
        const spenderAddress =
          best.approvalData.spenderAddress || best?.approvalData?.allowanceTarget;
        const approvalAmount = best.approvalData.amount || amountWei.toString();
        const tokenAddress = best.approvalData.tokenAddress || sourceTokenRaw;
        const { txHash: approvalHash, usedNonce } = await sendErc20ApproveRunOnce({
          provider,
          pkpAddress,
          pkpPublicKey,
          sourceChain,
          tokenAddress,
          spenderAddress,
          amount: approvalAmount,
        });
        console.log(`${logPrefix} Approval sent: ${approvalHash}`);
        if (separateApproval) {
          return succeed({
            approvalTxHash: approvalHash,
            bridgeTxData: txData,
            quoteId,
            requestHash,
            fromChainId: sourceChain,
            toChainId: destinationChain,
            timestamp: Date.now(),
            nextStep: 'send-bridge-tx',
          } as any);
        }
        // Stash used approval nonce for next tx
        const approvalUsedNonce = usedNonce ? ethers.BigNumber.from(usedNonce) : undefined;
        // Pass down via closure variable for bridge step
        (globalThis as any).__bungeeApprovalNonce = approvalUsedNonce
          ? approvalUsedNonce.toString()
          : undefined;
      }
      console.log(`${logPrefix} Best route:`, best);
      // Build bridge tx - use provided or autoRoute.txData per Auto Inbox flow
      // txData already set above
      if (!txData) {
        return fail({
          reason: KNOWN_ERRORS.EXECUTION_FAILED,
          error:
            'Missing txData from autoRoute. Please re-fetch quote immediately and retry execute.',
        });
      }
      if (!txData?.to || !txData?.data) {
        return fail({ reason: KNOWN_ERRORS.EXECUTION_FAILED, error: 'Invalid build-tx response' });
      }
      const { txHash } = await sendBridgeRunOnce({
        provider,
        pkpAddress,
        pkpPublicKey,
        sourceChain,
        txData,
        gasHints: { gasLimit: best?.gasFee?.gasLimit, gasPrice: best?.gasFee?.gasPrice },
        approvalUsedNonce: (globalThis as any).__bungeeApprovalNonce,
      });
      console.log(`${logPrefix} Bridge tx sent: ${txHash}`);

      return succeed({
        txHash,
        routeSummary: best,
        fromChainId: sourceChain,
        toChainId: destinationChain,
        timestamp: Date.now(),
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

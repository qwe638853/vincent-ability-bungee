import { ethers } from 'ethers';

import {
  createVincentAbility,
  supportedPoliciesForAbility,
} from '@lit-protocol/vincent-ability-sdk';
import { laUtils } from '@lit-protocol/vincent-scaffold-sdk';

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
  ERC20_ABI,
} from './helpers';
import {
  executeFailSchema,
  executeSuccessSchema,
  precheckFailSchema,
  precheckSuccessSchema,
  abilityParamsSchema,
  KNOWN_ERRORS,
} from './schemas';

// declare const Lit: typeof LitNamespace;
declare const Lit: any;

export const vincentAbility = createVincentAbility({
  packageName: '@lit-protocol/ability-bungee' as const,
  abilityParamsSchema: abilityParamsSchema,
  abilityDescription: 'Execute cross-chain transfers using Bungee API',
  precheckSuccessSchema,
  precheckFailSchema,
  supportedPolicies: supportedPoliciesForAbility([]),
  executeSuccessSchema,
  executeFailSchema,

  precheck: async (
    { abilityParams }: { abilityParams: AbilityParams },
    { fail, succeed, delegation }: { fail: any; succeed: any; delegation: any },
  ) => {
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
        slippage: String(Number(slippageBps) / 100),
        // Force manual routing and disable auto
        enableManual: 'true',
        disableAuto: 'true',
      } as const;

      console.log(`${logPrefix} Getting quote from Bungee...`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      const manualRoutes = quoteData?.result?.manualRoutes ?? quoteData?.manualRoutes ?? [];
      const candidates = manualRoutes;
      if (!candidates.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
      const getTime = (r: any) =>
        Number(
          r?.estimatedTime ??
            r?.route?.estimatedTime ??
            r?.estimation?.estimatedTxExecutionTime ??
            0,
        );
      const best = [...candidates].sort((a: any, b: any) => getTime(a) - getTime(b))[0];

      return succeed({
        fromChainId: sourceChain,
        toChainId: destinationChain,
        estimatedToAmount: String(best?.output?.amount ?? best?.toAmount ?? '0'),
        bestRoute: best,
      });
    } catch (error) {
      return fail({
        reason: KNOWN_ERRORS.EXECUTION_FAILED,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  execute: async (
    { abilityParams }: { abilityParams: AbilityParams },
    { succeed, fail, delegation }: { succeed: any; fail: any; delegation: any },
  ) => {
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

      // Quote routes
      const quoteParams: Record<string, any> = {
        originChainId: sourceChain,
        destinationChainId: destinationChain,
        inputToken: sourceTokenForQuote,
        outputToken: destinationToken,
        inputAmount: amountWei.toString(),
        userAddress: recipient ?? pkpAddress,
        receiverAddress: recipient ?? pkpAddress,
        slippage: String(Number(slippageBps) / 100),
        enableManual: 'true',
        disableAuto: 'true',
      };
      console.log(`${logPrefix} Fetching quote`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      const manualRoutes = quoteData?.result?.manualRoutes ?? quoteData?.manualRoutes ?? [];
      const candidates = manualRoutes;
      if (!candidates.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
      const getTime = (r: any) =>
        Number(
          r?.estimatedTime ??
            r?.route?.estimatedTime ??
            r?.estimation?.estimatedTxExecutionTime ??
            0,
        );
      const best = [...candidates].sort((a: any, b: any) => getTime(a) - getTime(b))[0];

      // Optional ERC20 approval (on-chain check). If insufficient, prepare approval tx via approvalData.
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
        const iface = new ethers.utils.Interface(ERC20_ABI as any);
        const data = iface.encodeFunctionData('approve', [spenderAddress, approvalAmount]);
        const approvalTx = {
          to: tokenAddress,
          data,
          value: ethers.BigNumber.from('0'),
          chainId: Number(sourceChain),
        } as any;
        const approvalRequest = { ...approvalTx, from: pkpAddress };
        approvalTx.gasLimit = await provider.estimateGas(approvalRequest);
        approvalTx.gasPrice = await provider.getGasPrice();
        approvalTx.nonce = await provider.getTransactionCount(pkpAddress);
        const approvalSigned = await laUtils.transaction.primitive.signTx({
          sigName: 'bungeeApproval',
          pkpPublicKey,
          tx: approvalTx,
        });
        const approvalHash = await laUtils.transaction.primitive.sendTx(provider, approvalSigned);
        console.log(`${logPrefix} Approval sent: ${approvalHash}`);
      }
      console.log(`${logPrefix} Best route:`, best);
      // Build bridge tx via quoteId (manual route)
      const topLevelQuoteId = quoteData?.result?.quoteId ?? quoteData?.quoteId;
      const quoteId = best?.quoteId ?? best?.route?.quoteId ?? topLevelQuoteId;
      if (!quoteId) {
        return fail({
          reason: KNOWN_ERRORS.EXECUTION_FAILED,
          error: 'Missing quoteId for build-tx. Please re-fetch quote and retry quickly.',
        });
      }
      const built: any = await callBungeeAPI('/bungee/build-tx', 'GET', { quoteId });
      const txData: any =
        built?.result?.txData || built?.result?.tx || built?.txData || built?.tx || built; // handle variants across API versions
      if (!txData?.to || !txData?.data) {
        return fail({ reason: KNOWN_ERRORS.EXECUTION_FAILED, error: 'Invalid build-tx response' });
      }

      // Prepare and serialize tx inside runOnce to minimize per-node work
      const serializedResp = await Lit.Actions.runOnce(
        { waitForResponse: true, name: 'bungeeSerializedTxn' },
        async () => {
          const tx: any = {
            to: txData.to,
            data: txData.data,
            value: txData.value
              ? ethers.BigNumber.from(String(txData.value))
              : ethers.BigNumber.from('0'),
            chainId: Number(sourceChain),
          };
          const txRequest = { ...tx, from: pkpAddress };
          // Estimate gas and get gas price via provider (manual route context)
          tx.gasLimit = await provider.estimateGas(txRequest);
          tx.gasPrice = await provider.getGasPrice();
          tx.nonce = await provider.getTransactionCount(pkpAddress);
          return JSON.stringify({ serializedTxn: ethers.utils.serializeTransaction(tx) });
        },
      );

      const { serializedTxn } = JSON.parse(String(serializedResp || '{}')) as {
        serializedTxn: string;
      };
      if (!serializedTxn) {
        return fail({ reason: KNOWN_ERRORS.EXECUTION_FAILED, error: 'Serialization failed' });
      }
      const toSign = ethers.utils.parseTransaction(serializedTxn) as any;
      delete toSign.v;
      delete toSign.r;
      delete toSign.s;

      // Sign & send via PKP
      const signed = await laUtils.transaction.primitive.signTx({
        sigName: 'bungeeSingleTxBridge',
        pkpPublicKey,
        tx: toSign,
      });
      const txHash = await laUtils.transaction.primitive.sendTx(provider, signed);
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

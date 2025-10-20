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
        fromChainId: sourceChain,
        fromTokenAddress: sourceTokenForQuote,
        toChainId: destinationChain,
        toTokenAddress: destinationToken,
        fromAmount: amountWei.toString(),
        userAddress: recipient ?? pkpAddress,
        uniqueRoutesPerBridge: true,
        sort: 'output',
        singleTxOnly: true,
        isContractCall: false,
        slippage: slippageBps,
      };

      console.log(`${logPrefix} Getting quote from Bungee...`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      const routes = quoteData?.result?.routes ?? quoteData?.routes ?? [];
      if (!routes.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
      const candidates = routes;
      const best = [...candidates].sort((a: any, b: any) => {
        const av = BigInt(a?.toAmount ?? '0');
        const bv = BigInt(b?.toAmount ?? '0');
        return av === bv ? 0 : av > bv ? -1 : 1;
      })[0];

      return succeed({
        fromChainId: sourceChain,
        toChainId: destinationChain,
        estimatedToAmount: String(best?.toAmount ?? '0'),
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
        fromChainId: sourceChain,
        fromTokenAddress: sourceTokenForQuote,
        toChainId: destinationChain,
        toTokenAddress: destinationToken,
        fromAmount: amountWei.toString(),
        userAddress: recipient ?? pkpAddress,
        uniqueRoutesPerBridge: true,
        sort: 'output',
        singleTxOnly: true,
        isContractCall: false,
        slippage: slippageBps,
      };
      console.log(`${logPrefix} Fetching quote`, quoteParams);
      const quoteData: any = await callBungeeAPI('/bungee/quote', 'GET', quoteParams);
      const routes = quoteData?.result?.routes ?? quoteData?.routes ?? [];
      if (!routes.length) {
        return fail({
          reason: KNOWN_ERRORS.NO_ROUTE_FOUND,
          error: 'No available routes from Bungee',
        });
      }
      const candidates = routes;
      const best = [...candidates].sort((a: any, b: any) => {
        const av = BigInt(a?.toAmount ?? '0');
        const bv = BigInt(b?.toAmount ?? '0');
        return av === bv ? 0 : av > bv ? -1 : 1;
      })[0];

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
        console.log(`${logPrefix} Building approval tx via Bungee`);
        const approvalBuild: any = await callBungeeAPI('/bungee/approval/build-tx', 'GET', {
          ...best.approvalData,
          owner: pkpAddress,
        });
        const approvalTx = {
          to: approvalBuild?.to,
          data: approvalBuild?.data,
          value: approvalBuild?.value
            ? ethers.BigNumber.from(String(approvalBuild.value))
            : ethers.BigNumber.from('0'),
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

      // Build bridge tx
      console.log(`${logPrefix} Building route tx via Bungee`);
      const buildPayload: Record<string, any> = {
        route: best,
        userAddress: pkpAddress,
      };
      const built: any = await callBungeeAPI('/bungee/server/build-tx', 'POST', buildPayload);
      const txData = built?.result?.tx || built?.tx || built; // handle variants
      if (!txData?.to || !txData?.data) {
        return fail({ reason: KNOWN_ERRORS.EXECUTION_FAILED, error: 'Invalid build-tx response' });
      }

      const bridgeTx: any = {
        to: txData.to,
        data: txData.data,
        value: txData.value
          ? ethers.BigNumber.from(String(txData.value))
          : ethers.BigNumber.from('0'),
        chainId: Number(sourceChain),
      };
      const txRequest = { ...bridgeTx, from: pkpAddress };
      bridgeTx.gasLimit = await provider.estimateGas(txRequest);
      bridgeTx.gasPrice = await provider.getGasPrice();
      bridgeTx.nonce = await provider.getTransactionCount(pkpAddress);

      // Sign & send via PKP
      const signed = await laUtils.transaction.primitive.signTx({
        sigName: 'bungeeSingleTxBridge',
        pkpPublicKey,
        tx: bridgeTx,
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

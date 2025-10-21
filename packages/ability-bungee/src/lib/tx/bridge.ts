import { ethers } from 'ethers';

import { laUtils } from '@lit-protocol/vincent-scaffold-sdk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Lit: any;

export async function sendBridgeRunOnce(params: {
  provider: ethers.providers.JsonRpcProvider;
  pkpAddress: string;
  pkpPublicKey: string;
  sourceChain: string;
  txData: { to: string; data: string; value?: string | number };
  gasHints?: { gasLimit?: string | number; gasPrice?: string | number };
  approvalUsedNonce?: string;
}): Promise<{ txHash: string }> {
  const { provider, pkpAddress, pkpPublicKey, sourceChain, txData, gasHints, approvalUsedNonce } =
    params;

  const serializedResp = await Lit.Actions.runOnce(
    { waitForResponse: true, name: 'bungeeSerializedTxn' },
    async () => {
      const tx: Record<string, unknown> = {
        to: txData.to,
        data: txData.data,
        value: txData.value
          ? ethers.BigNumber.from(String(txData.value))
          : ethers.BigNumber.from('0'),
        chainId: Number(sourceChain),
      };
      const txRequest = { ...tx, from: pkpAddress };
      // gas limit
      if (gasHints?.gasLimit) {
        tx.gasLimit = ethers.BigNumber.from(String(gasHints.gasLimit));
      } else {
        tx.gasLimit = await provider.estimateGas(txRequest);
      }
      // fee strategy
      try {
        const feeData = await provider.getFeeData();
        const latest = await provider.getBlock('latest');
        const base = latest?.baseFeePerGas ?? feeData.lastBaseFeePerGas;
        if (base) {
          const priority = feeData.maxPriorityFeePerGas || ethers.BigNumber.from('1500000');
          const hinted = gasHints?.gasPrice
            ? ethers.BigNumber.from(String(gasHints.gasPrice))
            : base;
          const baseRef = hinted.gt(base) ? hinted : base;
          const bumpedBase = baseRef.mul(12).div(10);
          delete (tx as { [k: string]: unknown }).gasPrice;
          (tx as { [k: string]: unknown }).type = 2;
          (tx as { [k: string]: unknown }).maxPriorityFeePerGas = priority;
          (tx as { [k: string]: unknown }).maxFeePerGas = bumpedBase.add(priority);
        } else {
          const hintedLegacy = gasHints?.gasPrice
            ? ethers.BigNumber.from(String(gasHints.gasPrice))
            : feeData.gasPrice || ethers.BigNumber.from('0');
          const bumpedLegacy = hintedLegacy.gt(0)
            ? hintedLegacy.mul(12).div(10)
            : ethers.BigNumber.from('20000000');
          (tx as { [k: string]: unknown }).gasPrice = bumpedLegacy;
          delete (tx as { [k: string]: unknown }).maxPriorityFeePerGas;
          delete (tx as { [k: string]: unknown }).maxFeePerGas;
          (tx as { [k: string]: unknown }).type = 0;
        }
      } catch {
        (tx as { [k: string]: unknown }).gasPrice = await provider.getGasPrice();
        delete (tx as { [k: string]: unknown }).maxPriorityFeePerGas;
        delete (tx as { [k: string]: unknown }).maxFeePerGas;
        (tx as { [k: string]: unknown }).type = 0;
      }
      // nonce
      const pendingNonce = await provider.getTransactionCount(pkpAddress, 'pending');
      if (approvalUsedNonce) {
        const nextFromApproval = ethers.BigNumber.from(approvalUsedNonce).add(1).toNumber();
        tx.nonce = pendingNonce < nextFromApproval ? nextFromApproval : pendingNonce;
      } else {
        tx.nonce = pendingNonce;
      }
      return JSON.stringify({ serializedTxn: ethers.utils.serializeTransaction(tx) });
    },
  );

  let serializedTxn: string | undefined;
  try {
    const parsed = JSON.parse(String(serializedResp || '{}')) as { serializedTxn?: string };
    serializedTxn = parsed?.serializedTxn;
  } catch {
    serializedTxn = undefined;
  }
  if (!serializedTxn) {
    throw new Error('Serialization failed');
  }
  const toSignUnknown = ethers.utils.parseTransaction(serializedTxn) as unknown;
  const toSign = toSignUnknown as Record<string, unknown>;
  delete (toSign as { [k: string]: unknown }).v;
  delete (toSign as { [k: string]: unknown }).r;
  delete (toSign as { [k: string]: unknown }).s;
  const signed = await laUtils.transaction.primitive.signTx({
    sigName: 'bungeeSingleTxBridge',
    pkpPublicKey,
    tx: toSign as any,
  });
  const txHash = await laUtils.transaction.primitive.sendTx(provider, signed);
  return { txHash };
}

import { ethers } from 'ethers';

import { laUtils } from '@lit-protocol/vincent-scaffold-sdk';

import { ERC20_ABI } from '../helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Lit: any;

export async function sendErc20ApproveRunOnce(params: {
  provider: ethers.providers.JsonRpcProvider;
  pkpAddress: string;
  pkpPublicKey: string;
  sourceChain: string;
  tokenAddress: string;
  spenderAddress: string;
  amount: string;
}): Promise<{ txHash: string; usedNonce?: string }> {
  const { provider, pkpAddress, pkpPublicKey, sourceChain, tokenAddress, spenderAddress, amount } =
    params;
  const iface = new ethers.utils.Interface(ERC20_ABI as any);
  const data = iface.encodeFunctionData('approve', [spenderAddress, amount]);

  const serializedApprovalResp = await Lit.Actions.runOnce(
    { waitForResponse: true, name: 'bungeeSerializedApproval' },
    async () => {
      const tx: Record<string, unknown> = {
        to: tokenAddress,
        data,
        value: ethers.BigNumber.from('0'),
        chainId: Number(sourceChain),
      };
      const txRequest = { ...tx, from: pkpAddress };
      try {
        tx.gasLimit = await provider.estimateGas(txRequest);
      } catch {
        tx.gasLimit = ethers.BigNumber.from('120000');
      }
      try {
        const feeData = await provider.getFeeData();
        const latest = await provider.getBlock('latest');
        const base = latest?.baseFeePerGas ?? feeData.lastBaseFeePerGas;
        if (base) {
          const priority = feeData.maxPriorityFeePerGas || ethers.BigNumber.from('1500000');
          const bumpedBase = base.mul(12).div(10);
          delete (tx as { [k: string]: unknown }).gasPrice;
          (tx as { [k: string]: unknown }).type = 2;
          (tx as { [k: string]: unknown }).maxPriorityFeePerGas = priority;
          (tx as { [k: string]: unknown }).maxFeePerGas = bumpedBase.add(priority);
        } else {
          const hinted = feeData.gasPrice || ethers.BigNumber.from('0');
          const bumped = hinted.gt(0) ? hinted.mul(12).div(10) : ethers.BigNumber.from('20000000');
          (tx as { [k: string]: unknown }).gasPrice = bumped;
          delete (tx as { [k: string]: unknown }).maxPriorityFeePerGas;
          delete (tx as { [k: string]: unknown }).maxFeePerGas;
          (tx as { [k: string]: unknown }).type = 0;
        }
      } catch {
        (tx as { [k: string]: unknown }).gasPrice = ethers.BigNumber.from('20000000');
        delete (tx as { [k: string]: unknown }).maxPriorityFeePerGas;
        delete (tx as { [k: string]: unknown }).maxFeePerGas;
        (tx as { [k: string]: unknown }).type = 0;
      }
      tx.nonce = await provider.getTransactionCount(pkpAddress, 'pending');
      return JSON.stringify({
        serializedTxn: ethers.utils.serializeTransaction(tx),
        nonce: String(tx.nonce),
      });
    },
  );

  let serializedApproval: string | undefined;
  let approvalNonceStr: string | undefined;
  try {
    const parsed = JSON.parse(String(serializedApprovalResp || '{}')) as {
      serializedTxn?: string;
      nonce?: string;
    };
    serializedApproval = parsed?.serializedTxn;
    approvalNonceStr = parsed?.nonce;
  } catch {
    serializedApproval = undefined;
  }
  if (!serializedApproval) {
    throw new Error('Approval serialization failed');
  }
  const toSignApprovalUnknown = ethers.utils.parseTransaction(serializedApproval) as unknown;
  const toSignApproval = toSignApprovalUnknown as Record<string, unknown>;
  delete (toSignApproval as { [k: string]: unknown }).v;
  delete (toSignApproval as { [k: string]: unknown }).r;
  delete (toSignApproval as { [k: string]: unknown }).s;
  const approvalSigned = await laUtils.transaction.primitive.signTx({
    sigName: 'bungeeApproval',
    pkpPublicKey,
    tx: toSignApproval as any,
  });
  const approvalHash = await laUtils.transaction.primitive.sendTx(provider, approvalSigned);
  return { txHash: approvalHash, usedNonce: approvalNonceStr };
}

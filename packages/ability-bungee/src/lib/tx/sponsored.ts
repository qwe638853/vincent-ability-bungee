import { sponsoredGasContractCall, waitForUserOp  } from '@lit-protocol/vincent-scaffold-sdk';

import { ERC20_ABI } from '../helpers';

export async function sendSponsoredApprove(params: {
  pkpPublicKey: string;
  pkpEthAddress: string;
  chainId: number;
  tokenAddress: string;
  spenderAddress: string;
  amount: string;
  sponsorApiKey: string;
  sponsorPolicyId: string;
}): Promise<{ useropHash: string; txHash: string }> {
  const {
    pkpPublicKey,
    chainId,
    tokenAddress,
    spenderAddress,
    amount,
    sponsorApiKey,
    sponsorPolicyId,
  } = params;
  const useropHash = await sponsoredGasContractCall({
    pkpPublicKey,
    abi: ERC20_ABI as any[],
    contractAddress: tokenAddress,
    functionName: 'approve',
    args: [spenderAddress, amount],
    overrides: {},
    chainId,
    eip7702AlchemyApiKey: sponsorApiKey,
    eip7702AlchemyPolicyId: sponsorPolicyId,
  });
  const txHash = await waitForUserOp({
    pkpPublicKey,
    chainId,
    eip7702AlchemyApiKey: sponsorApiKey,
    eip7702AlchemyPolicyId: sponsorPolicyId,
    userOp: useropHash as `0x${string}`,
  });
  return { useropHash, txHash };
}

export async function sendSponsoredBridge(params: {
  pkpPublicKey: string;
  chainId: number;
  to: string;
  data: string;
  value?: string | number;
  sponsorApiKey: string;
  sponsorPolicyId: string;
}): Promise<{ useropHash: string; txHash: string }> {
  const { pkpPublicKey, chainId, to, data, value, sponsorApiKey, sponsorPolicyId } = params;
  const useropHash = await sponsoredGasContractCall({
    pkpPublicKey,
    abi: ['function inbox(bytes data) external payable'] as any[],
    contractAddress: to,
    functionName: 'inbox',
    args: [data],
    overrides: { value: value ?? 0 },
    chainId,
    eip7702AlchemyApiKey: sponsorApiKey,
    eip7702AlchemyPolicyId: sponsorPolicyId,
  });
  const txHash = await waitForUserOp({
    pkpPublicKey,
    chainId,
    eip7702AlchemyApiKey: sponsorApiKey,
    eip7702AlchemyPolicyId: sponsorPolicyId,
    userOp: useropHash as `0x${string}`,
  });
  return { useropHash, txHash };
}

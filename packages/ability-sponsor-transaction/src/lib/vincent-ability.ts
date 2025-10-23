import {
  createVincentAbility,
  supportedPoliciesForAbility,
} from '@lit-protocol/vincent-ability-sdk';
import { laUtils } from '@lit-protocol/vincent-scaffold-sdk';

// Deep import to get sponsoredGasContractCall handler
import type { EthersType /*LitNamespace*/ } from '../Lit';

import {
  executeFailSchema,
  executeSuccessSchema,
  precheckFailSchema,
  precheckSuccessSchema,
  abilityParamsSchema,
} from './schemas';

// declare const Lit: typeof LitNamespace;
declare const ethers: EthersType;

export const vincentAbility = createVincentAbility({
  packageName: '@lit-protocol/ability-sponsor-transaction' as const,
  abilityParamsSchema: abilityParamsSchema,
  abilityDescription: 'Send sponsored transaction (EIP-7702)',
  supportedPolicies: supportedPoliciesForAbility([]),
  precheckSuccessSchema,
  precheckFailSchema,

  executeSuccessSchema,
  executeFailSchema,

  precheck: async ({ abilityParams }, { succeed }) => {
    // For sponsored transactions, we don't need balance checks
    // The gas is sponsored by Alchemy
    return succeed({ availableBalance: '0' });
  },

  execute: async ({ abilityParams }, { succeed, fail, delegation }) => {
    try {
      const {
        chainId,
        sponsorApiKey,
        sponsorPolicyId,
        contractAddress,
        functionName,
        args,
        abi,
        value,
      } = abilityParams;

      console.log(
        '[@lit-protocol/ability-sponsor-transaction/execute] Executing Sponsored Contract Call',
        {
          chainId,
          contractAddress,
          functionName,
        },
      );

      // Get PKP's public key from the delegation context
      const pkpPublicKey = delegation.delegatorPkpInfo.publicKey;

      // Execute sponsored contract call
      const useropHash = await laUtils.transaction.handler.sponsoredGasContractCall({
        pkpPublicKey,
        abi,
        contractAddress,
        functionName,
        args: args ?? [],
        overrides: value != null ? { value } : {},
        chainId,
        eip7702AlchemyApiKey: sponsorApiKey,
        eip7702AlchemyPolicyId: sponsorPolicyId,
      });

      return succeed({
        useropHash,
        contractAddress,
        functionName,
        chainId,
        timestamp: Date.now(),
        nextStep: 'wait-userop',
      });
    } catch (error) {
      console.error(
        '[@lit-protocol/ability-sponsor-transaction/execute] Sponsored contract call failed',
        error,
      );

      return fail({
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  },
});

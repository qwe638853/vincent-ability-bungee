// eslint-disable-next-line import-x/no-named-as-default
import Table from 'cli-table3';
import { ethers } from 'ethers';

import type { PermissionData } from '@lit-protocol/vincent-contracts-sdk';

import { bundledVincentAbility as bungeeAbility } from '@lit-protocol/ability-bungee';
import {
  disconnectVincentAbilityClients,
  getVincentAbilityClient,
} from '@lit-protocol/vincent-app-sdk/abilityClient';
import { bundledVincentAbility as nativeSendAbility } from '@lit-protocol/vincent-example-ability-native-send';
import { bundledVincentPolicy as counterPolicy } from '@lit-protocol/vincent-example-policy-counter';

import {
  getChainHelpers,
  delegator,
  delegatee,
  funder,
  appManager,
  ensureUnexpiredCapacityToken,
} from './lib';

function getSendAbilityClient(ethersSigner: ethers.Wallet) {
  return getVincentAbilityClient({ bundledVincentAbility: nativeSendAbility, ethersSigner });
}

async function getTargetAppVersionInfo({
  abilityIpfsCids,
  abilityPolicies,
}: {
  abilityIpfsCids: string[];
  abilityPolicies: string[][];
}) {
  const existingApp = await delegatee.getAppInfo();

  if (!existingApp) {
    return await appManager.registerNewApp({ abilityIpfsCids, abilityPolicies });
  } else {
    // Future optimization: Only create a new app version if the existing app version doesn't have the same ability and policy IPFS CIDs
    return await appManager.registerNewAppVersion({ abilityIpfsCids, abilityPolicies });
  }
}

// Define permission data for all abilities and policies
const PERMISSION_DATA: PermissionData = {
  [nativeSendAbility.ipfsCid]: {
    [counterPolicy.ipfsCid]: { maxSends: 1, timeWindowSeconds: 20 },
  },
  [bungeeAbility.ipfsCid]: {},
};

// An array of the IPFS cid of each ability to be tested, computed from the keys of PERMISSION_DATA
const ABILITY_IPFS_IDS: string[] = Object.keys(PERMISSION_DATA);

// Define the policies for each ability, computed from ABILITY_IPFS_IDS and PERMISSION_DATA
const POLICY_IPFS_IDS = ABILITY_IPFS_IDS.map((abilityIpfsCid) => {
  // Get the policy IPFS CIDs for this ability from PERMISSION_DATA
  return Object.keys(PERMISSION_DATA[abilityIpfsCid]);
});

// This is a full e2e test -- no mocks, so increase timeout accordingly
jest.setTimeout(120_000);

// Overview:
// 1. Ensure the funding wallet is funded, so that it can fund the app manager and delegatee
// 2. Ensure the app manager wallet is funded so it can manage delegations
// 3. Ensure the user's agent PKP wallet is funded, so that it can send tokens to someone else using the ability
// 4. Ensure delegatee has an unexpired RLI capacity token, so that it can use the LIT nodes to execute the ability on Datil
// 5. Get an app version to test against for the current delegatee. Either creates a new app @ version 1, or creates a new app version on the existing app if one exists
// 6. Ensure the delegatee has been permitted to execute the ability/policies for that appVersion on behalf of the user's agent PKP
// 7. Execute the ability!
describe('Run e2e test', () => {
  let agentPkpInfo: { ethAddress: string; tokenId: string };

  beforeAll(async () => {
    const { wallets } = await getChainHelpers();

    const table = new Table({
      head: ['Wallet', 'Address', 'Balance'],
      style: { head: ['green'] },
      wordWrap: true,
    });

    table.push([
      'Funder',
      await wallets.funder.getAddress(),
      ethers.utils.formatEther(await wallets.funder.getBalance()),
    ]);
    table.push([
      'agentWalletOwner',
      await wallets.agentWalletOwner.getAddress(),
      ethers.utils.formatEther(await wallets.agentWalletOwner.getBalance()),
    ]);
    table.push([
      'appManager',
      await wallets.appManager.getAddress(),
      ethers.utils.formatEther(await wallets.appManager.getBalance()),
    ]);
    table.push([
      'appDelegatee',
      await wallets.appDelegatee.getAddress(),
      ethers.utils.formatEther(await wallets.appDelegatee.getBalance()),
    ]);

    console.log(table.toString());

    await funder.checkFunderBalance();
    await delegatee.ensureAppDelegateeFunded();
    await appManager.ensureAppManagerFunded();
    await ensureUnexpiredCapacityToken(wallets.appDelegatee);

    // This call also...
    // 1. Funds the agent wallet owner (user) wallet if needed
    // 2. Mints a new the agent pkp if it doesn't exist
    // 3. Funds the agent pkp (user's agent wallet) if needed
    agentPkpInfo = await delegator.getFundedAgentPkp();

    // If an app exists for the appDelegatee, we will create a new app version with the current ipfs cids
    // Otherwise, we will create an app w/ version 1 appVersion with the current ipfs cids
    const { appId, appVersion } = await getTargetAppVersionInfo({
      abilityIpfsCids: ABILITY_IPFS_IDS,
      abilityPolicies: POLICY_IPFS_IDS,
    });

    await delegator.permitAppVersionForAgentWalletPkp({
      permissionData: PERMISSION_DATA,
      appId,
      appVersion,
      agentPkpInfo,
    });

    // Add permissions for the agent pkp to execute signing in the ability
    await delegator.addPermissionForAbilities(
      wallets.agentWalletOwner,
      agentPkpInfo.tokenId,
      ABILITY_IPFS_IDS,
    );
  });

  afterAll(async () => {
    await disconnectVincentAbilityClients();
  });

  it('should send test tokens to the funder account, but be blocked from sending again immediately by the policy', async () => {
    const { wallets } = await getChainHelpers();

    const abilityClient = getSendAbilityClient(wallets.appDelegatee);

    const sendResult = await abilityClient.execute(
      {
        to: wallets.funder.address,
        amount: '0.00001',
      },
      { delegatorPkpEthAddress: agentPkpInfo.ethAddress },
    );

    expect(sendResult).toHaveProperty('success', true);

    console.log('Trying to transfer again immediately; this will fail the policy check!');
    const policyFailResult = await abilityClient.execute(
      {
        to: wallets.funder.address,
        amount: '0.00001',
      },
      { delegatorPkpEthAddress: agentPkpInfo.ethAddress },
    );

    if (policyFailResult.success === false && policyFailResult.context) {
      expect(policyFailResult.context.policiesContext.deniedPolicy).toHaveProperty(
        'packageName',
        '@lit-protocol/vincent-example-policy-counter',
      );
    }
    expect(policyFailResult).toHaveProperty('success', false);
    expect(policyFailResult).toHaveProperty('context');
  });
});

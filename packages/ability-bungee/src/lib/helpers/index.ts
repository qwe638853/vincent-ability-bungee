import { ethers } from 'ethers';

import { LIT_EVM_CHAINS } from '@lit-protocol/constants';
// Lit is available at runtime inside Lit Actions; declare for TS
declare const Lit: any;

// Common constants shared across abilities
export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export const CHAIN_IDS = {
  ETHEREUM: '1',
  BASE: '8453',
  ARBITRUM: '42161',
  OPTIMISM: '10',
  POLYGON: '137',
  BSC: '56',
  AVALANCHE: '43114',
  ZKSYNC_ERA: '324',
  POLYGON_ZKEVM: '1101',
  SCROLL: '534352',
  MANTLE: '5000',
  MODE: '34443',
  BLAST: '81457',
  AURORA: '1313161554',
} as const;

export const CHAIN_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '8453': 'Base',
  '42161': 'Arbitrum',
  '10': 'Optimism',
  '137': 'Polygon',
  '56': 'BSC',
  '43114': 'Avalanche',
  '324': 'ZkSync Era',
  '1101': 'Polygon zkEVM',
  '534352': 'Scroll',
  '5000': 'Mantle',
  '34443': 'Mode',
  '81457': 'Blast',
  '1313161554': 'Aurora',
};

// Bungee API base URL (can be overridden via env if desired)
export const BUNGEE_API_URL = 'https://public-backend.bungee.exchange';

export const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [
      { name: '_owner', type: 'address' },
      { name: '_spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
  },
  {
    constant: false,
    inputs: [
      { name: '_spender', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
  },
  {
    constant: true,
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    type: 'function',
  },
];

export function isNativeToken(tokenAddress: string): boolean {
  return tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
}

export function getChainName(chainId: string): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}

export async function getTokenBalance(
  provider: ethers.providers.Provider,
  tokenAddress: string,
  userAddress: string,
) {
  if (isNativeToken(tokenAddress)) {
    return await provider.getBalance(userAddress);
  } else {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await tokenContract.balanceOf(userAddress);
  }
}

export async function getTokenDecimals(
  provider: ethers.providers.Provider,
  tokenAddress: string,
): Promise<number> {
  if (isNativeToken(tokenAddress)) {
    return 18;
  } else {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await tokenContract.decimals();
  }
}

export async function checkAndApproveToken(
  provider: ethers.providers.Provider,
  tokenAddress: string,
  ownerAddress: string,
  spenderAddress: string,
  amount: ethers.BigNumber,
): Promise<{ needsApproval: boolean; currentAllowance: ethers.BigNumber }> {
  if (isNativeToken(tokenAddress)) {
    return {
      needsApproval: false,
      currentAllowance: ethers.constants.MaxUint256,
    };
  }

  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const currentAllowance: ethers.BigNumber = await tokenContract.allowance(
    ownerAddress,
    spenderAddress,
  );

  return {
    needsApproval: currentAllowance.lt(amount),
    currentAllowance,
  };
}

export function validateChainId(chainId: string): boolean {
  return Object.values(CHAIN_IDS).includes(chainId as any);
}

export function validateAddress(address: string): boolean {
  try {
    ethers.utils.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

export async function callBungeeAPI(
  endpoint: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  data?: Record<string, unknown>,
) {
  let url = `${BUNGEE_API_URL}${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };

  if (method === 'GET' && data && typeof data === 'object') {
    const params = new URLSearchParams();
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const value = (data as any)[key];
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
    }
    const paramString = params.toString();
    if (paramString) {
      url += (url.includes('?') ? '&' : '?') + paramString;
    }
  } else if (data && method !== 'GET') {
    (options as any).body = JSON.stringify(data);
  }

  console.log(`Fetching bungee API URL:`, url);
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bungee API error: ${response.status} - ${errorText}`);
  }
  return await response.json();
}

export function formatAmount(amount: string, decimals: number): string {
  try {
    const formatted = ethers.utils.formatUnits(amount, decimals);
    return formatted;
  } catch {
    return amount;
  }
}

export function parseAmount(amount: string, decimals: number): string {
  try {
    const parsed = ethers.utils.parseUnits(amount, decimals);
    return parsed.toString();
  } catch {
    throw new Error(`Invalid amount format: ${amount}`);
  }
}

export async function getRpcUrl(chainId: string): Promise<string> {
  for (const [chainKey, chainData] of Object.entries(LIT_EVM_CHAINS)) {
    if (String((chainData as any).chainId) === String(chainId)) {
      const urls = (chainData as any).rpcUrls;
      if (typeof Lit !== 'undefined' && Lit?.Actions?.getRpcUrl) {
        try {
          return await Lit.Actions.getRpcUrl({ chain: chainKey });
        } catch (error) {
          console.warn('[helpers/getRpcUrl] fallback failed:', error);
        }
      }
      if (Array.isArray(urls) && urls.length > 0) {
        return String(urls[0]);
      }
    }
  }
  throw new Error(`ChainId ${chainId} not found in LIT_EVM_CHAINS`);
}

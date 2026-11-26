/**
 * Everything the browser knows about the chain.
 *
 * Only the EVM RPC is reachable from a page: the REST API and the Tendermint
 * RPC send no CORS headers (measured — docs/VERIFIED-FACTS.md). So this module
 * uses `eth_*` calls exclusively. Anything needing the native lane — opening an
 * EVM authorisation window, registering an ML-DSA-87 key — is done ahead of
 * time by the keeper, never here.
 */
import { createPublicClient, http, type Abi, type Hex } from 'viem';
import ELECTION_ABI from '../src/abi/Election.json';

export const NETWORK = {
  evmChainId: 9800,
  evmRpc: 'https://evm-testnet.qore.host',
  explorer: 'https://explore.qore.network',
  chainId: 'qorechain-diana',
} as const;

/** Written by the keeper into the deploy artifact. Never committed. */
export interface Pool {
  note: string;
  contract: Hex;
  electionId: string;
  closeAt: string;
  generatedAtBlock: string;
  invites: {
    index: number;
    address: Hex;
    /** Public by design: one ballot each, a few cents of testnet QOR. */
    privateKey: Hex;
    expiryHeight: string;
    remainingTxs: string;
    live: boolean;
  }[];
}

/** The finished election kept as the proof, on the contract it was run on. */
export const PROOF_ELECTION = {
  contract: '0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2' as Hex,
  electionId: 1n,
} as const;

export const abi = ELECTION_ABI as unknown as Abi;

export const client = createPublicClient({
  transport: http(NETWORK.evmRpc),
});

export function read<T>(contract: Hex, functionName: string, args: readonly unknown[] = []) {
  return client.readContract({ address: contract, abi, functionName, args }) as Promise<T>;
}

export interface ElectionData {
  question: string;
  optionCount: number;
  trusteeCount: number;
  threshold: number;
  voterCount: number;
  ballotCount: number;
  releasedCount: number;
  openAt: bigint;
  closeAt: bigint;
  exists: boolean;
  finalized: boolean;
  electionKeyHash: Hex;
}

export async function loadPool(): Promise<Pool | null> {
  try {
    const res = await fetch('./pool.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Pool;
  } catch {
    // Expected when running locally before the keeper has ever produced one.
    return null;
  }
}

export const txUrl = (hash: string) => `${NETWORK.explorer}/tx/${hash}`;
export const addressUrl = (a: string) => `${NETWORK.explorer}/address/${a}`;

/** Seconds until a timestamp, as a short human string. */
export function until(unixSeconds: bigint): string {
  const secs = Number(unixSeconds) - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'closed';
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  const m = Math.floor((secs % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

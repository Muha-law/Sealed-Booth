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
  /** ML-KEM-1024 + X25519 blob, so the page need not query the event log. */
  electionPublicKey: Hex;
  question: string;
  closeAt: string;
  generatedAtBlock: string;
  invites: {
    index: number;
    address: Hex;
    /**
     * Both keys are public by design. The page needs the secp256k1 key to send
     * and the ML-DSA-87 key to sign, and a browser cannot derive either without
     * a secret. One ballot each, a few cents of testnet QOR, and the master
     * mnemonic is never here.
     */
    privateKey: Hex;
    mldsaSecretKey: Hex;
    expiryHeight: string;
    remainingTxs: string;
    live: boolean;
  }[];
}

/**
 * The finished election shown as the proof.
 *
 * Election 3, not 1: both ran the three-process trustee tally, but 3 is the one
 * whose ballots carry an ML-DSA-87 signature sealed inside the envelope and
 * verified at tally against the registry. Election 1 predates that format.
 */
export const PROOF_ELECTION = {
  contract: '0xb7d52d7934c5c26a9a8fa623ce3669c5def336e2' as Hex,
  electionId: 3n,
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

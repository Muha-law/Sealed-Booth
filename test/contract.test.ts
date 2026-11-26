/**
 * Booth's contract logic, executed by the real QoreChain testnet EVM.
 *
 * These tests inject the compiled runtime bytecode with an `eth_call` state
 * override (this node supports them) and drive the create -> register -> cast
 * sequence through BoothHarness in a single call. So the contract's real logic
 * runs against the real chain's EVM — its ecrecover, its storage — with no
 * deployment and nothing spent.
 *
 * LIMIT OF THIS TECHNIQUE: a state override tells you nothing about
 * QoreChain's own precompiles. They are stateful and decline a caller with no
 * real Cosmos account, which once led this project to a wrong conclusion.
 * Anything touching 0x0a01 / 0x0c01 must be tested from a DEPLOYED contract.
 *
 * These tests need the network. If the RPC is unreachable they FAIL rather than
 * pass quietly; set BOOTH_SKIP_LIVE=1 to skip them deliberately.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateMnemonic } from '@qorechain/sdk';
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { voterFromMnemonic } from '../src/core/identity.js';
import { BALLOT_DOMAIN, ballotCommitment, type ElectionRef } from '../src/core/ballot.js';

const RPC = process.env.QORECHAIN_EVM_RPC ?? 'https://evm-testnet.qore.host';
const EVM_CHAIN_ID = 9800;
const SKIP = process.env.BOOTH_SKIP_LIVE === '1';

// Arbitrary addresses to host the injected code. Nothing lives at them on chain.
const BOOTH_ADDR = '0x00000000000000000000000000000000000b0001' as Hex;
const HARNESS_ADDR = '0x00000000000000000000000000000000000b0002' as Hex;

function artifact(name: string): { abi: Abi; deployedBytecode: Hex } {
  const a = JSON.parse(readFileSync(`build/${name}.json`, 'utf8'));
  return { abi: a.abi as Abi, deployedBytecode: a.deployedBytecode as Hex };
}

const booth = artifact('Booth');
const harness = artifact('BoothHarness');

const overrides = {
  [BOOTH_ADDR]: { code: booth.deployedBytecode },
  [HARNESS_ADDR]: { code: harness.deployedBytecode },
};

async function ethCall(to: Hex, data: Hex): Promise<Hex> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data, gas: toHex(30_000_000) }, 'latest', overrides],
    }),
  });
  const json = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (json.error) throw new Error(`eth_call reverted: ${json.error.message}`);
  if (!json.result) throw new Error('eth_call returned no result');
  return json.result;
}

async function callBooth<T>(functionName: string, args: unknown[]): Promise<T> {
  const data = encodeFunctionData({ abi: booth.abi, functionName, args });
  const result = await ethCall(BOOTH_ADDR, data);
  return decodeFunctionResult({ abi: booth.abi, functionName, data: result }) as T;
}

async function callHarness<T>(functionName: string, args: unknown[]): Promise<T> {
  const data = encodeFunctionData({ abi: harness.abi, functionName, args });
  const result = await ethCall(HARNESS_ADDR, data);
  return decodeFunctionResult({ abi: harness.abi, functionName, data: result }) as T;
}

/** The harness always creates the first election in a fresh override, so id 1. */
const HARNESS_ELECTION_ID = 1n;

const ref: ElectionRef = {
  evmChainId: EVM_CHAIN_ID,
  contract: BOOTH_ADDR,
  electionId: HARNESS_ELECTION_ID,
};

/** A ballot signed for the harness election. The envelope is opaque here. */
async function signedBallot(voter: ReturnType<typeof voterFromMnemonic>, envelope: Uint8Array) {
  const mldsaKeyHash = keccak256(voter.mldsaPublicKey);
  const envelopeHash = keccak256(envelope);
  const commitment = ballotCommitment(ref, mldsaKeyHash, envelopeHash);
  const account = privateKeyToAccount(voter.evmPrivateKey);
  const secpSignature = await account.signMessage({ message: { raw: commitment } });
  // The deployed contract does not check the ML-DSA signature today, so any
  // bytes of the right shape pass here. The tally checks it for real; see
  // test/core.test.ts. (The precompile CAN do this on chain - see
  // docs/VERIFIED-FACTS.md - it is just not wired into castBallot yet.)
  const mldsaSignature = new Uint8Array(4627);
  return { commitment, secpSignature, mldsaSignature, envelopeHash, mldsaKeyHash };
}

describe.skipIf(SKIP)('Booth on the real testnet EVM (state override, no deployment)', () => {
  beforeAll(async () => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const json = (await res.json()) as { result?: Hex };
    expect(json.result, `${RPC} did not answer eth_chainId`).toBeDefined();
    expect(
      Number(BigInt(json.result!)),
      'this suite asserts behaviour of EVM chain 9800',
    ).toBe(EVM_CHAIN_ID);
  }, 60_000);

  it('agrees with the TypeScript BALLOT_DOMAIN', async () => {
    expect(await callBooth<Hex>('BALLOT_DOMAIN', [])).toBe(BALLOT_DOMAIN);
  });

  it('computes the same ballot commitment as the TypeScript does', async () => {
    for (const electionId of [1n, 2n, 4095n]) {
      const keyHash = keccak256(toHex(`key-${electionId}`));
      const envelopeHash = keccak256(toHex(`envelope-${electionId}`));

      const onChain = await callHarness<Hex>('commitmentVia', [
        BOOTH_ADDR,
        electionId,
        keyHash,
        envelopeHash,
      ]);
      const offChain = ballotCommitment({ ...ref, electionId }, keyHash, envelopeHash);

      expect(onChain, `election ${electionId}`).toBe(offChain);
    }
  }, 60_000);

  it('accepts a correctly signed ballot from a registered voter', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const envelope = new Uint8Array(1754).fill(7);
    const { secpSignature, mldsaSignature, envelopeHash } = await signedBallot(voter, envelope);

    const out = await callHarness<{
      electionId: bigint;
      accepted: boolean;
      receiptOk: boolean;
      ballotCount: number;
      storedEnvelopeHash: Hex;
    }>('runVote', [
      BOOTH_ADDR,
      voter.evmAddress,
      voter.evmAddress,
      toHex(envelope),
      toHex(voter.mldsaPublicKey),
      toHex(mldsaSignature),
      secpSignature,
    ]);

    expect(out.electionId).toBe(HARNESS_ELECTION_ID);
    expect(out.accepted).toBe(true);
    expect(out.receiptOk).toBe(true);
    expect(out.ballotCount).toBe(1);
    expect(out.storedEnvelopeHash).toBe(envelopeHash);
  }, 120_000);

  it('refuses a ballot whose signer is not on the roll', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const stranger = voterFromMnemonic(generateMnemonic());
    const envelope = new Uint8Array(1754).fill(9);
    const { secpSignature, mldsaSignature } = await signedBallot(voter, envelope);

    // Signature is the voter's, but the roll holds someone else.
    const out = await callHarness<{ accepted: boolean; ballotCount: number }>('runVote', [
      BOOTH_ADDR,
      voter.evmAddress,
      stranger.evmAddress,
      toHex(envelope),
      toHex(voter.mldsaPublicKey),
      toHex(mldsaSignature),
      secpSignature,
    ]);

    expect(out.accepted).toBe(false);
    expect(out.ballotCount).toBe(0);
  }, 120_000);

  it('refuses a ballot whose secp256k1 signature is not the voter’s', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const impostor = voterFromMnemonic(generateMnemonic());
    const envelope = new Uint8Array(1754).fill(11);

    // Impostor signs, but presents the voter's ML-DSA key and the voter is on the roll.
    const mldsaKeyHash = keccak256(voter.mldsaPublicKey);
    const commitment = ballotCommitment(ref, mldsaKeyHash, keccak256(envelope));
    const secpSignature = await privateKeyToAccount(impostor.evmPrivateKey).signMessage({
      message: { raw: commitment },
    });

    const out = await callHarness<{ accepted: boolean; ballotCount: number }>('runVote', [
      BOOTH_ADDR,
      voter.evmAddress,
      voter.evmAddress,
      toHex(envelope),
      toHex(voter.mldsaPublicKey),
      toHex(new Uint8Array(4627)),
      secpSignature,
    ]);

    expect(out.accepted).toBe(false);
    expect(out.ballotCount).toBe(0);
  }, 120_000);

  it('refuses a malformed secp256k1 signature instead of crediting address zero', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const envelope = new Uint8Array(1754).fill(13);

    const out = await callHarness<{ accepted: boolean }>('runVote', [
      BOOTH_ADDR,
      voter.evmAddress,
      voter.evmAddress,
      toHex(envelope),
      toHex(voter.mldsaPublicKey),
      toHex(new Uint8Array(4627)),
      toHex(new Uint8Array(65)), // all zero: v is 0, outside {27,28}
    ]);

    expect(out.accepted).toBe(false);
  }, 120_000);

  it('lets a voter vote once', async () => {
    const voter = voterFromMnemonic(generateMnemonic());
    const envelope = new Uint8Array(1754).fill(15);
    const { secpSignature, mldsaSignature } = await signedBallot(voter, envelope);

    // Multiple return values decode to a tuple, not a named object.
    const [firstAccepted, secondAccepted, ballotCount] = await callHarness<
      [boolean, boolean, number]
    >('runDoubleVote', [
      BOOTH_ADDR,
      voter.evmAddress,
      toHex(envelope),
      toHex(voter.mldsaPublicKey),
      toHex(mldsaSignature),
      secpSignature,
    ]);

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(false);
    expect(ballotCount).toBe(1);
  }, 120_000);

  it('refuses to reveal a share while voting is still open', async () => {
    const refused = await callHarness<boolean>('revealTooEarly', [
      BOOTH_ADDR,
      toHex(new Uint8Array(33).fill(1)),
    ]);
    expect(refused).toBe(true);
  }, 120_000);
});

/**
 * Vote: seal a ballot with ML-KEM-1024 and send it, entirely in this tab.
 *
 * The choice is encrypted and the ML-DSA-87 signature produced here by
 * `src/core/ballot.ts` — the same module the tests and the trustee processes
 * use. There is no server; the only network calls are `eth_*` to the public
 * RPC.
 *
 * About the demo identity: a page cannot register an ML-DSA-87 key or open an
 * EVM authorisation window, because the native lane sends no CORS headers
 * (docs/VERIFIED-FACTS.md). So voting needs a pre-provisioned account, which
 * means its keys have to reach the browser, which means they are public. That
 * is said on screen rather than hidden: each demo identity is good for exactly
 * one ballot and holds a few cents of worthless testnet QOR.
 */
import { createWalletClient, encodeFunctionData, hexToBytes, http, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { registerScreen, type ScreenContext } from './main.ts';
import {
  NETWORK,
  abi,
  client,
  read,
  txUrl,
  until,
  type ElectionData,
  type Pool,
} from './chain.ts';
import { castBallot } from '../src/core/ballot.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/**
 * EIP-7623 calldata floor: 21000 + 10 per token, a zero byte being 1 token and
 * a non-zero byte 4. A ballot is ~6.5 KB of calldata, so the floor — not the
 * execution estimate — is what sets the gas limit.
 */
function calldataFloorGas(data: Hex): bigint {
  const body = data.slice(2);
  let tokens = 0n;
  for (let i = 0; i < body.length; i += 2) tokens += body.slice(i, i + 2) === '00' ? 1n : 4n;
  return 21_000n + 10n * tokens;
}

/** The first demo identity that has not voted and whose window is still live. */
async function pickInvite(pool: Pool, electionId: bigint, block: bigint) {
  for (const invite of pool.invites) {
    // Leave headroom so the window cannot lapse between picking and sending.
    if (BigInt(invite.expiryHeight) <= block + 200n) continue;
    const voted = await read<boolean>(pool.contract, 'hasVoted', [electionId, invite.address]);
    if (!voted) return invite;
  }
  return null;
}

registerScreen({
  id: 'vote',
  label: 'Vote',

  async render({ mount, pool }: ScreenContext) {
    mount.innerHTML = '';

    if (!pool) {
      mount.append(
        el(
          'div',
          { className: 'panel' },
          el('h3', {}, 'No demo pool published'),
          el(
            'p',
            { className: 'muted' },
            'The keeper publishes demo identities every four hours. Without one ' +
              'this page has no account to vote from, because a browser cannot open ' +
              'its own EVM authorisation window on this chain. Results still shows a ' +
              'real finished election.',
          ),
        ),
      );
      return;
    }

    const electionId = BigInt(pool.electionId);
    const [election, options, open, block] = await Promise.all([
      read<ElectionData>(pool.contract, 'getElection', [electionId]),
      read<readonly string[]>(pool.contract, 'getOptions', [electionId]),
      read<boolean>(pool.contract, 'isOpen', [electionId]),
      client.getBlockNumber(),
    ]);

    mount.append(
      el('h2', {}, election.question),
      el(
        'p',
        { className: 'muted' },
        open
          ? `Open for another ${until(election.closeAt)} · ${election.ballotCount} ballots cast so far`
          : 'This election has closed.',
      ),
    );

    if (!open) {
      mount.append(
        el('div', { className: 'panel' }, el('p', {}, 'Voting is closed. See Results.')),
      );
      return;
    }

    const invite = await pickInvite(pool, electionId, block);
    if (!invite) {
      mount.append(
        el(
          'div',
          { className: 'panel' },
          el('h3', { className: 'warn' }, 'The demo pool is refilling'),
          el(
            'p',
            { className: 'muted' },
            'Every published demo identity has either voted already or its EVM ' +
              'authorisation window has lapsed. The keeper refreshes them every four ' +
              'hours and provisions fresh ones when they run low, so this clears ' +
              'shortly. Nothing is broken.',
          ),
        ),
      );
      return;
    }

    // Be explicit about whose identity this is. No pretending it is the judge's.
    mount.append(
      el(
        'div',
        { className: 'panel' },
        el('h3', {}, 'You are voting as a demo identity'),
        el(
          'p',
          { className: 'muted' },
          'Demo voter #',
          String(invite.index),
          ' — ',
          el('code', {}, invite.address),
        ),
        el(
          'p',
          { className: 'muted' },
          'Pre-provisioned so you can vote without obtaining testnet QOR. Its keys ' +
            'are published in this page on purpose: a browser cannot register a ' +
            'post-quantum key or open an authorisation window itself. Good for ' +
            'exactly one ballot, holding a few cents of worthless testnet QOR.',
        ),
      ),
    );

    const form = el('form', { className: 'panel' });
    form.append(el('h3', {}, 'Your choice'));

    const choices = el('div', { className: 'choices' });
    options.forEach((option, i) => {
      const id = `choice-${i}`;
      const label = el('label', { className: 'choice', htmlFor: id });
      const input = el('input', { type: 'radio', name: 'choice', id, value: option });
      if (i === 0) input.checked = true;
      label.append(input, el('span', {}, option));
      choices.append(label);
    });
    form.append(choices);

    const status = el('p', { className: 'muted' });
    const submit = el('button', { type: 'submit' }, 'Seal and cast my ballot');
    form.append(submit, status);
    mount.append(form);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.className = 'muted';

      const chosen = (form.querySelector('input[name="choice"]:checked') as HTMLInputElement | null)
        ?.value;
      if (!chosen) {
        status.textContent = 'Pick an option first.';
        submit.disabled = false;
        return;
      }

      try {
        status.textContent = 'Sealing your ballot with ML-KEM-1024 and signing it with ML-DSA-87…';

        // Everything cryptographic happens right here, in this tab.
        const sealed = castBallot({
          evmChainId: NETWORK.evmChainId,
          contract: pool.contract,
          electionId,
          chainId: NETWORK.chainId,
          electionPublicKey: hexToBytes(pool.electionPublicKey),
          choice: chosen,
          voter: invite.address,
          mldsaSecretKey: hexToBytes(invite.mldsaSecretKey),
        });

        const args = [electionId, toHex(sealed.envelope)] as const;
        const data = encodeFunctionData({ abi, functionName: 'castBallot', args });

        status.textContent = `Sealed ${sealed.envelope.length} bytes. Estimating gas…`;
        const estimate = await client.estimateContractGas({
          address: pool.contract,
          abi,
          functionName: 'castBallot',
          args,
          account: invite.address,
        });
        const floor = calldataFloorGas(data);
        const withMargin = (estimate * 112n) / 100n;
        const gas = withMargin > floor ? withMargin : (floor * 102n) / 100n;

        const price = await client.getGasPrice();
        const maxFeePerGas = (price * 12n) / 10n;

        status.textContent = 'Sending your ballot…';
        const wallet = createWalletClient({
          account: privateKeyToAccount(invite.privateKey),
          transport: http(NETWORK.evmRpc),
          chain: { ...client.chain!, id: NETWORK.evmChainId },
        });

        const hash = await wallet.sendTransaction({
          to: pool.contract,
          data,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas: 0n,
        });

        status.textContent = 'Waiting for the transaction…';
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== 'success') {
          throw new Error(
            `the chain rejected the ballot (status ${receipt.status}). Transaction ${hash}`,
          );
        }

        // Read the receipt back from the contract, not from our own memory.
        const after = await read<ElectionData>(pool.contract, 'getElection', [electionId]);
        const ballotId = BigInt(after.ballotCount);
        const storedHash = await read<Hex>(pool.contract, 'ballotHash', [electionId, ballotId]);
        const included = storedHash.toLowerCase() === sealed.envelopeHash.toLowerCase();

        form.remove();
        mount.append(
          el(
            'div',
            { className: 'panel' },
            el('h3', { className: 'ok' }, 'Your ballot is on chain'),
            el(
              'ul',
              { className: 'steps' },
              el('li', { className: 'done' }, `Sealed with ML-KEM-1024: ${sealed.envelope.length} bytes of ciphertext`),
              el('li', { className: 'done' }, 'Signed with ML-DSA-87, sealed inside the envelope'),
              el('li', { className: 'done' }, `Gas limit ${gas} (EIP-7623 floor ${floor})`),
              el('li', { className: included ? 'done' : '' }, `Ballot #${ballotId} — inclusion check ${included ? 'passed' : 'FAILED'}`),
            ),
            el('h3', {}, 'Your receipt'),
            el('p', { className: 'muted' }, 'Keep this. It proves inclusion, and reveals nothing.'),
            el('table', {},
              el('tr', {}, el('th', {}, 'Ballot id'), el('td', {}, el('code', {}, String(ballotId)))),
              el('tr', {}, el('th', {}, 'Ciphertext hash'), el('td', {}, el('code', {}, sealed.envelopeHash))),
              el('tr', {}, el('th', {}, 'On chain'), el('td', {}, el('code', {}, storedHash))),
              el('tr', {}, el('th', {}, 'Transaction'), el('td', {},
                el('a', { href: txUrl(hash), target: '_blank', rel: 'noreferrer' }, 'explorer'))),
            ),
            el(
              'p',
              { className: 'warn' },
              'Your choice stays sealed until voting closes and 2 of 3 trustees ' +
                'release their shares. Nobody — including whoever runs this page — ' +
                'can read it before then.',
            ),
          ),
        );
      } catch (err) {
        // Show the real error. Never a fabricated success.
        status.className = 'error';
        status.textContent = err instanceof Error ? err.message : String(err);
        submit.disabled = false;
      }
    });
  },
});

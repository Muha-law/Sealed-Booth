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
import { verifyInclusion } from '../src/core/inclusion.ts';

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
    // One line, so the choices stay above the fold on a phone; the reasoning
    // is one tap away rather than gone.
    const why = el('details', {});
    why.append(
      el('summary', {}, 'Why?'),
      el(
        'p',
        { className: 'muted' },
        'Pre-provisioned so you can vote without obtaining testnet QOR. Its keys ' +
          'are published in this page on purpose: a browser cannot register a ' +
          'post-quantum key or open an authorisation window itself on this chain. ' +
          'Good for exactly one ballot, holding a few cents of worthless testnet QOR.',
      ),
      el('p', { className: 'muted' }, 'Address ', el('code', {}, invite.address)),
    );
    mount.append(
      el(
        'p',
        { className: 'identity muted' },
        el('span', {}, `Voting as public demo identity #${invite.index}`),
        why,
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
      status.textContent = '';

      const chosen = (form.querySelector('input[name="choice"]:checked') as HTMLInputElement | null)
        ?.value;
      if (!chosen) {
        status.textContent = 'Pick an option first.';
        submit.disabled = false;
        return;
      }
      for (const input of form.querySelectorAll('input')) input.disabled = true;
      form.querySelector('.progress')?.remove(); // from a failed earlier attempt

      // Live progress. Signing comes before sealing because the ML-DSA-87
      // signature is sealed INSIDE the envelope; both happen in one call to
      // src/core/ballot.ts, so they tick together rather than pretending to a
      // sequence that did not happen.
      const progress = el('ol', { className: 'progress', ariaLive: 'polite' });
      const step = (label: string) => {
        const detail = el('span', { className: 'detail' });
        const li = el('li', {}, el('span', {}, label), detail);
        progress.append(li);
        return {
          active() { li.className = 'active'; },
          done(text = '') { li.className = 'done'; detail.textContent = text; },
          failed(text = '') { li.className = 'failed'; detail.textContent = text; },
          get state() { return li.className; },
        };
      };
      const sign = step('Signing with ML-DSA-87');
      const seal = step('Sealing with ML-KEM-1024');
      const send = step('Sending');
      const confirm = step('Confirming on chain');
      const inclusion = step('Inclusion check');
      const steps = [sign, seal, send, confirm, inclusion];
      form.append(progress);

      try {
        sign.active();
        seal.active();
        // castBallot is synchronous and CPU-heavy: let the active state paint first.
        await new Promise((r) => setTimeout(r, 30));

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
        sign.done('signature sealed inside the envelope');
        seal.done(`${sealed.envelope.length.toLocaleString('en-US')} bytes of ciphertext`);

        send.active();
        const args = [electionId, toHex(sealed.envelope)] as const;
        const data = encodeFunctionData({ abi, functionName: 'castBallot', args });
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
        send.done(`${hash.slice(0, 10)}…`);

        confirm.active();
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (receipt.status !== 'success') {
          throw new Error(
            `the chain rejected the ballot (status ${receipt.status}). Transaction ${hash}`,
          );
        }
        confirm.done(`block ${receipt.blockNumber}`);

        // The ballot id comes from THIS transaction's BallotCast event, never
        // from "the newest ballot": someone else may have voted in between.
        // Then contract storage must hold our ciphertext hash under that id.
        inclusion.active();
        const { ballotId, storedHash, included } = await verifyInclusion({
          receipt,
          contract: pool.contract,
          electionId,
          voter: invite.address,
          envelopeHash: sealed.envelopeHash,
          readBallotHash: (id, ballot) => read<Hex>(pool.contract, 'ballotHash', [id, ballot]),
        });
        if (included) inclusion.done(`ballot #${ballotId} matches contract storage`);
        else inclusion.failed(`ballot #${ballotId}: storage does not hold this ciphertext`);

        // Keep the ticked steps; replace only the inputs.
        choices.remove();
        submit.remove();
        status.remove();
        form.querySelector('h3')!.textContent = `You chose: ${chosen}`;

        const tech = el('details', { className: 'tech' });
        tech.append(
          el('summary', {}, 'Technical details'),
          el(
            'ul',
            {},
            el('li', {}, `Envelope: ${sealed.envelope.length.toLocaleString('en-US')} bytes, ML-KEM-1024 + X25519 hybrid`),
            el('li', {}, `Gas limit ${gas} (EIP-7623 calldata floor ${floor}, estimate ${estimate})`),
            el('li', {}, `Gas used ${receipt.gasUsed}, block ${receipt.blockNumber}`),
            el('li', {}, 'Transaction ', el('code', {}, hash)),
          ),
        );

        mount.append(
          el(
            'div',
            { className: 'panel' },
            el('h3', { className: included ? 'ok' : 'error' }, included ? 'Your ballot is on chain' : 'Your ballot was sent, but the inclusion check failed'),
            el('p', {}, `Ballot #${ballotId} — inclusion check ${included ? 'passed' : 'FAILED'}`),
            el('h3', {}, 'Your receipt'),
            el('p', { className: 'muted' }, 'Keep this. It proves inclusion, and reveals nothing.'),
            el('table', {},
              el('tr', {}, el('th', {}, 'Ballot id'), el('td', {}, el('code', {}, String(ballotId)))),
              el('tr', {}, el('th', {}, 'Ciphertext hash'), el('td', {}, el('code', {}, sealed.envelopeHash))),
              el('tr', {}, el('th', {}, 'On chain'), el('td', {}, el('code', {}, storedHash))),
              el('tr', {}, el('th', {}, 'Transaction'), el('td', {},
                el('a', { href: txUrl(hash), target: '_blank', rel: 'noreferrer' }, 'explorer'))),
            ),
            tech,
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
        // Show the real error on the step that failed. Never a fabricated success.
        const current = steps.find((s) => s.state === 'active');
        current?.failed();
        for (const s of steps) if (s !== current && s.state === 'active') s.failed();
        status.className = 'error';
        status.textContent = err instanceof Error ? err.message : String(err);
        for (const input of form.querySelectorAll('input')) input.disabled = false;
        submit.disabled = false;
        // The failed step stays visible; a retry replaces this list.
      }
    });
  },
});

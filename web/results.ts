/**
 * Results: the finished election, read from the contract.
 *
 * This screen is deliberately the landing screen. It needs no demo pool, no
 * keys and no interaction — a judge sees a real finished election with its
 * transactions the moment the page loads.
 *
 * Everything here comes from `eth_call` against the contract. The totals are
 * what k trustees agreed on; this page does not recompute them, and says so.
 */
import { registerScreen, type ScreenContext } from './main.ts';
import {
  PROOF_ELECTION,
  addressUrl,
  client,
  read,
  txUrl,
  until,
  type ElectionData,
} from './chain.ts';
import type { Hex } from 'viem';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function bars(options: readonly string[], totals: readonly bigint[]): HTMLElement {
  const max = totals.reduce((a, b) => (b > a ? b : a), 0n);
  const wrap = el('div');
  options.forEach((option, i) => {
    const count = totals[i] ?? 0n;
    const pct = max === 0n ? 0 : Number((count * 100n) / max);
    wrap.append(
      el(
        'div',
        { className: 'bar-row' },
        el('span', {}, option),
        el('strong', {}, String(count)),
        count > 0n
          ? el('div', { className: 'bar', style: `width:${Math.max(pct, 4)}%` })
          : el('div', { className: 'bar-empty', style: 'width:100%' }),
      ),
    );
  });
  return wrap;
}

registerScreen({
  id: 'results',
  label: 'Results',

  async render({ mount, pool }: ScreenContext) {
    mount.innerHTML = '';

    const { contract, electionId } = PROOF_ELECTION;
    const [election, options] = await Promise.all([
      read<ElectionData>(contract, 'getElection', [electionId]),
      read<readonly string[]>(contract, 'getOptions', [electionId]),
    ]);
    const [released, threshold, enough] = await read<[number, number, boolean]>(
      contract,
      'releaseStatus',
      [electionId],
    );
    const [isFinal, agreements] = await read<[boolean, number, number]>(
      contract,
      'resultStatus',
      [electionId],
    );
    const proofOpen = await read<boolean>(contract, 'isOpen', [electionId]);

    // What Booth is, before any numbers. A judge lands here first.
    mount.append(
      el(
        'div',
        { className: 'intro' },
        el(
          'p',
          {},
          'Booth is a secret ballot on QoreChain. Each vote is sealed in the voter’s ' +
            'own browser with ML-KEM-1024 and signed with ML-DSA-87, so the ciphertext ' +
            'on chain stays unreadable even after a quantum computer arrives.',
        ),
        el(
          'p',
          {},
          'Ballots can only be opened after voting closes, and only by k of n ' +
            'trustees together. Below is a finished election; you can cast a real ' +
            'sealed ballot in the live one.',
        ),
        el('a', { className: 'button', href: '#/vote' }, 'Try voting'),
      ),
    );

    mount.append(
      el('h2', {}, `Proof election (${proofOpen ? 'open' : 'closed'})`),
      el(
        'p',
        { className: 'ids' },
        `Election ${electionId} on contract `,
        el('code', {}, contract),
      ),
      el('p', {}, election.question),
      el(
        'p',
        { className: 'muted' },
        `${election.ballotCount} ballots from ${election.voterCount} registered voters · `,
        `${threshold} of ${election.trusteeCount} trustees required · `,
        `closed, so nothing can still be cast`,
      ),
    );

    if (isFinal) {
      const [totals, counted] = await read<[readonly bigint[], Hex, number]>(
        contract,
        'finalResult',
        [electionId],
      );
      const panel = el('div', { className: 'panel' });
      panel.append(
        el('h3', {}, 'Final result'),
        bars(options, totals),
        el(
          'p',
          { className: 'muted' },
          `${agreements} trustees submitted identical totals (threshold ${threshold}). `,
          `${released} of ${election.trusteeCount} shares were released.`,
        ),
        el('p', { className: 'muted' }, 'Counted ballot set: ', el('code', {}, counted)),
      );
      mount.append(panel);
    } else {
      mount.append(
        el(
          'div',
          { className: 'panel' },
          el('h3', {}, 'No final result yet'),
          el(
            'p',
            { className: 'muted' },
            `${agreements} of ${threshold} trustees have submitted matching totals, and ` +
              `${released} of ${election.trusteeCount} shares have been released. ` +
              'Until k agree, this contract publishes no result at all — a disagreement ' +
              'produces nothing rather than something disputed.',
          ),
        ),
      );
    }

    // How the number was reached, and what it does and does not prove.
    mount.append(
      el(
        'div',
        { className: 'panel' },
        el('h3', {}, 'How this result was produced'),
        el(
          'ol',
          { className: 'steps' },
          el('li', { className: 'done' }, 'Each ballot was sealed in a browser with ML-KEM-1024 and sent by the voter.'),
          el('li', { className: 'done' }, 'The contract stored only the ciphertext hash and emitted the ciphertext.'),
          el('li', { className: 'done' }, 'After the close, each trustee opened its own share and re-sealed it to the other trustees’ registered ML-KEM-1024 keys.'),
          el('li', { className: 'done' }, 'Three separate processes, each holding one key, recombined and counted independently.'),
          el('li', { className: 'done' }, 'The result became final when k submitted byte-identical totals and the same counted-ballot set.'),
        ),
        el(
          'p',
          { className: 'warn' },
          'What this does not prove: you cannot recompute the tally yourself from ' +
            'chain data — the ballots are still encrypted. You are checking that k ' +
            'independent trustees agreed. And any trustee who collects k shares can ' +
            'open every ballot and see who voted what.',
        ),
      ),
      el(
        'div',
        { className: 'panel' },
        el('h3', {}, 'Check it yourself'),
        el(
          'p',
          { className: 'muted' },
          'Contract ',
          el('a', { href: addressUrl(contract), target: '_blank', rel: 'noreferrer' }, contract),
        ),
        el(
          'table',
          {},
          ...PROOF_ELECTION.transactions.map((t) =>
            el(
              'tr',
              {},
              el('th', {}, t.label),
              el(
                'td',
                {},
                el('a', { href: txUrl(t.hash), target: '_blank', rel: 'noreferrer' }, 'explorer'),
              ),
            ),
          ),
        ),
        el(
          'p',
          { className: 'muted' },
          'The two refusals above are meant to have failed — that is the point of ' +
            'them. Every transaction Booth has ever sent is listed in PROOF.md in ' +
            'the repository.',
        ),
      ),
    );

    // The live demo election, if the keeper has published a pool.
    if (pool) {
      const demoId = BigInt(pool.electionId);
      const demo = await read<ElectionData>(pool.contract, 'getElection', [demoId]);
      const openNow = await read<boolean>(pool.contract, 'isOpen', [demoId]);
      const block = await client.getBlockNumber();
      const usable = pool.invites.filter((i) => BigInt(i.expiryHeight) > block + 200n);

      mount.append(
        el(
          'div',
          { className: 'panel' },
          el('h3', {}, `Live demo election (${openNow ? 'open' : 'closed'})`),
          el(
            'p',
            { className: 'ids' },
            `Election ${demoId} on contract `,
            el('code', {}, pool.contract),
          ),
          el(
            'p',
            {},
            openNow ? `Closes in ${until(demo.closeAt)}. ` : 'Voting has closed. ',
            `${demo.ballotCount} ballots cast so far from ${demo.voterCount} allowlisted voters.`,
          ),
          el(
            'p',
            { className: usable.length ? 'muted' : 'warn' },
            usable.length
              ? `${usable.length} demo identities are ready — use the Vote screen to cast a real sealed ballot.`
              : 'No demo identity currently has a live authorisation window. The keeper refreshes them every four hours.',
          ),
          ...(openNow ? [el('a', { className: 'button', href: '#/vote' }, 'Vote')] : []),
        ),
      );
    }
  },
});

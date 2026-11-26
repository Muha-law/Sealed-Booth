/**
 * Q-Day: the same ten ballots, sealed two ways, attacked once.
 *
 * The attacker is handed the classical X25519 private keys — that is the whole
 * model, and it is the honest consequence of a quantum computer rather than a
 * hand-wave about running Shor's algorithm.
 *
 * Nothing on this screen is faked. The left column opens because
 * ChaCha20-Poly1305 really does decrypt once the X25519 secret is known; the
 * right column refuses because QoreSeal's `open()` genuinely throws, and the
 * error code it returns is printed next to each row.
 */
import { registerScreen, type ScreenContext } from './main.ts';
import {
  attackClassical,
  attackPostQuantum,
  buildSimulation,
  openWithRealKey,
  prepareAttacker,
  type Simulation,
} from '../src/core/qday.ts';

const VOTERS = [
  { name: 'Ada Lovelace', choice: 'hedgehog' },
  { name: 'Grace Hopper', choice: 'badger' },
  { name: 'Alan Turing', choice: 'otter' },
  { name: 'Katherine Johnson', choice: 'hedgehog' },
  { name: 'Joan Clarke', choice: 'badger' },
  { name: 'Edsger Dijkstra', choice: 'hedgehog' },
  { name: 'Barbara Liskov', choice: 'otter' },
  { name: 'Tony Hoare', choice: 'hedgehog' },
  { name: 'Radia Perlman', choice: 'badger' },
  { name: 'Leslie Lamport', choice: 'otter' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

registerScreen({
  id: 'qday',
  label: 'Q-Day',

  async render({ mount }: ScreenContext) {
    mount.innerHTML = '';

    mount.append(
      el('h2', {}, 'Q-Day'),
      el(
        'p',
        { className: 'sim-badge' },
        'SIMULATION — no real election is involved, and no quantum computer exists',
      ),
      el(
        'p',
        { className: 'muted' },
        'Ten people vote. Their ballots are sealed twice over: once the way ' +
          'encrypted ballots are protected today, and once the way Booth does it. ' +
          'Then a quantum adversary arrives and is simply handed the classical ' +
          'private keys, because that is what a quantum computer buys you.',
      ),
      el('p', { className: 'loading', id: 'qday-building' }, 'Sealing twenty ballots…'),
    );

    // 300ms of real ML-KEM-1024 and X25519 work. Yield first so the message paints.
    await wait(16);
    const sim: Simulation = buildSimulation(VOTERS);
    const attacker = prepareAttacker(sim);
    document.getElementById('qday-building')?.remove();

    const button = el('button', { type: 'button' }, 'Fast-forward to 2040');
    const verdict = el('p', { className: 'muted' });

    const grid = el('div', { className: 'qday-grid' });
    const left = el('div', { className: 'qday-col' });
    const right = el('div', { className: 'qday-col' });

    left.append(
      el('h3', {}, 'Today’s encrypted ballot'),
      el('p', { className: 'muted' }, 'X25519 + ChaCha20-Poly1305'),
    );
    right.append(
      el('h3', {}, 'Booth’s ballot'),
      el('p', { className: 'muted' }, 'ML-KEM-1024 + X25519, combined through SHA3-256'),
    );

    const leftRows: HTMLElement[] = [];
    const rightRows: HTMLElement[] = [];

    sim.ballots.forEach((ballot) => {
      const l = el('div', { className: 'qday-row sealed' }, el('span', {}, '🔒 sealed ballot'));
      const r = el('div', { className: 'qday-row sealed' }, el('span', {}, '🔒 sealed ballot'));
      leftRows.push(l);
      rightRows.push(r);
      left.append(l);
      right.append(r);
      void ballot;
    });

    grid.append(left, right);
    mount.append(button, verdict, grid);

    button.addEventListener('click', async () => {
      button.disabled = true;
      verdict.className = 'warn';
      verdict.textContent =
        'The adversary is handed the X25519 private keys for both ballot boxes…';
      await wait(500);

      let broken = 0;
      let held = 0;

      for (let i = 0; i < sim.ballots.length; i++) {
        const ballot = sim.ballots[i]!;

        // LEFT: the recovered secret is all it takes.
        try {
          const revealed = attackClassical(ballot.classical, sim.recovered.classicalSecret);
          const row = leftRows[i]!;
          row.className = 'qday-row broken';
          row.replaceChildren(el('span', {}, '🔓 ' + revealed));
          broken++;
        } catch (err) {
          // Would mean the classical baseline was wrong. Say so rather than hide it.
          const row = leftRows[i]!;
          row.className = 'qday-row';
          row.replaceChildren(
            el('span', { className: 'error' }, `classical attack failed: ${String(err)}`),
          );
        }

        // RIGHT: same recovered X25519 secret, plus the on-chain ML-KEM public
        // key. QoreSeal refuses, and we print its own error code.
        const result = attackPostQuantum(ballot.postQuantum, attacker);
        const row = rightRows[i]!;
        if (result.opened) {
          // Must never happen. If it ever does, show it loudly.
          row.className = 'qday-row broken';
          row.replaceChildren(el('span', { className: 'error' }, '🔓 ' + result.plaintext));
        } else {
          row.className = 'qday-row held';
          row.replaceChildren(
            el('span', {}, '🔒 still sealed'),
            el('code', {}, result.code),
          );
          held++;
        }

        await wait(70); // cascade, for the camera
      }

      verdict.className = held === sim.ballots.length ? 'ok' : 'error';
      verdict.textContent =
        `${broken} of ${sim.ballots.length} ballots on the left are now public, with names attached. ` +
        `${held} of ${sim.ballots.length} on the right are still sealed.`;

      await wait(400);
      mount.append(
        el(
          'div',
          { className: 'panel' },
          el('h3', {}, 'Why the right-hand column held'),
          el(
            'p',
            { className: 'muted' },
            'QoreSeal’s hybrid mode derives its key from SHA3-256 over BOTH the ' +
              'ML-KEM-1024 shared secret and the X25519 one. The adversary has the ' +
              'X25519 half and the ML-KEM public key — which was on chain all along ' +
              '— but not the ML-KEM secret. Half a shared secret derives nothing.',
          ),
          el(
            'p',
            { className: 'muted' },
            'The refusals above are QoreSeal’s own error codes, not labels this page ' +
              'chose. And the ballots are real: with the correct key they open to ',
            el('code', {}, openWithRealKey(sim.ballots[0]!.postQuantum, sim)),
            '.',
          ),
          el(
            'p',
            { className: 'warn' },
            'What this does not claim: Booth’s ballot secrecy still rests on its ' +
              'trustees. Any k of them can open every ballot today, quantum computer ' +
              'or not. Q-Day is about the ciphertext on chain outliving the maths ' +
              'that protected it — not about trusting nobody.',
          ),
        ),
      );
    });
  },
});

/**
 * Vote — not built yet.
 *
 * Deliberately a placeholder rather than a half-working ballot: the ballot
 * FORMAT is an open question and building on a guess would mean re-running the
 * demo election on a format that then changed.
 *
 * The question: `src/core/ballot.ts` produces an ML-DSA-87 signature plus a
 * secp256k1 one over a commitment, but `Election.castBallot(electionId,
 * ciphertext)` takes a single opaque blob and no signature parameter. So the
 * per-ballot post-quantum signature has to live INSIDE the sealed envelope,
 * which changes the ballot plaintext format and the tally.
 *
 * See the note in the repository for the two options and the recommendation.
 */
import { registerScreen, type ScreenContext } from './main.ts';

registerScreen({
  id: 'vote',
  label: 'Vote',
  render({ mount }: ScreenContext) {
    mount.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h3>Vote is next</h3>' +
      '<p class="muted">The Results screen shows a real finished election now. ' +
      'Voting from the browser is the next piece: the ballot format needs one ' +
      'decision first, because Election.sol takes a single opaque ciphertext and ' +
      'no signature parameter, so the per-ballot ML-DSA-87 signature has to be ' +
      'sealed inside the envelope.</p>';
    mount.append(panel);
  },
});

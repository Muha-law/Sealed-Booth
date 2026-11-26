/**
 * Q-Day demo — not built yet. Agreed to come after Vote and Results.
 */
import { registerScreen, type ScreenContext } from './main.ts';

registerScreen({
  id: 'qday',
  label: 'Q-Day',
  render({ mount }: ScreenContext) {
    mount.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<h3>Q-Day demo is scheduled last</h3>' +
      '<p class="muted">It will show the same ballot sealed in QoreSeal’s hybrid ' +
      'mode (ML-KEM-1024 + X25519) and in ML-KEM-only mode, and why breaking the ' +
      'X25519 half alone gains an attacker nothing.</p>';
    mount.append(panel);
  },
});

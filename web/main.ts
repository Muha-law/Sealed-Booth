/**
 * Booth's shell: routing and the chain status line.
 *
 * The Vote, Results and Q-Day screens register themselves here. Each screen
 * renders into #screen and may read the chain; none of them talk to a server,
 * because there isn't one.
 */
import {
  NETWORK,
  PROOF_ELECTION,
  client,
  loadPool,
  read,
  type ElectionData,
  type Pool,
} from './chain.ts';
import './style.css';

export interface ScreenContext {
  pool: Pool | null;
  mount: HTMLElement;
}

type Screen = {
  id: string;
  label: string;
  render: (ctx: ScreenContext) => void | Promise<void>;
};

const screens: Screen[] = [];
export function registerScreen(screen: Screen) {
  screens.push(screen);
}

const mount = document.getElementById('screen')!;
const nav = document.getElementById('nav')!;
const statusLine = document.getElementById('chain-status')!;

let pool: Pool | null = null;

function currentId(): string {
  const hash = location.hash.replace(/^#\/?/, '');
  return screens.some((s) => s.id === hash) ? hash : (screens[0]?.id ?? '');
}

function renderNav() {
  const active = currentId();
  nav.innerHTML = '';
  for (const s of screens) {
    const a = document.createElement('a');
    a.href = `#/${s.id}`;
    a.textContent = s.label;
    a.className = s.id === active ? 'active' : '';
    nav.append(a);
  }
}

async function route() {
  renderNav();
  const screen = screens.find((s) => s.id === currentId());
  if (!screen) {
    mount.innerHTML = '<p class="error">No screens are registered.</p>';
    return;
  }
  mount.innerHTML = '<p class="loading">Loading…</p>';
  try {
    await screen.render({ pool, mount });
  } catch (err) {
    mount.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'error';
    // Show the real error. Never a fabricated success.
    p.textContent = `Something failed: ${err instanceof Error ? err.message : String(err)}`;
    mount.append(p);
  }
}

async function showChainStatus() {
  try {
    const [block, chainId] = await Promise.all([client.getBlockNumber(), client.getChainId()]);
    if (chainId !== NETWORK.evmChainId) {
      statusLine.textContent = `Connected to chain ${chainId}, expected ${NETWORK.evmChainId}.`;
      statusLine.className = 'error';
      return;
    }
    const proof = await read<ElectionData>(PROOF_ELECTION.contract, 'getElection', [
      PROOF_ELECTION.electionId,
    ]);
    statusLine.textContent =
      `block ${block} · proof election ${PROOF_ELECTION.electionId}: ` +
      `${proof.ballotCount} ballots, ${proof.releasedCount}/${proof.trusteeCount} shares released` +
      (pool ? ` · demo pool ${pool.invites.length} ready` : ' · no demo pool published');
  } catch (err) {
    statusLine.textContent = `Could not reach ${NETWORK.evmRpc}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    statusLine.className = 'error';
  }
}

async function boot() {
  pool = await loadPool();
  // Screens are imported for their side effect of registering themselves.
  await Promise.all([import('./results.ts'), import('./vote.ts'), import('./qday.ts')]);
  window.addEventListener('hashchange', route);
  await route();
  await showChainStatus();
}

void boot();

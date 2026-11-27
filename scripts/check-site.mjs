/**
 * Drive the published site in a real browser, the way a judge would.
 *
 *   node scripts/check-site.mjs [url]
 *
 * Checks the four screens at desktop and phone widths, casts a real ballot,
 * collects console errors and failed requests, and writes screenshots outside
 * the repository. Exits non-zero if anything a judge would notice is broken.
 *
 * This casts a genuine ballot into the demo election, consuming one demo
 * identity. That is the point: a check that stubs the transaction proves
 * nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const URL_UNDER_TEST = process.argv[2] ?? 'https://muha-law.github.io/Sealed-Booth/';
const SHOTS = join(homedir(), 'booth-screenshots');
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

const findings = [];
const note = (level, where, message) => {
  findings.push({ level, where, message });
  console.log(`  ${level === 'fail' ? 'FAIL' : level === 'warn' ? 'warn' : 'ok  '}  ${where}: ${message}`);
};

// Use the system Chrome rather than Playwright's bundled build: it is the
// browser a judge actually has, and it avoids a 150 MB download. Falls back to
// Edge, then to a bundled build if one is installed.
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      const b = await chromium.launch({ channel });
      console.log(`browser: ${channel} ${b.version()}`);
      return b;
    } catch {
      /* try the next one */
    }
  }
  const b = await chromium.launch();
  console.log(`browser: bundled chromium ${b.version()}`);
  return b;
}

const browser = await launch();

/**
 * WCAG contrast of every element matching `selector`: its text colour against
 * the first opaque background found walking up the tree. Runs in the page, on
 * the computed styles the browser actually painted with.
 */
async function contrastOf(page, selector) {
  return page.evaluate((sel) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = '1'] = m[1].split(/[ ,\/]+/).filter(Boolean);
      return { r: +r, g: +g, b: +b, a: +a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0.5) return c;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    return [...document.querySelectorAll(sel)]
      .filter((el) => el.offsetParent !== null && !el.disabled)
      .map((el) => {
        const fg = parse(getComputedStyle(el).color);
        const bg = bgOf(el);
        const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return { text: el.textContent.trim().slice(0, 40), ratio: (hi + 0.05) / (lo + 0.05) };
      });
  }, selector);
}

function judgeContrast(where, items, what) {
  if (items.length === 0) return note('warn', where, `no visible ${what} to measure`);
  const worst = items.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  const level = worst.ratio >= 4.5 ? 'ok' : 'fail';
  note(level, where, `${what}: lowest contrast ${worst.ratio.toFixed(2)}:1 ("${worst.text}") of ${items.length}, AA needs 4.5`);
}

for (const vp of VIEWPORTS) {
  console.log(`\n================ ${vp.name} (${vp.width}x${vp.height}) ================`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  // Record the resource URL alongside the text: a "Failed to load resource"
  // message does NOT contain the URL, so filtering on text alone let a favicon
  // 404 through as a failure.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    consoleErrors.push(url ? `${m.text()} [${url}]` : m.text());
  });
  page.on('response', (r) => {
    if (r.status() === 404) consoleErrors.push(`404 ${r.url()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));

  const shot = async (name) => {
    const file = join(SHOTS, `${vp.name}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };

  // ---------------------------------------------------- 1. Results loads first
  await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(2500); // chain reads

  const nav = await page.locator('#nav a').allTextContents();
  if (nav.length === 0) note('fail', 'shell', 'no navigation rendered');
  else note('ok', 'shell', `nav: ${nav.join(' / ')}`);

  const activeFirst = await page.locator('#nav a.active').first().textContent();
  if (activeFirst?.trim() === 'Results') note('ok', 'results', 'Results is the landing screen');
  else note('fail', 'results', `landing screen is "${activeFirst}", expected Results`);

  const body = await page.locator('#screen').innerText();
  if (/hedgehog/i.test(body) && /badger/i.test(body)) note('ok', 'results', 'options rendered');
  else note('fail', 'results', 'option names missing from Results');

  // Totals: the known result of the proof election.
  const totalsOk = /\b3\b/.test(body) && /Final result/i.test(body);
  if (totalsOk) note('ok', 'results', 'final result section with totals present');
  else note('fail', 'results', 'no final result section');

  if (/Something failed|Could not reach/i.test(body)) {
    note('fail', 'results', `error text on screen: ${body.slice(0, 160)}`);
  }

  // Explorer links must be real and resolve.
  const links = await page.locator('#screen a[href^="https://explore.qore.network"]').all();
  if (links.length === 0) note('fail', 'results', 'no explorer links');
  else {
    const hrefs = await Promise.all(links.map((l) => l.getAttribute('href')));
    let bad = 0;
    for (const href of hrefs.slice(0, 4)) {
      const res = await fetch(href, { method: 'GET' }).catch(() => null);
      if (!res || !res.ok) bad++;
    }
    if (bad === 0) note('ok', 'results', `${hrefs.length} explorer link(s), sampled ones all resolve`);
    else note('fail', 'results', `${bad} explorer link(s) did not resolve`);
  }
  if (await page.locator('#screen a.button', { hasText: 'Try voting' }).first().isVisible()) {
    note('ok', 'results', 'intro with a "Try voting" button');
  } else note('fail', 'results', 'no "Try voting" button');
  if (/Proof election \((open|closed)\)/.test(body) && /Live demo election \((open|closed)\)/.test(body)) {
    note('ok', 'results', 'headings without election numbers');
  } else note('fail', 'results', 'headings not in the "Proof election (closed)" form');
  if (await page.locator('#screen .panel a.button', { hasText: /^Vote$/ }).count()) {
    note('ok', 'results', 'Vote button inside the live demo card');
  } else note('warn', 'results', 'no Vote button in the live demo card');
  judgeContrast('results', await contrastOf(page, '#screen .button, #screen button'), 'primary buttons');
  judgeContrast('results', await contrastOf(page, '#screen .warn'), 'warning text');
  if (await page.locator('header a.repo-link').isVisible()) note('ok', 'shell', '"Source and proof" link in the header');
  else note('fail', 'shell', 'no "Source and proof" link');
  console.log(`  screenshot: ${await shot('1-results')}`);

  // ------------------------------------------------------------- 2. Vote
  await page.locator('#nav a', { hasText: 'Vote' }).click();
  await page.waitForTimeout(3000);
  let voteText = await page.locator('#screen').innerText();

  if (/demo pool is refilling|No demo pool published/i.test(voteText)) {
    note('warn', 'vote', 'no demo identity available right now — cannot cast');
    console.log(`  screenshot: ${await shot('2-vote-unavailable')}`);
  } else if (!/demo identity/i.test(voteText)) {
    note('fail', 'vote', `unexpected Vote content: ${voteText.slice(0, 200)}`);
    console.log(`  screenshot: ${await shot('2-vote-broken')}`);
  } else {
    note('ok', 'vote', 'a demo identity was offered, and labelled as one');
    if (await page.locator('.identity summary', { hasText: 'Why?' }).isVisible()) {
      note('ok', 'vote', 'demo identity on one line with a "Why?" toggle');
    } else note('fail', 'vote', 'no "Why?" toggle on the demo identity');
    const firstChoice = await page.locator('.choice').first().boundingBox();
    if (firstChoice && firstChoice.y + firstChoice.height <= vp.height) {
      note('ok', 'vote', `choices above the fold (first choice ends at ${Math.round(firstChoice.y + firstChoice.height)}px of ${vp.height})`);
    } else note('fail', 'vote', 'first choice is below the fold');
    judgeContrast('vote', await contrastOf(page, 'button[type=submit]'), 'cast button');
    console.log(`  screenshot: ${await shot('2-vote-ready')}`);

    const choices = await page.locator('.choice').count();
    if (choices < 2) note('fail', 'vote', `only ${choices} choice(s) rendered`);
    else note('ok', 'vote', `${choices} choices rendered`);

    // Pick the second option so it is a deliberate selection, not the default.
    await page.locator('.choice').nth(1).click();
    await page.locator('button[type=submit]').click();

    // Sealing + estimate + send + receipt. Allow generously.
    try {
      await page.waitForSelector('text=Your ballot is on chain', { timeout: 120_000 });
      note('ok', 'vote', 'ballot accepted on chain');
    } catch {
      const status = await page.locator('#screen').innerText();
      note('fail', 'vote', `no receipt after 120s. Screen says: ${status.slice(-300)}`);
      console.log(`  screenshot: ${await shot('2-vote-failed')}`);
    }

    const receipt = await page.locator('#screen').innerText();
    if (/Ballot id/i.test(receipt)) note('ok', 'vote', 'receipt shows a ballot id');
    else note('fail', 'vote', 'receipt has no ballot id');

    const hashMatch = /0x[0-9a-f]{64}/i.exec(receipt);
    if (hashMatch) note('ok', 'vote', `receipt shows a ciphertext hash ${hashMatch[0].slice(0, 14)}…`);
    else note('fail', 'vote', 'receipt has no ciphertext hash');

    if (/inclusion check passed/i.test(receipt)) {
      note('ok', 'vote', 'inclusion check passed against the chain');
    } else if (/inclusion check FAILED/i.test(receipt)) {
      note('fail', 'vote', 'inclusion check FAILED');
    } else {
      note('warn', 'vote', 'no inclusion check line found');
    }
    const doneSteps = await page.locator('.progress li.done').count();
    if (doneSteps === 5) note('ok', 'vote', 'all 5 progress steps ticked');
    else note('fail', 'vote', `${doneSteps} of 5 progress steps ticked`);
    const tech = page.locator('details.tech');
    if ((await tech.count()) && !(await tech.evaluate((d) => d.open)) && !/Gas limit/.test(await page.locator('#screen').innerText())) {
      note('ok', 'vote', 'gas line tucked into a collapsed "Technical details"');
    } else note('fail', 'vote', 'gas line not inside a collapsed "Technical details"');
    console.log(`  screenshot: ${await shot('3-vote-receipt')}`);

    // ------------------------------------------- 3. a second vote attempt
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#nav a', { hasText: 'Vote' }).click();
    await page.waitForTimeout(3500);
    const second = await page.locator('#screen').innerText();

    if (/Something failed|undefined|NaN/i.test(second)) {
      note('fail', 'vote', `second attempt shows an error: ${second.slice(0, 200)}`);
    } else if (/demo pool is refilling/i.test(second)) {
      note('ok', 'vote', 'second attempt: pool exhausted, explained cleanly');
    } else if (/demo identity/i.test(second)) {
      note('ok', 'vote', 'second attempt: a different demo identity offered');
    } else {
      note('warn', 'vote', `second attempt unclear: ${second.slice(0, 160)}`);
    }
    console.log(`  screenshot: ${await shot('4-vote-second')}`);
  }

  // ------------------------------------------------------------- 4. Q-Day
  await page.locator('#nav a', { hasText: 'Q-Day' }).click();
  await page.waitForTimeout(2500);

  const sim = await page.locator('.sim-badge').first();
  if (await sim.isVisible()) {
    note('ok', 'qday', `SIMULATION label visible: "${(await sim.textContent())?.slice(0, 40)}…"`);
  } else {
    note('fail', 'qday', 'SIMULATION label not visible');
  }

  const rowsBefore = await page.locator('.qday-row').count();
  if (rowsBefore !== 20) note('fail', 'qday', `expected 20 ballot rows, found ${rowsBefore}`);
  else note('ok', 'qday', '20 rows: ten ballots, sealed two ways');
  judgeContrast('qday', await contrastOf(page, '.sim-badge'), 'SIMULATION badge');
  judgeContrast('qday', await contrastOf(page, '#screen button'), 'Fast-forward button');
  console.log(`  screenshot: ${await shot('5-qday-before')}`);

  const button = page.locator('button', { hasText: 'Fast-forward to 2040' });
  if (!(await button.isVisible())) {
    note('fail', 'qday', 'Fast-forward button missing');
  } else {
    await button.click();
    await page.waitForTimeout(3000);

    const broken = await page.locator('.qday-row.broken').count();
    const held = await page.locator('.qday-row.held').count();

    if (broken === 10) note('ok', 'qday', 'all 10 classical ballots broken open');
    else note('fail', 'qday', `${broken} of 10 classical ballots opened`);

    if (held === 10) note('ok', 'qday', 'all 10 Booth ballots still sealed');
    else note('fail', 'qday', `only ${held} of 10 Booth ballots held`);

    const qdayText = await page.locator('#screen').innerText();
    const name = /Ada Lovelace|Grace Hopper|Alan Turing/.exec(qdayText);
    if (name) note('ok', 'qday', `a voter name is now exposed on the left: ${name[0]}`);
    else note('fail', 'qday', 'no voter name revealed — the attack did not land');

    if (/DECRYPTION_FAILED|NOT_A_RECIPIENT/.test(qdayText)) {
      note('ok', 'qday', 'QoreSeal error codes shown as evidence');
    } else {
      note('warn', 'qday', 'no QoreSeal error code shown');
    }
    const verdictClass = await page.locator('#screen .actions + p').getAttribute('class');
    if (verdictClass === 'verdict') note('ok', 'qday', 'result line is neutral, not green');
    else note('fail', 'qday', `result line class is "${verdictClass}"`);
    judgeContrast('qday', await contrastOf(page, '#screen .warn'), 'warning text');
    console.log(`  screenshot: ${await shot('6-qday-after')}`);

    const reset = page.locator('#screen button', { hasText: 'Reset' });
    if (!(await reset.isVisible())) {
      note('fail', 'qday', 'no Reset button after the run');
    } else {
      await reset.click();
      await page.waitForTimeout(2500);
      const sealedAgain = await page.locator('.qday-row.sealed').count();
      const brokenAgain = await page.locator('.qday-row.broken').count();
      const ffEnabled = await page.locator('button', { hasText: 'Fast-forward to 2040' }).isEnabled();
      if (sealedAgain === 20 && brokenAgain === 0 && ffEnabled) {
        note('ok', 'qday', 'Reset restores 20 sealed ballots and re-arms the run, no reload');
      } else note('fail', 'qday', `after Reset: ${sealedAgain} sealed, ${brokenAgain} broken, fast-forward ${ffEnabled ? 'on' : 'off'}`);
      console.log(`  screenshot: ${await shot('7-qday-reset')}`);
    }
  }

  // ------------------------------------------------- 5. console + requests
  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  // Also surface the landing-screen order, which was racy.
  note('ok', 'shell', `screen order: ${nav.join(' / ')}`);
  if (realErrors.length === 0) note('ok', 'console', 'no console errors');
  else for (const e of realErrors.slice(0, 6)) note('fail', 'console', e.slice(0, 220));

  const realFailed = failedRequests.filter((r) => !/favicon/i.test(r));
  if (realFailed.length === 0) note('ok', 'network', 'no failed requests');
  else for (const r of realFailed.slice(0, 6)) note('fail', 'network', r.slice(0, 220));

  await context.close();
}

// ------------------------------------- dark mode: contrast only, no casting
{
  console.log(`\n================ dark mode (1440x900, contrast only, casts nothing) ================`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const page = await context.newPage();
  const shot = async (name) => {
    const file = join(SHOTS, `dark-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  };
  await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(2500);
  judgeContrast('dark', await contrastOf(page, '#screen .button, #screen button, #screen .warn'), 'Results buttons and warnings');
  console.log(`  screenshot: ${await shot('1-results')}`);
  await page.locator('#nav a', { hasText: 'Vote' }).click();
  await page.waitForTimeout(3000);
  judgeContrast('dark', await contrastOf(page, 'button[type=submit]'), 'cast button');
  console.log(`  screenshot: ${await shot('2-vote-ready')}`);
  await page.locator('#nav a', { hasText: 'Q-Day' }).click();
  await page.waitForTimeout(2500);
  judgeContrast('dark', await contrastOf(page, '.sim-badge, #screen button'), 'SIMULATION badge and button');
  console.log(`  screenshot: ${await shot('5-qday-before')}`);
  await context.close();
}

await browser.close();

// ------------------------------------------------------------------ summary

const fails = findings.filter((f) => f.level === 'fail');
const warns = findings.filter((f) => f.level === 'warn');
console.log(`\n================ summary ================`);
console.log(`  ${findings.length - fails.length - warns.length} ok, ${warns.length} warning(s), ${fails.length} failure(s)`);
for (const f of fails) console.log(`  FAIL  ${f.where}: ${f.message}`);
for (const f of warns) console.log(`  warn  ${f.where}: ${f.message}`);
console.log(`  screenshots in ${SHOTS}`);

writeFileSync(join(SHOTS, 'report.json'), JSON.stringify({ url: URL_UNDER_TEST, findings }, null, 2) + '\n');
process.exit(fails.length ? 1 : 0);

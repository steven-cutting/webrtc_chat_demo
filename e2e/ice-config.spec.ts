import { expect, test, type Page } from '@playwright/test';
import { installPc, type Fixture } from './pc';

// The ICE server configuration surface: src/ice-config.ts reads it out of location.hash, and
// src/main.ts §2 builds pc from what it returns. Everything here is about which RTCConfiguration
// the BROWSER ended up with, never about which one the parser thinks it produced -- installPc's
// `config` is a top-level spread over the app's object (e2e/pc.ts), so those two can be made to
// disagree, and every claim this app prints about the running connection has to come from the one
// the engine actually holds.
//
// Nothing in this file starts ICE gathering against a real relay, and no test in this repo does:
// a relay of one's own is not a thing a suite may depend on, and a green run here says the
// configuration crossed the constructor, not that any relay would answer.

/**
 * The applied configuration, read back through the browser. `urls` is normalised because
 * getConfiguration() is free to return the string form or the array form and this repo has not
 * measured which -- an assertion should not be a reading of that.
 */
async function applied(page: Page): Promise<{ urls: string[]; policy: string }> {
  return page.evaluate(() => {
    const pc = (window as unknown as Record<string, unknown>).__pc as RTCPeerConnection;
    const cfg = pc.getConfiguration();
    const urls = (cfg.iceServers ?? []).flatMap((s) =>
      typeof s.urls === 'string' ? [s.urls] : [...s.urls]);
    return { urls, policy: cfg.iceTransportPolicy ?? 'all' };
  });
}

test('with no fragment the connection carries exactly the built-in STUN server and no relay', async ({ page }) => {
  // The guard on the decision that the default stays zero-relay. It is expected to be green the
  // moment it is written, and that is its job: every other test in this file reads as "and this is
  // what CHANGED it" only because this one pins what the default is.
  await installPc(page); // no config override: the app's own object reaches the browser
  await page.goto('/');

  expect(await applied(page)).toEqual({
    urls: ['stun:stun.l.google.com:19302'],
    policy: 'all',
  });
  await expect(page.getByTestId('diag')).toContainText('relay:0');
  await expect(page.getByTestId('ice-panel')).not.toHaveAttribute('open', '');
});

test('an ice fragment reaches the real RTCConfiguration, and the tab says whose relay it is on', async ({ page }) => {
  await installPc(page);
  await page.goto('/#ice=stun:stun.l.google.com:19302&ice=turn:relay.example:3478&username=u&credential=p');

  expect(await applied(page)).toEqual({
    urls: ['stun:stun.l.google.com:19302', 'turn:relay.example:3478'],
    policy: 'all',
  });
  // A tab running a relay someone else chose must not look like a default one: that server sees
  // both endpoints' addresses, so the panel is open and the host is named where it cannot scroll.
  await expect(page.getByTestId('diag')).toContainText('relay:1');
  await expect(page.getByTestId('ice-panel')).toHaveAttribute('open', '');
  await expect(page.getByTestId('ice-status')).toContainText('relay.example');
  await expect(page.getByTestId('wire-log')).toContainText('turn:relay.example:3478');
  // Prefilled from what is RUNNING, credentials included. Empty boxes beside a working relay
  // read as "no credentials configured", and the operator's next move is to retype the two
  // values that were already right -- or to press Apply and silently strip them.
  await expect(page.getByTestId('ice-urls')).toHaveValue(
    'stun:stun.l.google.com:19302\nturn:relay.example:3478');
  await expect(page.getByTestId('ice-username')).toHaveValue('u');
  await expect(page.getByTestId('ice-credential')).toHaveValue('p');
  // A configuration is not an error.
  await expect(page.getByTestId('error')).toHaveText('');
});

test('the ice list replaces the default rather than adding to it', async ({ page }) => {
  // Legibility is the whole argument for a readable fragment: what the link says is what runs.
  // Quietly keeping a Google STUN server that the link does not name would break exactly that, so
  // the panel prefills the effective list instead and the operator carries it forward on purpose.
  await installPc(page);
  await page.goto('/#ice=turn:relay.example:3478&username=u&credential=p');

  expect((await applied(page)).urls).toEqual(['turn:relay.example:3478']);
});

const REFUSED: [string, string, string][] = [
  ['a scheme that is not an ICE scheme', '#ice=https://relay.example/', 'https://relay.example/'],
  ['a javascript: URL', '#ice=javascript:alert(1)', 'javascript:alert(1)'],
  ['a relay with no credentials', '#ice=turn:relay.example:3478', 'turn:relay.example:3478'],
  ['more servers than anyone configures by hand',
   '#ice=stun:a.example&ice=stun:b.example&ice=stun:c.example&ice=stun:d.example&ice=stun:e.example',
   'more than 4'],
  ['a transport policy that is neither', '#ice=stun:a.example&policy=sideways', 'sideways'],
];

for (const [name, hash, echoed] of REFUSED) {
  test(`refuses ${name}, keeps the default, and says which value it dropped`, async ({ page }) => {
    await installPc(page);
    await page.goto(`/${hash}`);

    expect((await applied(page)).urls).toEqual(['stun:stun.l.google.com:19302']);
    await expect(page.getByTestId('wire-log')).toContainText(echoed);
    // The page has to still WORK. A refusal that took the offer button with it would be a worse
    // failure than the configuration it refused.
    await page.getByTestId('create-offer').click();
    await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
  });
}

test('a fragment that is not an ice configuration is left entirely alone', async ({ page }) => {
  await installPc(page);
  await page.goto('/#top');

  expect((await applied(page)).urls).toEqual(['stun:stun.l.google.com:19302']);
  await expect(page.getByTestId('wire-log')).not.toContainText('ignored');
  await expect(page.getByTestId('ice-panel')).not.toHaveAttribute('open', '');
});

test('a configuration the engine itself refuses falls back instead of blanking the page', async ({ page }) => {
  // src/main.ts builds pc at module scope. A throw there registers no listener, runs no render(),
  // and leaves every control dead behind an empty diagnostics strip -- delivered by a link. The
  // validator is written from a reading of the spec; this catch is what stops that reading being
  // load-bearing.
  await installPc(page, { throwOnce: 'the engine refused that ICE configuration' });
  await page.goto('/#ice=turn:relay.example:3478&username=u&credential=p');

  expect((await applied(page)).urls).toEqual(['stun:stun.l.google.com:19302']);
  await expect(page.getByTestId('wire-log')).toContainText('the engine refused that ICE configuration');
  await expect(page.getByTestId('diag')).toContainText('relay:0');
  await page.getByTestId('create-offer').click();
  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
});

test('Reset keeps the relay, because the whole design rests on a reload preserving the fragment', async ({ page }) => {
  // Asserted rather than recalled. pc is built once, at module scope, so a configuration change
  // only lands on a reload -- and Reset IS location.reload() (src/main.ts). If a reload dropped the
  // fragment, Reset would silently return the operator to the configuration that failed.
  await installPc(page);
  await page.goto('/#ice=turn:relay.example:3478&username=u&credential=p');
  await expect(page.getByTestId('diag')).toContainText('relay:1');

  await page.getByTestId('reset').click();
  await expect(page.getByTestId('diag')).toContainText('relay:1');
  expect((await applied(page)).urls).toEqual(['turn:relay.example:3478']);
});

test('Apply writes the fragment, so the running URL is the invite link', async ({ browser }) => {
  // No clipboard anywhere in this suite: no permission grants, no headless flake, and the
  // assertion surface is the URL itself. Because Apply writes the fragment, the link and the page
  // cannot diverge -- which is also what keeps the Pages base path right with no test for it.
  const ctxA = await browser.newContext();
  const A = await ctxA.newPage();
  await installPc(A);
  await A.goto('/');

  await A.getByTestId('ice-panel').click(); // open the disclosure
  await A.getByTestId('ice-urls').fill('stun:stun.l.google.com:19302\nturn:relay.example:3478');
  await A.getByTestId('ice-username').fill('u');
  await A.getByTestId('ice-credential').fill('p+/=');
  await A.getByTestId('ice-apply').click();

  await expect(A.getByTestId('diag')).toContainText('relay:1');
  const link = A.url();
  expect(link).toContain('#ice=');

  // The other device opens that link and gets the same connection, credential intact -- a base64
  // credential carries + and / and = and none of them may be mangled by the round trip.
  const ctxB = await browser.newContext();
  const B = await ctxB.newPage();
  await installPc(B);
  await B.goto(link);
  expect((await applied(B)).urls).toEqual([
    'stun:stun.l.google.com:19302', 'turn:relay.example:3478',
  ]);
  expect(await B.evaluate(() => {
    const pc = (window as unknown as Record<string, unknown>).__pc as RTCPeerConnection;
    return (pc.getConfiguration().iceServers ?? []).map((s) => s.credential);
  })).toContain('p+/=');

  await ctxA.close();
  await ctxB.close();
});

test('force relay reaches the transport policy and is impossible to miss', async ({ page }) => {
  // The knob the manual procedure turns to prove a relay is real. It must be visible in the
  // diagnostics strip, because a forced-relay session that looked like a normal one would make
  // every other reading on the page mean something else.
  await installPc(page);
  await page.goto('/#ice=turn:relay.example:3478&username=u&credential=p&policy=relay');

  expect((await applied(page)).policy).toBe('relay');
  await expect(page.getByTestId('diag')).toContainText('policy:relay');
});

/** A real two-context handshake, with one side's getStats() served from a fixture. */
async function connected(browser: import('@playwright/test').Browser, stats: Fixture) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await installPc(A, { stats });
  await A.goto('/');
  await B.goto('/');

  await A.getByTestId('create-offer').click();
  await expect(A.getByTestId('signal-phase')).toHaveText('offer-ready');
  await B.getByTestId('remote-blob').fill(await A.getByTestId('local-blob').inputValue());
  await B.getByTestId('accept').click();
  await expect(B.getByTestId('signal-phase')).toHaveText('answer-ready');
  await A.getByTestId('remote-blob').fill(await B.getByTestId('local-blob').inputValue());
  await A.getByTestId('accept').click();
  await expect(A.getByTestId('diag')).toContainText('channel:open');
  return { A, close: async (): Promise<void> => { await ctxA.close(); await ctxB.close(); } };
}

test('a connected session says which pair carried it, so a relayed path is not invisible', async ({ browser }) => {
  // §8 runs only from connectionState 'failed', so until now a session that WORKED said nothing
  // about how. Under the ordinary policy there is no other way to tell a relayed path from a direct
  // one -- and relaying has privacy and cost consequences the operator should not have to infer.
  const { A, close } = await connected(browser, [
    ['T', { type: 'transport', selectedCandidatePairId: 'P' }],
    ['P', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' }],
    ['L', { type: 'local-candidate', candidateType: 'relay', protocol: 'udp', url: 'turn:198.51.100.1:3478' }],
    ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ]);

  await expect(A.getByTestId('wire-log')).toContainText('path — relay ↔ srflx via turn:198.51.100.1:3478');
  // handshake.spec.ts asserts a healthy run never prints 'post-mortem'; this line is on the success
  // path and must not put that word in the log.
  await expect(A.getByTestId('wire-log')).not.toContainText('post-mortem');
  await expect(A.getByTestId('error')).toHaveText('');
  await close();
});

test('and says so plainly when the engine reports no selected pair, rather than guessing', async ({ browser }) => {
  // Safari's reporting here is not measured anywhere in this repo -- no project runs WebKit -- so
  // the only honest degrade is to name the gap. A guess would be worse than the silence it replaced.
  const { A, close } = await connected(browser, []);

  await expect(A.getByTestId('wire-log')).toContainText('path — not knowable from here');
  await expect(A.getByTestId('wire-log')).not.toContainText('post-mortem');
  await close();
});

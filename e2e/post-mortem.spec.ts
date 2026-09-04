import { expect, test, type Page } from '@playwright/test';

// The getStats() post-mortem in src/main.ts §8. It replaces one fixed sentence
// ("Press Reset in both tabs and redo the exchange") that used to be printed under
// every cause -- advice that, for a blocked path, reproduces the failure exactly.
//
// Almost none of this needs a real 15 s ICE timeout: the post-mortem is a pure
// function of (remote SDP, getStats() report), and both are supplied here. Only the
// last test pays for a real one, because it is the only claim about Chromium rather
// than about our own logic.

type Fixture = [string, Record<string, unknown>][];

/**
 * Stash the app's pc on window, and optionally serve getStats() from a fixture.
 *
 * The fixture is installed from addInitScript -- before src/main.ts constructs pc --
 * rather than patched in later, so the 1 s sampler can never record a real report
 * that outranks it. §8 deliberately keeps the richest snapshot it has seen.
 */
async function install(page: Page, stats?: Fixture): Promise<void> {
  await page.addInitScript((fixture: Fixture | undefined) => {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Orig {
      constructor(cfg?: RTCConfiguration) {
        super(cfg);
        (window as unknown as Record<string, unknown>).__pc = this;
        if (fixture) {
          // A Map's forEach signature is RTCStatsReport's, which is all §8 uses.
          (this as unknown as Record<string, unknown>).getStats =
            async (): Promise<unknown> => new Map(fixture.map(([id, s]) => [id, { id, ...s }]));
        }
      }
    };
  }, stats);
}

/** Replace every a=candidate line in a real, otherwise-untouched offer. */
function withCandidates(sdp: string, lines: string[]): string {
  const out: string[] = [];
  let spliced = false;
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('a=candidate:')) {
      if (!spliced) { out.push(...lines); spliced = true; }
      continue; // drop the donor's own candidates
    }
    out.push(line);
  }
  // Loud rather than silent: no candidates means the host gathered none, and every
  // assertion below would then be measuring the wrong thing.
  if (!spliced) throw new Error('the donor offer carried no candidates to replace');
  return out.join('\r\n');
}

const MDNS_HOST = (uuid: string): string =>
  `a=candidate:1 1 udp 2113937151 ${uuid}.local 50000 typ host generation 0 network-cost 999`;
const IP_HOST =
  'a=candidate:2 1 udp 2113937150 192.0.2.1 50001 typ host generation 0 network-cost 999';

/**
 * A crafted offer into a real answerer, so currentRemoteDescription is exactly
 * these candidates and localDescription is a real answer. Returns the answerer.
 */
async function answererWith(page: Page, donor: Page, candidates: string[]): Promise<void> {
  await donor.goto('/');
  await donor.getByTestId('create-offer').click();
  await expect(donor.getByTestId('signal-phase')).toHaveText('offer-ready');

  const offer = JSON.parse(await donor.getByTestId('local-blob').inputValue()) as { sdp: string };
  offer.sdp = withCandidates(offer.sdp, candidates);

  await page.goto('/');
  await page.getByTestId('remote-blob').fill(JSON.stringify(offer));
  await page.getByTestId('accept').click();
  await expect(page.getByTestId('signal-phase')).toHaveText('answer-ready');
}

/** Drive connectionState to 'failed' without waiting 15 s for the real thing. */
async function synthesizeFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pc = (window as unknown as Record<string, unknown>).__pc as RTCPeerConnection;
    Object.defineProperty(pc, 'connectionState', { get: () => 'failed', configurable: true });
    pc.dispatchEvent(new Event('connectionstatechange'));
  });
}

const PAIR = (extra: Record<string, unknown>): Record<string, unknown> => ({
  type: 'candidate-pair', state: 'failed', localCandidateId: 'L', remoteCandidateId: 'R',
  requestsSent: 9, requestsReceived: 0, responsesReceived: 0, ...extra,
});

test('names mDNS when the peer\'s .local candidates never became remote candidates', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // A freshly minted UUID label is registered by no responder anywhere, so it fails
  // to resolve identically whether this host's multicast DNS is healthy, blocked by
  // Local Network privacy, or absent in a container. Deterministic by construction.
  const uuid = '4f1a2c3d-0000-4000-8000-abcdef123456';
  await install(page, [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', url: 'stun:stun.l.google.com:19302' }],
    ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ]);
  await answererWith(page, donor, [MDNS_HOST(uuid)]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('never resolved');
  await expect(page.getByTestId('wire-log')).toContainText('Local Network');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  await expect(page.getByTestId('wire-log')).toContainText('udp-host-pairs:0');
  // Real provenance, read from local-candidate.url rather than asserted.
  await expect(page.getByTestId('wire-log')).toContainText('stun:stun.l.google.com:19302');
  // The whole point of the change: the old blanket advice must not be the verdict.
  await expect(page.getByTestId('error')).not.toContainText('Press Reset in both tabs');

  await ctx.close();
});

test('names silence, not mDNS, when the peer offered a routable candidate', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  await install(page, [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ]);
  await answererWith(page, donor, [IP_HOST]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('9 connectivity checks were sent and none came back');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:0');
  await expect(page.getByTestId('wire-log')).not.toContainText('never resolved');

  await ctx.close();
});

test('does NOT blame mDNS when a udp host pair did form', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // Both an unresolvable .local AND a routable host. A udp host pair exists, which
  // proves resolution worked -- the gate is pair-based precisely so that this run,
  // and every healthy run on an engine that also emits a tcptype-active host
  // candidate, cannot be misread as a multicast failure.
  await install(page, [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ]);
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-1111-4000-8000-abcdef123456'), IP_HOST]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('udp-host-pairs:1');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  await expect(page.getByTestId('wire-log')).not.toContainText('never resolved');

  await ctx.close();
});

test('a real ICE failure still reports its candidate pairs', async ({ browser }) => {
  // The one claim the fixtures cannot make, because it is about Chromium and not
  // about our logic: that §8's sampler really does capture a pair from a real ICE
  // failure. Note what it does NOT assert -- pairs do not survive to the 'failed'
  // event. Measured on this host: the 1 s sampler saw 1 pair on all 15 ticks while
  // a getStats() read from inside the 'failed' handler returned 0, because libwebrtc
  // tears down write-timed-out connections as it reports failed. That is the whole
  // reason §8 samples instead of reading once; a naive read would see no pairs, and
  // 'udp-host-pairs:0' would then be trivially true on EVERY failure, firing the
  // mDNS verdict at operators whose multicast is fine. If this goes red with
  // pairs:0, the sampler has stopped working and that false positive is back.
  test.skip(test.info().project.name !== 'chromium', 'libwebrtc-level behaviour; ~15 s of real ICE');
  test.setTimeout(60_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  await install(page); // no fixture: real getStats()
  await answererWith(page, donor, [IP_HOST]); // routable, blackholed -> a pair forms, then times out

  await expect(page.getByTestId('wire-log')).toContainText('post-mortem —', { timeout: 40_000 });
  const evidence = await page.getByTestId('wire-log').innerText();
  const pairs = /post-mortem — pairs:(\d+)/.exec(evidence);
  expect(pairs, 'the post-mortem never printed its evidence line').not.toBeNull();
  expect(Number(pairs?.[1]), 'no candidate pair survived to the failed event — see §8').toBeGreaterThan(0);

  await ctx.close();
});

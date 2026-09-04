import { expect, test, type Page } from '@playwright/test';
import { installPc, IP_HOST, MDNS_HOST, SRFLX, SRFLX6, SRFLX_BLACKHOLE, UDP_HOST } from './pc';

// The getStats() post-mortem in src/main.ts §8. It replaces one fixed sentence
// ("Press Reset in both tabs and redo the exchange") that used to be printed under
// every cause -- advice that, for a blocked path, reproduces the failure exactly.
//
// Almost none of this needs a real 15 s ICE timeout: the post-mortem is a pure
// function of (remote SDP, local SDP, getStats() report, what this session had already
// reached), and all four are supplied here. Only the last test pays for a real one,
// because it is the only claim about Chromium rather than about our own logic.

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

test('names mDNS when no pair was ever formed against the peer\'s .local candidates', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // A freshly minted UUID label is registered by no responder anywhere, so it fails
  // to resolve identically whether this host's multicast DNS is healthy, blocked by
  // Local Network privacy, or absent in a container. Deterministic by construction.
  const uuid = '4f1a2c3d-0000-4000-8000-abcdef123456';
  await installPc(page, { stats: [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', url: 'stun:stun.l.google.com:19302' }],
    ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ] });
  await answererWith(page, donor, [MDNS_HOST(uuid)]);
  await synthesizeFailure(page);

  // The claim is pair absence, and the cause is RANKED rather than asserted: getStats
  // cannot distinguish a name that never resolved from one that resolved to an address
  // nothing here could pair with.
  await expect(page.getByTestId('wire-log')).toContainText('no candidate pair was ever formed against');
  await expect(page.getByTestId('wire-log')).toContainText('leading suspect');
  await expect(page.getByTestId('wire-log')).not.toContainText('never resolved —');
  await expect(page.getByTestId('wire-log')).toContainText('Local Network');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  await expect(page.getByTestId('wire-log')).toContainText('udp-host-pairs:0');
  await expect(page.getByTestId('wire-log')).toContainText('remote-hosts:0');
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

  await installPc(page, { stats: [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ] });
  await answererWith(page, donor, [IP_HOST]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('9 connectivity checks were sent and none came back');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:0');
  await expect(page.getByTestId('wire-log')).not.toContainText('.local host candidates');

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
  await installPc(page, { stats: [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ] });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-1111-4000-8000-abcdef123456'), IP_HOST]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('udp-host-pairs:1');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  await expect(page.getByTestId('wire-log')).not.toContainText('.local host candidates');

  await ctx.close();
});

test('does NOT blame mDNS when the pair exists but this side is not reported as host', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // udp-host-pairs cannot carry the verdict alone, because the LOCAL candidate's reported
  // type is not stable: Connection::MaybeUpdateLocalCandidate rewrites it to srflx or prflx
  // when a check's mapped address differs from the port's own. That drops a pair mDNS had
  // demonstrably built out of the counter -- but the remote side still reads 'host', which
  // is why remote-hosts is in the gate.
  await installPc(page, { stats: [
    ['P', PAIR({})],
    ['L', { type: 'local-candidate', candidateType: 'prflx', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ] });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-2222-4000-8000-abcdef123456')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('udp-host-pairs:0');
  await expect(page.getByTestId('wire-log')).toContainText('remote-hosts:1');
  await expect(page.getByTestId('wire-log')).not.toContainText('.local host candidates');
  // and it still says the thing that IS true about this snapshot
  await expect(page.getByTestId('error')).toContainText('none came back');

  await ctx.close();
});

test('does NOT blame mDNS when the two ends have different public addresses', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // The failure this whole change exists for: laptop on Wi-Fi, phone on cellular. Every
  // conjunct of the mDNS gate holds here too -- the peer offered .local names, this side
  // has udp host candidates, no path was found, and nothing paired against those names --
  // because a .local name CANNOT resolve across the internet. That zero is the expected
  // reading of a cross-network attempt, not evidence of a broken multicast stack, and the
  // macOS Local Network advice is the one thing an operator on cellular cannot act on.
  //
  // What separates the two cases is not in getStats at all: it is whether the two ends'
  // server-reflexive addresses intersect. They do not here.
  await installPc(page, {
    stats: [
      ['P', PAIR({})],
      ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', url: 'stun:stun.l.google.com:19302' }],
      ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ],
    localCandidates: [UDP_HOST, SRFLX('203.0.113.9')],
  });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-4444-4000-8000-abcdef123456'), SRFLX('198.51.100.7')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('local-srflx:1 remote-srflx:1 nets:different');
  // The suppression, headline and log alike. mdns-offered is still 1: the peer really did
  // offer .local names, and the evidence line still says so. It is the VERDICT that is wrong.
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  // The suppression -- and NOT by the absence of the phrase '.local host candidates', which
  // the cross-network verdict uses itself to say why that zero is expected. What must be
  // gone is the mDNS verdict's own two marks: its ranked cause and its remedy.
  await expect(page.getByTestId('wire-log')).not.toContainText('leading suspect');
  await expect(page.getByTestId('wire-log')).not.toContainText('Local Network');

  await ctx.close();
});

test('names the relay-shaped failure when both ends published reflexive candidates and nothing answered', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  await installPc(page, {
    stats: [
      ['P', PAIR({})],
      ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', url: 'stun:stun.l.google.com:19302' }],
      ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ],
    localCandidates: [UDP_HOST, SRFLX('203.0.113.9')],
  });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-5555-4000-8000-abcdef123456'), SRFLX('198.51.100.7')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('error')).toContainText('different public addresses');
  await expect(page.getByTestId('error')).toContainText('9 connectivity checks went out with 0 answered');
  // Ranked, not decided. A NAT that maps per destination and a firewall that drops inbound
  // UDP are indistinguishable from here, and the text has to say so rather than pick one --
  // the same register the mDNS finding holds itself to.
  await expect(page.getByTestId('error')).toContainText('Two readings fit');
  await expect(page.getByTestId('error')).toContainText('symmetric');
  await expect(page.getByTestId('error')).toContainText('drops inbound UDP');
  // What is actually missing, said plainly, plus the one workaround that does not need it.
  await expect(page.getByTestId('error')).toContainText('a TURN relay is what is missing');
  await expect(page.getByTestId('error')).toContainText('put both devices on the same network');
  // Reset is not the remedy for a blocked path; it is the action that reproduces it.
  await expect(page.getByTestId('error')).not.toContainText('Press Reset in both tabs');

  await ctx.close();
});

test('keeps blaming mDNS when the two ends share a public address', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // The regression guard for the suppressor above. Two peers behind one NAT are reflected
  // to the SAME public address, so the intersection is non-empty and the cross-network
  // reading does not hold -- which is exactly when the .local names were supposed to work
  // and did not.
  await installPc(page, {
    stats: [
      ['P', PAIR({})],
      ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp', url: 'stun:stun.l.google.com:19302' }],
      ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ],
    localCandidates: [UDP_HOST, SRFLX('198.51.100.7')],
  });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-6666-4000-8000-abcdef123456'), SRFLX('198.51.100.7')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('local-srflx:1 remote-srflx:1 nets:same');
  await expect(page.getByTestId('error')).toContainText('no candidate pair was ever formed against');
  await expect(page.getByTestId('error')).toContainText('Local Network');
  await expect(page.getByTestId('wire-log')).not.toContainText('different public addresses');

  await ctx.close();
});

test('names an address-family split as the thing that makes a pair impossible', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // The one cross-network reading that is provable rather than ranked: with no family in
  // common there is no address the two ends share, so the absent pair is arithmetic, not a
  // suspicion. It leads when it holds, ahead of the symmetric-NAT reading.
  await installPc(page, {
    stats: [
      ['P', PAIR({})],
      ['L', { type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
      ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ],
    localCandidates: [UDP_HOST, SRFLX('203.0.113.9')],
  });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-7777-4000-8000-abcdef123456'), SRFLX6('2001:db8::1')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('error')).toContainText('only IPv4 server-reflexive candidates and the peer only IPv6');
  await expect(page.getByTestId('error')).toContainText('no address the two ends share');
  // Disjoint families are disjoint addresses, so the cross-network reading holds too -- it
  // is simply the weaker of the two and must not take the headline from it.
  await expect(page.getByTestId('wire-log')).toContainText('nets:different');
  await expect(page.getByTestId('wire-log')).toContainText('different public addresses');
  await expect(page.getByTestId('wire-log')).not.toContainText('leading suspect');
  await expect(page.getByTestId('wire-log')).not.toContainText('Local Network');

  await ctx.close();
});

test('a side with no reflexive candidate is reported, but does not take the headline', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // With one side at zero srflx the addresses cannot be compared at all, so the
  // discriminator reads 'unknown' and the mDNS finding still holds the headline. That is
  // deliberate: on a healthy LAN a peer legitimately has no srflx, and promoting this
  // finding would steal the headline in the exact scenario the mDNS one was written for.
  // The pre-flight LAN ONLY marker is what covers this case, before the blob is copied.
  await installPc(page, {
    stats: [
      ['P', PAIR({})],
      ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
      ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
    ],
    localCandidates: [UDP_HOST],
  });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-8888-4000-8000-abcdef123456'), SRFLX('198.51.100.7')]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('local-srflx:0 remote-srflx:1 nets:unknown');
  await expect(page.getByTestId('wire-log')).toContainText('never got a server-reflexive candidate of its own');
  await expect(page.getByTestId('error')).toContainText('Local Network');

  await ctx.close();
});

test('a succeeded pair without a connected ICE is reported as historical', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // 'succeeded' in a retained sample is a reading of an earlier moment, not of the state at
  // 'failed'. Saying "ICE found a path, so the failure is after it" from this alone rules
  // ICE out on evidence that cannot rule it out -- a path found and then lost before DTLS
  // finished leaves exactly this trace.
  await installPc(page, { stats: [
    ['P', PAIR({ state: 'succeeded' })],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
  ] });
  await answererWith(page, donor, [IP_HOST]);
  await synthesizeFailure(page);

  await expect(page.getByTestId('wire-log')).toContainText('had reached succeeded in an earlier sample');
  await expect(page.getByTestId('wire-log')).toContainText('may simply have gone away');
  await expect(page.getByTestId('wire-log')).not.toContainText('ICE reported connected');

  await ctx.close();
});

test('a session that had an open channel is diagnosed as path loss, not as DTLS or SCTP', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  // The one case the fixtures cannot reach on their own: a real handshake that reached
  // channel:open, and only then failed. This fixture is what the previous revision read as
  // two independent proofs about a handshake -- a succeeded pair ("whatever failed is after
  // ICE, so DTLS or SCTP") and no pair against B's real .local host candidates ("their names
  // never resolved, check Local Network"). Both are false once the channel has been open:
  // DTLS and SCTP demonstrably finished, and mDNS demonstrably stopped nothing.
  await installPc(A, { stats: [
    ['P', PAIR({ state: 'succeeded' })],
    ['L', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
    ['R', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ] });
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

  await synthesizeFailure(A);

  await expect(A.getByTestId('error')).toContainText('the path went away');
  await expect(A.getByTestId('wire-log')).not.toContainText('DTLS or SCTP');
  await expect(A.getByTestId('wire-log')).not.toContainText('.local host candidates');
  // Reset IS the right advice here, and this is the only branch that gives it.
  await expect(A.getByTestId('error')).toContainText('Press Reset in both tabs');

  await ctxA.close();
  await ctxB.close();
});

test('a real ICE failure: the sampler keeps its pair, and an unresolvable .local never becomes one', async ({ browser }) => {
  // The claims the fixtures cannot make, because they are about Chromium and not about our
  // logic. The remote candidates mirror the real failure this section was written for: one
  // .local name nothing can resolve, plus a routable candidate that answers nothing.
  //
  // 1. §8's sampler really does capture a pair from a real ICE failure. Note what this does
  //    NOT assert -- that pairs survive to the 'failed' event. Measured on this host: the
  //    1 s sampler saw 1 pair on all 15 ticks while a getStats() read from inside the
  //    'failed' handler returned 0, because libwebrtc tears down write-timed-out
  //    connections as it reports failed. That is the whole reason §8 samples instead of
  //    reading once; a naive read would see no pairs, and every counter in the gate would
  //    be trivially 0 on EVERY failure, firing the mDNS verdict at operators whose
  //    multicast is fine. If this goes red with pairs:0, that false positive is back.
  // 2. remote-hosts:0 next to a live pair is a real reading and not an artefact of an empty
  //    report -- the srflx pair is there, in the same snapshot, and the .local one is not.
  //    This is what licenses gating the mDNS finding on it.
  test.skip(test.info().project.name !== 'chromium', 'libwebrtc-level behaviour; ~15 s of real ICE');
  test.setTimeout(60_000);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const donor = await ctx.newPage();

  // Real getStats(), but a pinned READING of the local SDP. The remote srflx below is
  // 192.0.2.1, while this machine's own srflx is whatever its public address happens to
  // be -- which would read as two different networks and suppress the very finding this
  // test measures, on machines with STUN reachability and not on machines without. The
  // splice is additive and read-only: libwebrtc still gathers and sends the real thing,
  // so both claims above -- a live pair from a real ICE failure, and remote-hosts:0 beside
  // it -- are still read from an unmodified browser.
  await installPc(page, { extraLocalCandidates: [SRFLX('192.0.2.1')] });
  await answererWith(page, donor, [MDNS_HOST('4f1a2c3d-3333-4000-8000-abcdef123456'), SRFLX_BLACKHOLE]);

  await expect(page.getByTestId('wire-log')).toContainText('post-mortem —', { timeout: 40_000 });
  const evidence = await page.getByTestId('wire-log').innerText();
  const pairs = /post-mortem — pairs:(\d+)/.exec(evidence);
  expect(pairs, 'the post-mortem never printed its evidence line').not.toBeNull();
  expect(Number(pairs?.[1]), 'no candidate pair survived to the failed event — see §8').toBeGreaterThan(0);
  // The true positive, end to end in a real browser rather than from a fixture.
  await expect(page.getByTestId('wire-log')).toContainText('remote-hosts:0');
  await expect(page.getByTestId('wire-log')).toContainText('mdns-offered:1');
  await expect(page.getByTestId('error')).toContainText('no candidate pair was ever formed against');

  await ctx.close();
});

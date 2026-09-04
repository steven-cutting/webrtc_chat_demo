import { asEnvelope, describe, type Envelope, type Role } from './protocol';
import {
  buildFragment, iceUrls, readIceConfig, relayHosts, relayUrls,
  type IceConfig,
} from './ice-config';

// ── §1 state, DOM refs, wants() ────────────────────────────────────────────

type Phase =
  | 'idle' | 'gathering' | 'offer-ready' | 'answer-ready'
  | 'connecting' | 'connected' | 'closed';

// Measured on this host: with a reachable STUN server gathering reaches
// 'complete' in ~125 ms, and every candidate has landed by ~250 ms in every
// configuration tried. With a black-holed STUN server Chrome keeps retrying and
// only completes at ~39.9 s -- with a candidate set identical to the one it
// already had at 3 s. So 3000 ms costs nothing when STUN works and saves ~37 s
// of dead waiting when it does not.
//
// "Every configuration tried" is a smaller set than the configurations this app can run in,
// now that a relay can be configured. A relay candidate is not one more round trip on the STUN
// transaction -- it is its own Allocate, which the long-term credential mechanism normally
// answers with a challenge the client has to re-send against, and a turns: URL puts TCP and TLS
// handshakes in front of all of that. That is a reading of the mechanism; how long it costs from
// this host has never been timed here, so this constant is left where the measurement put it
// rather than raised to a number nobody measured. What the relay case gets instead is a specific
// marker: reachMarker() says a relay candidate has not arrived yet while gathering runs, and NO
// RELAY once it has stopped -- and the existing refresh path still republishes a complete blob if
// the allocation lands late.
const ICE_GATHER_TIMEOUT_MS = 3000;

let phase: Phase = 'idle';
let role: Role | null = null;
let dc: RTCDataChannel | null = null;
let seq = 0;
/** True while the published blob is the partial snapshot taken at the gathering timeout. */
let provisional = false;
/**
 * Latched: this blob was published while gathering was still running, at least once. `provisional`
 * itself clears when gathering completes, and by the time §8 runs it always has -- but the copy the
 * peer actually received was taken before that, which is the whole point of the caveat that reads
 * this.
 */
let wasProvisional = false;
/** Post-mortem state; see §8. Declared here so no listener can hit a TDZ. */
let lastSample: Snapshot | null = null;
let sampler: number | undefined;
let explained = false;
/**
 * Two latches §8 reads. Every verdict in that section is about a handshake that never
 * completed, so none of them may be printed over a session that completed one and then
 * lost it. Separate flags rather than `phase`, because `phase` becomes 'closed' when the
 * channel closes and the order of that against 'conn → failed' is not measured here.
 */
let iceEverConnected = false;
let everOpen = false;
/** ICE server URLs that raised an icecandidateerror, so §8 can say whether one was reported. */
const iceErrorUrls = new Set<string>();

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  role: el<HTMLSpanElement>('role'),
  phase: el<HTMLSpanElement>('signal-phase'),
  reset: el<HTMLButtonElement>('reset'),
  diag: el<HTMLParagraphElement>('diag'),
  iceCard: el<HTMLDetailsElement>('ice-card'),
  iceStatus: el<HTMLSpanElement>('ice-status'),
  iceUrls: el<HTMLTextAreaElement>('ice-urls'),
  iceUsername: el<HTMLInputElement>('ice-username'),
  iceCredential: el<HTMLInputElement>('ice-credential'),
  iceRelayOnly: el<HTMLInputElement>('ice-relay-only'),
  iceApply: el<HTMLButtonElement>('ice-apply'),
  iceLink: el<HTMLButtonElement>('ice-link'),
  createOffer: el<HTMLButtonElement>('create-offer'),
  localCard: el<HTMLDivElement>('local-card'),
  localLabel: el<HTMLHeadingElement>('local-label'),
  localBlob: el<HTMLTextAreaElement>('local-blob'),
  copy: el<HTMLButtonElement>('copy'),
  blobMeta: el<HTMLSpanElement>('blob-meta'),
  remoteLabel: el<HTMLHeadingElement>('remote-label'),
  remoteBlob: el<HTMLTextAreaElement>('remote-blob'),
  accept: el<HTMLButtonElement>('accept'),
  error: el<HTMLParagraphElement>('error'),
  wireLog: el<HTMLOListElement>('wire-log'),
  compose: el<HTMLInputElement>('compose'),
  send: el<HTMLButtonElement>('send'),
};

/**
 * The single source of truth for "what blob is this tab waiting for". It drives
 * the Accept button's label, its disabled state, AND the paste guard's expected
 * type -- so those three can never disagree.
 */
function wants(): 'offer' | 'answer' | null {
  if (phase === 'idle') return 'offer';        // nothing done yet -> we can answer
  if (phase === 'offer-ready') return 'answer'; // we offered -> we need the answer
  return null;
}

// ── §2 the peer connection ─────────────────────────────────────────────────

// The configuration is read from location.hash BEFORE this line, because pc is built once, at
// module scope, and every listener below captures it -- so a configuration change lands only on a
// reload. Reset is already location.reload(), and a reload preserves the fragment, which is what
// makes an invite link survive it (asserted in e2e/ice-config.spec.ts rather than recalled).
// The panel that writes the fragment is §12.
const { pc, ice } = openPeerConnection(readIceConfig(location.hash));

/**
 * A throw from `new RTCPeerConnection` at module scope is not an error message -- it is a blank
 * page: no listener below is registered, render() never runs, the diagnostics strip stays empty and
 * every control is dead, delivered by a link someone else wrote. readIceConfig() validates, and
 * this catches what the validation missed. The fallback is the built-in configuration, which is the
 * one this repo has actually run.
 */
function openPeerConnection(want: IceConfig): { pc: RTCPeerConnection; ice: IceConfig } {
  try {
    return { pc: new RTCPeerConnection(want.rtc), ice: want };
  } catch (err) {
    const safe = readIceConfig('');
    safe.notes = [...want.notes,
      `the browser refused that ICE configuration (${reason(err)}) — falling back to the built-in STUN server`];
    return { pc: new RTCPeerConnection(safe.rtc), ice: safe };
  }
}

/**
 * What the RUNNING connection is configured with, which is not always what the parser produced: the
 * fallback above rewrites it, and a test can hand the engine a configuration the app never parsed.
 * Every claim this page makes about the connection reads from here; `ice` is used only for
 * provenance -- the log lines, and whether the panel starts open.
 */
const applied = (): RTCConfiguration => pc.getConfiguration();

// Registered unconditionally: it simply never fires for the offerer, which is
// the role asymmetry expressed by execution rather than by a comment.
pc.addEventListener('datachannel', (ev) => {
  log('event', `datachannel received "${ev.channel.label}" — this tab is the answerer`);
  attach(ev.channel);
});

pc.addEventListener('icegatheringstatechange', () => {
  log('event', `ice gathering → ${pc.iceGatheringState}`);
  render();
});

pc.addEventListener('iceconnectionstatechange', () => {
  log('event', `ice → ${pc.iceConnectionState}`);
  if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
    iceEverConnected = true;
  }
  updateSampler();
  render();
});

pc.addEventListener('connectionstatechange', () => {
  log('event', `conn → ${pc.connectionState}`);
  // connectionState drives exactly one thing. 'disconnected' is transient and
  // often self-heals, so it is logged and otherwise ignored.
  if (pc.connectionState === 'failed') {
    // Two rows, deliberately: the screen is never silent while getStats() is read,
    // and the pair reads as the chronology it is.
    fail('Connection failed — reading getStats() for the reason…');
    void explainFailure();
  }
  render();
});

pc.addEventListener('signalingstatechange', render);

pc.addEventListener('icecandidateerror', (ev) => {
  const e = ev as RTCPeerConnectionIceErrorEvent;
  // Without this a dead STUN server reads as a freeze rather than an event.
  log('event', `ice candidate error ${e.errorCode} ${e.errorText} (${e.url})`);
  // 701 is not a STUN error code at all. The W3C definition of errorCode sets it "if no
  // host candidate can reach the server" -- reachability, which name resolution is only
  // one way to lose. libwebrtc raises it for a stun: URL from two places, distinguished
  // by their errorText: "STUN host lookup received error." and "STUN binding request
  // timed out." (p2p/base/stun_port.cc, webrtc-mirror @ 3710345, read here), so the text
  // logged on the line above is what says which failure this was. An earlier revision
  // called 701 a per-address-family DNS failure and annotated it "benign"; that was
  // recalled rather than measured, and it is neither what the spec defines nor what the
  // implementation does. What WAS seen on this host is narrower: one 701 for
  // stun.l.google.com in a run that still published a working srflx candidate -- which is
  // why the candidate count publish() logs a moment later is the actual check.
  if (typeof e.url === 'string') iceErrorUrls.add(e.url);
  if (e.errorCode === 701) {
    log('event', '↳ 701 = no host candidate could reach that server; the errorText above says which failure, the candidate count below is the check');
  } else if (/^turns?:/i.test(e.url ?? '')) {
    // Distinguished by SCHEME and nothing else. No table: a relay answering and a relay refusing
    // can carry the same code -- a 401 is the ordinary first step of the long-term credential
    // handshake as well as a rejection -- and which of those this engine surfaces has not been
    // measured here. The errorText above is the engine's own words, and the relay count in the
    // publish line below is the check.
    log('event', '↳ that code came from the relay itself; the errorText above is its own words, and the relay candidate count below is the check');
  }
});

// ── §3 offerer ─────────────────────────────────────────────────────────────

async function startOffer(): Promise<void> {
  clearError();
  role = 'offerer';
  document.body.dataset.role = role;
  setPhase('gathering');
  try {
    // The data channel MUST be created before createOffer(): it is what emits
    // the m=application section. Create it after, and the answerer's
    // `datachannel` event never fires and no ICE transport is created, so the
    // offer carries zero candidates and BOTH peers sit at gathering:new ·
    // ice:new · conn:new forever -- nothing was ever created that could
    // transition. Measured in Chromium 151; the strip shows the whole signature.
    attach(pc.createDataChannel('chat'));
    await pc.setLocalDescription(await pc.createOffer()); // gathering starts HERE
  } catch (err) {
    role = null;
    document.body.dataset.role = '';
    setPhase('idle');
    fail(`Could not create an offer: ${reason(err)}`);
    return;
  }
  await gatherAndPublish('offer-ready');
}

// ── §4 answerer ────────────────────────────────────────────────────────────

async function acceptOffer(desc: RTCSessionDescriptionInit): Promise<void> {
  const previous = phase;
  role = 'answerer';
  document.body.dataset.role = role;
  setPhase('gathering');
  try {
    await pc.setRemoteDescription(desc);
    logRemote('offer', desc.sdp ?? '');
    await pc.setLocalDescription(await pc.createAnswer()); // gathering starts HERE
  } catch (err) {
    role = null;
    document.body.dataset.role = '';
    setPhase(previous);
    fail(`Could not accept that offer: ${reason(err)}`);
    return;
  }
  await gatherAndPublish('answer-ready');
}

// ── §5 offerer, second half ────────────────────────────────────────────────

async function acceptAnswer(desc: RTCSessionDescriptionInit): Promise<void> {
  const previous = phase;
  try {
    await pc.setRemoteDescription(desc);
  } catch (err) {
    setPhase(previous);
    fail(`Could not accept that answer: ${reason(err)}`);
    return;
  }
  logRemote('answer', desc.sdp ?? '');
  // Not 'gathering' (nothing gathers here) and not 'connected'
  // (ICE has not even started checking).
  setPhase('connecting');
}

// ── §6 the paste guard ─────────────────────────────────────────────────────

function parseBlob(raw: string): RTCSessionDescriptionInit | null {
  const text = raw.trim();
  if (!text) {
    fail("Paste the other tab's blob here first.");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('That is not valid JSON — the paste was probably truncated.');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    fail('That JSON is not a session description ({"type":…,"sdp":…}).');
    return null;
  }
  const desc = parsed as Record<string, unknown>;
  if (typeof desc.type !== 'string' || typeof desc.sdp !== 'string') {
    fail('That JSON is not a session description ({"type":…,"sdp":…}).');
    return null;
  }

  // Checked FIRST: pasting a tab's own blob back into itself is by far the
  // likeliest operator error, and "that's your own blob" is a far more
  // actionable message than a type mismatch.
  if (pc.localDescription && desc.sdp === pc.localDescription.sdp) {
    fail("That's this tab's own blob — paste it into the OTHER tab.");
    return null;
  }

  const want = wants();
  if (!want) {
    fail('This tab is not waiting for a blob right now.');
    return null;
  }
  if (desc.type !== want) {
    // The browser will NOT reject a misplaced offer for us: per the W3C
    // setRemoteDescription algorithm it triggers an implicit rollback and is
    // applied silently, with no exception to catch. So we refuse it ourselves.
    fail(`This tab needs an ${want}, but you pasted: "${desc.type}".`);
    return null;
  }

  return { type: desc.type as RTCSdpType, sdp: desc.sdp };
}

// ── §7 non-trickle ICE ─────────────────────────────────────────────────────

function waitForIce(timeoutMs = ICE_GATHER_TIMEOUT_MS): Promise<{ timedOut: boolean }> {
  // Synchronous check first: any prior await may have let gathering finish, and
  // then no further event ever fires and we would hang forever.
  if (pc.iceGatheringState === 'complete') return Promise.resolve({ timedOut: false });

  return new Promise((resolve) => {
    const done = (timedOut: boolean): void => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve({ timedOut });
    };
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') done(false);
    };
    // The timeout is not optional. Firefox bug 1297158 is still open: with a
    // dead STUN server 'complete' can never arrive at all. Chrome does complete,
    // but only after ~39.9 s of STUN retransmits (measured) -- far too long to
    // hold the blob back for, since the candidates are already there.
    const timer = setTimeout(() => done(true), timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

async function gatherAndPublish(ready: Phase): Promise<void> {
  const { timedOut } = await waitForIce();
  if (!timedOut) {
    setPhase(ready);
    publish();
    return;
  }

  // Gathering is still running. Registered before publish() so the refresh path
  // reads in the order it happens.
  provisional = true;
  wasProvisional = true;
  const onComplete = (): void => {
    if (pc.iceGatheringState !== 'complete') return;
    pc.removeEventListener('icegatheringstatechange', onComplete);
    provisional = false;
    // Only refresh while the provisional blob is still the one the operator is
    // copying from. 'gathering' is the zero-candidate case below recovering;
    // any later phase means the peer already consumed the blob, and rewriting
    // 'offer-ready' over a live session would re-enable Accept, re-log "copy
    // again" and wipe a Connection failed message off the screen.
    if (phase !== ready && phase !== 'gathering') {
      renderBlobMeta(); // drop the PARTIAL marker from a blob that is now spent
      return;
    }
    if (phase === 'gathering') clearError();
    setPhase(ready);
    publish();
    log('event', 'gathering finished — the blob above is complete now, copy it again');
  };
  pc.addEventListener('icegatheringstatechange', onComplete);
  onComplete(); // the same synchronous re-check waitForIce does, for the same reason
  if (!provisional) return;

  // What can be missing here is CANDIDATES, not merely a trailing
  // a=end-of-candidates: Chrome never writes that line into localDescription.sdp
  // even once gathering completes, so its absence signals nothing either way.
  const { total } = countCandidates(pc.localDescription?.sdp ?? '');
  log('event', `ice gathering still running after ${ICE_GATHER_TIMEOUT_MS} ms — ${total} candidate${total === 1 ? '' : 's'} so far`);

  if (total === 0) {
    // A description with no candidates can never form a candidate pair. Calling
    // it 'ready' hands the operator a blob that is guaranteed to fail, so stay
    // in 'gathering' -- where every control is already disabled -- and say so.
    // If gathering finishes later, onComplete above still recovers the flow.
    // Under Force relay the network is the wrong thing to check: that policy gathers nothing but
    // relayed candidates, so a relay that will not allocate leaves exactly zero -- which is the
    // shape ice-timeout.spec.ts drives. The prefix is unchanged; only the action after it moves.
    fail(applied().iceTransportPolicy === 'relay'
      ? 'No ICE candidates yet, so there is nothing to copy. Force relay is on, so check the relay '
        + 'before the network: that policy gathers nothing else, and a relay that will not allocate '
        + 'leaves exactly this.'
      : 'No ICE candidates yet, so there is nothing to copy. If none arrive, press Reset and check the network.');
    return;
  }

  setPhase(ready);
  publish();
}

function publish(): void {
  // Re-read localDescription AFTER the wait. The object returned by
  // createOffer()/createAnswer() is a frozen snapshot with ZERO candidates;
  // the browser merges candidates into localDescription.sdp as it surfaces them.
  const blob = JSON.stringify(pc.localDescription);
  ui.localBlob.value = blob;

  const c = countCandidates(pc.localDescription?.sdp ?? '');
  renderBlobMeta();
  log('event', `${pc.localDescription?.type} published — ${blob.length} chars, ${c.summary}`);
  if (c.mdns) {
    log('event', 'host candidates are mDNS-obfuscated — the peer must resolve them over multicast DNS');
  }
  if (!provisional && !canLeaveLan(c)) {
    log('event', 'no server-reflexive candidate, no relay candidate and no routable host address — ' +
      'this blob can only reach a peer on this network');
  }
  render();
}

/**
 * The line under the Copy button. Separate from publish() so the PARTIAL marker
 * can be cleared without re-logging a publish that did not happen. The wire log
 * scrolls; this sits where the operator is looking when they decide to copy.
 */
function renderBlobMeta(): void {
  const blob = ui.localBlob.value;
  const c = countCandidates(pc.localDescription?.sdp ?? '');
  ui.blobMeta.textContent = `${blob.length.toLocaleString()} chars · ${c.summary}${reachMarker(c)}`;
}

/**
 * Whether this blob can leave the LAN, said where the operator is looking when they decide
 * to copy it. A description with nothing but LAN addresses is not broken -- host↔host on one
 * network is the case this repo actually measures -- but it is unusable against a peer
 * anywhere else, and finding that out cost a hand-delivered blob and a 15 s ICE timeout.
 *
 * The test is canLeaveLan(), not `srflx === 0`. An endpoint at a routable host address gets
 * no srflx candidate at all (RFC 8445 §5.1.3 drops it as redundant) and is reachable anyway,
 * and reading that blob as LAN-only warned about a blob that would have worked.
 *
 * A warning and never an error: LAN-only is a supported mode, so this must not reach
 * ui.error, which a healthy run asserts is empty. The two zero cases are kept apart
 * because the actions differ -- under PARTIAL the candidate may still be seconds away,
 * and calling that blob LAN-only would be a verdict on a set that is not final yet.
 */
function reachMarker(c: Candidates): string {
  // Two independent readings, so they compose rather than shadow each other: a blob can be
  // perfectly able to leave this LAN by way of a srflx candidate AND be missing the relay that was
  // configured to carry it. That second case prints nothing at all under the old early-return --
  // canLeaveLan() is already true -- and it is exactly the shape a cross-network failure takes.
  const lan = provisional
    ? (canLeaveLan(c)
      ? ' · PARTIAL — still gathering, copy again when this clears'
      : ' · PARTIAL — still gathering, no server-reflexive or routable candidate yet, copy again when this clears')
    : (canLeaveLan(c)
      ? ''
      : ' · LAN ONLY — every candidate here is a LAN address, so this blob can only reach a peer on this network');
  return `${lan}${relayMarker(c)}`;
}

/**
 * A relay is configured and produced nothing.
 *
 * Silent while provisional, for the same reason LAN ONLY is: an allocation may still be seconds
 * away, and calling it missing would be a verdict on a set that is not final. Read from the RUNNING
 * configuration, not the parsed one -- what matters is what the engine was asked for.
 */
function relayMarker(c: Candidates): string {
  if (c.relay > 0 || relayUrls(applied()).length === 0) return '';
  return provisional
    ? ' · no relay candidate yet'
    : ' · NO RELAY — a relay is configured but produced no candidate, so this blob does not carry '
      + 'one; the ice candidate error lines in the log are what to read';
}

interface Candidates {
  total: number;
  summary: string;
  mdns: boolean;
  /** typ -> count. The post-mortem asks this instead of re-parsing the SDP. */
  byType: Map<string, number>;
  /** `typ host` lines whose address is an mDNS name. */
  mdnsHosts: number;
  /** `typ host` lines carried over UDP -- the only ones that can ever pair. */
  udpHosts: number;
  /** `typ srflx` lines. NOT on its own the answer to "can this leave the LAN" -- canLeaveLan(). */
  srflx: number;
  /**
   * `typ relay` lines: addresses a TURN server allocated for this side. Counted rather than read
   * off byType because three readers arrived at once -- the NO RELAY marker, the evidence line and
   * the finding in §8 -- and all three ask about relays specifically.
   *
   * Zero here does NOT mean no relay is configured. That question is answered by the RUNNING
   * configuration, relayUrls(applied()), and the interesting case is the two together: a relay
   * configured and nothing gathered from it.
   */
  relay: number;
  /**
   * The mapped addresses of those lines: this side as the STUN server saw it. Comparing the
   * two ends' sets is the only thing separating a broken multicast stack from a cross-network
   * attempt -- getStats() cannot make it, because both produce an identical report -- but it
   * is a READING and not a topology, and it errs in both directions. §8 has the two ways and
   * the wording they force; do not shorten this to "intersect means one network".
   */
  srflxAddresses: string[];
  /** The families of those addresses. Disjoint families cannot pair, whatever the NAT does. */
  srflxFamilies: Set<'v4' | 'v6'>;
  /**
   * `typ host` lines whose address is a globally routable literal. Such a host needs no
   * srflx candidate to be reached from off this network -- and is given none, because
   * RFC 8445 §5.1.3 eliminates a candidate whose transport address AND base equal another's,
   * which is exactly the srflx derived from a public host. A public IPv6 address is the
   * everyday case. So `srflx === 0` is not "cannot leave this LAN"; see canLeaveLan().
   */
  routableHosts: number;
  /**
   * Address families over EVERY candidate carrying a literal, not just the reflexive ones.
   * A claim that no pair can exist has to count everything that could pair: a host candidate
   * on one side pairs with a same-family srflx on the other, and the srflx subset alone
   * cannot rule that out.
   */
  families: Set<'v4' | 'v6'>;
  /**
   * True if any candidate is an mDNS name. Those hide an address of unknown family, so while
   * one is present no family claim about this side is safe.
   */
  unknownFamily: boolean;
}

/**
 * Where a candidate address can be reached from, and which family it is.
 *
 * An mDNS name is neither answer: multicast DNS is link-scope, so a `.local` name cannot
 * resolve across the internet whatever address it hides -- LAN-only by construction, family
 * unknown. For literals, the ranges below are the ones that are NOT globally routable:
 * RFC 1918 private v4, RFC 6598 shared space (the CGNAT pool), RFC 3927 link-local and
 * loopback; RFC 4193 ULA, RFC 4291 link-local and loopback for v6. Everything else counts as
 * routable -- including the RFC 5737 / RFC 3849 documentation ranges, which is what lets the
 * e2e fixtures pin a routable address without naming a real host.
 */
function classifyAddress(address: string | undefined): { family: 'v4' | 'v6' | null; routable: boolean } {
  if (!address || address.endsWith('.local')) return { family: null, routable: false };
  if (address.includes(':')) {
    const a = address.toLowerCase();
    const local = /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a === '::1' || a === '::';
    return { family: 'v6', routable: !local };
  }
  const o = address.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { family: null, routable: false };
  }
  const local = o[0] === 10 || o[0] === 127 || o[0] === 0
    || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 192 && o[1] === 168)
    || (o[0] === 169 && o[1] === 254)
    || (o[0] === 100 && o[1] >= 64 && o[1] <= 127);
  return { family: 'v4', routable: !local };
}

/**
 * Whether this description can reach a peer that is NOT on this network. Three ways in, and
 * an earlier revision counted only the first: a server-reflexive candidate, a relay, or a host
 * candidate at a routable literal, which needs no srflx and is not issued one. Raised in
 * review, and correct: `srflx === 0` alone marked usable blobs unusable.
 *
 * The relay term was written before a relay could exist here -- for the reading rather than for
 * the branch. A relay is configurable now, so the branch arrived, and it needed no change to
 * take it.
 */
function canLeaveLan(c: Candidates): boolean {
  return c.srflx > 0 || (c.byType.get('relay') ?? 0) > 0 || c.routableHosts > 0;
}

/** Read-only: counts a=candidate lines. Never modifies the SDP. */
function countCandidates(sdp: string): Candidates {
  const lines = sdp.split(/\r\n|\n/).filter((l) => l.startsWith('a=candidate:'));
  const byType = new Map<string, number>();
  let mdns = false;
  let mdnsHosts = 0;
  let udpHosts = 0;
  let srflx = 0;
  let relay = 0;
  const srflxAddresses: string[] = [];
  const srflxFamilies = new Set<'v4' | 'v6'>();
  let routableHosts = 0;
  const families = new Set<'v4' | 'v6'>();
  let unknownFamily = false;
  for (const line of lines) {
    const m = /\btyp (\w+)\b/.exec(line);
    if (m) byType.set(m[1], (byType.get(m[1]) ?? 0) + 1);
    // a=candidate:<foundation> <component> <transport> <priority> <address> <port> typ <typ>
    const field = line.split(' ');
    const transport = field[2]?.toLowerCase();
    const address = field[4];
    if (address?.endsWith('.local')) mdns = true;
    // Read for every candidate, not only the reflexive ones -- see Candidates.families.
    const { family, routable } = classifyAddress(address);
    if (family) families.add(family); else unknownFamily = true;
    if (m?.[1] === 'host' && routable) routableHosts++;
    if (m?.[1] === 'host') {
      if (address?.endsWith('.local')) mdnsHosts++;
      if (transport === 'udp') udpHosts++;
    }
    // Field [4] of a srflx line is the MAPPED address, not the local one -- the local one
    // is in raddr further along. Field [4] of a relay line is the address the TURN server
    // ALLOCATED, which is why relay addresses are counted and deliberately NOT admitted to
    // srflxAddresses: two peers using the same relay are allocated addresses at the same host, so
    // feeding those into the comparison below would read as nets:same for two peers on opposite
    // sides of the planet. (This counter used to be absent, annotated "counting a type that cannot
    // occur would be an abstraction ahead of a use". A relay is configurable now, so it can occur,
    // and the use arrived with it.)
    if (m?.[1] === 'relay') relay++;
    if (m?.[1] === 'srflx' && address) {
      srflx++;
      if (!srflxAddresses.includes(address)) srflxAddresses.push(address);
      srflxFamilies.add(address.includes(':') ? 'v6' : 'v4');
    }
  }
  const total = lines.length;
  const base = {
    total, mdns, byType, mdnsHosts, udpHosts, srflx, relay, srflxAddresses, srflxFamilies,
    routableHosts, families, unknownFamily,
  };
  if (total === 0) return { ...base, summary: 'no candidates' };
  const parts = [...byType].map(([t, n]) => `${n} ${t}`).join(', ');
  // No ' via <server>' here. This function sees only the SDP, which carries no
  // trace of which ICE server produced a srflx candidate, so naming one was an
  // assertion rather than a reading -- and it once printed 'via stun.l.google.com'
  // in the same second as a 701 host-lookup failure for that exact server. Real
  // provenance comes from local-candidate.url in getStats(); the post-mortem
  // prints it there, where it is actually known.
  return { ...base, summary: `${total} candidate${total === 1 ? '' : 's'} (${parts})` };
}

function logRemote(kind: 'offer' | 'answer', sdp: string): void {
  const c = countCandidates(sdp);
  log('event', `remote ${kind} accepted — ${c.summary}`);
  if (c.mdns) {
    log('event', `the remote ${kind}'s host candidates are mDNS-obfuscated — multicast DNS must work on this network`);
  }
}

// ── §8 the failure post-mortem ─────────────────────────────────────────────

// Kept verbatim, but demoted to the degrade path. It used to be the ONLY thing
// said on failure, which made every cause look alike -- and for a blocked path it
// is the one instruction guaranteed to reproduce the failure.
const GENERIC_FAILURE = 'Connection failed. Press Reset in both tabs and redo the exchange.';

interface Snapshot {
  pairs: number;
  udpHostPairs: number;
  remoteHosts: number;
  succeeded: number;
  /**
   * Candidate pairs with a relayed address at either end. The only thing separating "the relay
   * candidates were in the descriptions and ICE never paired them" from "the pairs existed and the
   * path did not" -- two different next actions.
   */
  relayPairs: number;
  requestsSent: number;
  requestsReceived: number;
  responsesReceived: number;
  /** local-candidate.url -- the ICE server a srflx/relay candidate really came from. */
  serverUrls: string[];
}

type Stat = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Sampled on a timer rather than read once at 'failed'.
 *
 * libwebrtc tears down write-timed-out connections as it reports failed, and
 * Chrome builds candidate-pair/remote-candidate rows only from LIVE connections.
 * Read the report inside the 'failed' handler and it can come back with no pairs
 * for reasons that have nothing to do with the failure -- collapsing every
 * diagnosis onto "no pair was ever formed", which is the one verdict that would
 * send the operator somewhere useless. Sampling makes the verdict independent of
 * whether the rows survive that long.
 */
async function sample(): Promise<void> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return; // an engine without getStats() simply never produces a snapshot
  }

  const byId = new Map<string, Stat>();
  report.forEach((stat, id) => { byId.set(id, stat as Stat); });

  const snap: Snapshot = {
    pairs: 0, udpHostPairs: 0, remoteHosts: 0, succeeded: 0, relayPairs: 0,
    requestsSent: 0, requestsReceived: 0, responsesReceived: 0, serverUrls: [],
  };

  for (const stat of byId.values()) {
    if (stat.type === 'candidate-pair') {
      snap.pairs++;
      snap.requestsSent += num(stat.requestsSent);
      snap.requestsReceived += num(stat.requestsReceived);
      snap.responsesReceived += num(stat.responsesReceived);
      if (stat.state === 'succeeded') snap.succeeded++;
      const local = byId.get(String(stat.localCandidateId));
      const remote = byId.get(String(stat.remoteCandidateId));
      // A pair against a resolved host candidate is the proof that mDNS worked.
      // UDP only: a tcptype-active host candidate can never pair with anything the
      // peer offered, so counting it would make a perfectly healthy run look like
      // a resolution failure on every engine that emits one.
      // Read together with remoteHosts below, never alone: this counter also requires
      // the LOCAL candidate to still be reported as 'host', and that is not stable --
      // Connection::MaybeUpdateLocalCandidate rewrites it to srflx or prflx when a
      // check's mapped address says so (p2p/base/connection.cc).
      if (local?.candidateType === 'host' && remote?.candidateType === 'host'
          && remote?.protocol === 'udp') {
        snap.udpHostPairs++;
      }
      // Either end: one relayed address is enough to make a pair a relayed pair, and one working
      // relay is normally enough for a session.
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') snap.relayPairs++;
    } else if (stat.type === 'remote-candidate') {
      // Pair-derived, despite the name: Chrome produces a remote-candidate row only from
      // a live connection (ProduceIceCandidateStats is called with is_local=false only
      // inside the loop over connection_infos, pc/rtc_stats_collector.cc, webrtc-mirror
      // @ 3710345). So this counts host candidates of theirs that we PAIRED with -- never
      // how many they signalled -- which is exactly the reading §8 needs and not one word
      // more.
      if (stat.candidateType === 'host') snap.remoteHosts++;
    } else if (stat.type === 'local-candidate') {
      if (typeof stat.url === 'string' && !snap.serverUrls.includes(stat.url)) {
        snap.serverUrls.push(stat.url);
      }
    }
  }

  // Keep the richest snapshot. A later, emptier report is exactly the tear-down
  // artefact described above and must not overwrite one taken while the pairs
  // were still alive.
  if (lastSample === null || snap.pairs >= lastSample.pairs) lastSample = snap;
}

/** Runs only while pairs can still be observed; a background tab must not poll forever. */
function updateSampler(): void {
  const live = pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'disconnected';
  if (live && sampler === undefined) {
    void sample();
    sampler = window.setInterval(() => { void sample(); }, 1000);
  } else if (!live && sampler !== undefined) {
    clearInterval(sampler);
    sampler = undefined;
  }
}

/**
 * What this can prove is "no candidate pair against the peer's .local host candidates
 * ever existed" -- not that those names failed to resolve. getStats cannot show a remote
 * candidate that never paired (see the remote-candidate branch in sample()), and a pair
 * can be missing for more than one reason. So the findings state the pair absence and
 * RANK the cause; the macOS Local Network permission is named as the first thing to TRY,
 * never as a proven cause -- upgrading a correlation to a diagnosis is the exact failure
 * this whole section exists to remove.
 */
async function explainFailure(): Promise<void> {
  if (explained) return; // 'failed' is re-enterable: nothing here closes pc
  explained = true;
  try {
    await sample();
    const snap = lastSample;
    if (!snap) { fail(GENERIC_FAILURE); return; }

    const remote = countCandidates(pc.currentRemoteDescription?.sdp ?? '');
    const local = countCandidates(pc.localDescription?.sdp ?? '');
    // The RUNNING configuration, not the parsed one. Every claim below about what this session was
    // asked to do reads from here.
    const cfg = applied();
    const relays = relayUrls(cfg);

    // The comparison getStats() cannot make. A .local name that never became a pair looks
    // identical whether multicast is broken on one LAN or the peer is simply somewhere
    // else -- across the internet a .local name CANNOT resolve, so that zero is the
    // expected reading of a cross-network attempt rather than evidence of a fault. What
    // separates the two is whether the two ends were reflected to the same public address,
    // and that is in the SDPs, not in the stats report.
    //
    // Both sets must be non-empty for the question to mean anything. With one side at zero
    // the reading is 'unknown' and every verdict below falls back to what it said before.
    const bothReflexive = local.srflx > 0 && remote.srflx > 0;
    const shared = local.srflxAddresses.filter((a) => remote.srflxAddresses.includes(a));
    // A READING, not a topology, and every verdict below has to be worded to match. It is
    // wrong in both directions and neither is detectable from here:
    //   disjoint but ONE network -- a dual-WAN router, a NAT address pool, or a VPN on one
    //     side reflects two peers on one LAN to different addresses. So this must never
    //     silently DROP another finding; the mDNS one below is demoted under it, not gated
    //     on it (that suppressor was removed after review).
    //   equal but TWO networks -- one carrier CGNAT reflects two unrelated subscriber
    //     networks to a single address. Nothing here catches that; the mDNS finding says so
    //     in its own text rather than pretending the comparison is decisive.
    const differentNetworks = bothReflexive && shared.length === 0;
    // Two family readings, and the difference between them is the whole review finding.
    //
    // reflexiveFamilySplit rules out the REFLEXIVE pair -- the one that had to work across
    // networks -- and nothing more. It cannot say "no pair could exist", because a host
    // candidate on one side still pairs with a same-family srflx on the other.
    const reflexiveFamilySplit = bothReflexive
      && [...local.srflxFamilies].every((f) => !remote.srflxFamilies.has(f));
    // familySplit is the endpoint-wide claim, and it counts EVERY candidate carrying a
    // literal. It refuses to fire while either side holds an mDNS name: that name hides an
    // address of unknown family, and a family it might bridge is a family this cannot rule
    // out. With no unknowns on either side and the full sets disjoint, "no candidate pair
    // could exist" is arithmetic rather than a suspicion, which is what licenses the wording.
    const familySplit = !local.unknownFamily && !remote.unknownFamily
      && local.families.size > 0 && remote.families.size > 0
      && [...local.families].every((f) => !remote.families.has(f));
    /** v4, v6, v4+v6, or a trailing ? for the mDNS names whose family is not knowable. */
    const familyLabel = (c: Candidates): string =>
      ([...[...c.families].sort(), ...(c.unknownFamily ? ['?'] : [])].join('+')) || 'none';
    const nets = bothReflexive ? (differentNetworks ? 'different' : 'same') : 'unknown';

    // Evidence before verdicts, and printed whether or not a verdict fires -- so a
    // branch that did NOT fire is still visible to whoever reads the log next.
    log('event',
      `post-mortem — pairs:${snap.pairs} udp-host-pairs:${snap.udpHostPairs} ` +
      `remote-hosts:${snap.remoteHosts} mdns-offered:${remote.mdnsHosts} ` +
      `local-udp-hosts:${local.udpHosts} ` +
      `local-srflx:${local.srflx} remote-srflx:${remote.srflx} nets:${nets} ` +
      `families:${familyLabel(local)}|${familyLabel(remote)} ` +
      // Relay group. relay-cfg: counts the relay URLs the RUNNING connection holds -- what the
      // engine was asked for, which is not always what the parser produced -- while local-relay/
      // remote-relay count what each side actually gathered. The interesting reading is the two
      // disagreeing.
      `relay-cfg:${relayUrls(cfg).length} local-relay:${local.relay} remote-relay:${remote.relay} ` +
      `relay-pairs:${snap.relayPairs} ` +
      (cfg.iceTransportPolicy === 'relay' ? 'policy:relay ' : '') +
      `sent:${snap.requestsSent} ` +
      `recv:${snap.requestsReceived} answered:${snap.responsesReceived}` +
      // 'via:', not 'stun:'. The value is local-candidate.url verbatim, so the old label printed
      // 'stun:stun:stun.l.google.com:19302' -- a doubling visible in the bug report this change
      // came from -- and it would be plainly wrong as soon as the URL is a turn: one.
      (snap.serverUrls.length ? ` via:${snap.serverUrls.join(',')}` : '') +
      // Public addresses, and the only place they are printed. The verdicts below say
      // "different public addresses" and leave the values here, so a log pasted into a bug
      // report can be redacted at one line rather than mid-sentence.
      (local.srflxAddresses.length ? ` local-mapped:${local.srflxAddresses.join(',')}` : '') +
      (remote.srflxAddresses.length ? ` remote-mapped:${remote.srflxAddresses.join(',')}` : ''));

    // Said alone and first, because none of the findings below apply to it: they are all
    // about a handshake that never completed, and this session completed one. It is also
    // the one case where "Reset and redo" is honest advice rather than the instruction
    // that reproduces the failure.
    if (everOpen) {
      const lost = 'this session was connected — the channel had been open, so ICE, DTLS and SCTP ' +
        'all worked — and then the path went away. That is ICE failing late, not something after ' +
        'it. Press Reset in both tabs and redo the exchange; session descriptions are single-use.';
      ui.error.textContent = lost;
      log('event', `post-mortem: ${lost}`);
      return;
    }

    // Every finding that holds is reported. In the failure this was written for,
    // both the first and the second are true, and printing only one hides half of it.
    const findings: string[] = [];

    // A path found at any point disqualifies every "nothing worked" reading below,
    // including the mDNS one: host candidates that never paired cannot be what stopped a
    // connection ICE did complete.
    const foundAPath = iceEverConnected || snap.succeeded > 0;

    /**
     * What to say about the relay, wherever a verdict has to mention one. Three sites need it and
     * they say structurally different things -- an address-family claim, a NAT-shape claim and a
     * trailing caveat -- so what is shared is the STATE, not a sentence.
     */
    const relayAdvice = relays.length === 0
      ? 'none is configured in this tab. Open ICE servers above and add a turn: URL with its '
        + 'credentials, or send the other device an invite link carrying the same configuration — '
        + 'a configuration change only takes effect on a reload, so redo the exchange from scratch '
        + 'in both tabs afterwards. One working relay is normally enough, but two allocations fail '
        + 'independently, so configure both ends if you can'
      : `one is configured here (${relays.join(', ')}) and this side gathered `
        + `${local.relay} relay candidate${local.relay === 1 ? '' : 's'} from it`;

    // Leads, and deliberately ahead of every topology reading below. The operator who gets here has
    // usually read one of those already, turned the knob it named, and the knob did nothing -- and
    // nothing else on this list says so. It is standalone rather than a branch inside the
    // cross-network verdict because that one needs a reflexive candidate from BOTH ends, which
    // Force relay guarantees will not exist.
    if (relays.length > 0 && local.relay === 0 && !foundAPath) {
      const named = relays.filter((u) => iceErrorUrls.has(u));
      findings.push(
        `a relay is configured (${relays.join(', ')}) and this side gathered no relay candidate at `
        + 'all, so the relay was never in the running — whatever else is true of the two networks, '
        + 'the thing that was meant to bridge them published no address. '
        + (named.length > 0
          ? `The engine reported an ice candidate error for ${named.join(', ')}; its errorText in `
            + 'the log above is what to read, and a wrong credential and an unreachable port look '
            + 'alike from here.'
          : 'No ice candidate error was reported for it either, which is the ambiguous case: on some '
            + 'engines nothing being reported is not the same as nothing happening. An allocation '
            + 'still in flight when the blob was published looks identical from here.')
        + ' If the network blocks UDP to the relay port, a turn: URL with ?transport=tcp or a turns: '
        + 'URL on 443 is the usual alternative.');
    }

    // The other half of the relay reading: it DID allocate somewhere, and it still failed.
    if ((local.relay > 0 || remote.relay > 0) && !foundAPath) {
      const both = local.relay > 0 && remote.relay > 0;
      findings.push(
        (both
          ? 'both ends published relay candidates and the session still failed'
          : local.relay > 0
            ? 'this side published a relay candidate and the peer did not'
            : 'the peer published a relay candidate and this side did not')
        + ` — relay-pairs:${snap.relayPairs} on the evidence line above says how many candidate `
        + 'pairs had a relayed address at either end. A relayed address does not depend on either '
        + "NAT's mapping behaviour, so a NAT that maps per destination and a firewall that drops "
        + 'inbound UDP are not the readings that fit this shape. '
        + (both
          ? 'What is left — an allocation refused on refresh, a permission never installed, a '
            + 'credential that expired mid-session, a relay that will not forward between its own '
            + 'allocations — is not separable from a stats report, and the relay\'s own logs are '
            + 'the next place to look.'
          : 'One relay candidate is normally enough, so the pair that had to work is that relayed '
            + 'address against the other side\'s candidates; whether it was never reached or never '
            + 'forwarded is not separable from here. If you have a relay of your own, configure it '
            + 'too — two allocations fail independently.')
        + (local.relay > 0 && wasProvisional
          ? ' One thing this count cannot see: local-relay counts what this side GATHERED, not what '
            + 'you delivered. This blob was published while gathering was still running, so a relay '
            + 'candidate that landed after you copied it is invisible to the peer.'
          : ''));
    }

    // Provable, so it leads when it holds: with no family in common there is no address
    // the two ends share, and the absent pair follows from that alone. !foundAPath for the
    // same reason as everything below -- a dual-stack pair that connected host↔host on one
    // LAN can still have disjoint families, and that is not a failure.
    if (familySplit && !foundAPath) {
      // Exactly one family per side: two families here would leave the other side with none,
      // and families.size > 0 on both is part of the gate.
      const here = local.families.has('v4') ? 'IPv4' : 'IPv6';
      const there = here === 'IPv4' ? 'IPv6' : 'IPv4';
      findings.push(
        `this side published only ${here} candidates and the peer only ${there} — every candidate ` +
        'on both sides, not just the reflexive ones, and neither side is hiding one behind an mDNS ' +
        'name. There is no address the two ends share, so no candidate pair could exist — this is not a ' +
        'NAT to be traversed, it is two disjoint address families. Only a relay bridges those, and ' +
        `${relayAdvice}. A relay bridges two families only if its allocation lands in a family both ` +
        'ends can reach, which nothing here checks; failing that, both ends need a network where ' +
        'they have a family in common.');
    }

    // Ranked, not decided, and the ranking is the point: a NAT that maps per destination and
    // a firewall that drops inbound UDP are indistinguishable from here. The check counts are
    // in the text rather than in the gate, so a cross-network failure that happened to get one
    // response back still gets this verdict instead of falling through to the mDNS one.
    if (differentNetworks && !foundAPath) {
      const sent = snap.requestsSent;
      findings.push(
        'the two ends were reflected to different public addresses — the evidence line above has ' +
        'both. That usually means different networks, though it is a reading rather than proof: a ' +
        'dual-WAN router, a NAT address pool, or a VPN on one side reflects two peers on ONE ' +
        "network to different addresses too. Taking it at its usual meaning, the peer's .local host " +
        'candidates could never have resolved here, and that zero is expected rather than a fault. ' +
        `What had to work is the server-reflexive pair: ${sent} connectivity ` +
        `check${sent === 1 ? '' : 's'} went out with ${snap.responsesReceived} answered. ` +
        (reflexiveFamilySplit && !familySplit
          ? `Those reflexive candidates also share no address family — ` +
            `${local.srflxFamilies.has('v4') ? 'IPv4 here, IPv6 there' : 'IPv6 here, IPv4 there'} — ` +
            'which rules that pair out on its own. Not the whole endpoint, though: a host candidate ' +
            'on one side could still pair with a same-family reflexive one on the other. '
          : '') +
        'Two readings fit and getStats cannot separate them: a ' +
        'NAT that maps per destination (symmetric), which mobile carriers commonly run, or a ' +
        'firewall that drops inbound UDP. Neither is beaten by STUN alone — ' +
        // The lead-in flips on whether a relay exists, because "a relay is what is missing, and one
        // is configured here" contradicts itself in the same sentence. Only the first branch is
        // asserted (post-mortem.spec.ts), and only the first branch can run without a relay.
        (relays.length === 0
          ? `a TURN relay is what is missing, and ${relayAdvice}`
          : `a TURN relay is what beats both, and ${relayAdvice} — the relay findings above say ` +
            'what became of it') +
        '. The workaround that needs no relay is to put both devices on the same network.');
    }

    // Gated on what happened to the PEER'S candidates. Two of these conjuncts are newer
    // than the rest and both can only ever SUPPRESS this finding, never fire it somewhere
    // it did not fire before:
    //   remote-hosts:0 -- no pair against any host candidate of theirs, whatever this side
    //     was reported as. udp-host-pairs additionally requires the LOCAL candidate to
    //     still read 'host', and libwebrtc rewrites that to srflx/prflx on a check whose
    //     mapped address differs, which would drop a pair mDNS had demonstrably built.
    //   !foundAPath -- see above.
    // differentNetworks is NOT among them any more. It was a third suppressor, and review
    // was right that it should not be: mapped addresses can differ on ONE network (dual-WAN,
    // a NAT pool, a VPN on one side), and a hard gate there hides advice that was correct.
    // It DEMOTES instead. This block already sits after the cross-network one, so leaving
    // the gate out puts the right verdict in ui.error -- which shows findings[0] alone --
    // while the mDNS advice stays in the log for the operator the reading misclassified.
    // Its text carries the condition when that happens, and the opposite error the other way:
    // one carrier CGNAT reflects two unrelated networks to a single address, so the residual
    // gap runs both directions and nothing here closes either. (local-srflx/remote-srflx are
    // in the evidence line for the same reason: the comparison needs a srflx from BOTH ends,
    // so a side whose STUN was blocked reads 'unknown'. The LAN ONLY marker fires on that
    // side before the blob is ever copied, which is where that case is meant to be caught.)
    // What is deliberately NOT claimed any more is that their names failed to resolve. An
    // unresolved .local name IS discarded rather than added -- P2PTransportChannel::
    // AddRemoteCandidateWithResult returns on a resolver error, so the candidate never
    // reaches FinishAddingRemoteCandidate (p2p/base/p2p_transport_channel.cc, webrtc-mirror
    // @ 3710345) -- but the same zero is produced by a name that resolved to an address
    // nothing here can pair with, an IPv4/IPv6 split being the obvious one, and getStats
    // cannot tell those two apart.
    if (remote.mdnsHosts > 0 && local.udpHosts > 0 && !foundAPath
        && snap.remoteHosts === 0 && snap.udpHostPairs === 0) {
      findings.push(
        (differentNetworks
          ? 'Only if the two devices are on one network after all — the mapped addresses above ' +
            'read as saying they are not, and the verdict above takes them at that: '
          : '') +
        "no candidate pair was ever formed against the peer's .local host candidates. " +
        'The leading suspect is that those names never resolved. Two browsers on ONE machine: ' +
        'check System Settings → Privacy & Security → Local Network on macOS, enable BOTH ' +
        'browsers, then quit and relaunch them — they reach each other over loopback once the ' +
        'name resolves, so nothing outside that machine has to work. Two DEVICES: the same zero ' +
        'also appears when the network drops multicast, which a guest VLAN or AP client isolation ' +
        'will do.' +
        (differentNetworks ? '' :
          ' One caveat on the reading that got you here: a single carrier CGNAT reflects two ' +
          'unrelated networks to the SAME public address, so matching local-mapped/remote-mapped ' +
          'is not proof the two devices share a network. If the peer is on cellular, none of the ' +
          `above applies and what is missing is a relay — ${relayAdvice}.`));
    }

    if (snap.pairs === 0) {
      findings.push('no candidate pair was ever formed, so ICE had nothing to test.');
    } else if (snap.requestsSent > 0 && snap.responsesReceived === 0) {
      findings.push(`${snap.requestsSent} connectivity checks were sent and none came back.`);
    }

    // Reported, never promoted. On a healthy LAN a peer legitimately has no srflx and
    // host↔host is the path, so putting either of these ahead of the mDNS finding would take
    // the headline in exactly the case that finding exists for. The pre-flight LAN ONLY
    // marker is what covers this, before a blob nothing off-LAN can use has been delivered.
    // canLeaveLan(), not `srflx === 0`: a side at a routable host address publishes no srflx
    // and is reachable anyway, so the old test called a usable blob a LAN address. Same
    // correction as the LAN ONLY marker, which review noted the post-mortem was repeating.
    // Not under Force relay. That policy suppresses host and reflexive candidates by design, so
    // this would report the knob working as a network fault -- a verdict about LAN addresses this
    // session never published and STUN it never used. Reachable: gatherAndPublish() publishes on a
    // clean gathering completion with no zero-candidate check on that branch.
    if (!canLeaveLan(local) && !foundAPath && cfg.iceTransportPolicy !== 'relay') {
      findings.push('this side never got a server-reflexive candidate of its own, no relay candidate ' +
        'and no routable host address either, so everything it published was a LAN address — the ice ' +
        'candidate error lines above say what happened to STUN. A peer that is not on this network ' +
        'had nothing here to aim at.');
    }
    if (!canLeaveLan(remote) && !foundAPath) {
      findings.push('the peer published no server-reflexive candidate, no relay candidate and no ' +
        'routable host address, so everything in their blob was a LAN address. If they are not on ' +
        'this network, there was nothing there to aim at.');
    }

    if (iceEverConnected) {
      findings.push('ICE reported connected earlier in this session, so a path was found — whatever ' +
        'failed is after it (DTLS or SCTP), and redoing the exchange is worth a try.');
    } else if (snap.succeeded > 0) {
      // Historical, and labelled as such. This is a pair that HAD reached 'succeeded' in
      // some earlier sample; ICE never reported connected, so it says nothing about the
      // state at 'failed' and does not rule ICE out -- a path that is found and then lost
      // before DTLS finishes leaves exactly this trace.
      findings.push('a candidate pair had reached succeeded in an earlier sample, so ICE did find a ' +
        'path at that moment. It never reported connected, though, so that path may simply have ' +
        'gone away — redoing the exchange is worth a try.');
    } else if (role === 'answerer' && snap.requestsReceived === 0) {
      // Careful with this one. Slow delivery is NOT the explanation: an answer
      // withheld for 20 s -- past the write-timeout -- still reaches channel:open,
      // because the offerer answers checks against its own credentials long before
      // it applies the answer (measured in answerer-clock.spec.ts). So silence here
      // means this tab's own checks went nowhere. What it cannot rule out is an
      // offerer that had not started checking yet, which looks identical from here,
      // and that is the only reason the advice is "go look" rather than "it failed".
      findings.push('nothing arrived from the peer either, so this tab\'s checks went nowhere. ' +
        'If the other tab had not accepted your answer yet when this fired, finish delivering it ' +
        'and read THAT tab\'s log — from this side the two look identical.');
    }

    if (findings.length === 0) { fail(GENERIC_FAILURE); return; }

    ui.error.textContent = findings[0];
    for (const finding of findings) log('event', `post-mortem: ${finding}`);
  } catch {
    // A thinner stats implementation must degrade, never throw.
    fail(GENERIC_FAILURE);
  }
}

/**
 * Which pair actually carried the session, said once, on the success path.
 *
 * §8 runs only from connectionState 'failed', so a session that WORKED used to say nothing about
 * how -- and under the ordinary transport policy there is no other way to tell a relayed path from
 * a direct one. That distinction is not cosmetic: relaying costs someone bandwidth, and it puts a
 * third party on the path.
 *
 * Degrades rather than guesses. Which stats an engine reports here is not measured in this repo --
 * no project runs WebKit, and the reported failure this all came from was Safari-to-Safari -- so
 * when nothing names a selected pair this says so instead of picking one.
 *
 * Deliberately does NOT contain the word 'post-mortem': a healthy run asserts that word is absent
 * from the log.
 */
async function reportPath(): Promise<void> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return; // an engine without getStats() simply says nothing, as §8 does
  }
  const byId = new Map<string, Stat>();
  report.forEach((stat, id) => { byId.set(id, stat as Stat); });

  let pair: Stat | undefined;
  for (const stat of byId.values()) {
    if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      pair = byId.get(stat.selectedCandidatePairId);
    }
  }
  // Fallback for engines that report no transport row: a nominated or succeeded pair is the same
  // claim by another route.
  if (!pair) {
    for (const stat of byId.values()) {
      if (stat.type === 'candidate-pair' && (stat.nominated === true || stat.state === 'succeeded')) {
        pair = stat;
        break;
      }
    }
  }
  if (!pair) {
    log('event', 'path — not knowable from here: this engine reported no selected candidate pair, '
      + 'so whether this session is relayed cannot be read off getStats()');
    return;
  }

  const local = byId.get(String(pair.localCandidateId));
  const remote = byId.get(String(pair.remoteCandidateId));
  const url = typeof local?.url === 'string' ? ` via ${local.url}` : '';
  log('event', `path — ${String(local?.candidateType ?? '?')} ↔ ${String(remote?.candidateType ?? '?')}${url}`);
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') {
    log('event', 'this session is going through the relay, which sees both endpoints and the timing '
      + 'and volume of what you send — not its contents. If a direct path would do, Force relay is '
      + 'what suppresses it; turn it off and redo the exchange to find out whether one exists.');
  }
}

// ── §9 the data channel ────────────────────────────────────────────────────

function attach(channel: RTCDataChannel): void {
  dc = channel;

  channel.addEventListener('open', () => {
    everOpen = true; // latched for §8: what fails after this is not a handshake failure
    setPhase('connected'); // the ONLY place 'connected' is written
    log('event', `channel "${channel.label}" open`);
    void reportPath();
  });

  channel.addEventListener('close', () => {
    if (phase === 'closed') return;
    setPhase('closed');
    log('event', `channel "${channel.label}" closed`);
  });

  channel.addEventListener('error', (ev) => {
    log('event', `channel error: ${(ev as RTCErrorEvent).error?.message ?? 'unknown'}`);
  });

  channel.addEventListener('message', (ev: MessageEvent<unknown>) => {
    if (typeof ev.data !== 'string') {
      log('event', 'ignored a non-string frame (this demo only speaks JSON text)');
      return;
    }
    // Logged from event.data BEFORE JSON.parse. That call placement is what
    // makes "these are the exact bytes" true rather than aspirational.
    const raw = ev.data;
    const envelope = asEnvelope(raw);
    if (!envelope) {
      // Never dropped silently.
      log('event', `unparseable frame: ${raw.slice(0, 200)}`);
      return;
    }
    log('recv', describe(envelope), raw);
  });

  render();
}

function send(text: string): void {
  // Gated on readyState, never connectionState: 'connected' only means ICE +
  // DTLS finished; SCTP/DCEP still has to complete, and send() in that window
  // throws InvalidStateError.
  if (!dc || dc.readyState !== 'open' || !role) return;
  const envelope: Envelope = { v: 1, seq: ++seq, from: role, kind: 'chat', text };
  const raw = JSON.stringify(envelope); // stringify FIRST; log the same string we send
  dc.send(raw);
  log('sent', describe(envelope), raw);
}

// ── §10 teardown ────────────────────────────────────────────────────────────

// pagehide, not beforeunload: beforeunload is unreliable on mobile, which is in scope.
window.addEventListener('pagehide', (ev) => {
  if (ev.persisted) return; // going into the bfcache, not closing
  if (dc?.readyState === 'open' && role) {
    const bye: Envelope = { v: 1, seq: ++seq, from: role, kind: 'bye' };
    try {
      dc.send(JSON.stringify(bye));
    } catch {
      // Closing anyway.
    }
  }
  dc?.close();
  pc.close();
  if (sampler !== undefined) clearInterval(sampler);
});

// ── §11 rendering ──────────────────────────────────────────────────────────

function setPhase(next: Phase): void {
  phase = next;
  render();
}

function render(): void {
  ui.role.textContent = role ? `you are the ${role.toUpperCase()}` : 'no role yet';
  ui.phase.textContent = phase;
  const cfg = applied();
  ui.diag.textContent = [
    location.origin,
    `secure:${window.isSecureContext}`,
    // Read from the engine, not from the parser: a forced-relay session that looked like a normal
    // one would silently change what every other reading on this page means.
    `relay:${relayUrls(cfg).length}`,
    ...(cfg.iceTransportPolicy === 'relay' ? ['policy:relay'] : []),
    `sig:${pc.signalingState}`,
    `gathering:${pc.iceGatheringState}`,
    `ice:${pc.iceConnectionState}`,
    `conn:${pc.connectionState}`,
    `channel:${dc ? dc.readyState : 'none'}`,
  ].join(' · ');

  const want = wants();
  ui.accept.disabled = want === null;
  ui.accept.textContent =
    want === 'offer' ? 'Join as ANSWERER — accept their offer'
    : want === 'answer' ? 'Accept answer'
    : 'Accept';

  ui.createOffer.disabled = phase !== 'idle';

  // Both headings are rewritten every render, so the step numbers are never
  // inverted for half the users.
  ui.localLabel.textContent = role === 'answerer'
    ? '2 · Your ANSWER — copy it back to the other tab'
    : '1 · Your OFFER — copy it into the other tab';
  ui.remoteLabel.textContent = role === 'answerer'
    ? '1 · Paste their OFFER here'
    : role === 'offerer' ? '2 · Paste their ANSWER here' : 'Paste their OFFER here';
  ui.localCard.hidden = ui.localBlob.value === '';

  const canSend = dc?.readyState === 'open';
  ui.send.disabled = !canSend;
  ui.compose.disabled = !canSend;
}

function log(dir: 'sent' | 'recv' | 'event', text: string, raw?: string): void {
  const li = document.createElement('li');
  li.dataset.dir = dir;
  if (raw !== undefined) li.dataset.raw = raw; // sent/recv only: the assertion surface

  const head = document.createElement('span');
  head.className = 'head';
  head.textContent = `${stamp()}  ${text}`; // textContent, never innerHTML
  li.append(head);

  if (raw !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = raw;
    li.append(pre);
  }

  ui.wireLog.append(li);
  ui.wireLog.scrollTop = ui.wireLog.scrollHeight;
}

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function fail(message: string): void {
  ui.error.textContent = message;
  log('event', `error: ${message}`);
}

function clearError(): void {
  ui.error.textContent = '';
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function copyBlob(): Promise<void> {
  const text = ui.localBlob.value;
  if (!text) return;
  // navigator.clipboard is `undefined` (not throwing) on http://<lan-ip>:5173,
  // so it must be feature-detected, not try/caught. Nothing is awaited before
  // writeText() -- Safari rejects a call made after an await.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      flash(ui.copy, 'Copied', 'Copy');
      return;
    } catch {
      // Fall through to the selection fallback.
    }
  }
  ui.localBlob.focus();
  ui.localBlob.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  flash(ui.copy, ok ? 'Copied' : 'Press ⌘/Ctrl+C', 'Copy');
}

/** Second caller arrived with the invite link, so the button is a parameter now. */
function flash(button: HTMLButtonElement, label: string, idle: string): void {
  button.textContent = label;
  setTimeout(() => { button.textContent = idle; }, 1400);
}

// ── §12 the ICE server panel ───────────────────────────────────────────────

/**
 * The panel writes the URL fragment and reloads; it never reconfigures a live pc. That is not a
 * shortcut -- pc is built at module scope and captured by every listener, so a reload is what
 * applying a configuration MEANS here, and it keeps the URL bar honest about what the connection
 * was actually built with.
 */
function renderIcePanel(): void {
  const cfg = applied();
  const hosts = relayHosts(cfg);
  ui.iceStatus.textContent = hosts.length > 0
    ? `relay via ${hosts.join(', ')}${cfg.iceTransportPolicy === 'relay' ? ' · FORCE RELAY' : ''}`
    : 'built-in STUN, no relay';
  // Prefilled from what is RUNNING, so the built-in STUN server is visible and gets carried into
  // the link on purpose rather than smuggled into it. The link is then what runs, which is the
  // whole reason this fragment is readable instead of encoded.
  ui.iceUrls.value = iceUrls(cfg).join('\n');
  // The RELAY entry, found by its URLs rather than by having a username: getConfiguration()
  // reports `username: ''` on a STUN entry, which is a string, so looking for one that had a
  // username picked the STUN server and left the boxes empty beside a working relay. Empty boxes
  // there read as "no credentials configured" -- and pressing Apply would then have stripped them.
  const relaySrv = (cfg.iceServers ?? []).find((srv) =>
    (typeof srv.urls === 'string' ? [srv.urls] : srv.urls).some((u) => /^turns?:/i.test(u)));
  ui.iceUsername.value = relaySrv?.username ?? '';
  ui.iceCredential.value = typeof relaySrv?.credential === 'string' ? relaySrv.credential : '';
  ui.iceRelayOnly.checked = cfg.iceTransportPolicy === 'relay';
  // Open when the configuration arrived from a link: a tab running a relay someone else chose must
  // not look like a default one.
  if (ice.source === 'link') ui.iceCard.open = true;
}

function currentPanelFragment(): string {
  return buildFragment({
    urls: ui.iceUrls.value.split('\n').map((u) => u.trim()).filter(Boolean),
    username: ui.iceUsername.value.trim(),
    credential: ui.iceCredential.value.trim(),
    relayOnly: ui.iceRelayOnly.checked,
  });
}

function applyIce(): void {
  // A reload discards a handshake in progress, and the operator reaching for this panel is usually
  // on their SECOND attempt -- with a blob already on screen.
  const inFlight = ui.localBlob.value !== '' || ui.remoteBlob.value !== '';
  if (inFlight && !window.confirm(
    'Applying reloads this tab and discards the blobs on screen. Session descriptions are '
    + 'single-use, so you will need to redo the exchange from scratch in both tabs. Continue?')) {
    return;
  }
  const fragment = currentPanelFragment();
  // replace(), not assign(): the configuration that just failed is not a page worth going Back to.
  location.replace(`${location.pathname}${location.search}${fragment}`);
  // Same-document when only the fragment changed, so nothing would re-read it without this.
  location.reload();
}

async function copyInviteLink(): Promise<void> {
  // location.href, never a rebuilt URL: Apply wrote the fragment, so the link and the running page
  // cannot diverge -- which is also what keeps the Pages sub-path right with nothing to get wrong.
  const link = location.href;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(link);
      flash(ui.iceLink, 'Copied', 'Copy invite link');
      return;
    } catch {
      // Fall through to the same selection fallback the blob uses.
    }
  }
  // No dedicated field for this: the URL list doubles as the selection surface, the same way the
  // blob textarea does for copyBlob().
  ui.iceUrls.value = link;
  ui.iceUrls.focus();
  ui.iceUrls.setSelectionRange(0, link.length);
  const ok = document.execCommand('copy');
  flash(ui.iceLink, ok ? 'Copied' : 'Press ⌘/Ctrl+C', 'Copy invite link');
  // Only when it worked. Restoring the list under a "Press ⌘/Ctrl+C" prompt would delete the very
  // thing the operator was just told to copy.
  if (ok) renderIcePanel();
}

// ── wiring ─────────────────────────────────────────────────────────────────

ui.createOffer.addEventListener('click', () => { void startOffer(); });

ui.accept.addEventListener('click', () => {
  clearError();
  const want = wants();
  const desc = parseBlob(ui.remoteBlob.value);
  if (!desc) return;
  void (want === 'offer' ? acceptOffer(desc) : acceptAnswer(desc));
});

ui.copy.addEventListener('click', () => { void copyBlob(); });
ui.iceApply.addEventListener('click', applyIce);
ui.iceLink.addEventListener('click', () => { void copyInviteLink(); });
ui.reset.addEventListener('click', () => { location.reload(); });
ui.send.addEventListener('click', submit);
ui.compose.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

function submit(): void {
  const text = ui.compose.value.trim();
  if (!text) return;
  send(text);
  ui.compose.value = '';
}

renderIcePanel();
render();
// Before 'ready', because the configuration is the first thing that happened to pc.
for (const note of ice.notes) log('event', note);
log('event', 'ready — pick a role: create an offer, or paste one you were sent');

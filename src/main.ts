import { asEnvelope, describe, type Envelope, type Role } from './protocol';

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
const ICE_GATHER_TIMEOUT_MS = 3000;

let phase: Phase = 'idle';
let role: Role | null = null;
let dc: RTCDataChannel | null = null;
let seq = 0;
/** True while the published blob is the partial snapshot taken at the gathering timeout. */
let provisional = false;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  role: el<HTMLSpanElement>('role'),
  phase: el<HTMLSpanElement>('signal-phase'),
  reset: el<HTMLButtonElement>('reset'),
  diag: el<HTMLParagraphElement>('diag'),
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

const pc = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

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
  render();
});

pc.addEventListener('connectionstatechange', () => {
  log('event', `conn → ${pc.connectionState}`);
  // connectionState drives exactly one thing. 'disconnected' is transient and
  // often self-heals, so it is logged and otherwise ignored.
  if (pc.connectionState === 'failed') {
    fail('Connection failed. Press Reset in both tabs and redo the exchange.');
  }
  render();
});

pc.addEventListener('signalingstatechange', render);

pc.addEventListener('icecandidateerror', (ev) => {
  const e = ev as RTCPeerConnectionIceErrorEvent;
  // Without this a dead STUN server reads as a freeze rather than an event.
  log('event', `ice candidate error ${e.errorCode} ${e.errorText} (${e.url})`);
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
    fail('No ICE candidates yet, so there is nothing to copy. If none arrive, press Reset and check the network.');
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
  const partial = provisional ? ' · PARTIAL — still gathering, copy again when this clears' : '';
  ui.blobMeta.textContent = `${blob.length.toLocaleString()} chars · ${c.summary}${partial}`;
}

/** Read-only: counts a=candidate lines. Never modifies the SDP. */
function countCandidates(sdp: string): { total: number; summary: string; mdns: boolean } {
  const lines = sdp.split(/\r\n|\n/).filter((l) => l.startsWith('a=candidate:'));
  const byType = new Map<string, number>();
  let mdns = false;
  for (const line of lines) {
    const m = /\btyp (\w+)\b/.exec(line);
    if (m) byType.set(m[1], (byType.get(m[1]) ?? 0) + 1);
    // a=candidate:<foundation> <component> <transport> <priority> <address> ...
    const address = line.split(' ')[4];
    if (address?.endsWith('.local')) mdns = true;
  }
  const total = lines.length;
  if (total === 0) return { total, summary: 'no candidates', mdns };
  const parts = [...byType].map(([t, n]) => `${n} ${t}`).join(', ');
  const via = byType.has('srflx') ? ' via stun.l.google.com' : '';
  return { total, summary: `${total} candidate${total === 1 ? '' : 's'} (${parts}${via})`, mdns };
}

function logRemote(kind: 'offer' | 'answer', sdp: string): void {
  const c = countCandidates(sdp);
  log('event', `remote ${kind} accepted — ${c.summary}`);
  if (c.mdns) {
    log('event', `the remote ${kind}'s host candidates are mDNS-obfuscated — multicast DNS must work on this network`);
  }
}

// ── §8 the data channel ────────────────────────────────────────────────────

function attach(channel: RTCDataChannel): void {
  dc = channel;

  channel.addEventListener('open', () => {
    setPhase('connected'); // the ONLY place 'connected' is written
    log('event', `channel "${channel.label}" open`);
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

// ── §9 teardown ────────────────────────────────────────────────────────────

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
});

// ── §10 rendering ──────────────────────────────────────────────────────────

function setPhase(next: Phase): void {
  phase = next;
  render();
}

function render(): void {
  ui.role.textContent = role ? `you are the ${role.toUpperCase()}` : 'no role yet';
  ui.phase.textContent = phase;
  ui.diag.textContent = [
    location.origin,
    `secure:${window.isSecureContext}`,
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
      flashCopy('Copied');
      return;
    } catch {
      // Fall through to the selection fallback.
    }
  }
  ui.localBlob.focus();
  ui.localBlob.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  flashCopy(ok ? 'Copied' : 'Press ⌘/Ctrl+C');
}

function flashCopy(label: string): void {
  ui.copy.textContent = label;
  setTimeout(() => { ui.copy.textContent = 'Copy'; }, 1400);
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
ui.reset.addEventListener('click', () => { location.reload(); });
ui.send.addEventListener('click', submit);
ui.compose.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

function submit(): void {
  const text = ui.compose.value.trim();
  if (!text) return;
  send(text);
  ui.compose.value = '';
}

render();
log('event', 'ready — pick a role: create an offer, or paste one you were sent');

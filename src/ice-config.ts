// The ICE servers pc is built from, read out of the URL fragment. Pure: no DOM, no Location, no
// RTCPeerConnection -- src/main.ts hands it `location.hash` and does everything else. That is the
// same split as protocol.ts, and it is what lets a hand-written guard be read on its own.

export interface IceConfig {
  /** Exactly what §2 passes to the constructor. */
  rtc: RTCConfiguration;
  /** Where it came from. 'link' only when a fragment was actually applied. */
  source: 'default' | 'link';
  /** Wire-log lines: what was applied, or the one value that got the whole fragment refused. */
  notes: string[];
}

export const DEFAULT_STUN = 'stun:stun.l.google.com:19302';

/** More than this by hand is a mistake or an attempt to make gathering expensive. */
const MAX_URLS = 4;
const ICE_SCHEME = /^(stun|stuns|turn|turns):/i;
const IS_RELAY = /^turns?:/i;

/** Nothing here is rendered as HTML -- main.ts logs via textContent -- but an unbounded echo is
 *  still a wall of someone else's text in the operator's log. */
const echo = (v: string): string => (v.length > 100 ? `${v.slice(0, 100)}…` : v);

/**
 * Never throws, and never applies a fragment PARTLY.
 *
 * All-or-nothing is the deliberate half. The whole reason this is a readable query string rather
 * than an opaque blob is that the person opening an invite link can see which relay they are being
 * pointed at before they open it -- that server will see both endpoints' addresses. A fragment that
 * silently dropped one bad value and applied the rest would break exactly that: the link would no
 * longer be what runs. So one refusal refuses the lot, and says which value did it.
 */
export function readIceConfig(hash: string): IceConfig {
  const fallback = (notes: string[] = []): IceConfig => ({
    rtc: { iceServers: [{ urls: DEFAULT_STUN }], iceTransportPolicy: 'all' },
    source: 'default',
    notes,
  });

  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const urls = q.getAll('ice').map((u) => u.trim()).filter(Boolean);
  const policy = q.get('policy');
  // A fragment this app has no opinion about -- '#top', a deep link, anything -- must be silent.
  // Only `policy` counts as a claim on this module without `ice`, because relay-only against the
  // built-in STUN server is a state the forced-relay knob has to be able to express.
  if (urls.length === 0 && policy === null) return fallback();

  const refuse = (why: string): IceConfig =>
    fallback([`ignored the ICE configuration in this link — ${why}. Using the built-in STUN server.`]);

  if (urls.length > MAX_URLS) return refuse(`it lists ${urls.length} servers, more than ${MAX_URLS}`);
  if (policy !== null && policy !== 'all' && policy !== 'relay') {
    return refuse(`"${echo(policy)}" is not a transport policy (all or relay)`);
  }
  for (const u of urls) {
    if (!ICE_SCHEME.test(u)) return refuse(`"${echo(u)}" is not a stun: or turn: URL`);
  }

  const username = q.get('username') ?? '';
  const credential = q.get('credential') ?? '';
  const relays = urls.filter((u) => IS_RELAY.test(u));
  // A turn: URL with no credentials is the likeliest way a hand-edited fragment reaches the
  // constructor and is refused there -- and a throw at module scope is a blank page, so it is
  // caught here as well. Belt and braces on purpose: this rule is read from the spec, and
  // openPeerConnection()'s catch is what stops that reading from being load-bearing.
  if (relays.length > 0 && (!username || !credential)) {
    return refuse(`"${echo(relays[0])}" is a relay and needs a username and a credential`);
  }

  const iceServers: RTCIceServer[] = [];
  const stuns = urls.filter((u) => !IS_RELAY.test(u));
  if (stuns.length > 0) iceServers.push({ urls: stuns });
  if (relays.length > 0) iceServers.push({ urls: relays, username, credential });
  if (iceServers.length === 0) iceServers.push({ urls: DEFAULT_STUN });

  // Always written out, so getConfiguration() and the diagnostics strip cannot disagree about
  // which policy is in force.
  const rtc: RTCConfiguration = {
    iceServers,
    iceTransportPolicy: policy === 'relay' ? 'relay' : 'all',
  };
  const notes = [`ICE servers from this link — ${urls.join(', ') || DEFAULT_STUN}` +
    (policy === 'relay' ? ' · FORCE RELAY: nothing but relayed candidates will be gathered' : '')];
  if (policy === 'relay' && relays.length === 0) {
    notes.push('force relay is on and no relay is configured — this tab can gather no candidates at all');
  }
  return { rtc, source: 'link', notes };
}

/**
 * The fragment an invite link carries.
 *
 * URLSearchParams.toString() percent-encodes ':' '/' '?' and '=', which would make the one thing
 * this format exists for -- being readable before you open it -- false. Those four are put back:
 * each is a legal fragment character, and none of them can change the parse, because pairs split on
 * '&' and each pair at its FIRST '='.
 *
 * '+' is deliberately NOT put back. URLSearchParams decodes a raw '+' as a space, so un-escaping it
 * would silently corrupt every base64 credential containing one.
 */
export function buildFragment(v: {
  urls: string[]; username: string; credential: string; relayOnly: boolean;
}): string {
  const q = new URLSearchParams();
  for (const u of v.urls) q.append('ice', u);
  if (v.username) q.set('username', v.username);
  if (v.credential) q.set('credential', v.credential);
  if (v.relayOnly) q.set('policy', 'relay');
  const readable = q.toString()
    .replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%3F/g, '?').replace(/%3D/g, '=');
  return readable ? `#${readable}` : '';
}

/** Every URL in a configuration, whatever shape `urls` came back in. */
export function iceUrls(cfg: RTCConfiguration): string[] {
  return (cfg.iceServers ?? []).flatMap((s) => (typeof s.urls === 'string' ? [s.urls] : [...s.urls]));
}

/** The relay URLs of a configuration. Read from the BROWSER's configuration, never the parser's. */
export function relayUrls(cfg: RTCConfiguration): string[] {
  return iceUrls(cfg).filter((u) => IS_RELAY.test(u));
}

/** Hostnames only, for the line that names whose relay this tab is on. */
export function relayHosts(cfg: RTCConfiguration): string[] {
  const hosts = relayUrls(cfg).map((u) => u.replace(IS_RELAY, '').split(/[:?]/)[0]).filter(Boolean);
  return [...new Set(hosts)];
}

import type { Page } from '@playwright/test';

// One wrapper around the app's `new RTCPeerConnection(...)`, installed from
// addInitScript so it is in place BEFORE src/main.ts constructs pc at module scope.
// It grew out of two unshared copies -- override() in ice-timeout.spec.ts (config only)
// and install() in post-mortem.spec.ts (stats only) -- once a third spec needed both,
// plus a third knob neither had.

/** getStats() rows as [id, fields]. A Map's forEach signature is RTCStatsReport's, which is all §8 uses. */
export type Fixture = [string, Record<string, unknown>][];

export interface PcOptions {
  /**
   * Spread over the RTCConfiguration src/main.ts passes -- at the TOP LEVEL, so an `iceServers`
   * here REPLACES the app's array rather than merging with it. That is the point: it hands the
   * browser a configuration the app never parsed, which is how a test drives the real
   * getConfiguration() independently of the app's own reading of location.hash.
   */
  config?: RTCConfiguration;
  /** Serve getStats() from these rows instead of the real report. */
  stats?: Fixture;
  /** REPLACE every a=candidate line the app reads back from localDescription. */
  localCandidates?: string[];
  /** ADD these a=candidate lines to the ones the app reads back. */
  extraLocalCandidates?: string[];
  /**
   * Make the FIRST construction throw with this message, and only the first. src/main.ts builds pc
   * at module scope, so a throw there registers no listener and renders nothing -- the app catches
   * it and rebuilds with the default config, and that second construction has to succeed or the
   * test measures the fallback failing rather than the fallback working.
   */
  throwOnce?: string;
}

/**
 * Stash the app's pc on window.__pc, and apply whichever knobs are asked for.
 *
 * `localCandidates` / `extraLocalCandidates` rewrite what the app READS from
 * localDescription. They do not touch what libwebrtc gathers or sends, so a test can
 * pin the SDP the post-mortem reasons about while a real ICE failure runs underneath.
 * Without them, every assertion about local srflx addresses would depend on the public
 * IP of whatever machine ran the suite.
 */
export async function installPc(page: Page, opts: PcOptions = {}): Promise<void> {
  await page.addInitScript((o: PcOptions) => {
    const Orig = window.RTCPeerConnection;
    // Captured from the prototype, because the instance property defined below shadows it.
    const real = Object.getOwnPropertyDescriptor(Orig.prototype, 'localDescription');

    const splice = (sdp: string): string => {
      const out: string[] = [];
      let replaced = false;
      let last = -1;
      for (const line of sdp.split('\r\n')) {
        if (line.startsWith('a=candidate:') && o.localCandidates) {
          if (!replaced) { out.push(...o.localCandidates); replaced = true; last = out.length - 1; }
          continue; // drop the real one
        }
        out.push(line);
        if (line.startsWith('a=candidate:')) last = out.length - 1;
      }
      // A description with no candidate lines at all still has to carry the fixture,
      // or a test would silently measure an empty set instead of the one it asked for.
      if (o.localCandidates && !replaced) { out.push(...o.localCandidates); last = out.length - 1; }
      if (o.extraLocalCandidates) {
        out.splice(last + 1, 0, ...o.extraLocalCandidates);
      }
      return out.join('\r\n');
    };

    let thrown = false;

    window.RTCPeerConnection = class extends Orig {
      constructor(cfg?: RTCConfiguration) {
        // Before super(), which is legal so long as `this` is not touched -- and it is what makes
        // this indistinguishable from the engine refusing the configuration outright.
        if (o.throwOnce !== undefined && !thrown) { thrown = true; throw new TypeError(o.throwOnce); }
        super({ ...cfg, ...(o.config ?? {}) });
        (window as unknown as Record<string, unknown>).__pc = this;

        if (o.stats) {
          (this as unknown as Record<string, unknown>).getStats =
            async (): Promise<unknown> => new Map(o.stats!.map(([id, s]) => [id, { id, ...s }]));
        }

        if (o.localCandidates || o.extraLocalCandidates) {
          Object.defineProperty(this, 'localDescription', {
            configurable: true,
            // Lazily, at read time: there is no local description yet when this runs,
            // and render() reads the property before any offer exists.
            get: (): RTCSessionDescriptionInit | null => {
              const desc = real?.get?.call(this) as RTCSessionDescription | null;
              if (!desc) return null; // null before setLocalDescription -- pass it straight through
              return { type: desc.type, sdp: splice(desc.sdp) };
            },
          });
        }
      }
    };
  }, opts);
}

/** Routed nowhere (TEST-NET-1, RFC 5737), so it never answers and gathering runs on. */
export const DEAD_STUN: RTCConfiguration = { iceServers: [{ urls: 'stun:192.0.2.1:19302' }] };

// ── candidate lines ────────────────────────────────────────────────────────
// Documentation addresses only (RFC 5737 TEST-NET-1/2/3, RFC 3849 for v6), so nothing
// here can accidentally name a real host.

export const MDNS_HOST = (uuid: string): string =>
  `a=candidate:1 1 udp 2113937151 ${uuid}.local 50000 typ host generation 0 network-cost 999`;
export const IP_HOST =
  'a=candidate:2 1 udp 2113937150 192.0.2.1 50001 typ host generation 0 network-cost 999';
/**
 * A GLOBALLY ROUTABLE host candidate, and the shape the LAN-only reading used to get wrong:
 * an endpoint at a public address is reachable from off its network with no srflx candidate
 * at all, and is issued none -- RFC 8445 §5.1.3 drops that srflx as redundant with its base.
 * Public IPv6 is where this actually happens, so the fixture is v6 (RFC 3849).
 */
export const IP_HOST6 =
  'a=candidate:7 1 udp 2113937148 2001:db8::1 50006 typ host generation 0 network-cost 999';
/** Routable, answered by nothing (TEST-NET-1): a pair forms against it and then times out. */
export const SRFLX_BLACKHOLE =
  'a=candidate:3 1 udp 1677729535 192.0.2.1 50002 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999';
/** A plain UDP host candidate, for pinning local.udpHosts without pinning an mDNS name. */
export const UDP_HOST =
  'a=candidate:4 1 udp 2113937149 10.0.0.4 50003 typ host generation 0 network-cost 999';
/** Server-reflexive at a named public address -- what `nets:` is computed from. */
export const SRFLX = (addr: string): string =>
  `a=candidate:5 1 udp 1677729534 ${addr} 50004 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999`;
export const SRFLX6 = (addr: string): string =>
  `a=candidate:6 1 udp 1677729533 ${addr} 50005 typ srflx raddr :: rport 0 generation 0 network-cost 999`;
/**
 * A relay candidate: field [4] is the address the TURN server ALLOCATED, which is why it is a
 * routable literal here and the base in raddr is not. Nothing in countCandidates() reads raddr --
 * it reads the transport (field 2) and the address (field 4) and nothing else -- so no assertion in
 * this suite depends on it, and the value below is shaped rather than measured.
 *
 * Writing this line allocates nothing. It is a string in an SDP the app READS, and no test in this
 * repo reaches a TURN server that answers -- the only turn: URLs here are routed nowhere -- so
 * none of them can show that relaying works.
 */
export const RELAY =
  'a=candidate:8 1 udp 41885439 198.51.100.1 50007 typ relay raddr 192.0.2.1 rport 50002 generation 0 network-cost 999';
/**
 * A TURN server at a routed-nowhere address (TEST-NET-2, RFC 5737): the ALLOCATION never completes,
 * so `getConfiguration()` reports a relay is configured while zero relay candidates are gathered.
 * That is the shape the NO RELAY marker and the first new post-mortem finding are both about.
 */
export const DEAD_TURN: RTCIceServer = {
  urls: 'turn:198.51.100.1:3478', username: 'u', credential: 'p',
};

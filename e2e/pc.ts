import type { Page } from '@playwright/test';

// One wrapper around the app's `new RTCPeerConnection(...)`, installed from
// addInitScript so it is in place BEFORE src/main.ts constructs pc at module scope.
// It grew out of two unshared copies -- override() in ice-timeout.spec.ts (config only)
// and install() in post-mortem.spec.ts (stats only) -- once a third spec needed both,
// plus a third knob neither had.

/** getStats() rows as [id, fields]. A Map's forEach signature is RTCStatsReport's, which is all §8 uses. */
export type Fixture = [string, Record<string, unknown>][];

export interface PcOptions {
  /** Merged field-by-field over the RTCConfiguration src/main.ts passes. */
  config?: RTCConfiguration;
  /** Serve getStats() from these rows instead of the real report. */
  stats?: Fixture;
  /** REPLACE every a=candidate line the app reads back from localDescription. */
  localCandidates?: string[];
  /** ADD these a=candidate lines to the ones the app reads back. */
  extraLocalCandidates?: string[];
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

    window.RTCPeerConnection = class extends Orig {
      constructor(cfg?: RTCConfiguration) {
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

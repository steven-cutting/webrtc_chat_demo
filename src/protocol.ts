// Everything that crosses the RTCDataChannel is JSON.stringify() of an Envelope.

export type Role = 'offerer' | 'answerer';

export type Envelope =
  | { v: 1; seq: number; from: Role; kind: 'chat'; text: string }
  | { v: 1; seq: number; from: Role; kind: 'bye' };

// `seq` is a per-tab counter, NOT crypto.randomUUID(): randomUUID is
// secure-context-only and is `undefined` on http://<lan-ip>:5173 -- exactly the
// origin the phone uses. A counter also reads far better in a wire log.
// `from` is the role, so there is no peer-id generator anywhere in the demo.
// There is no timestamp field: the log already stamps every row.
// `bye` is sent on pagehide; without it, noticing a vanished peer means waiting
// out ICE consent freshness (~30 s).

/** Hand-written guard. No dependency: this is ten lines. */
export function asEnvelope(raw: string): Envelope | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const e = m as Record<string, unknown>;
  if (e.v !== 1 || typeof e.seq !== 'number') return null;
  if (e.from !== 'offerer' && e.from !== 'answerer') return null;
  if (e.kind === 'bye') return e as Envelope;
  if (e.kind === 'chat' && typeof e.text === 'string') return e as Envelope;
  return null;
}

/** What the log prints above the raw bytes. Every kind has a rendering. */
export function describe(e: Envelope): string {
  return e.kind === 'chat' ? e.text : '— peer left —';
}

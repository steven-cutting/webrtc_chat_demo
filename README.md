# webrtc-json-wire

A zero-server WebRTC demo: two browsers exchange **typed JSON envelopes** over an
`RTCDataChannel`. The wire log *is* the chat transcript — every message renders as
the exact JSON string that crossed the channel, so you cannot read the conversation
without reading the bytes.

There is no signaling server. **You** are the signaling channel: you copy one JSON
blob from tab A into tab B, and the answer back.

```
npm install
npm run dev          # note BOTH printed URLs: Local and Network
```

Open the Local URL in two tabs. In one, click **Start as OFFERER**; copy its blob into
the other tab's paste box and click **Join as ANSWERER**; copy that tab's answer back
into the first and click **Accept answer**. Both tabs show `channel:open`. Type.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite on `0.0.0.0:5173` (`--strictPort`, so a port collision is loud) |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `e2e/`, `playwright.config.ts` |
| `npm run test:e2e` | Playwright, two projects (bundled Chromium, and Google Chrome via `channel`) on **stock launch args**, so mDNS obfuscation stays on: `handshake.spec.ts` runs the full two-context handshake and asserts byte-identity both ways; `ice-timeout.spec.ts` drives the gathering-timeout path against a black-holed STUN/TURN address; `post-mortem.spec.ts` covers the failure diagnosis in §8, three of its four tests from a stats fixture rather than a real 15 s timeout; `answerer-clock.spec.ts` measures the no-deadline claim with a deliberate 20 s stall (~1 min 45 s total; the chromium-only tests carry the deliberate waits). Add `--project=chromium` if Chrome is not installed |
| `npm run build` | Production bundle (nothing here is deployed; this is just a gate) |

## The handshake

```
        OFFERER (tab A)                                  ANSWERER (tab B)
             │                                                  │
   createDataChannel('chat')        ← MUST be before createOffer
             │
   createOffer → setLocalDescription
             │
   ICE gathering ─── host + srflx (via stun.l.google.com) ───┐
             │                                              │
   JSON.stringify(pc.localDescription)  ←── after gathering ─┘
             │
             │  ~~~~~~ you copy/paste the blob ~~~~~~►      │
             │                                    setRemoteDescription(offer)
             │                                              │
             │                                    createAnswer → setLocalDescription
             │                                              │
             │                                       ICE gathering
             │                                              │
             │  ◄~~~~~~ you copy/paste it back ~~~~~~       JSON.stringify(localDescription)
             │
   setRemoteDescription(answer)
             │
             └────── ICE checks → DTLS → SCTP → dc.onopen ──┘
                                                            │
                          {"v":1,"seq":1,"from":"offerer","kind":"chat","text":"hi"}
```

## Five things this demo gets right (and most don't)

1. **`createDataChannel()` before `createOffer()`.** The channel is what emits the
   `m=application` section. Reverse the order and the answerer's `datachannel` event
   never fires and no ICE transport is created, so the offer carries **zero**
   candidates and both peers sit at `gathering:new · ice:new · conn:new` forever —
   nothing was ever created that could transition. Measured in Chromium 151; the
   diagnostics strip shows that whole signature, which is how you tell it apart from
   a network problem.
2. **Serialize `pc.localDescription`, not the `createOffer()` return value.** That
   returned object is a frozen snapshot with **zero** candidates. The browser merges
   candidates into `localDescription.sdp` as it surfaces them, so you must re-read it
   *after* gathering finishes. With no signaling channel there is nowhere to trickle
   candidates to — everything must ride in the one blob.
3. **The browser will not reject a misplaced paste.** Per the W3C
   `setRemoteDescription` algorithm, an offer arriving in `have-local-offer` triggers
   an **implicit rollback** and is applied *silently* — there is no exception to catch.
   This demo guards the paste itself, checking "that's your own blob" first because it
   is the likeliest mistake.
4. **`connectionState === 'connected'` does not mean you can send.** It only means ICE
   and DTLS finished; SCTP/DCEP still has to complete, and `dc.send()` in that window
   throws `InvalidStateError`. The only true readiness signal is
   `dc.readyState === 'open'`.
5. **No TURN, so no NAT traversal.** On a LAN this connects host↔host. Over the open
   internet, or behind strict/symmetric NAT, it will not — and that is out of scope
   rather than half-implemented.

## Across devices

`npm run dev` binds `0.0.0.0` and prints a `➜ Network:` URL. Open **that IP literal**
on a phone on the same Wi-Fi — not `<hostname>.local`, which Vite's default
`allowedHosts` rejects with "Blocked request".

Plain HTTP is deliberate. `RTCPeerConnection`, `createDataChannel` and STUN are **not**
secure-context gated, so no cert, no trust profile, no interstitial. `navigator.clipboard`
*is* gated (it is `undefined` on `http://192.168.x.x:5173`), so the Copy button
feature-detects it and falls back to selecting the text — and pasting never needed an
API at all.

**Acceptance:** `channel:open` on both physical devices, and a chat envelope visible in
the receiving device's wire log.

### If it doesn't connect

The diagnostics strip and the wire log say why:

**Read the post-mortem first.** On `conn → failed` the app samples `getStats()` and
prints what it measured — an evidence line (`post-mortem — pairs:… udp-host-pairs:…
mdns-offered:… sent:… recv:… answered:…`) followed by every verdict that holds. It is
sampled on a timer during checking rather than read once at `failed`, because
libwebrtc destroys write-timed-out connections as it reports failed: measured here,
the sampler saw 1 candidate pair on all 15 ticks while a read from inside the `failed`
handler returned 0.

- **All host candidates end in `.local`** — this on its own is **normal, not a fault**.
  Chrome obfuscates host candidates with mDNS by default for any origin that does not
  hold camera/microphone permission, so you will see it on every healthy run too
  (measured here: `.local` candidates present in 100% of runs that connected fine).
  What implicates resolution is `udp-host-pairs:0` next to a non-zero `mdns-offered`
  in the post-mortem — the peer named hosts and not one of them ever became a pair.
- **Zero `srflx` candidates** — STUN is unreachable from this network. A lone
  `ice candidate error 701` is *not* that: 701 is reported per address family, so on a
  host with no global IPv6 the AAAA attempt fails on every run while IPv4 succeeds.
  The candidate count on the next line is the actual check.
- **Both** — there is no path, and with TURN out of scope nothing here can fix it.
- **`conn → failed`** — Reset is **not** the general remedy, and for a blocked path it
  is the one action guaranteed to reproduce the failure. Reset only when the
  post-mortem says a pair succeeded (the failure is then after ICE) or when you are
  re-running with a stale blob; session descriptions are single-use.
- **`ice → failed` exactly 15 s after `ice → checking`** — that is libwebrtc's
  `CONNECTION_WRITE_TIMEOUT`: every pair went write-timeout without one answered check.
  It does **not** mean you pasted too slowly. The answerer has no delivery deadline,
  because the offerer answers Binding Requests against its own credentials long before
  it applies the answer (RFC 8445 §7.3). Measured by `answerer-clock.spec.ts`: an
  answer withheld for 20 s — past the timeout — still reaches `channel:open`.
- **macOS: `conn → failed` with `udp-host-pairs:0`, even between two browsers on one
  Mac** — the leading suspect is **Local Network** access in System Settings → Privacy
  & Security → Local Network. Enable it for **both** browsers and relaunch them.
  Note what the topology rules out: with both peers on one machine, `route get` for the
  LAN address returns `lo0`, so once a `.local` name resolves the media path is kernel
  loopback and never touches the LAN. Guest VLANs and AP client isolation — real mDNS
  blockers between *devices* — are categorically inapplicable here. Only the OS can
  break this case.
  Origin-scoped alternative, no System Settings needed: allow camera + microphone for
  `http://localhost:5173` in `chrome://settings/content`, since Chrome skips mDNS
  obfuscation for origins holding media-capture permission (mechanism is consistent
  with Chromium's design; not exercised by anything in this repo, and **localhost
  only** — media-capture permission needs a secure context, so it is unavailable on
  the `http://<lan-ip>:5173` origin the phone uses).

  **Calibration, and it is weaker than it used to read here.** An earlier revision said
  this failure did not reproduce under automation. That claim stands as a measurement
  and falls as evidence, because the suite cannot reproduce this topology:
  `handshake.spec.ts` builds both peers with `browser.newContext()` from **one**
  `browser` fixture — one process, one network service, one mDNS stack — and
  `playwright.config.ts` declares no `webkit` project. **No automated run here has ever
  exercised two independent browser instances, or two engines.** Two further
  differences between the passing and failing runs are open: macOS attributes Local
  Network permission to the *responsible process*, which for a terminal-spawned browser
  may be the terminal rather than Chrome.app; and Playwright spawns fresh from
  `/Applications`, so it can run a newer build than the long-lived Dock-launched
  process that failed (seen here: bundle 152, running helpers 149).
  So Local Network remains **one hypothesis, not the diagnosis**. To settle it, change
  one variable at a time, pasting fast each run: (A) as-is; (B) both tabs in the *same*
  browser; (C) fully quit and relaunch both browsers, setting untouched; (D) enable
  Local Network. Only *C fails and D connects* licenses calling the permission the
  cause — if C connects, it was the stale process.

`chrome://webrtc-internals` is the confirming second opinion. Under the mDNS story
there is no remote `host` row and no pair against the LAN address at all — only pairs
against the remote `srflx`, `requestsSent` climbing and `responsesReceived` at 0. A
pair against the LAN address in state `failed` means something else: local-subnet
unicast blocked rather than name resolution, same fix but a different claim.

## What's on the wire

```ts
type Envelope =
  | { v: 1; seq: number; from: 'offerer' | 'answerer'; kind: 'chat'; text: string }
  | { v: 1; seq: number; from: 'offerer' | 'answerer'; kind: 'bye' };
```

```
{"v":1,"seq":1,"from":"offerer","kind":"chat","text":"hello from A"}
```

`seq` is a per-tab counter rather than `crypto.randomUUID()` — `randomUUID` is
secure-context-only and would be `undefined` on exactly the LAN origin the phone uses
(a bug that passes on localhost and crashes on the phone). Incoming frames are logged
from `event.data` **before** `JSON.parse`; outgoing ones **after** `JSON.stringify`.
That call placement is what makes "these are the exact bytes" true rather than
aspirational. A frame that fails the guard is logged, never dropped silently.

## Deliberately not here

Signaling server · TURN · mesh/rooms/>2 peers · HTTPS · blob compression or QR ·
SDP rewriting · `restartIce()` and auto-reconnect · audio/video · backpressure
handling · persistence, nicknames, typing indicators, file transfer.

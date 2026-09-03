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
| `npm run test:e2e` | Playwright, two projects (bundled Chromium, and Google Chrome via `channel`) on **stock launch args**, so mDNS obfuscation stays on: `handshake.spec.ts` runs the full two-context handshake and asserts byte-identity both ways; `ice-timeout.spec.ts` drives the gathering-timeout path against a black-holed STUN/TURN address (~50 s total, mostly one deliberate 40 s back-off). Add `--project=chromium` if Chrome is not installed |
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

- **All host candidates end in `.local`** — this on its own is **normal, not a fault**.
  Chrome obfuscates host candidates with mDNS by default for any origin that does not
  hold camera/microphone permission, so you will see it on every healthy run too
  (measured here: `.local` candidates present in 100% of runs that connected fine).
  It only implicates multicast when it appears *together with* `ice → failed`. If it
  does, then suspect the network: guest VLANs and APs with client isolation block
  mDNS, which is one hop and never crosses subnets. On macOS, suspect the OS first
  (see below).
- **Zero `srflx` candidates** — STUN is unreachable from this network.
- **Both** — there is no path, and with TURN out of scope nothing here can fix it.
- **`conn → failed`** — press **Reset** in both tabs and redo the exchange. Session
  descriptions are single-use; a stale blob cannot be re-pasted.
- **macOS: `conn → failed` with all-`.local` candidates, even between two tabs of the
  same browser** — try granting Chrome **Local Network** access in System Settings →
  Privacy & Security → Local Network; without it Chrome may be unable to resolve mDNS
  candidates. Origin-scoped alternative, no System Settings needed: allow camera +
  microphone for `http://localhost:5173` in `chrome://settings/content`, since Chrome
  skips mDNS obfuscation for origins holding media-capture permission (mechanism is
  consistent with Chromium's design; not exercised by anything in this repo, and
  **localhost only** — media-capture permission needs a secure context, so it is
  unavailable on the `http://<lan-ip>:5173` origin the phone uses).
  Calibration before you spend time here: this failure did **not** reproduce under
  automation. Driving the full handshake with mDNS obfuscation left on, Google Chrome
  152 from `/Applications` and bundled Chromium 151 both reached `channel:open` in
  under 300 ms, with `.local` candidates on both sides. The caveat that keeps this
  from being conclusive: Playwright launches Chrome with a fresh temporary profile,
  and macOS attributes Local Network permission to the *responsible process*, which
  for a terminal-spawned browser may be the terminal rather than Chrome.app — so a
  Dock-launched Chrome can still differ. Treat Local Network permission as one
  hypothesis, not the diagnosis, and confirm in `chrome://webrtc-internals` before
  changing OS settings.

`chrome://webrtc-internals` is the confirming second opinion.

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

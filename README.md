# webrtc-json-wire

A zero-server WebRTC demo: two browsers exchange **typed JSON envelopes** over an
`RTCDataChannel`. The wire log *is* the chat transcript — every message renders as
the exact JSON string that crossed the channel, so you cannot read the conversation
without reading the bytes.

There is no signaling server. **You** are the signaling channel: you copy one JSON
blob from tab A into tab B, and the answer back.

**Live: <https://stevencutting.com/webrtc_chat_demo/>** — two tabs, nothing to install.
Static hosting, so there is still no *signaling* server — one STUN server is in the loop,
as §5 and the diagram below say. A public URL buys less reach than it looks like: there is
no TURN here, so no relay fallback, and whether two people on *different* networks connect
depends on the NAT at each end (§5). Nothing in this repo measures that case. Same LAN, or
two tabs on one machine, is what is actually exercised.

What changed is only what the app *says* about that case. It is now named as what it is —
before the exchange, by a `LAN ONLY` marker on any blob whose every candidate is a LAN
address, and
after it, by a post-mortem that reports a missing relay instead of macOS Local Network
settings. Diagnosed is not connected, and neither one is measured.

To run it locally instead:

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
| `npm run typecheck` | `tsc --noEmit` over `src/`, `e2e/`, `playwright.config.ts`, `vite.config.ts` |
| `npm run test:e2e` | Playwright. Two dev-server projects (bundled Chromium, and Google Chrome via `channel`) on **stock launch args**, so mDNS obfuscation stays on: `handshake.spec.ts` runs the full two-context handshake and asserts byte-identity both ways; `ice-timeout.spec.ts` drives the gathering-timeout path against a black-holed STUN/TURN address; `post-mortem.spec.ts` covers the failure diagnosis in §8, six of its seven tests from a stats fixture rather than a real 15 s timeout; `answerer-clock.spec.ts` measures the no-deadline claim with a deliberate 20 s stall (~1 min 45 s total; the chromium-only tests carry the deliberate waits). A third project, **`pages-build`**, is the only one that runs against the *built* bundle under `/webrtc_chat_demo/` rather than the dev server: `pages-build.spec.ts` fails on any response ≥ 400 while loading it, and `handshake.spec.ts` runs there too. That project is the CI gate. Without Google Chrome installed, run `--project=chromium --project=pages-build` |
| `npm run build` | Production bundle into `dist/` — exactly what GitHub Pages serves |
| `npm run preview:pages` | Builds, then serves `dist/` at `http://127.0.0.1:4173/webrtc_chat_demo/` — the Pages layout, reproduced locally. The `pages-build` project's server |

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
5. **No TURN, so no relay fallback.** STUN still runs, and its `srflx` candidates do
   traverse many NATs — so "no TURN" is not "no NAT traversal". What is missing is the
   last resort: behind symmetric NAT, or a firewall that drops UDP, there is no direct
   path, and with TURN out of scope nothing here can build one. On a LAN this connects
   host↔host, which is the only case this repo measures. What the app does do is *say* so:
   when both ends published `srflx` candidates and their public addresses differ, the
   post-mortem names the missing relay rather than leaving it to be inferred — and admits
   it cannot tell a symmetric NAT from a firewall that drops inbound UDP.

## Across devices

Two origins reach a phone, and they differ in exactly one thing: whether the context is
secure. The diagnostics strip says which one you are on — `location.origin` and
`secure:<bool>` are its first two fields.

**The dev server, plain HTTP.** `npm run dev` binds `0.0.0.0` and prints a `➜ Network:`
URL. Open **that IP literal** on a phone on the same Wi-Fi — not `<hostname>.local`, which
Vite's default `allowedHosts` rejects with "Blocked request".

Plain HTTP is deliberate here and still is. `RTCPeerConnection`, `createDataChannel` and
STUN are **not** secure-context gated, so no cert, no trust profile, no interstitial.
`navigator.clipboard` *is* gated (it is `undefined` on `http://192.168.x.x:5173`), so the
Copy button feature-detects it and falls back to selecting the text — and pasting never
needed an API at all.

**The hosted copy, HTTPS.** Same bundle, same STUN server, same absent signaling server;
the only difference is that a secure context has `navigator.clipboard`, so Copy takes that
branch instead of the selection fallback. Measured rather than read off the source: with
both paths instrumented on the built bundle over a secure origin, a real click called
`writeText` once and `execCommand` zero times, leaving the textarea unselected. The button
says "Copied" either way, so the label is not the evidence.

**Acceptance:** `channel:open` on both physical devices, and a chat envelope visible in
the receiving device's wire log. Same Wi-Fi — that is the topology this is acceptance for.

**One thing that did not work here**, recorded as the single observation it is: a laptop
(Safari, Wi-Fi) and an iPhone (Safari, **cellular**) did not connect over the hosted URL.
Carrier-grade NAT is typically address-and-port-dependent, and `srflx` candidates cannot
traverse that, so the outcome is what the mechanism predicts. One attempt plus a mechanism
is not a measurement, though, and nothing here claims cellular can never work. What is new
is that the app now names that shape when it happens, instead of sending you to a macOS
Local Network setting you are not on the wrong side of.

### If it doesn't connect

The diagnostics strip and the wire log say why:

**Read the post-mortem first.** On `conn → failed` the app samples `getStats()` and
prints what it measured — an evidence line (`post-mortem — pairs:… udp-host-pairs:…
remote-hosts:… mdns-offered:… local-udp-hosts:… local-srflx:… remote-srflx:… nets:…
families:…|… sent:… recv:… answered:…`) followed by every verdict that holds, most
conclusive first — and `ui.error` shows only the first, so the ranking is the message. It is
sampled on a timer during checking rather than read once at `failed`, because
libwebrtc destroys write-timed-out connections as it reports failed: measured here,
the sampler saw 1 candidate pair on all 15 ticks while a read from inside the `failed`
handler returned 0.

- **All host candidates end in `.local`** — this on its own is **normal, not a fault**.
  Chrome obfuscates host candidates with mDNS by default for any origin that does not
  hold camera/microphone permission, so you will see it on every healthy run too
  (measured here: `.local` candidates present in 100% of runs that connected fine).
  What implicates resolution is `remote-hosts:0` next to a non-zero `mdns-offered` in the
  post-mortem — the peer named hosts and not one of them ever became a pair. *Implicates*,
  not proves: Chrome reports a remote candidate only once a pair exists for it, so a name
  that did resolve but to an address nothing here can pair with — an IPv4/IPv6 split, say —
  leaves the same zero behind.
- **Zero `srflx` candidates *and* no routable host address** — STUN is unreachable from
  this network, and nothing you publish can leave it. You no longer have to reach a failure
  to find that out: the meta line under Copy reads `LAN ONLY` before you hand the blob over.
  Both halves are load-bearing: an endpoint sitting at a globally routable address (a public
  IPv6 is the everyday case) is reachable from anywhere with **no** `srflx` candidate, and is
  issued none — RFC 8445 §5.1.3 eliminates a candidate whose transport address *and* base
  equal another's, which is exactly that one. So `local-srflx:0` alone is not the verdict;
  an mDNS `.local` name, on the other hand, *is* LAN-only whatever address it hides, because
  multicast DNS is link-scope. A lone
  `ice candidate error 701` is *not* that. 701 is not a STUN error code at all: the W3C
  definition of `errorCode` sets it "if no host candidate can reach the server", which is
  reachability in general, not name resolution — libwebrtc raises it both for a lookup
  failure (`STUN host lookup received error.`) and for a plain timeout (`STUN binding
  request timed out.`), so the `errorText` logged beside it is what says which. Seen here:
  one 701 for `stun.l.google.com` in a run that still published a working `srflx`
  candidate. The candidate count on the next line is the actual check.
- **Both** — there is no path, and with TURN out of scope nothing here can fix it.
- **`nets:different`** — the two ends were reflected to different public addresses. That
  **usually** means different networks; it is a reading and not a topology, and it is wrong
  in both directions. A dual-WAN router, a NAT address pool, or a VPN on one side reflects
  two peers on **one** network to two addresses. So the verdict says "reflected to different
  public addresses" rather than "are on different networks", and it does not *suppress* the
  mDNS finding — it outranks it. The mDNS advice is still printed below, under its condition,
  for the operator this reading has misclassified. Taken at its usual meaning: `remote-hosts:0`
  beside a non-zero `mdns-offered` implicates nothing, because a `.local` name *cannot*
  resolve across the internet, so that zero is expected. What had to work was the `srflx`
  pair, and when it did not, two readings fit that `getStats()` cannot separate — a NAT that
  maps per destination (symmetric), which mobile carriers commonly run, or a firewall that
  drops inbound UDP. Neither is beaten by STUN alone. The missing piece is a relay, which is
  out of scope (see "Deliberately not here"); the workaround that needs no relay is to put
  both devices on one network.
  - `nets:same` — one NAT reflected both ends to one address, so the mDNS reading stays live
    and keeps the headline. Not proof of one network either: a single carrier CGNAT reflects
    two unrelated subscriber networks to the same public address, and nothing here can tell
    that apart. The mDNS verdict says so in its own text rather than leaving it implied.
  - `nets:unknown` — one side published no `srflx` at all, so the addresses cannot be
    compared; `local-srflx` / `remote-srflx` say which side. Note the gap this leaves: the
    mDNS verdict can still take the headline here even when the peer is demonstrably
    elsewhere, which is why the `LAN ONLY` marker exists on the publishing side.
  - `families:v4+v6|v6+?` — the address families on each side, over **every** candidate that
    carries a literal. A trailing `?` is an mDNS name, whose family is not knowable from the
    SDP.
  - `local-mapped:` / `remote-mapped:` **are public IP addresses.** They are the evidence for
    `nets:`, they are already inside the blob you paste around, and they are printed on that
    one line and nowhere else — so a log pasted into a bug report can be redacted a line at a
    time rather than mid-sentence.
- **One end published only IPv4 and the other only IPv6** — its own verdict, and it leads
  ahead of `nets:different`, because it is provable rather than ranked: with no family in
  common there is no address the two ends share, so the absent pair is arithmetic and not a
  suspicion. Only a relay bridges two address families.

  It is read across **every** candidate, and it will not fire while either side shows a `?`
  in `families:`. The reflexive candidates alone cannot carry it — ICE pairs a host candidate
  on one side with a same-family `srflx` on the other, and an mDNS name hides a family that
  might be the bridge. When only the *reflexive* families are disjoint, that observation is
  folded into the `nets:different` verdict as a sentence instead: it rules out the reflexive
  pair, which is the pair that had to work, and nothing wider.
- **`conn → failed`** — Reset is **not** the general remedy, and for a blocked path it
  is the one action guaranteed to reproduce the failure. Reset when the post-mortem says
  this session *had been connected* and then lost the path, when it says ICE reported
  `connected` before the failure (so what broke is after ICE), or when you are re-running
  with a stale blob; session descriptions are single-use. A retained `succeeded` pair on
  its own licenses none of that — it is a reading of an earlier sample, not of the state at
  failure, and a path found and then lost before DTLS finishes leaves exactly that trace.
  The post-mortem labels that case as historical rather than deciding it for you.
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
  blockers between *devices* — are categorically inapplicable here. What that rules out is
  everything *outside* the machine, and nothing inside it: the OS permission, the browser's
  own mDNS responder, a stale browser process and local filtering software all remain in
  scope, which is why the calibration below keeps more than one hypothesis open.
  Origin-scoped alternative, no System Settings needed: allow camera + microphone for
  `http://localhost:5173` in `chrome://settings/content`, since Chrome skips mDNS
  obfuscation for origins holding media-capture permission (mechanism is consistent
  with Chromium's design; not exercised by anything in this repo). Media-capture
  permission needs a secure context, so this lever exists on `localhost` and on the
  hosted HTTPS origin, and **not** on the `http://<lan-ip>:5173` origin the phone uses.

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

`chrome://webrtc-internals` is the confirming second opinion, and it confirms less than it
looks like. Under the mDNS story there is no remote `host` row and no pair against the LAN
address at all — only pairs against the remote `srflx`, `requestsSent` climbing and
`responsesReceived` at 0. **A cross-network failure produces that identical shape**, which
is the whole premise of the `nets:` reading: nothing in `webrtc-internals`, and nothing in
`getStats()`, separates the two. Only comparing the two ends' reflexive addresses does, and
the post-mortem is the only place that happens — so read `nets:` first and treat this page
as corroboration of the *shape*, never of the cause. That
shape is what the real-ICE canary in `post-mortem.spec.ts` reproduces and measures: one
unresolvable `.local` plus one blackholed routable candidate, and the sampler reports a
live pair and `remote-hosts:0` in the same snapshot. A
pair against the LAN address in state `failed` means something else: local-subnet
unicast blocked rather than name resolution, same fix but a different claim.

## Deployed

`.github/workflows/deploy-pages.yml` builds on push to `main` and publishes `dist/` to
GitHub Pages. The gate is `npm run typecheck && npm run build`. The Playwright suite is
deliberately not in it — it needs a browser install and spends ~1 min 45 s on deliberate
waits, and nothing it covers can break from a change that typechecks and bundles — so it
stays a local check. `dist/` is never committed; the workflow uploads it as an artifact.

The URL is inherited rather than configured. The account's user site carries a custom apex
domain, and GitHub serves every project site in that account beneath it, so this lands at
`stevencutting.com/webrtc_chat_demo/` and `steven-cutting.github.io/webrtc_chat_demo/`
301s there. There is no `CNAME` file in this repo and there could not usefully be one:
Actions-based publishing ignores it, and the override is a repo setting instead.

`vite.config.ts` sets `base: './'` so the bundle resolves under that subpath while naming
the repo nowhere. It relies on Pages redirecting `/webrtc_chat_demo` to
`/webrtc_chat_demo/` before the document is parsed — long-standing behavior that GitHub
does not actually document, so it is worth re-checking with `curl -sI` if assets ever 404.

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

Signaling server · TURN · mesh/rooms/>2 peers · blob compression or QR ·
SDP rewriting · `restartIce()` and auto-reconnect · audio/video · backpressure
handling · persistence, nicknames, typing indicators, file transfer.

HTTPS used to be on that list and is now only half off it. This repo still terminates no
TLS and configures no cert; `npm run dev` is plain HTTP by design. The hosted copy is
HTTPS because Pages is, not because anything here asked for it — and nothing in the code
requires a secure context, which is exactly why `seq` is a counter rather than
`crypto.randomUUID()` (`src/protocol.ts`).

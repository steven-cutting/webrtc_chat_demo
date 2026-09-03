import { expect, test, type Page } from '@playwright/test';

// The ICE-gathering timeout path in src/main.ts, which handshake.spec.ts never
// reaches: on a healthy network gathering completes in ~125 ms, roughly 24x
// inside ICE_GATHER_TIMEOUT_MS. These force it by pointing the app at
// 192.0.2.1 (TEST-NET-1, RFC 5737) -- routed nowhere, so it never answers and
// Chrome retransmits until it gives up ~40 s later.

/** Re-run the app's own `new RTCPeerConnection(...)` with these fields replaced. */
async function override(page: Page, overrides: RTCConfiguration): Promise<void> {
  // addInitScript, so the wrapper is installed before src/main.ts constructs pc.
  await page.addInitScript((o: RTCConfiguration) => {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Orig {
      constructor(cfg?: RTCConfiguration) {
        super({ ...cfg, ...o });
        (window as unknown as Record<string, unknown>).__pc = this;
      }
    };
  }, overrides);
}

const DEAD_STUN: RTCConfiguration = { iceServers: [{ urls: 'stun:192.0.2.1:19302' }] };

test('gathering timeout with candidates: publishes, marks the blob PARTIAL, then refreshes it', async ({ page }) => {
  // Chromium only: this is libwebrtc back-off, identical across channels, and it
  // costs ~45 s -- not worth paying twice.
  test.skip(test.info().project.name !== 'chromium', 'libwebrtc-level behaviour; ~45 s of STUN back-off');
  test.setTimeout(150_000);

  await override(page, DEAD_STUN);
  await page.goto('/');
  await page.getByTestId('create-offer').click();

  // Host candidates are there, so the blob IS worth copying -- but it is a
  // snapshot, and that has to be visible next to the Copy button, not only in
  // the wire log, which scrolls.
  await expect(page.getByTestId('signal-phase')).toHaveText('offer-ready');
  await expect(page.getByTestId('blob-meta')).toContainText('PARTIAL');
  expect(await page.getByTestId('local-blob').inputValue()).toMatch(/typ host/);
  await expect(page.getByTestId('wire-log')).toContainText('ice gathering still running after 3000 ms');

  // ~40 s later Chrome gives up on the dead STUN server and completes: the
  // refresh must actually land, and the marker must clear.
  await expect(page.getByTestId('blob-meta')).not.toContainText('PARTIAL', { timeout: 90_000 });
  await expect(page.getByTestId('wire-log')).toContainText('gathering finished');
  await expect(page.getByTestId('error')).toHaveText('');
});

test('gathering timeout with ZERO candidates: refuses to publish an unusable blob', async ({ page }) => {
  // relay-only against a TURN server that never answers: nothing to gather.
  await override(page, {
    iceTransportPolicy: 'relay',
    iceServers: [{ urls: 'turn:192.0.2.1:3478', username: 'x', credential: 'y' }],
  });
  await page.goto('/');
  await page.getByTestId('create-offer').click();

  // A description with no candidates can never form a pair, so calling it
  // 'offer-ready' would hand the operator a blob guaranteed to fail.
  await expect(page.getByTestId('error')).toContainText('No ICE candidates yet', { timeout: 30_000 });
  await expect(page.getByTestId('signal-phase')).toHaveText('gathering');
  expect(await page.getByTestId('local-blob').inputValue()).toBe('');
});

test('a late gathering completion must not reset a session that already connected', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  // Only A is starved, so only A arms the refresh listener; B answers normally.
  await override(A, DEAD_STUN);
  await A.goto('/');
  await B.goto('/');

  await A.getByTestId('create-offer').click();
  await expect(A.getByTestId('signal-phase')).toHaveText('offer-ready'); // via the 3 s timeout
  await expect(A.getByTestId('blob-meta')).toContainText('PARTIAL');

  await B.getByTestId('remote-blob').fill(await A.getByTestId('local-blob').inputValue());
  await B.getByTestId('accept').click();
  await expect(B.getByTestId('signal-phase')).toHaveText('answer-ready');
  await A.getByTestId('remote-blob').fill(await B.getByTestId('local-blob').inputValue());
  await A.getByTestId('accept').click();
  await expect(A.getByTestId('diag')).toContainText('channel:open');

  // Fire the completion synthetically rather than waiting out ~40 s of real
  // back-off: the app only reads pc.iceGatheringState, so a stubbed getter plus
  // the event is indistinguishable from the real thing at the call site.
  await A.evaluate(() => {
    const pc = (window as unknown as Record<string, unknown>).__pc as RTCPeerConnection;
    Object.defineProperty(pc, 'iceGatheringState', { get: () => 'complete', configurable: true });
    pc.dispatchEvent(new Event('icegatheringstatechange'));
  });

  // The blob is spent. Republishing it would re-enable Accept on a live session,
  // tell the operator to "copy again", and clear any error off the screen.
  await expect(A.getByTestId('wire-log')).toContainText('ice gathering → complete');
  await expect(A.getByTestId('signal-phase')).toHaveText('connected');
  await expect(A.getByTestId('accept')).toBeDisabled();
  await expect(A.getByTestId('wire-log')).not.toContainText('gathering finished');
  await expect(A.getByTestId('blob-meta')).not.toContainText('PARTIAL'); // marker still drops

  await ctxA.close();
  await ctxB.close();
});

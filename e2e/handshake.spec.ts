import { expect, test, type Page } from '@playwright/test';
import type { Envelope } from '../src/protocol';

const FROM_A = 'hello from A';
const FROM_B = 'reply from B';

/** Surface page errors from BOTH contexts; otherwise a thrown TypeError just looks like a timeout. */
function watch(page: Page, tag: string): void {
  page.on('pageerror', (err) => console.log(`[${tag}] pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${tag}] console.error: ${msg.text()}`);
  });
}

/** The exact strings the app logged, straight off the assertion surface. */
function raws(page: Page, dir: 'sent' | 'recv'): Promise<string[]> {
  return page
    .locator(`[data-testid="wire-log"] li[data-dir="${dir}"]`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.raw ?? ''));
}

test('typed JSON envelopes cross the data channel, byte for byte', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  watch(A, 'A');
  watch(B, 'B');
  await A.goto('/');
  await B.goto('/');

  // 1. Offerer role, and the non-trickle gate. Reading the blob before
  //    'offer-ready' races and copies a candidate-less SDP that still connects
  //    on localhost -- a green test hiding the real bug.
  await A.getByTestId('create-offer').click();
  await expect(A.getByTestId('signal-phase')).toHaveText('offer-ready');
  await expect(A.getByTestId('role')).toContainText('OFFERER');

  const offer = await A.getByTestId('local-blob').inputValue();

  // 2. Candidate assertions about the APP, not about the harness. mDNS
  //    obfuscation is a Chrome DEFAULT, not a fault -- both projects run with it
  //    on -- so '.local' host candidates are expected and asserting their
  //    absence would only have asserted a launch flag. What must actually hold
  //    is that countCandidates() reads the SDP correctly: the app's mDNS notice
  //    fires if and only if a candidate address really ends in .local.
  //    Note the blob is JSON, so its SDP newlines are the two characters \r\n;
  //    match on the escaped text, never with a multiline anchor.
  expect(offer).toMatch(/typ host/);
  expect(offer, 'offer has no data channel section — was createDataChannel called before createOffer?').toContain('m=application');
  const mdnsInSdp = /a=candidate:[^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+\.local /.test(offer);
  const mdnsNoticed = (await A.getByTestId('wire-log').innerText()).includes('mDNS-obfuscated');
  expect(mdnsNoticed, "the app's mDNS notice disagrees with the candidates it published").toBe(mdnsInSdp);

  // 3. The rollback guard. A pastes its OWN offer back. This asserts the
  //    ABSENCE of the implicit rollback the W3C spec obliges the browser to
  //    perform silently.
  await expect(A.getByTestId('accept')).toHaveText(/Accept answer/);
  await A.getByTestId('remote-blob').fill(offer);
  await A.getByTestId('accept').click();
  await expect(A.getByTestId('error')).toContainText('own blob');
  await expect(A.getByTestId('signal-phase')).toHaveText('offer-ready');
  await expect(A.getByTestId('diag')).toContainText('sig:have-local-offer');
  await A.getByTestId('remote-blob').fill('');

  // 4. The handshake. Blobs move by fill()/inputValue(), never the OS
  //    clipboard: no permission grants, no headless clipboard flake, and the
  //    same code path a human paste takes.
  await B.getByTestId('remote-blob').fill(offer);
  await B.getByTestId('accept').click();
  await expect(B.getByTestId('signal-phase')).toHaveText('answer-ready');
  await expect(B.getByTestId('role')).toContainText('ANSWERER');

  const answer = await B.getByTestId('local-blob').inputValue();
  expect(answer).not.toBe(offer);

  await A.getByTestId('remote-blob').fill(answer);
  await A.getByTestId('accept').click();

  // 5. Readiness: dc.readyState, never iceConnectionState, never waitForTimeout.
  await expect(A.getByTestId('diag')).toContainText('channel:open');
  await expect(B.getByTestId('diag')).toContainText('channel:open');

  // 6. Both directions.
  await A.getByTestId('compose').fill(FROM_A);
  await A.getByTestId('send').click();
  await expect(B.locator('[data-testid="wire-log"] li[data-dir="recv"]')).toHaveCount(1);

  await B.getByTestId('compose').fill(FROM_B);
  await B.getByTestId('send').click();
  await expect(A.locator('[data-testid="wire-log"] li[data-dir="recv"]')).toHaveCount(1);

  const [aSent] = await raws(A, 'sent');
  const [bRecv] = await raws(B, 'recv');
  const [bSent] = await raws(B, 'sent');
  const [aRecv] = await raws(A, 'recv');

  // 7. The headline: raw-string equality on the bytes, not deep-equal on parsed
  //    objects, so even a reordered key fails. This is the assertion that
  //    literally proves the JSON that crossed is the JSON that was sent.
  expect(bRecv).toBe(aSent);
  expect(aRecv).toBe(bSent);

  expect(JSON.parse(bRecv) as Envelope).toEqual({
    v: 1, seq: 1, from: 'offerer', kind: 'chat', text: FROM_A,
  });
  expect(JSON.parse(aRecv) as Envelope).toEqual({
    v: 1, seq: 1, from: 'answerer', kind: 'chat', text: FROM_B,
  });

  await ctxA.close();
  await ctxB.close();
});

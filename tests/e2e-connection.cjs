'use strict';

// Exercises the actual browser client against synthetic loopback-only API replies.
// No hosted accounts, KGS services or database are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const user = { id: '00000000-0000-4000-8000-000000000001', name: '自分' };
const other = { memberId: '00000000-0000-4000-8000-000000000002', name: '相手' };
const snapshot = (extra = {}) => ({
  ok: true, wallet: { balance: 20000, walletRevision: '1' }, match: null,
  lobby: { online: [other], queue: null, incoming: [], outgoing: [] }, ...extra,
});
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const failed = route => json(route, { ok: false, error: { code: 'TEMPORARY_FAILURE', message: '通信エラー' } }, 503);
let server, browser;

async function fixture(base, handler) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/session') return json(route, { ok: true, user, wallet: snapshot().wallet });
    if (pathname === '/api/logout') return json(route, { ok: true });
    await handler(route, pathname);
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.locator('[data-challenge-user]').waitFor();
  return { page, close: async () => { await context.close(); assert.deepEqual(errors, [], 'client has no uncaught errors'); } };
}

async function run(base) {
  {
    let fail = false, lobbyCalls = 0;
    const f = await fixture(base, async (route, pathname) => {
      if (pathname === '/api/lobby') lobbyCalls++;
      return fail ? failed(route) : json(route, snapshot());
    });
    const { page } = f;
    try {
      fail = true;
      await page.locator('#refresh-lobby').click();
      await page.waitForFunction(() => !document.querySelector('#notice').hidden && document.querySelector('#notice-text').textContent === '再接続中…');
      // The automatic poll must continue even while the warning is displayed.
      const previousCalls = lobbyCalls;
      await page.waitForRequest(request => new URL(request.url()).pathname === '/api/lobby', { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('#notice').hidden);
      assert.ok(lobbyCalls > previousCalls, 'failed polling continues to retry');
      assert.equal(await page.locator('#online-count').textContent(), '2', 'failure preserves the last roster and self');
      assert.equal(await page.locator('[data-self-user]').count(), 1, 'self remains listed exactly once');
      assert.equal(await page.locator('[data-challenge-user]').count(), 1, 'last known opponent remains listed');
      fail = false;
      await page.locator('#refresh-lobby').click();
      await page.waitForFunction(() => document.querySelector('#notice').hidden);
      assert.equal(await page.locator('#wallet-balance').textContent(), '20,000', 'recovery applies the real snapshot');
      console.log('PASS persistent failures retry and retain state; a successful snapshot clears the connection notice');
    } finally { await f.close(); }
  }
  {
    let fail = false, checked = false;
    const f = await fixture(base, async (route, pathname) => {
      if (pathname === '/api/queue') {
        fail = false;
        return json(route, { ok: false, error: { code: 'STAKE_REJECTED', message: '賭け額を確認してください。' } }, 422);
      }
      if (!fail && checked) checked = 'recovered';
      return fail ? failed(route) : json(route, snapshot());
    });
    const { page } = f;
    try {
      fail = true;
      await page.locator('#refresh-lobby').click();
      await page.waitForFunction(() => !document.querySelector('#notice').hidden);
      checked = true;
      const recovered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lobby' && response.status() === 200);
      await page.locator('#random-button').click();
      await page.waitForFunction(() => document.querySelector('#notice-text').textContent === '賭け額を確認してください。');
      await recovered;
      assert.equal(checked, 'recovered', 'the successful post-error snapshot was received');
      assert.equal(await page.locator('#notice').isVisible(), true, 'recovery does not hide an operation error');
      assert.equal(await page.locator('#notice-text').textContent(), '賭け額を確認してください。');
      console.log('PASS connection recovery preserves unrelated operation errors');
    } finally { await f.close(); }
  }
  {
    let held = null, hold = false, calls = 0;
    const f = await fixture(base, async route => {
      if (hold) calls++;
      if (hold && !held) { held = route; return; }
      return json(route, snapshot());
    });
    const { page } = f;
    try {
      hold = true;
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/lobby/heartbeat');
      await page.locator('#refresh-lobby').click();
      await requested;
      await page.locator('#refresh-lobby').click();
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForTimeout(100);
      assert.equal(calls, 1, 'manual refresh, heartbeat and lobby polling share the outstanding heartbeat');
      const recovered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lobby/heartbeat' && response.status() === 200);
      await json(held, snapshot());
      await recovered;
      assert.equal(await page.locator('#notice').isVisible(), false);
      console.log('PASS overlapping lobby refreshes and reconnect events share one heartbeat snapshot');
    } finally { await f.close(); }
  }
  {
    let held = null, holdRead = false, heartbeatCalls = 0;
    const f = await fixture(base, async (route, pathname) => {
      if (pathname === '/api/lobby/heartbeat') heartbeatCalls++;
      if (holdRead && pathname === '/api/lobby' && !held) { held = route; return; }
      return json(route, snapshot());
    });
    const { page } = f;
    try {
      holdRead = true;
      await page.waitForRequest(request => new URL(request.url()).pathname === '/api/lobby', { timeout: 5000 });
      const previousHeartbeats = heartbeatCalls;
      await page.locator('#refresh-lobby').click();
      await page.locator('#refresh-lobby').click();
      assert.equal(heartbeatCalls, previousHeartbeats, 'a due heartbeat waits for the in-flight read');
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lobby/heartbeat' && response.status() === 200);
      await json(held, snapshot());
      await refreshed;
      assert.equal(heartbeatCalls, previousHeartbeats + 1, 'the deferred heartbeat still refreshes presence exactly once');
      console.log('PASS a due heartbeat is deferred and still refreshes presence after a lobby read');
    } finally { await f.close(); }
  }
  {
    let held = null, hold = false;
    const f = await fixture(base, async (route, pathname) => {
      if (pathname === '/api/queue') return json(route, snapshot({ lobby: { online: [other], queue: { position: 1, stake: 100, formation: 0 }, incoming: [], outgoing: [] } }));
      if (hold && !held) { held = route; return; }
      return json(route, snapshot());
    });
    const { page } = f;
    try {
      hold = true;
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/lobby/heartbeat');
      await page.locator('#refresh-lobby').click();
      await requested;
      await page.locator('#random-button').click();
      await page.locator('#queue-wait').waitFor();
      assert.ok(held, 'pre-mutation read is still outstanding');
      const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/lobby/heartbeat' && response.status() === 503);
      await failed(held);
      await rejected;
      assert.equal(await page.locator('#notice').isVisible(), false, 'an old lobby generation cannot revive a disconnect warning');
      assert.equal(await page.locator('#queue-wait').isVisible(), true, 'newer queue state is preserved');
      console.log('PASS late pre-mutation failure preserves newer lobby state');
    } finally { await f.close(); }
  }
}

(async () => {
  try {
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/style.css': ['style.css', 'text/css'] };
      const file = files[pathname];
      if (!file) { res.writeHead(404); return res.end(); }
      try { res.writeHead(200, { 'Content-Type': file[1] }); res.end(await fs.readFile(path.join(root, 'public', file[0]))); }
      catch { res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = process.env.BROWSER === 'webkit'
      ? await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE || '/workspace/scratch/webkit-runtime/pw-run.sh', headless: true })
      : await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

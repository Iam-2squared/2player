'use strict';

// Actual client assets with synthetic local API replies. No real accounts or DB.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium, webkit} = require('playwright');
const physics = require('../public/physics.js');
const root = path.resolve(__dirname, '..');
const user = {id: '00000000-0000-4000-8000-000000000001', name: '自分'};
const other = {id: '00000000-0000-4000-8000-000000000002', name: '相手'};
const matchId = '00000000-0000-4000-8000-000000000003';
const wallet = {balance: 20000, walletRevision: '1'};
const json = (route, body, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
const iso = ms => new Date(ms).toISOString();
function match(extra = {}) {
  const now = Date.now();
  return {id: matchId, status: 'playing', mode: 'alternating', version: 2, round: 41, turn: 'host', stake: 100, escrow: 200,
    host: {memberId: user.id, name: user.name, formation: 0, offer: 100, ready: true, inputLocked: false},
    guest: {memberId: other.id, name: other.name, formation: 0, offer: 100, ready: true, inputLocked: false},
    scores: {host: 0, guest: 0}, state: physics.initialState(), updatedAt: iso(now),
    turnStartedAt: iso(now), turnExpiresAt: iso(now + 60000), serverNow: iso(now), ...extra};
}
let server, browser;
async function fixture(base, initial, getMatch = async () => {}, otherRoute = async () => {}) {
  const context = await browser.newContext({viewport: {width: 320, height: 740}, reducedMotion: 'reduce'});
  // A badly set phone clock must not determine whose turn it is.
  await context.addInitScript(() => { const realNow = Date.now; Date.now = () => realNow() + 5 * 86400000; });
  let current = initial, reads = 0, inputs = 0;
  const errors = [];
  await context.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/session') return json(route, {ok: true, user, wallet});
    if (pathname === '/api/logout') return json(route, {ok: true});
    if (pathname === '/api/match') {
      reads++;
      if (await getMatch(route, reads)) return;
      return json(route, {ok: true, wallet, match: current});
    }
    if (pathname === '/api/input') inputs++;
    if (await otherRoute(route, pathname)) return;
    return json(route, {ok: true, wallet, match: current, lobby: {online: [], incoming: [], outgoing: [], queue: null}});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('#game-view').waitFor({state: 'visible'});
  return {page, setMatch: value => {current = value;}, reads: () => reads, inputs: () => inputs,
    close: async () => {await context.close(); assert.deepEqual(errors, [], 'no uncaught client errors');}};
}
async function run(base) {
  {
    const now = Date.now();
    let held;
    const f = await fixture(base, match({turnStartedAt: iso(now - 56500), turnExpiresAt: iso(now + 3500), serverNow: iso(now)}), async route => {
      if (!held) {held = route; return true;}
    });
    const {page} = f;
    try {
      assert.equal(await page.locator('#turn-banner').getAttribute('data-team'), 'host');
      assert.equal(await page.locator('#turn-name').textContent(), user.name);
      assert.equal(await page.locator('#turn-action').textContent(), '攻撃中');
      assert.equal(await page.locator('#round-label').textContent(), '41手目');
      assert.equal(await page.locator('#score-host-team').evaluate(node => node.classList.contains('is-attacking')), true);
      await page.locator('#keyboard-controls').evaluate(node => {node.open = true;});
      assert.equal(await page.locator('#lock-input').isEnabled(), true, 'server clock, not the skewed phone clock, permits the turn');
      await page.waitForFunction(() => document.getElementById('turn-clock').textContent === '0:00');
      assert.equal(await page.locator('#lock-input').isDisabled(), true);
      assert.equal(await page.locator('#pitch').getAttribute('aria-disabled'), 'true');
      assert.equal(await page.locator('#round-label').textContent(), '41手目', 'the client never passes the turn itself');
      await page.waitForTimeout(1100);
      assert.equal(f.reads(), 1, 'expiry and ordinary polls share the outstanding match request');
      assert.equal(f.inputs(), 0, 'expiry never invents or submits a shot');
      const next = match({round: 42, turn: 'guest'});
      f.setMatch(next);
      await json(held, {ok: true, wallet, match: next});
      await page.waitForFunction(() => document.getElementById('turn-banner').dataset.team === 'guest');
      assert.equal(await page.locator('#turn-name').textContent(), other.name);
      assert.equal(await page.locator('#score-guest-team').evaluate(node => node.classList.contains('is-attacking')), true);
      assert.equal(await page.locator('#score-host-team').evaluate(node => node.classList.contains('is-attacking')), false);
      assert.equal(await page.locator('#round-label').textContent(), '42手目');
      assert.equal(await page.locator('#lock-input').isDisabled(), true);
      assert.ok(await page.locator('#turn-clock').textContent() !== '0:00');
      console.log('PASS server-clock expiry blocks shots, coalesces reads and waits for the authoritative handoff beyond40');
    } finally {await f.close();}
  }
  {
    const now = Date.now();
    const f = await fixture(base, match({turnStartedAt: iso(now + 1200), turnExpiresAt: iso(now + 61200), serverNow: iso(now)}));
    const {page} = f;
    try {
      await page.locator('#keyboard-controls').evaluate(node => {node.open = true;});
      assert.equal(await page.locator('#turn-clock').textContent(), '1:00');
      assert.equal(await page.locator('#turn-banner').getAttribute('data-team'), '');
      assert.equal(await page.locator('#lock-input').isDisabled(), true, 'playback grace is not a new shooting window');
      await page.waitForFunction(() => document.getElementById('turn-banner').dataset.team === 'host', undefined, {timeout: 1700});
      assert.equal(await page.locator('#lock-input').isEnabled(), true);
      assert.equal(f.reads(), 0, 'the future start boundary re-enables controls without waiting for another poll');
      assert.ok(['1:00', '0:59'].includes(await page.locator('#turn-clock').textContent()));
      console.log('PASS playback grace blocks shots then opens the server-defined turn without resetting its clock');
    } finally {await f.close();}
  }
  {
    const now = Date.now();
    const current = match({round: 45, turnStartedAt: iso(now - 54000), turnExpiresAt: iso(now + 6000), serverNow: iso(now)});
    const old = match({round: 44, turn: 'guest', updatedAt: iso(now - 1000), turnStartedAt: iso(now), turnExpiresAt: iso(now + 60000), serverNow: iso(now + 60000)});
    const f = await fixture(base, current, async route => {await json(route, {ok: true, wallet, match: old}); return true;});
    try {
      await f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/match');
      assert.equal(await f.page.locator('#round-label').textContent(), '45手目');
      assert.equal(await f.page.locator('#turn-banner').getAttribute('data-team'), 'host');
      const clock = await f.page.locator('#turn-clock').textContent();
      assert.ok(!['1:00', '0:59', '—'].includes(clock), 'an obsolete response cannot rewind the countdown');
      console.log('PASS obsolete match snapshots cannot reset the clock or attacker');
    } finally {await f.close();}
  }
  {
    let oldRead, freshHeartbeat;
    const current = match();
    const f = await fixture(base, current, async route => {
      if (!oldRead) oldRead = route;
      return true;
    }, async (route, pathname) => {
      if (pathname === '/api/lobby/heartbeat' && oldRead) {freshHeartbeat = route; return true;}
    });
    try {
      await f.page.locator('#keyboard-controls').evaluate(node => {node.open = true;});
      await f.page.waitForRequest(request => new URL(request.url()).pathname === '/api/match');
      await f.page.evaluate(() => window.dispatchEvent(new Event('offline')));
      assert.equal(await f.page.locator('#lock-input').isDisabled(), true);
      const heartbeat = f.page.waitForRequest(request => new URL(request.url()).pathname === '/api/lobby/heartbeat');
      await f.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await heartbeat;
      await json(oldRead, {ok: true, wallet, match: current});
      await f.page.waitForTimeout(20);
      assert.equal(await f.page.locator('#lock-input').isDisabled(), true, 'a pre-disconnection reply cannot re-confirm the turn clock');
      assert.ok(freshHeartbeat, 'a fresh post-reconnection heartbeat was requested');
      await json(freshHeartbeat, {ok: true, wallet, match: {...current, serverNow: iso(Date.now())}, lobby: {online: [], incoming: [], outgoing: [], queue: null}});
      await f.page.waitForFunction(() => !document.getElementById('lock-input').disabled);
      console.log('PASS reconnection requires a fresh server clock and ignores pre-disconnection replies');
    } finally {await f.close();}
  }
  {
    for (const code of ['STALE_INPUT', 'NOT_YOUR_TURN', 'TURN_PENDING', 'UNKNOWN_CONFLICT']) {
      const expected = code !== 'UNKNOWN_CONFLICT';
      let f;
      f = await fixture(base, match(), undefined, async (route, pathname) => {
        if (pathname !== '/api/input') return;
        if (expected) f.setMatch(match({round: 42, turn: 'guest'}));
        await json(route, {ok: false, error: {code, message: '確認が必要なエラー'}}, 409);
        return true;
      });
      try {
        await f.page.locator('#keyboard-controls').evaluate(node => {node.open = true;});
        const refreshed = f.page.waitForResponse(response => new URL(response.url()).pathname === '/api/match');
        await f.page.locator('#lock-input').click();
        await refreshed;
        assert.equal(f.inputs(), 1, 'a rejected shot is never replayed automatically');
        if (expected) {
          await f.page.waitForFunction(() => document.getElementById('turn-banner').dataset.team === 'guest');
          assert.equal(await f.page.locator('#notice').isVisible(), false, code + ' is an ordinary server handoff');
          assert.equal(await f.page.locator('#retry-notice').isVisible(), false, 'the obsolete input is retired');
          assert.equal(await f.page.locator('#round-label').textContent(), '42手目');
        } else {
          assert.equal(await f.page.locator('#notice').isVisible(), true, 'unknown operation errors remain visible');
          assert.equal(await f.page.locator('#notice-text').textContent(), '確認が必要なエラー');
        }
      } finally {await f.close();}
    }
    console.log('PASS only expected input timing conflicts refresh silently; unknown errors stay visible and shots never replay');
  }
  {
    const f = await fixture(base, match({turnStartedAt: undefined, turnExpiresAt: undefined, serverNow: undefined}));
    try {
      await f.page.locator('#keyboard-controls').evaluate(node => {node.open = true;});
      assert.equal(await f.page.locator('#turn-clock').textContent(), '—');
      assert.equal(await f.page.locator('#turn-banner').getAttribute('data-team'), '');
      assert.equal(await f.page.locator('#lock-input').isDisabled(), true, 'missing timing never invents a local turn window');
      console.log('PASS missing authoritative timing fails closed');
    } finally {await f.close();}
  }
}
(async () => {
  try {
    server = http.createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const file = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'],
        '/physics.js': ['physics.js', 'application/javascript'], '/style.css': ['style.css', 'text/css']}[pathname];
      if (!file) {res.writeHead(404); return res.end();}
      res.writeHead(200, {'Content-Type': file[1]});
      res.end(await fs.readFile(path.join(root, 'public', file[0])));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = process.env.BROWSER === 'webkit'
      ? await webkit.launch({headless: true, executablePath: process.env.WEBKIT_PATH || '/workspace/scratch/webkit-runtime/pw-run.sh'})
      : await chromium.launch({headless: true, executablePath: '/usr/bin/chromium', args: ['--no-sandbox']});
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});

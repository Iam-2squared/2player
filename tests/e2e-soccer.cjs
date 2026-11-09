'use strict';
// This suite creates and destroys its own loopback-only PostgreSQL database.
// Identity is a synthetic local KGS bridge. Never point it at hosted services.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client, Pool } = require('pg');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const targetRoot = process.env.TARGET_SOURCE_ROOT || path.resolve(root, '../Target-g-games');
const reportDir = path.join(root, 'test-results');
const dbName = 'two_player_soccer_' + process.pid + '_test';
const uuid = () => crypto.randomUUID();
const opaque = () => crypto.randomBytes(32).toString('base64url');
const secret = opaque(), identitySecret = opaque(), cookieSecret = opaque(), legacySecret = opaque();
const players = [
  { id: uuid(), name: '検証A', attendanceNumber: 1, pin: '4826' },
  { id: uuid(), name: '検証B', attendanceNumber: 2, pin: '6392' },
  { id: uuid(), name: '検証C', attendanceNumber: 3, pin: '7541' },
];
const tokens = new Map();
const results = [];
const processes = new Set();
const browserErrors = [];
const sensitive = [secret, identitySecret, cookieSecret, legacySecret];
let checks = 0, db, admin, identityServer, staticServer, appBase, identityBase, appLogs = '', databaseCreated = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function scoringState(seat) {
  // Isolated synthetic near-goal state: the actual API still runs the engine.
  const row = [60, 140, 220, 420, 500, 580];
  const state = { players: [...row.map(x => ({ x, y: 860 })), { x: 60, y: 760 }, { x: 320, y: 110 }, ...row.map(x => ({ x, y: 200 })), { x: 60, y: 300 }, { x: 500, y: 500 }], ball: { x: 320, y: 35 } };
  const rotate = point => ({ x: 640 - point.x, y: 960 - point.y });
  return seat === 'host' ? state : { players: [...state.players.slice(8).map(rotate), ...state.players.slice(0, 8).map(rotate)], ball: rotate(state.ball) };
}
const redact = value => sensitive.reduce((text, item) => text.split(item).join('[credential]'), String(value));
function eq(actual, expected, label) { checks++; assert.deepEqual(actual, expected, label); }
function ok(value, label) { checks++; assert.ok(value, label); }
async function scenario(name, run) {
  const started = Date.now();
  try { await run(); results.push({ name, status: 'passed', durationMs: Date.now() - started }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, status: 'failed', durationMs: Date.now() - started, error: redact(error.message).split('\n')[0] }); throw error; }
}
function localUrl(value, label) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), label + ' must use loopback');
  assert.ok(!url.search && !url.hash, label + ' must not contain parameters');
  return url;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'http://127.0.0.1:' + server.address().port;
}
async function freePort() {
  const server = http.createServer(); await listen(server); const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function jsonBody(req) {
  let body = ''; for await (const data of req) { body += data; if (body.length > 4096) throw Error('Oversized local identity request'); }
  return body ? JSON.parse(body) : {};
}
async function startIdentity() {
  identityServer = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + identitySecret) return send(403, { error: { code: 'FORBIDDEN' } });
      if (!req.url.startsWith('/api/integrations/two-player/')) return send(404, { error: { code: 'NOT_FOUND' } });
      const action = req.url.split('/').pop(), body = await jsonBody(req);
      if (action === 'login') {
        const player = players.find(item => item.attendanceNumber === body.attendanceNumber && item.pin === body.accountPin);
        if (!player) return send(401, { error: { code: 'INVALID_CREDENTIALS', message: '確認してください。' } });
        const token = opaque(); sensitive.push(token); tokens.set(token, player);
        return send(200, { member: { id: player.id, name: player.name }, token, expiresAt: new Date(Date.now() + 86400000).toISOString() });
      }
      const player = tokens.get(body.token);
      if (!player) return send(401, { error: { code: 'SESSION_EXPIRED', message: 'ログインしてください。' } });
      if (action === 'logout') { tokens.delete(body.token); return send(200, { ok: true }); }
      if (action === 'verify') return send(200, { member: { id: player.id, name: player.name }, expiresAt: new Date(Date.now() + 86400000).toISOString() });
      return send(404, { error: { code: 'NOT_FOUND' } });
    } catch { send(500, { error: { code: 'TEST_IDENTITY_ERROR' } }); }
  });
  identityBase = await listen(identityServer);
}
async function createDatabase() {
  eq(process.env.NODE_ENV, 'test', 'NODE_ENV=test is mandatory');
  const source = localUrl(process.env.DATABASE_URL || '', 'DATABASE_URL');
  const adminURL = new URL(source.href); adminURL.pathname = '/postgres';
  admin = new Client({ connectionString: adminURL.href }); await admin.connect();
  await admin.query('CREATE DATABASE "' + dbName + '"'); databaseCreated = true;
  source.pathname = '/' + dbName;
  db = new Pool({ connectionString: source.href, max: 24 });
  await db.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$");
  const migrations = path.join(targetRoot, 'supabase/migrations');
  const files = (await fs.readdir(migrations)).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
  ok(files.some(file => /two_player/.test(file)), 'Soccer migration must exist in the Target source');
  for (const file of files) {
    await db.query('BEGIN');
    const sql = await fs.readFile(path.join(migrations, file), 'utf8');
    try { await db.query(sql); await db.query('COMMIT'); }
    catch (error) { await db.query('ROLLBACK'); throw Error(file + ':' + (error.position ? sql.slice(0, Number(error.position)).split('\n').length : '?') + ': ' + error.message); }
  }
  await db.query("INSERT INTO target_private.two_player_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))", [secret]);
  await db.query("INSERT INTO target_private.server_credentials(singleton,key_hash) VALUES(true,encode(sha256(convert_to($1,'UTF8')),'hex'))", [legacySecret]);
  for (const player of players) {
    await db.query('INSERT INTO target_private.profiles(member_id,name,total_points,correct_count,answered_count) VALUES($1,$2,0,0,0)', [player.id, player.name]);
    if (player !== players[2]) for (let receipt = 0; receipt < 20; receipt++) {
      const quiz = uuid(), question = uuid(), choice = uuid(), requestId = uuid();
      await db.query("INSERT INTO target_private.quizzes(id,member_id,request_id,book,direction,from_number,to_number,questions,total,answered_count,correct_count,quiz_points,charged_bytes) VALUES($1,$2,$3,'target1900','english',1,1,$4::jsonb,1,1,1,100000,512)", [quiz, player.id, uuid(), JSON.stringify([{ id: question, number: 1, correctChoiceId: choice }])]);
      await db.query("INSERT INTO target_private.answers(quiz_id,member_id,question_id,choice_id,request_id,request_ids,response,award_points,charged_bytes) VALUES($1,$2,$3,$4,$5,ARRAY[$5::uuid],$6::jsonb,100000,512)", [quiz, player.id, question, choice, requestId, JSON.stringify({ correct: true, awardPoints: 100000 })]);
      await db.query('UPDATE target_private.profiles SET total_points=total_points+100000,correct_count=correct_count+1,answered_count=answered_count+1 WHERE member_id=$1', [player.id]);
    }
  }
  return source.href;
}
async function startApp(databaseUrl) {
  const port = await freePort(); appBase = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['scripts/dev.cjs'], { cwd: root, env: {
    ...process.env, NODE_ENV: 'test', VERCEL: '', PORT: String(port),
    TWO_PLAYER_DATABASE_URL: databaseUrl, TWO_PLAYER_RPC_SECRET: secret,
    TWO_PLAYER_COOKIE_SECRET: cookieSecret,
    TWO_PLAYER_KGS_INTEGRATION_SECRET: identitySecret, KGS_IDENTITY_URL: identityBase,
    TWO_PLAYER_ALLOWED_ORIGINS: appBase,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.add(child);
  child.stdout.on('data', chunk => { appLogs = (appLogs + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { appLogs = (appLogs + chunk).slice(-16000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error('Local soccer server exited: ' + redact(appLogs));
    try { if ((await fetch(appBase + '/api/session')).status === 200) return; } catch {}
    await delay(100);
  }
  throw Error('Local soccer server readiness timed out: ' + redact(appLogs));
}
async function request(context, route, input, expectedStatus = 200, headers = {}) {
  const response = await context.request.fetch(appBase + route, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Origin: appBase, 'Content-Type': 'application/json', ...headers },
    ...(input === undefined ? {} : { data: input }), timeout: 20000,
  });
  const value = await response.json();
  if (expectedStatus !== null) eq(response.status(), expectedStatus, route + ': ' + JSON.stringify(value.error || {}));
  ok(/no-store/.test(response.headers()['cache-control'] || ''), 'API responses exclude shared caches');
  const text = JSON.stringify(value);
  for (const credential of sensitive) ok(!text.includes(credential), 'API does not disclose server credentials or session tokens');
  return { status: response.status(), value };
}
async function api(context, route, input, status = 200, headers = {}) { return (await request(context, route, input, status, headers)).value; }
async function login(context, player) { return api(context, '/api/login', { attendanceNo: player.attendanceNumber, pin: player.pin }); }
async function rpc(action, input) { return (await db.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value', [secret, action, JSON.stringify(input)])).rows[0].value; }
async function shop(action, player, extra = {}) { return (await db.query('SELECT public.target_shop_rpc($1,$2,$3::jsonb) AS value', [legacySecret, action, JSON.stringify({ memberId: player.id, name: player.name, ...extra })])).rows[0].value; }
async function cleanup() {
  for (const child of processes) { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), delay(1500)]); if (child.exitCode === null) child.kill('SIGKILL'); } }
  if (identityServer) await new Promise(resolve => identityServer.close(resolve));
  if (staticServer) await new Promise(resolve => staticServer.close(resolve));
  if (db) await db.end();
  if (admin) {
    if (databaseCreated) {
      // Let closed client sockets disappear before dropping this fixture. A
      // forced drop can race an idle pool's shutdown and emit an uncaught
      // administrative-termination error after every assertion has passed.
      for (let attempt = 0; attempt < 20; attempt++) {
        const remaining = Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1', [dbName])).rows[0].n);
        if (!remaining) break;
        await delay(50);
      }
      await admin.query('DROP DATABASE IF EXISTS "' + dbName + '"');
    }
    await admin.end();
  }
}

async function startStatic() {
  staticServer = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const names = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/physics.js': ['physics.js', 'application/javascript'], '/styles.css': ['styles.css', 'text/css'], '/style.css': ['style.css', 'text/css'] };
    const item = names[pathname];
    if (!item) { res.writeHead(404); return res.end(); }
    try { const contents = await fs.readFile(path.join(root, 'public', item[0])); res.writeHead(200, { 'Content-Type': item[1], 'Cache-Control': 'no-store' }); res.end(contents); }
    catch { res.writeHead(404); res.end(); }
  });
  return listen(staticServer);
}
function browserFixture() {
  const P = require(path.join(root, 'public/physics.js'));
  let user = null, match = null, calls = [], delayed = null;
  const wallets = new Map(players.map(player => [player.id, { balance: 10000, totalIncome: 10000, spent: 0, walletRevision: 1, gameNet: 0, escrow: 0 }]));
  const response = () => ({ ok: true, user: user && { id: user.id, name: user.name }, wallet: user && wallets.get(user.id), ...(match ? { match: structuredClone(match) } : {}) });
  const newMatch = () => ({ id: uuid(), code: 'TEST42', status: 'waiting', mode: 'alternating', turn: 'host', stake: 100, escrow: 0, round: 1, version: 2, formations: [0, 0],
    host: { memberId: players[0].id, name: players[0].name, offer: 100, ready: false, inputLocked: false, formation: 0 },
    guest: { memberId: players[1].id, name: players[1].name, offer: 100, ready: true, inputLocked: false, formation: 0 },
    scores: { host: 0, guest: 0 }, state: P.initialState(), lastRound: null, winner: null, reason: null,
    expiresAt: new Date(Date.now() + 120000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return {
    get calls() { return calls; }, get match() { return match; },
    hostTurn() { match.turn = 'host'; match.round++; match.lastRound = null; match.state = P.initialState(); match.host.inputLocked = false; },
    lockHost() { match.host.inputLocked = true; },
    guestGame() { match = newMatch(); match.status = 'playing'; match.turn = 'guest'; match.host.ready = true; match.guest.ready = true; match.escrow = 200; },
    delayNextMatch() { delayed = {}; delayed.promise = new Promise(resolve => { delayed.resolve = resolve; }); delayed.entered = new Promise(resolve => { delayed.enter = resolve; }); return delayed; },
    async handle(route) {
      const req = route.request(), url = new URL(req.url());
      const input = req.method() === 'POST' ? req.postDataJSON() : undefined;
      calls.push({ path: url.pathname, input });
      const send = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(body) });
      if (url.pathname === '/api/login') {
        const player = players.find(item => item.attendanceNumber === Number(input.attendanceNo) && item.pin === input.pin);
        if (!player) return send(401, { ok: false, error: { code: 'INVALID_ACCOUNT_CREDENTIALS', message: '出席番号またはPINが違います。' } });
        user = player; match = null; return send(200, response());
      }
      if (url.pathname === '/api/logout') { user = null; match = null; return send(200, { ok: true }); }
      if (url.pathname === '/api/session') return send(200, response());
      if (!user) return send(401, { ok: false, error: { code: 'AUTHENTICATION_REQUIRED', message: 'ログインしてください。' } });
      if (url.pathname === '/api/rooms') {
        if (req.method() === 'POST') { match = newMatch(); return send(200, response()); }
        return send(200, { ...response(), rooms: match && match.status === 'waiting' ? [match] : [] });
      }
      if (url.pathname === '/api/match') {
        const value = response();
        if (delayed) { const held = delayed; delayed = null; held.enter(); await held.promise; }
        return send(200, value);
      }
      if (url.pathname === '/api/offer') { match.host.offer = input.stake; match.host.ready = false; return send(200, response()); }
      if (url.pathname === '/api/formation') {
        const role = user.id === match.host.memberId ? 'host' : 'guest';
        match[role].formation = input.formation; match.formations[role === 'host' ? 0 : 1] = input.formation;
        match.state = P.initialState(match.formations); match.host.ready = false; match.guest.ready = false;
        return send(200, response());
      }
      if (url.pathname === '/api/ready') {
        match.host.ready = true; match.status = 'playing'; match.escrow = 200;
        const money = wallets.get(user.id); money.balance = 9900; money.escrow = 100; money.walletRevision++;
        return send(200, response());
      }
      if (url.pathname === '/api/input') {
        const role = user.id === match.host.memberId ? 'host' : 'guest';
        if (match.turn !== role) return send(409, { ok: false, error: { code: 'NOT_YOUR_TURN', message: '相手の番です。' } });
        const inputs = { host: { angle: 0, power: 0, piece: 0 }, guest: { angle: 0, power: 0, piece: 0 } }; inputs[role] = { angle: input.angle, power: input.power, piece: input.piece };
        const result = P.simulate(match.state, [inputs.host, inputs.guest], match.formations);
        match.lastRound = { round: match.round, version: 2, inputs, goal: result.goal === 0 ? 'host' : result.goal === 1 ? 'guest' : null, frames: result.frames, state: result.state, resultHash: 'local-fixture-result' };
        match.state = result.state; match.round++; match.turn = role === 'host' ? 'guest' : 'host';
        return send(200, response());
      }
      if (url.pathname === '/api/cancel') { match.status = 'cancelled'; match.escrow = 0; return send(200, response()); }
      return send(404, { ok: false, error: { code: 'NOT_FOUND', message: '見つかりません。' } });
    },
  };
}
async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible', timeout: 10000 }); }
async function fillAttendance(page, number) {
  if (await page.locator('#attendance').evaluate(node => node.tagName === 'SELECT')) await page.selectOption('#attendance', String(number));
  else await page.fill('#attendance', String(number));
}
async function assertLayout(page, width, height, label) {
  await page.setViewportSize({ width, height });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' has no horizontal overflow');
  const canvas = page.locator('#pitch');
  if (await canvas.isVisible()) {
    const box = await canvas.boundingBox(); ok(box.width > 100 && box.x >= -1 && box.x + box.width <= width + 1, label + ' canvas fits the viewport');
    ok(await canvas.evaluate(node => { const context = node.getContext('2d'); return context.getImageData(0, 0, node.width, node.height).data.some((value, index) => index % 4 === 3 && value > 0); }), label + ' canvas actually paints');
  }
  await page.screenshot({ path: path.join(reportDir, label + '.png'), fullPage: true });
}
async function runBrowserScenarios(origin) {
  const parsedOrigin = new URL(origin).origin;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    let browser;
    await scenario(name + ' public assets: own-disc slingshot, pull distance, guest rotation and session isolation', async () => {
      const proxy = process.env.APP_ORIGIN && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
      browser = await engine.launch(name === 'chromium' ? { headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'], proxy } : { headless: true, executablePath: process.env.WEBKIT_PATH || undefined, proxy });
      try {
        const context = await browser.newContext({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
        const fixture = browserFixture();
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === parsedOrigin && url.pathname.startsWith('/api/')) return fixture.handle(route);
          if (url.origin !== parsedOrigin) return route.abort();
          return route.continue();
        });
        const page = await context.newPage(); page.on('pageerror', error => browserErrors.push({ browser: name, message: error.message }));
        await page.goto(origin, { waitUntil: 'networkidle' }); await visible(page, '#login-view');
        eq(await page.locator('#pin').getAttribute('maxlength'), '4');
        eq(await page.locator('#pin').getAttribute('inputmode'), 'numeric');
        await assertLayout(page, 320, 740, name + '-login-320');
        await fillAttendance(page, 1); await page.fill('#pin', players[0].pin); await page.click('#login-submit');
        await visible(page, '#lobby-view');
        await assertLayout(page, 320, 740, name + '-lobby-320');
        await assertLayout(page, 1280, 900, name + '-lobby-desktop');
        await page.setViewportSize({ width: 320, height: 740 });
        await page.fill('#create-stake', '100'); await page.click('#create-room');
        await visible(page, '#room-view'); await page.waitForFunction(() => document.getElementById('room-code').textContent.includes('TEST42'));
        eq(await page.locator('#formation-picker > button').count(), 3, 'The room offers three formation choices');
        for (const formation of [1, 2, 0]) {
          await page.click('#formation-' + formation);
          await page.waitForFunction(id => document.getElementById(id).getAttribute('aria-pressed') === 'true', 'formation-' + formation);
          eq(fixture.match.host.formation, formation, 'The formation choice reaches the local API contract');
        }
        await assertLayout(page, 320, 740, name + '-room-320');
        await page.click('#ready-button'); await visible(page, '#game-view');
        await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        await assertLayout(page, 320, 740, name + '-game-320');
        await assertLayout(page, 1280, 900, name + '-game-desktop');
        await assertLayout(page, 740, 320, name + '-game-landscape');
        await page.setViewportSize({ width: 320, height: 740 });
        await page.locator('#pitch').scrollIntoViewIfNeeded();
        await page.locator('#pitch').evaluate(node => node.addEventListener('pointerdown', event => { window.__qaPointerId = event.pointerId; }, { capture: true }));
        const shots = () => fixture.calls.filter(call => call.path === '/api/input');
        const screenPoint = async (x, y) => {
          const pitch = await page.locator('#pitch').boundingBox();
          return { x: pitch.x + x * pitch.width / 640, y: pitch.y + y * pitch.height / 960 };
        };
        const drag = async (x, y, dx, dy, cancelType) => {
          const start = await screenPoint(x, y);
          await page.mouse.move(start.x, start.y); await page.mouse.down();
          await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
          if (cancelType === 'return-center') await page.mouse.move(start.x, start.y, { steps: 3 });
          else if (cancelType) await page.locator('#pitch').dispatchEvent(cancelType, { pointerId: await page.evaluate(() => window.__qaPointerId), pointerType: 'mouse' });
          await page.mouse.up(); await page.waitForTimeout(60);
        };
        for (const [label, x, y] of [['empty pitch', 80, 480], ['white football', 320, 480], ['opponent disc', 500, 290]]) {
          await drag(x, y, 0, 30); eq(shots().length, 0, 'Dragging the ' + label + ' cannot submit a shot');
        }
        const ownPieces = require(path.join(root, 'public/physics.js')).initialState().players.slice(0, 8);
        for (let piece = 0; piece < ownPieces.length; piece++) {
          await drag(ownPieces[piece].x, ownPieces[piece].y, 0, 0);
          eq(await page.inputValue('#aim-piece'), String(piece), 'Each of the eight owned pieces can be selected');
          eq(shots().length, 0, 'Selecting an owned piece does not launch it');
        }
        await drag(140, 670, 0, 0); eq(shots().length, 0, 'A tap on the owned disc does not launch it');
        await drag(140, 670, 0, 35, 'pointercancel'); eq(shots().length, 0, 'Cancelling an owned-disc drag never submits a shot');
        await drag(140, 670, 0, 35, 'lostpointercapture'); eq(shots().length, 0, 'Losing pointer capture never submits a shot');
        await drag(140, 670, 0, 35, 'return-center'); eq(shots().length, 0, 'Returning the pull to the owned-disc center cancels the launch');
        await drag(140, 670, 0, 20);
        await page.waitForFunction(() => document.getElementById('lock-input').disabled);
        eq(shots().length, 1, 'One owned-disc release submits exactly one shot');
        eq(shots()[0].input.angle, 270, 'Pulling the host disc down launches it up, opposite the pull');
        eq(shots()[0].input.piece, 4, 'The selected owned piece is included in the version2 command'); eq(shots()[0].input.version, 2);
        ok(shots()[0].input.power > 0 && shots()[0].input.power < 100, 'A short pull has bounded intermediate power');
        const shortPower = shots()[0].input.power;
        await drag(140, 670, 0, 35); eq(shots().length, 1, 'The inactive player cannot launch another shot');
        await page.reload({ waitUntil: 'networkidle' }); await visible(page, '#game-view');
        ok(await page.locator('#lock-input').isDisabled(), 'Refresh restores the inactive turn');
        fixture.hostTurn(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        await page.locator('#pitch').scrollIntoViewIfNeeded();
        await drag(140, 670, 0, 38);
        await page.waitForFunction(() => document.getElementById('lock-input').disabled);
        eq(shots().length, 2); eq(shots()[1].input.angle, 270);
        ok(shots()[1].input.power > shortPower, 'Pulling farther increases launch power');
        fixture.hostTurn(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        fixture.lockHost(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => document.getElementById('lock-input').disabled);
        await drag(140, 670, 0, 35); eq(shots().length, 2, 'A locked current input cannot submit another shot while processing');
        fixture.hostTurn(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        const angleBefore = Number(await page.inputValue('#aim-angle'));
        await page.locator('#pitch').focus(); await page.keyboard.press('ArrowRight');
        ok(Number(await page.inputValue('#aim-angle')) !== angleBefore, 'The keyboard accessibility control adjusts aim');
        const held = fixture.delayNextMatch(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await Promise.race([held.entered, delay(5000).then(() => { throw Error('No synthetic delayed reconnect request'); })]);
        await page.click('#logout-button'); await visible(page, '#login-view');
        await fillAttendance(page, 2); await page.fill('#pin', players[1].pin); await page.click('#login-submit');
        await visible(page, '#lobby-view'); held.resolve(); await page.waitForTimeout(100);
        eq(await page.locator('#account-name').textContent(), players[1].name, 'Delayed responses from the old account cannot restore its identity');
        ok(await page.locator('#lobby-view').isVisible(), 'Delayed old-account match data cannot reopen its room');
        ok(await page.locator('#game-view').isHidden(), 'Account switches discard the old game');
        fixture.guestGame(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await visible(page, '#game-view'); await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        await page.locator('#pitch').scrollIntoViewIfNeeded();
        await drag(500, 290, 0, 25); eq(shots().length, 2, 'Guest cannot launch the opponent shown above them');
        await drag(140, 670, 0, 25);
        await page.waitForFunction(() => document.getElementById('lock-input').disabled);
        eq(shots().length, 3, 'Guest launches their own rotated disc once');
        eq(shots()[2].input.angle, 90, 'Guest screen-up launch maps to server-down after the 180 degree view rotation');
        eq(shots()[2].input.piece, 4, 'Guest piece selection remains relative to their own team');
        await page.screenshot({ path: path.join(reportDir, name + '-guest-slingshot-320.png'), fullPage: true });
        await context.close();
      } finally { if (browser) await browser.close(); }
    });
  }
  eq(browserErrors, [], 'Browsers have no uncaught application errors');
}

// Scenario definitions follow the API and migration contract below.
async function runApiScenarios(browser) {
  const contexts = await Promise.all(players.map(() => browser.newContext()));
  const [A, B, C] = contexts;
  await scenario('Two independent cookie sessions use synthetic KGS identity', async () => {
    eq((await api(A, '/api/session')).user, null);
    for (let index = 0; index < contexts.length; index++) {
      const value = await login(contexts[index], players[index]);
      eq(value.user.id, players[index].id);
    }
    const cookieA = (await A.cookies()).find(cookie => cookie.name.includes('two_player_session'));
    const cookieB = (await B.cookies()).find(cookie => cookie.name.includes('two_player_session'));
    ok(cookieA && cookieB && cookieA.value !== cookieB.value, 'Players have distinct session cookies');
    ok(cookieA.httpOnly && cookieB.httpOnly, 'Identity cookies are inaccessible to scripts');
    eq((await api(A, '/api/session')).user.id, players[0].id);
    eq((await api(B, '/api/session')).user.id, players[1].id);
    await api(A, '/api/rooms', { requestId: uuid(), stake: 100, memberId: players[1].id }, 400);
    await api(A, '/api/rooms', { requestId: uuid(), stake: 100 }, 403, { Origin: 'https://untrusted.invalid' });
  });
  const wallet = async context => (await api(context, '/api/session')).wallet;
  const get = async (context, match) => (await api(context, '/api/match?code=' + match.code)).match;
  const cancel = async (context, match) => {
    let result = (await api(context, '/api/cancel', { requestId: uuid(), matchId: match.id })).match;
    if (result.status === 'playing') {
      eq(result.escrow, match.escrow, 'One cancellation request keeps the funded stake reserved');
      result = (await api(context === A ? B : A, '/api/cancel', { requestId: uuid(), matchId: match.id })).match;
    }
    return result;
  };
  const make = async (guest = B, stake = 100) => {
    const created = (await api(A, '/api/rooms', { requestId: uuid(), stake })).match;
    ok(created.id && created.code, 'Created room has a server identity and code');
    return (await api(guest, '/api/rooms/join', { requestId: uuid(), code: created.code })).match;
  };
  const fund = async (guest = B, stake = 100, formations) => {
    let match = await make(guest, stake);
    if (formations) {
      await api(A, '/api/formation', { requestId: uuid(), matchId: match.id, formation: formations[0] });
      await api(guest, '/api/formation', { requestId: uuid(), matchId: match.id, formation: formations[1] });
    }
    await api(guest, '/api/offer', { requestId: uuid(), matchId: match.id, stake });
    await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true });
    match = (await api(guest, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true })).match;
    eq(match.status, 'playing'); eq(match.escrow, stake * 2);
    return match;
  };
  const fire = async (match, input = { angle: 0, power: 0, piece: 0 }, overrides = {}) => {
    const actor = match.turn === 'host' ? A : B;
    return (await api(actor, '/api/input', { requestId: uuid(), matchId: match.id, round: match.round, version: 2, piece: 0, ...input, ...overrides })).match;
  };
  const balances = async () => Promise.all([wallet(A), wallet(B)]);
  const conserved = async (before, match) => {
    const after = await balances();
    eq(after.reduce((sum, item) => sum + item.balance, 0) + match.escrow,
      before.reduce((sum, item) => sum + item.balance, 0), 'Spendable money plus match escrow is conserved');
    return after;
  };
  await scenario('All nine formation pairs initialize sixteen pieces and changing formation clears both confirmations', async () => {
    const P = require(path.join(root, 'public/physics.js'));
    for (let host = 0; host < 3; host++) for (let guest = 0; guest < 3; guest++) {
      let match = await make(B, 100);
      await api(A, '/api/formation', { requestId: uuid(), matchId: match.id, formation: host });
      match = (await api(B, '/api/formation', { requestId: uuid(), matchId: match.id, formation: guest })).match;
      eq(match.version, 2); eq(match.formations, [host, guest]); eq(match.state.players.length, 16);
      eq(match.state, P.initialState([host, guest]), 'API/database initialization matches the engine for each formation pair');
      await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true });
      match = (await api(B, '/api/formation', { requestId: uuid(), matchId: match.id, formation: (guest + 1) % 3 })).match;
      eq([match.host.ready, match.guest.ready], [false, false], 'Changing formation invalidates both confirmations');
      await api(B, '/api/formation', { requestId: uuid(), matchId: match.id, formation: guest });
      await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true });
      match = (await api(B, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true })).match;
      await api(A, '/api/formation', { requestId: uuid(), matchId: match.id, formation: (host + 1) % 3 }, 409);
      await db.query('UPDATE target_private.two_player_matches SET state=$2::jsonb WHERE id=$1', [match.id, JSON.stringify(scoringState(match.turn))]);
      match = await fire(match, { angle: match.turn === 'host' ? 270 : 90, power: 100, piece: 7 });
      eq(match.lastRound.goal, match.turn === 'host' ? 'guest' : 'host');
      eq(match.state, P.initialState([host, guest]), 'A scored goal restores the selected formation pair');
      await cancel(A, match);
    }
    // This case deliberately exercises many independent rooms in one second.
    await db.query('UPDATE target_private.two_player_rates SET minute_bucket=minute_bucket-1');
  });
  await scenario('Different stake offers never fund; both explicit confirmations reserve each stake once', async () => {
    const before = await balances(); let match = await make();
    await api(B, '/api/offer', { requestId: uuid(), matchId: match.id, stake: 200 });
    await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true }, 409);
    match = await get(A, match); eq(match.escrow, 0);
    eq((await balances()).map(item => item.balance), before.map(item => item.balance));
    await api(A, '/api/offer', { requestId: uuid(), matchId: match.id, stake: 200 });
    await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true });
    eq((await get(A, match)).escrow, 0, 'One ready player cannot reserve anyone’s money');
    const ready = { requestId: uuid(), matchId: match.id, ready: true };
    const raced = await Promise.all(Array.from({ length: 8 }, () => api(B, '/api/ready', ready)));
    match = raced[0].match; eq(match.status, 'playing'); eq(match.escrow, 400);
    for (const value of raced) eq(value.match.id, match.id);
    const after = await conserved(before, match);
    eq(after.map(item => item.balance), before.map(item => item.balance - 200));
    const refund = await cancel(A, match); eq(refund.status, 'cancelled'); eq(refund.escrow, 0);
    eq((await balances()).map(item => item.balance), before.map(item => item.balance));
    await api(A, '/api/cancel', { requestId: uuid(), matchId: match.id });
    eq((await balances()).map(item => item.balance), before.map(item => item.balance), 'Cancellation refunds once');
  });
  await scenario('Insufficient balance rejects funding atomically for both players', async () => {
    const beforeA = await wallet(A), beforeC = await wallet(C); const match = await make(C);
    await api(C, '/api/offer', { requestId: uuid(), matchId: match.id, stake: 100 });
    await api(A, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true });
    await api(C, '/api/ready', { requestId: uuid(), matchId: match.id, ready: true }, 409);
    eq((await wallet(A)).balance, beforeA.balance); eq((await wallet(C)).balance, beforeC.balance);
    eq((await get(A, match)).escrow, 0); await cancel(A, match);
  });
  await scenario('Alternating turns reject the other player, retry shots once, and reject stale or changed input', async () => {
    const before = await balances(); let match = await fund();
    const firstTurn = match.turn, actor = firstTurn === 'host' ? A : B, other = actor === A ? B : A;
    const command = { requestId: uuid(), matchId: match.id, round: match.round, version: 2, angle: 180, power: 35, piece: 4 };
    const expectedInputs = firstTurn === 'host' ? [{ angle: 180, power: 35, piece: 4 }, { angle: 0, power: 0, piece: 0 }] : [{ angle: 0, power: 0, piece: 0 }, { angle: 180, power: 35, piece: 4 }];
    const expectedPhysics = require(path.join(root, 'public/physics.js')).simulate(match.state, expectedInputs, match.formations);
    for (const piece of [-1, 8, 15, 1.5, null]) await api(actor, '/api/input', { ...command, requestId: uuid(), piece }, 400);
    await api(actor, '/api/input', { ...command, requestId: uuid(), version: 1 }, 400);
    await api(other, '/api/input', { ...command, requestId: uuid() }, 409);
    eq((await get(A, match)).round, match.round, 'Inactive input cannot advance the match');
    const raced = await Promise.all(Array.from({ length: 12 }, async (_, index) => { await delay(index % 3 * 7); return api(actor, '/api/input', command); }));
    match = await get(A, match);
    eq(match.round, command.round + 1, 'Concurrent retries advance one move');
    eq(match.turn, firstTurn === 'host' ? 'guest' : 'host', 'The turn changes after motion resolves');
    ok(match.lastRound, 'Resolved shot has a server replay');
    const accepted = match.lastRound;
    eq(accepted.state, expectedPhysics.state, 'Request arrival and retries cannot change the fixed simulation state');
    eq(accepted.frames, expectedPhysics.frames, 'The browser replay uses the exact server physics frames');
    for (const value of raced) if (value.match.lastRound) eq(value.match.lastRound, accepted, 'Concurrent retries keep the same physics result');
    const passive = firstTurn === 'host' ? accepted.inputs.guest : accepted.inputs.host;
    eq(passive.power, 0, 'The inactive disc receives no launch impulse');
    await api(actor, '/api/input', { ...command, power: 100 }, 409);
    await api(actor, '/api/input', { ...command, requestId: uuid() }, 409);
    const replay = (await api(actor, '/api/input', command)).match;
    eq(replay.lastRound, accepted, 'A delayed duplicate preserves its original shot');
    const refreshed = await get(other, match); eq(refreshed.state, match.state); eq(refreshed.turn, match.turn);
    const financialSnapshot = (await db.query('SELECT target_private.wallet_finance_snapshot() AS value')).rows[0].value;
    await assert.rejects(db.query('SELECT target_private.restore_wallet_finances($1,$2,$3::jsonb,$4)', ['soccer-funded-' + process.pid, new Date(Date.now() - 3600000), JSON.stringify(financialSnapshot), 'a'.repeat(64)]), error => error.code === '23514');
    checks++;
    await conserved(before, match); match = await cancel(A, match); await conserved(before, match);
  });
  await scenario('A server-simulated goal pays the winner once and existing gacha wallets agree', async () => {
    const before = await balances(); let match = await fund(B, 300, [1, 2]);
    let lastTurn;
    // Seed only the disposable fixture state; clients never supply results.
    for (let shot = 0; shot < 5 && match.status === 'playing'; shot++) {
      lastTurn = match.turn;
      await db.query('UPDATE target_private.two_player_matches SET state=$2::jsonb WHERE id=$1', [match.id, JSON.stringify(scoringState(lastTurn))]);
      match = await fire(match, { angle: lastTurn === 'host' ? 270 : 90, power: 100, piece: 7 });
      eq(match.state, require(path.join(root, 'public/physics.js')).initialState([1, 2]), 'Each goal retains both formation choices');
    }
    eq(match.status, 'finished', 'The first player to three goals completes this match'); eq(match.escrow, 0);
    const after = await conserved(before, match);
    const winnerIndex = lastTurn === 'host' ? 0 : 1;
    eq(after[winnerIndex].balance, before[winnerIndex].balance + 300);
    eq(after[1 - winnerIndex].balance, before[1 - winnerIndex].balance - 300);
    eq(after.map(item => item.spent), before.map(item => item.spent), 'A soccer loss does not rewrite purchase receipts');
    await Promise.all(Array.from({ length: 8 }, () => get(A, match)));
    eq((await balances()).map(item => item.balance), after.map(item => item.balance), 'Concurrent resolution reads cannot settle again');
    for (let index = 0; index < 2; index++) {
      const source = await shop('wallet', players[index]);
      eq(source.balance, after[index].balance, 'Target wallet includes the soccer net');
      eq(source.totalIncome, after[index].totalIncome); eq(source.spent, after[index].spent);
    }
    const receiptsBefore = (await db.query('SELECT count(*)::int AS n FROM target_private.item_draws WHERE member_id=$1', [players[0].id])).rows[0].n;
    const draw = await shop('draw', players[0], { requestId: uuid(), expectedPrice: 100000, expectedCatalogVersion: 3, itemType: 'frame' });
    ok(!draw.error, 'Existing frame gacha still accepts the soccer-adjusted balance');
    const receiptsAfter = (await db.query('SELECT count(*)::int AS n FROM target_private.item_draws WHERE member_id=$1', [players[0].id])).rows[0].n;
    eq(receiptsAfter, receiptsBefore + 1, 'A gacha draw adds one existing receipt');
    const fresh = await wallet(A), source = await shop('wallet', players[0]);
    eq(fresh.balance, source.balance); eq(fresh.spent, source.spent);
    const linked = (await db.query('SELECT public.target_calculus_rpc($1,$2,$3::jsonb) AS value', [legacySecret, 'link', JSON.stringify({ memberId: players[0].id, name: players[0].name, userId: 1, totalPoints: 1, known: true, deleted: false })])).rows[0].value;
    ok(!linked.error, 'An existing source income link remains available after PvP settlement');
    const linkedWallet = await wallet(A); eq(linkedWallet.balance, fresh.balance + 10000);
    const mismatches = (await db.query('SELECT count(*)::integer AS n FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id) WHERE p.member_id=ANY($1::uuid[]) AND (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)', [[players[0].id, players[1].id]])).rows[0].n;
    eq(mismatches, 0, 'The authoritative finance projection includes soccer, source income and the gacha receipt');
  });
  await scenario('Forty motionless alternating turns draw and refund both players exactly once', async () => {
    const before = await balances(); let match = await fund(B, 100);
    for (let turn = 0; turn < 40 && match.status === 'playing'; turn++) match = await fire(match);
    eq(match.status, 'finished'); eq(match.escrow, 0);
    eq((await balances()).map(item => item.balance), before.map(item => item.balance));
    for (let repeat = 0; repeat < 3; repeat++) await get(A, match);
    eq((await balances()).map(item => item.balance), before.map(item => item.balance), 'Draw refund is idempotent');
  });
  await scenario('Expired funded matches refund on reconnect and cancellation cannot pay again', async () => {
    const before = await balances(); let match = await fund(B, 100);
    await db.query("UPDATE target_private.two_player_matches SET expires_at=now()-interval '1 minute' WHERE id=$1", [match.id]);
    match = await get(B, match); eq(match.status, 'cancelled'); eq(match.escrow, 0);
    eq((await balances()).map(item => item.balance), before.map(item => item.balance));
    await cancel(A, match); eq((await balances()).map(item => item.balance), before.map(item => item.balance));
  });
  await scenario('Accepted moves reserve bounded result capacity and a full database still permits refunds', async () => {
    let match = await fund(B, 100);
    const actor = match.turn === 'host' ? players[0] : players[1];
    const logicalBytes = async () => Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
    const initialBytes = await logicalBytes();
    const input = { memberId: actor.id, name: actor.name, requestId: uuid(), matchId: match.id, round: match.round, version: 2, angle: 0, power: 0, piece: 0 };
    const locked = await rpc('input', input); ok(locked._processing, 'A raw server RPC returns a private processing claim');
    const acceptedBytes = await logicalBytes(); eq(acceptedBytes - initialBytes, 393216 + 512, 'A shot reserves its bounded result and idempotency receipt before acceptance');
    let claim = locked._processing;
    const P = require(path.join(root, 'public/physics.js'));
    const outcome = P.simulate(claim.state, [claim.inputs.host, claim.inputs.guest], claim.formations);
    const resolveInput = { memberId: actor.id, name: actor.name, requestId: uuid(), matchId: match.id, round: match.round, version: 2, claimToken: claim.claimToken, state: outcome.state, frames: outcome.frames, goal: null };
    await db.query("UPDATE target_private.two_player_moves SET claim_until=now()-interval '1 second' WHERE match_id=$1 AND round=$2", [match.id, match.round]);
    eq((await rpc('resolve', resolveInput)).error.code, 'STALE_CLAIM', 'An expired processing lease cannot publish a result');
    claim = (await rpc('state', { memberId: actor.id, name: actor.name, matchId: match.id }))._processing;
    ok(claim && claim.claimToken !== resolveInput.claimToken, 'Reconnect claims abandoned immutable input with a new lease');
    resolveInput.claimToken = claim.claimToken;
    const resolutions = await Promise.all(Array.from({ length: 8 }, () => rpc('resolve', resolveInput)));
    ok(resolutions.every(value => value.ok), 'Concurrent same-result resolutions succeed');
    const move = (await db.query('SELECT charged_bytes FROM target_private.two_player_moves WHERE match_id=$1 AND round=$2', [match.id, input.round])).rows[0];
    eq((await logicalBytes()) - acceptedBytes, move.charged_bytes - 393216, 'Resolution releases unused reserved result bytes without another receipt charge');
    eq((await db.query('SELECT count(*)::int AS n FROM target_private.two_player_moves WHERE match_id=$1', [match.id])).rows[0].n, 1);
    match = await get(A, match);
    const before = await balances(), priorCapacity = await logicalBytes();
    await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
    try { match = await cancel(A, match); eq(match.status, 'cancelled'); eq(match.escrow, 0); }
    finally { await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton', [priorCapacity]); }
    eq((await balances()).map(item => item.balance), before.map(item => item.balance + 100), 'Refunds remain possible at the storage cap');
  });
  await scenario('A historical wallet cutoff inside a completed escrow interval cannot manufacture money', async () => {
    const cutoff = (await db.query("SELECT r.created_at+(s.created_at-r.created_at)/2 AS cutoff FROM target_private.two_player_wallet_events r JOIN target_private.two_player_wallet_events s ON s.match_id=r.match_id AND s.member_id=r.member_id AND s.phase='settle' WHERE r.phase='reserve' AND s.kind='payout' ORDER BY r.created_at LIMIT 1")).rows[0]?.cutoff;
    ok(cutoff, 'The real completed winning match supplies an escrow cutoff fixture');
    const before = await balances(), financialSnapshot = (await db.query('SELECT target_private.wallet_finance_snapshot() AS value')).rows[0].value;
    await assert.rejects(db.query('SELECT target_private.restore_wallet_finances($1,$2,$3::jsonb,$4)', ['soccer-between-' + process.pid, cutoff, JSON.stringify(financialSnapshot), 'b'.repeat(64)]), error => error.code === '23514');
    checks++;
    eq((await balances()).map(item => item.balance), before.map(item => item.balance));
  });
  await scenario('Money receipts and resolved shots are append-only and private', async () => {
    for (const sql of [
      'UPDATE target_private.two_player_wallet_events SET delta=delta',
      'DELETE FROM target_private.two_player_wallet_events',
      'UPDATE target_private.two_player_moves SET power=power WHERE resolved_at IS NOT NULL',
      'DELETE FROM target_private.two_player_requests',
    ]) { await assert.rejects(db.query(sql), error => error.code === '42501'); checks++; }
    const invariants = (await db.query("SELECT count(*) FILTER(WHERE reserves<>2 OR settled<>2 OR money<>0)::int AS n FROM (SELECT match_id,count(*) FILTER(WHERE phase='reserve') AS reserves,count(*) FILTER(WHERE phase='settle') AS settled,sum(delta) AS money FROM target_private.two_player_wallet_events GROUP BY match_id) e")).rows[0].n;
    eq(invariants, 0, 'Every funded closed match has two reserves, two settlements and zero created money');
    const privileges = (await db.query("SELECT has_table_privilege('anon','target_private.two_player_wallet_events','SELECT') AS public_rows,has_function_privilege('anon','target_private.two_player_settle(uuid,text,text,text)','EXECUTE') AS public_settle,relrowsecurity AS rls FROM pg_class WHERE oid='target_private.two_player_wallet_events'::regclass")).rows[0];
    eq(privileges, { public_rows: false, public_settle: false, rls: true });
  });
  await scenario('The 500-profile cap rejects allocation while existing wallets remain usable', async () => {
    const client = await db.connect(); await client.query('BEGIN');
    try {
      const count = Number((await client.query('SELECT count(*) AS n FROM target_private.profiles')).rows[0].n);
      await client.query("INSERT INTO target_private.profiles(member_id,name) SELECT gen_random_uuid(),'枠の検証' FROM generate_series(1,$1)", [500 - count]);
      const newcomer = (await client.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value', [secret, 'wallet', JSON.stringify({ memberId: uuid(), name: '新しい検証' })])).rows[0].value;
      eq(newcomer.error.status, 507); eq(Number((await client.query('SELECT count(*) AS n FROM target_private.profiles')).rows[0].n), 500);
      const existing = (await client.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS value', [secret, 'wallet', JSON.stringify({ memberId: players[0].id, name: players[0].name })])).rows[0].value;
      ok(existing.ok, 'An existing player can still read their money at the profile cap');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  await scenario('Read-only financial and access postflight reconciles the entire fixture', async () => {
    const queries = await db.query(await fs.readFile(path.join(targetRoot, 'supabase/tests/two_player_soccer_verify.sql'), 'utf8'));
    ok(queries.some(result => result.rows?.some(row => row.result === 'two_player_soccer_postflight_passed')), 'The reviewed read-only soccer postflight passes');
  });
  await scenario('Logout invalidates only its own cookie and identity session', async () => {
    await api(A, '/api/logout', {}); eq((await api(A, '/api/session')).user, null);
    eq((await api(B, '/api/session')).user.id, players[1].id);
    await api(A, '/api/rooms', undefined, 401);
  });
  for (const context of contexts) await context.close();
}

async function main() {
  let browser, failure;
  await fs.mkdir(reportDir, { recursive: true });
  try {
    if (process.env.SOCCER_BROWSER_ONLY !== '1') {
      const databaseUrl = await createDatabase();
      await startIdentity(); await startApp(databaseUrl);
      browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      await runApiScenarios(browser); await browser.close(); browser = null;
    }
    if (process.env.SOCCER_API_ONLY !== '1') await runBrowserScenarios(process.env.APP_ORIGIN || appBase || await startStatic());
  } catch (error) { failure = error; }
  finally {
    if (browser) await browser.close();
    await cleanup();
    await fs.writeFile(path.join(reportDir, process.env.APP_ORIGIN ? 'soccer-public-qa.json' : process.env.SOCCER_BROWSER_ONLY === '1' ? 'soccer-browser-qa.json' : process.env.SOCCER_API_ONLY === '1' ? 'soccer-v2-api-qa.json' : 'soccer-qa.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, results, browserErrors, hostedWrites: false, syntheticIdentity: true, protocolVersion: 2, apiMode: process.env.SOCCER_BROWSER_ONLY === '1' ? 'locally-fulfilled' : 'actual-local-and-locally-fulfilled-browser' }, null, 2) + '\n');
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ soccerIntegration: 'passed', checks, scenarios: results.length, hostedWrites: false }));
}
main().catch(error => { console.error('Soccer QA failed: ' + redact(error.stack || error)); process.exitCode = 1; });

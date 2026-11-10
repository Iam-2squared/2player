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
const dbName = 'two_player_matchmaking_' + process.pid + '_test';
const uuid = () => crypto.randomUUID();
const opaque = () => crypto.randomBytes(32).toString('base64url');
const secret = opaque(), identitySecret = opaque(), cookieSecret = opaque(), legacySecret = opaque();
const players = ['A','B','C','D','E','F'].map((name,index)=>({id:uuid(),name:'検証'+name,attendanceNumber:index+1,pin:String(4826+index)}));
const tokens = new Map();
const results = [];
const processes = new Set();
const browserErrors = [];
const databaseErrors = [];
const sensitive = [secret, identitySecret, cookieSecret, legacySecret];
let checks = 0, db, admin, identityServer, staticServer, appBase, identityBase, appLogs = '', databaseCreated = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  db.on('error', error => databaseErrors.push({code:error.code || error.name}));
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
    for (let receipt = 0; receipt < 2; receipt++) {
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
      let clients=1;
      for(let attempt=0;attempt<100&&clients;attempt++) {
        clients=Number((await admin.query("SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",[dbName])).rows[0].n);
        if(clients)await delay(20);
      }
      if(clients)throw Error('Disposable database connections did not close before cleanup');
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

const paths = {
  lobby: '/api/lobby', heartbeat: '/api/lobby/heartbeat', leave: '/api/lobby/leave',
  challenge: '/api/challenge', accept: '/api/challenge/accept', decline: '/api/challenge/decline',
  withdraw: '/api/challenge/cancel', queue: '/api/queue', unqueue: '/api/queue/cancel',
};
const choices = (stake = 100) => ({ stake });
const mutation = body => ({ requestId: uuid(), ...body });
const playerDTO = player => ({ memberId: player.id, name: player.name });
const sameMatch = (match, a, b) => match && new Set([match.host?.memberId, match.guest?.memberId]).has(a.id) && new Set([match.host?.memberId, match.guest?.memberId]).has(b.id);
function sessionMatch(value) { return value?.match && ['waiting', 'playing'].includes(value.match.status) ? value.match : null; }
async function pulse(context) { return api(context, paths.heartbeat, {}); }
async function lobby(context) { return api(context, paths.lobby); }
async function queue(context, stake = 100) { return api(context, paths.queue, mutation(choices(stake))); }
async function challenge(context, player, stake = 100) { return api(context, paths.challenge, mutation({ targetId: player.id, ...choices(stake) })); }
function sharedFormation(match) {
  const formation = match?.host?.formation;
  ok(Number.isInteger(formation) && formation >= 0 && formation <= 2, 'The server chooses one of the three formations');
  eq(match.guest?.formation, formation, 'Both players receive the same formation');
  eq(match.formations, [formation, formation]);
  return formation;
}
async function money(context) { return (await api(context, '/api/session')).wallet; }
async function cancelMatch(context, match) { return api(context, '/api/cancel', mutation({ matchId: match.id })); }
async function rawLobby(action, player, sessionId, extra = {}) { return (await db.query('SELECT public.two_player_lobby_rpc($1,$2,$3::jsonb) AS value', [secret, action, JSON.stringify({ ...playerDTO(player), sessionId, ...extra })])).rows[0].value; }
async function agePresence(player) {
  await db.query("UPDATE target_private.two_player_lobby_presence SET seen_at=clock_timestamp()-interval '61 seconds' WHERE member_id=$1", [player.id]);
}
async function clearParticipants(contexts) {
  for (let pass = 0; pass < 2; pass++) for (const context of contexts) {
    const value = await lobby(context);
    if (value.lobby?.queue) await api(context, paths.unqueue, mutation({}));
    for (const item of value.lobby?.outgoing || []) await request(context, paths.withdraw, mutation({ invitationId: item.id }), null);
    for (const item of value.lobby?.incoming || []) await request(context, paths.decline, mutation({ invitationId: item.id }), null);
    if (sessionMatch(value)) await cancelMatch(context, value.match);
  }
}
async function actualScenarios(browser) {
  const contexts = await Promise.all(players.map(() => browser.newContext()));
  const [A, B, C, D, E, F] = contexts;
  for (let i = 0; i < contexts.length; i++) await login(contexts[i], players[i]);
  const baseline = await Promise.all(contexts.map(money));
  await scenario('Authenticated sessions appear online without exposing actor tokens or oneself', async () => {
    for (const context of contexts) await pulse(context);
    for (let i = 0; i < contexts.length; i++) {
      const value = await lobby(contexts[i]);
      eq(value.lobby.online.length, players.length - 1);
      eq(new Set(value.lobby.online.map(item => item.memberId)), new Set(players.filter((_, n) => n !== i).map(item => item.id)));
      ok(value.lobby.online.every(item => Object.keys(item).every(key => ['memberId', 'name', 'busy'].includes(key))));
      eq(value.lobby.queue, null); eq(value.lobby.incoming, []); eq(value.lobby.outgoing, []);
    }
    const guest = await browser.newContext();
    try { await api(guest, paths.lobby, undefined, 401); await api(guest, paths.heartbeat, {}, 401); }
    finally { await guest.close(); }
    const wrongOrigin = await request(A, paths.queue, mutation(choices()), 403, { Origin: 'https://foreign.invalid' });
    eq(wrongOrigin.value.error.code, 'ORIGIN_REJECTED');
    for (const forged of [{ memberId: players[1].id }, { sessionId: 'f'.repeat(64) }, { winner: 'host' }]) {
      await api(A, paths.queue, { ...mutation(choices()), ...forged }, 400);
    }
    eq((await lobby(A)).lobby.queue, null);
    const rewrittenLobby = await api(A, '/api/index?route=lobby&path=lobby');
    eq(rewrittenLobby.lobby.online.length, players.length - 1, 'The authenticated Vercel wildcard capture reaches the real lobby RPC');
    const rewrittenHeartbeat = await api(A, '/api/index?route=lobby%2Fheartbeat&path=lobby%2Fheartbeat', {});
    eq(rewrittenHeartbeat.lobby.online.length, players.length - 1, 'The authenticated rewritten heartbeat reaches the real lobby RPC');
  });
  await scenario('The real browser recovers from one failed lobby poll through the actual API and database', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let failedPolls = 0;
    const failOnePoll = async route => {
      if (route.request().method() === 'GET' && failedPolls === 0) {
        failedPolls++;
        return route.abort('failed');
      }
      return route.continue();
    };
    const responseFor = pathname => response => new URL(response.url()).pathname === pathname && response.status() === 200;
    try {
      await page.goto(appBase);
      await visible(page, '#login-view');
      await page.selectOption('#attendance', String(players[0].attendanceNumber));
      await page.fill('#pin', players[0].pin);
      const heartbeat = page.waitForResponse(responseFor(paths.heartbeat));
      await page.click('#login-submit');
      await heartbeat;
      await visible(page, '[data-challenge-user="' + players[1].id + '"]');
      eq(await page.locator('[data-self-user]').count(), 1, 'The actual login lists the current member once');
      eq(await page.locator('[data-self-user] strong').textContent(), players[0].name);
      eq(await page.locator('#online-count').textContent(), String(players.length));
      const walletText = await page.locator('#wallet-balance').textContent();
      eq(walletText, new Intl.NumberFormat('ja-JP').format(baseline[0].balance), 'The displayed wallet came from the actual shared database');
      eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_lobby_presence WHERE member_id=$1 AND revoked_at IS NULL', [players[0].id])).rows[0].n, 2, 'The browser heartbeat created its own presence session');

      // Only this failed read is intercepted. Login, heartbeat, recovery reads,
      // and logout all cross the real local router, identity bridge and SQL RPC.
      await context.route('**/api/lobby', failOnePoll);
      await page.waitForFunction(() => !document.getElementById('notice').hidden && document.getElementById('notice-text').textContent === '再接続中…');
      eq(failedPolls, 1, 'Exactly one automatic lobby read failed');
      eq(await page.locator('[data-self-user]').count(), 1, 'A failed read keeps the current member listed');
      eq(await page.locator('#wallet-balance').textContent(), walletText, 'A failed read preserves the last verified wallet');
      const recovered = page.waitForResponse(responseFor(paths.lobby));
      await context.unroute('**/api/lobby', failOnePoll);
      await recovered;
      await page.waitForFunction(() => document.getElementById('notice').hidden);
      eq(await page.locator('[data-self-user]').count(), 1, 'The recovered roster still lists the current member once');
      eq(await page.locator('[data-challenge-user="' + players[1].id + '"]').count(), 1, 'Recovery receives the real online opponent');
      eq(await page.locator('#wallet-balance').textContent(), walletText, 'Recovery preserves the authoritative wallet');

      const loggedOut = page.waitForResponse(responseFor('/api/logout'));
      await page.click('#logout-button');
      await loggedOut;
      await visible(page, '#login-view');
      eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_lobby_presence WHERE member_id=$1 AND revoked_at IS NULL', [players[0].id])).rows[0].n, 1, 'Browser logout revokes only its own presence session');
      eq((await money(A)).balance, baseline[0].balance, 'The existing API session and wallet remain usable after browser logout');
      eq(errors, [], 'The actual browser recovery flow has no uncaught errors');
    } finally {
      await context.close();
    }
  });
  await scenario('Actual browser commands omit formation and both players retain one server-selected layout', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage(), commands = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => {
      const pathname = new URL(req.url()).pathname;
      if (req.method() === 'POST' && [paths.queue, paths.challenge, paths.accept].includes(pathname)) commands.push({ pathname, body: req.postDataJSON() });
    });
    const clickReply = async (selector, pathname) => {
      const response = page.waitForResponse(value => new URL(value.url()).pathname === pathname);
      await page.click(selector);
      const reply = await response;
      eq(reply.status(), 200, 'The real browser command succeeds: ' + pathname);
      return reply.json();
    };
    const leaveEndedMatch = async () => {
      await visible(page, '#back-lobby'); await page.click('#back-lobby'); await visible(page, '#lobby-view');
    };
    try {
      await page.goto(appBase); await visible(page, '#login-view');
      await page.selectOption('#attendance', String(players[0].attendanceNumber)); await page.fill('#pin', players[0].pin);
      const heartbeat = page.waitForResponse(value => new URL(value.url()).pathname === paths.heartbeat && value.status() === 200);
      await page.click('#login-submit'); await heartbeat;
      await visible(page, '[data-challenge-user="' + players[1].id + '"]');
      eq(await page.locator('[id*="formation"]').count(), 0, 'No manual formation controls remain in the actual page');
      const before = await Promise.all([money(A), money(B)]);

      await clickReply('#random-button', paths.queue); await visible(page, '#queue-wait');
      eq(Object.keys(commands.find(value => value.pathname === paths.queue).body).sort(), ['requestId', 'stake']);
      await clickReply('#queue-cancel', paths.unqueue); await page.waitForFunction(() => document.getElementById('queue-wait').hidden);

      const invited = await challenge(B, players[0], 100), invitationId = invited.lobby.outgoing[0].id;
      await visible(page, '[data-accept-invitation="' + invitationId + '"]');
      const accepted = await clickReply('[data-accept-invitation="' + invitationId + '"]', paths.accept);
      const formation = sharedFormation(accepted.match), initial = require(path.join(root, 'public/physics.js')).initialState([formation, formation]);
      eq(accepted.match.state, initial, 'The actual browser receives the mirrored initial layout');
      eq(Object.keys(commands.find(value => value.pathname === paths.accept).body).sort(), ['invitationId', 'requestId', 'stake']);
      await visible(page, '#room-view');
      eq(await page.locator('[id*="formation"]').count(), 0, 'The room has no formation picker');
      await api(B, '/api/ready', mutation({ matchId: accepted.match.id, ready: true }));
      const funded = await clickReply('#ready-button', '/api/ready');
      eq(funded.match.status, 'playing'); eq(sharedFormation(funded.match), formation); eq(funded.match.state, initial);
      await visible(page, '#game-view');
      await page.waitForFunction(turn => document.getElementById('turn-banner').dataset.team === turn, funded.match.turn);
      eq(await page.locator('#turn-name').textContent(), funded.match[funded.match.turn].name, 'The actual attacking player is named prominently');
      eq(await page.locator('#turn-action').textContent(), '攻撃中');
      ok(/^(?:1:00|0:5\d)$/.test(await page.locator('#turn-clock').textContent()), 'The actual page counts a server-owned minute');
      eq(await page.locator('#round-label').textContent(), '1手目', 'The page has no forty-turn limit');
      eq(await page.locator('#score-' + funded.match.turn + '-team').evaluate(node => node.classList.contains('is-attacking')), true, 'The attacking score team is emphasized');
      const stored = (await db.query('SELECT host_formation,guest_formation FROM target_private.two_player_matches WHERE id=$1', [funded.match.id])).rows[0];
      eq(stored, { host_formation: formation, guest_formation: formation }, 'The shared layout is stored by the actual SQL boundary');
      const nextTurn = funded.match.turn === 'host' ? 'guest' : 'host';
      await db.query("UPDATE target_private.two_player_matches SET turn_started_at=statement_timestamp()-interval '60.2 seconds',turn_expires_at=statement_timestamp()-interval '0.2 seconds' WHERE id=$1", [funded.match.id]);
      await page.waitForFunction(turn => document.getElementById('turn-banner').dataset.team === turn, nextTurn);
      eq(await page.locator('#turn-name').textContent(), funded.match[nextTurn].name, 'A real server timeout changes the visible attacking player');
      eq(await page.locator('#round-label').textContent(), '2手目');
      const passed = (await api(A, '/api/match?matchId=' + funded.match.id)).match;
      eq(passed.turn, nextTurn); eq(passed.escrow, funded.match.escrow, 'A visible timeout preserves the funded stake');
      await cancelMatch(A, funded.match); await cancelMatch(B, funded.match); await leaveEndedMatch();

      const sent = await clickReply('[data-challenge-user="' + players[1].id + '"]', paths.challenge);
      eq(Object.keys(commands.find(value => value.pathname === paths.challenge).body).sort(), ['requestId', 'stake', 'targetId']);
      const paired = await api(B, paths.accept, mutation({ invitationId: sent.lobby.outgoing[0].id, stake: 100 }));
      const secondFormation = sharedFormation(paired.match);
      eq(paired.match.state, require(path.join(root, 'public/physics.js')).initialState([secondFormation, secondFormation]));
      await visible(page, '#room-view');
      await cancelMatch(A, paired.match); await leaveEndedMatch();
      eq((await Promise.all([money(A), money(B)])).map(value => value.balance), before.map(value => value.balance), 'The real ready/cancel flow fully refunds both wallets');
      await clickReply('#logout-button', '/api/logout'); await visible(page, '#login-view');
      eq(errors, [], 'The actual browser matchmaking flow has no uncaught errors');
    } finally {
      await context.close();
    }
  });
  await scenario('Multiple sessions preserve presence until the final session leaves or expires', async () => {
    const originalSession = (await db.query('SELECT session_id FROM target_private.two_player_lobby_presence WHERE member_id=$1 AND revoked_at IS NULL ORDER BY seen_at DESC LIMIT 1',[players[0].id])).rows[0].session_id;
    sensitive.push(originalSession);
    const secondA = await browser.newContext();
    try {
      await login(secondA, players[0]); await pulse(secondA);
      await api(A, paths.leave, {});
      ok((await lobby(B)).lobby.online.some(item => item.memberId === players[0].id), 'The second active session keeps the member online');
      await api(A, '/api/logout', {});
      const racedHeartbeat = await rawLobby('heartbeat', players[0], originalSession);
      ok([401,403].includes(racedHeartbeat.error?.status), 'A logout fence rejects a previously verified heartbeat for the revoked session');
      ok((await lobby(B)).lobby.online.some(item => item.memberId === players[0].id), 'Logging out one session cannot remove another');
      await queue(secondA); await agePresence(players[0]);
      ok(!(await lobby(B)).lobby.online.some(item => item.memberId === players[0].id), 'Expired sessions do not appear online');
      const paired = await queue(B);
      eq(sessionMatch(paired), null, 'An offline queue entry is not selected for a match');
      await api(B, paths.unqueue, mutation({}));
      await pulse(secondA); eq((await lobby(secondA)).lobby.queue, null, 'Expired queue entries do not silently return');
      await api(secondA, '/api/logout', {});
    } finally { await secondA.close(); }
    await login(A, players[0]); await pulse(A);
  });
  await scenario('Direct challenges require acceptance and assign one shared random formation without charging', async () => {
    await clearParticipants(contexts);
    const before = await Promise.all([money(A), money(B)]);
    const offered = await api(A, paths.challenge, mutation({ targetId: players[1].id, stake: 300, formation: 2 }));
    const outgoing = offered.lobby.outgoing.find(item => item.to.memberId === players[1].id);
    ok(outgoing, 'The selected online opponent receives a challenge');
    eq(sessionMatch(offered), null);
    const incoming = (await lobby(B)).lobby.incoming.find(item => item.id === outgoing.id);
    eq(incoming.from.memberId, players[0].id); eq(incoming.stake, 300);
    const acceptBody = mutation({ invitationId: outgoing.id, stake: 700, formation: 1 });
    const accepts = await Promise.all(Array.from({ length: 6 }, () => api(B, paths.accept, acceptBody)));
    const match = accepts[0].match;
    ok(accepts.every(value => value.match?.id === match.id)); ok(sameMatch(match, players[0], players[1]));
    eq(match.status, 'waiting'); eq(match.host.offer, 300); eq(match.guest.offer, 700);
    const formation = sharedFormation(match);
    eq(match.state, require(path.join(root, 'public/physics.js')).initialState([formation, formation]));
    ok(accepts.every(value => value.match.host.formation === formation && value.match.guest.formation === formation), 'Concurrent accept retries retain the same assignment');
    eq(match.escrow, 0);
    eq(await Promise.all([money(A), money(B)]), before, 'Pairing reserves no money');
    eq((await lobby(C)).lobby.online.find(item => item.memberId === players[0].id).busy, true);
    await api(A, '/api/ready', mutation({ matchId: match.id, ready: true }), 409);
    await api(B, '/api/offer', mutation({ matchId: match.id, stake: 300 }));
    await api(A, '/api/ready', mutation({ matchId: match.id, ready: true }));
    const funded = await api(B, '/api/ready', mutation({ matchId: match.id, ready: true }));
    eq(funded.match.status, 'playing'); eq(funded.match.state.players.length, 16); eq(funded.match.escrow, 600);
    eq(sharedFormation(funded.match), formation, 'Funding does not reroll the common formation');
    const reserved = await Promise.all([money(A), money(B)]);
    eq(reserved.map(value => value.balance), before.map(value => value.balance - 300));
    const lateChallenge = await request(C, paths.challenge, mutation({ targetId: players[0].id, ...choices() }), null);
    ok([404, 409].includes(lateChallenge.status), 'Busy opponents cannot be pulled into another match');
    await cancelMatch(A, funded.match); await cancelMatch(B, funded.match);
    eq((await Promise.all([money(A), money(B)])).map(value => value.balance), before.map(value => value.balance));
  });
  await scenario('Declined, cancelled, and offline invitations never create a match on late acceptance or retry', async () => {
    await clearParticipants(contexts);
    const issued = mutation({ targetId: players[1].id, ...choices() });
    let value = await api(A, paths.challenge, issued);
    let invitationId = value.lobby.outgoing[0].id;
    const outsider = await request(C, paths.accept, mutation({ invitationId, ...choices() }), null);
    ok([403,404].includes(outsider.status), 'Another member cannot accept someone else’s invitation');
    await api(B, paths.decline, mutation({ invitationId }));
    const declined = await request(B, paths.accept, mutation({ invitationId, ...choices() }), null);
    ok([404, 409].includes(declined.status));
    value = await api(A, paths.challenge, issued);
    eq(sessionMatch(value), null); eq(value.lobby.outgoing.length, 0, 'The exact old challenge retry never recreates a declined challenge');
    value = await challenge(A, players[1]); invitationId = value.lobby.outgoing[0].id;
    await api(A, paths.withdraw, mutation({ invitationId }));
    const cancelled = await request(B, paths.accept, mutation({ invitationId, ...choices() }), null);
    ok([404, 409].includes(cancelled.status));
    const self = await request(A, paths.challenge, mutation({ targetId: players[0].id, ...choices() }), null);
    ok([400, 409].includes(self.status));
    await api(B, paths.leave, {});
    const offline = await request(A, paths.challenge, mutation({ targetId: players[1].id, ...choices() }), null);
    ok([404, 409].includes(offline.status));
    await pulse(B);
    eq(sessionMatch(await lobby(A)), null); eq(sessionMatch(await lobby(B)), null);
  });
  await scenario('Random pairing takes the earliest waiting player across differing stake selections', async () => {
    await clearParticipants(contexts);
    const first = await api(A, paths.queue, mutation({ stake: 100, formation: 2 })); ok(first.lobby.queue); eq(first.lobby.queue.position, 1); eq(first.lobby.queue.stake,100); eq(sessionMatch(first), null);
    const requestB = mutation({ stake: 600, formation: 1 });
    const seconds = await Promise.all(Array.from({ length: 5 }, () => api(B, paths.queue, requestB)));
    const matchAB = seconds[0].match;
    ok(seconds.every(value => value.match?.id === matchAB.id)); ok(sameMatch(matchAB, players[0], players[1]));
    eq(matchAB.host.offer, 100); eq(matchAB.guest.offer, 600);
    const formation = sharedFormation(matchAB); eq(matchAB.escrow, 0);
    ok(seconds.every(value => value.match.host.formation === formation && value.match.guest.formation === formation), 'Concurrent queue retries cannot reroll the assignment');
    const third = await queue(C, 900); ok(third.lobby.queue); eq(third.lobby.queue.position, 1);
    const fourth = await queue(D, 200); ok(sameMatch(fourth.match, players[2], players[3]));
    ok(fourth.match.id !== matchAB.id);
    eq((await lobby(A)).match.id, matchAB.id, 'The earliest waiter learns the same match through normal lobby refresh');
    const cancelledAfterPair = await api(A, paths.unqueue, mutation({}));
    eq(cancelledAfterPair.match.id, matchAB.id); eq(cancelledAfterPair.match.status, 'waiting', 'Cancelling a stale queue cannot cancel a paired match');
    await clearParticipants(contexts);
  });
  await scenario('The oldest waiter still matches when only the newer opponent can create a game', async () => {
    await clearParticipants(contexts);
    const original = (await db.query('SELECT create_count FROM target_private.two_player_rates WHERE member_id=$1',[players[0].id])).rows[0].create_count;
    await db.query('UPDATE target_private.two_player_rates SET create_count=20 WHERE member_id=$1',[players[0].id]);
    try {
      await queue(A, 100);
      const pair = await queue(F, 600);
      ok(sameMatch(pair.match, players[0], players[5]), 'The oldest queued opponent is not skipped due to host creation quota');
      eq(pair.match.host.memberId, players[5].id);
      eq(pair.match.guest.memberId, players[0].id);
      eq(pair.match.escrow, 0);
    } finally {
      await db.query('UPDATE target_private.two_player_rates SET create_count=$2 WHERE member_id=$1',[players[0].id,original]);
      await clearParticipants(contexts);
    }
  });
  await scenario('Users can leave queue or withdraw an invitation at the storage cap', async () => {
    const logical = async () => Number((await db.query('SELECT logical_bytes FROM target_private.system_state WHERE singleton')).rows[0].logical_bytes);
    await queue(A);
    const beforeQueue = await logical();
    await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
    try { const value = await api(A, paths.unqueue, mutation({})); eq(value.lobby.queue, null); }
    finally { await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[beforeQueue]); }
    const issued = await challenge(A, players[1]), invitationId = issued.lobby.outgoing[0].id;
    const beforeInvite = await logical();
    await db.query('UPDATE target_private.system_state SET logical_bytes=104857600 WHERE singleton');
    try { const value = await api(A, paths.withdraw, mutation({invitationId})); eq(value.lobby.outgoing, []); }
    finally { await db.query('UPDATE target_private.system_state SET logical_bytes=$1 WHERE singleton',[beforeInvite]); }
  });
  await scenario('A cancelled wait is not resurrected by retry and concurrent direct/random matching never double-pairs', async () => {
    const enqueueBody = mutation(choices(100));
    await api(A, paths.queue, enqueueBody);
    await api(A, paths.unqueue, mutation({}));
    const old = await api(A, paths.queue, enqueueBody);
    eq(old.lobby.queue, null); eq(sessionMatch(old), null, 'A retired queue attempt is not enqueued again');
    await queue(B); eq(sessionMatch(await lobby(B)), null); await api(B, paths.unqueue, mutation({}));
    const issued = await challenge(A, players[1], 100), invitationId = issued.lobby.outgoing[0].id;
    await queue(C, 300);
    const race = await Promise.all([
      request(B, paths.accept, mutation({ invitationId, ...choices(200) }), null),
      request(A, paths.queue, mutation(choices(400)), null),
    ]);
    ok(race.every(result => [200, 409].includes(result.status)), 'The match race returns either the unique match or a conflict');
    const active = await Promise.all([lobby(A), lobby(B), lobby(C)]);
    const ids = new Set(active.map(value => sessionMatch(value)?.id).filter(Boolean));
    eq(ids.size, 1, 'The shared player is attached to exactly one active match');
    const participants = (await db.query('SELECT member_id,count(*)::integer AS n FROM target_private.two_player_participants WHERE member_id=ANY($1::uuid[]) GROUP BY member_id', [players.slice(0, 3).map(item => item.id)])).rows;
    ok(participants.every(row => row.n === 1));
    eq(participants.length, 2);
    await clearParticipants(contexts);
  });
  await scenario('Rate limits cannot keep a user queued or resurrect a logged-out session', async () => {
    await clearParticipants(contexts);
    await queue(A);
    const session = (await db.query('SELECT session_id FROM target_private.two_player_lobby_presence WHERE member_id=$1 AND revoked_at IS NULL ORDER BY seen_at DESC LIMIT 1',[players[0].id])).rows[0].session_id;
    const oldRate = (await db.query('SELECT minute_bucket,minute_count FROM target_private.two_player_rates WHERE member_id=$1',[players[0].id])).rows[0];
    await db.query("UPDATE target_private.two_player_rates SET minute_bucket=floor(extract(epoch FROM clock_timestamp())/60)::bigint,minute_count=241 WHERE member_id=$1",[players[0].id]);
    try {
      await api(A, '/api/logout', {});
      eq((await db.query('SELECT count(*)::integer AS n FROM target_private.two_player_lobby_queue WHERE member_id=$1',[players[0].id])).rows[0].n,0,'Logout removes the actual queue despite existing game read limits');
      const revoked = (await db.query('SELECT revoked_at IS NOT NULL AS revoked FROM target_private.two_player_lobby_presence WHERE member_id=$1 AND session_id=$2',[players[0].id,session])).rows[0];
      eq(revoked.revoked,true);
      eq((await rawLobby('heartbeat',players[0],session)).error.status,401,'The logout fence precedes ordinary rate limits');
    } finally {
      await db.query('UPDATE target_private.two_player_rates SET minute_bucket=$2,minute_count=$3 WHERE member_id=$1',[players[0].id,oldRate.minute_bucket,oldRate.minute_count]);
      await login(A,players[0]);await pulse(A);
    }
    await queue(A);
    const priorLobbyRate=(await db.query('SELECT * FROM target_private.two_player_lobby_rates WHERE member_id=$1',[players[0].id])).rows[0];
    await db.query("UPDATE target_private.two_player_lobby_rates SET minute_bucket=floor(extract(epoch FROM clock_timestamp())/60)::bigint,mutations=31,day_bucket=floor(extract(epoch FROM clock_timestamp())/86400)::bigint,day_mutations=1001 WHERE member_id=$1",[players[0].id]);
    try { eq((await api(A,paths.unqueue,mutation({}))).lobby.queue,null,'Releasing a real queue is permitted at lobby rate limits'); }
    finally { await db.query('UPDATE target_private.two_player_lobby_rates SET minute_bucket=$2,mutations=$3,day_bucket=$4,day_mutations=$5 WHERE member_id=$1',[players[0].id,priorLobbyRate.minute_bucket,priorLobbyRate.mutations,priorLobbyRate.day_bucket,priorLobbyRate.day_mutations]); }
    const issue=mutation(choices(100));await api(A,paths.queue,issue);await api(A,'/api/logout',{});await login(A,players[0]);await pulse(A);
    const originalName=players[0].name;players[0].name='検証A 更新';
    try {const replay=await api(A,paths.queue,issue);eq(replay.lobby.queue,null);eq(sessionMatch(replay),null,'An old ticket remains retired across session and display-name changes');}
    finally {players[0].name=originalName;}
  });
  await scenario('Logout and expired presence remove abandoned waits without changing other sessions or money', async () => {
    await queue(E, 500); await api(E, '/api/logout', {});
    const lone = await queue(F, 500); eq(sessionMatch(lone), null, 'A logged-out queue member is not paired');
    await api(F, paths.unqueue, mutation({}));
    await login(E, players[4]); await pulse(E);
    await queue(E); await agePresence(players[4]);
    const later = await queue(F); eq(sessionMatch(later), null, 'Expired queued players are skipped');
    await api(F, paths.unqueue, mutation({})); await pulse(E);
    for (let index = 0; index < contexts.length; index++) eq((await money(contexts[index])).balance, baseline[index].balance);
  });
  await scenario('Lobby allocation is private and permanent wallet projections still reconcile', async () => {
    const tables = (await db.query("SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='target_private' AND c.relkind='r' AND c.relname LIKE 'two_player_lobby_%'")).rows;
    ok(tables.length >= 3, 'The real lobby schema is present');
    for (const table of tables) {
      eq(table.relrowsecurity, true, table.relname + ' has RLS');
      const acl = (await db.query('SELECT has_table_privilege(\'anon\',$1,\'SELECT,INSERT,UPDATE,DELETE\') AS allowed', ['target_private.' + table.relname])).rows[0];
      eq(acl.allowed, false);
    }
    const projection = (await db.query('SELECT count(*)::integer AS n FROM target_private.wallet_finance_projection(NULL) l JOIN target_private.profiles p USING(member_id) WHERE (p.total_points,p.spent_points,p.calculus_points,p.birthday_points,p.casino_net,p.calculus_forgiven_points) IS DISTINCT FROM (l.total_points,l.spent_points,l.calculus_points,l.birthday_points,l.casino_net,l.calculus_forgiven_points)')).rows[0];
    eq(projection.n, 0);
    const checks = await db.query(await fs.readFile(path.join(targetRoot, 'supabase/tests/two_player_soccer_verify.sql'), 'utf8'));
    ok(checks.some(value => value.rows?.some(row => row.result === 'two_player_soccer_postflight_passed')));
    const forbidden = (await db.query('SELECT public.two_player_lobby_rpc($1,$2,$3::jsonb) AS value', [opaque(), 'heartbeat', '{}'])).rows[0].value;
    eq(forbidden.error.status, 403);
  });
  for (const context of contexts) await context.close();
}

function matchmakingFixture() {
  const P = require(path.join(root, 'public/physics.js'));
  let user = null, match = null, pendingQueue = null, incoming = [], outgoing = [], held = null;
  const calls = [];
  const wallet = { balance: 10000, totalIncome: 10000, spent: 0, walletRevision: 1, gameNet: 0, escrow: 0 };
  const makeMatch = (guest = false, stake = 100) => ({
    id: uuid(), status: 'waiting', mode: 'alternating', version: 2, turn: guest ? 'guest' : 'host', round: 1, stake: null, escrow: 0,
    host: { ...playerDTO(guest ? players[1] : players[0]), offer: stake, formation: 1, ready: guest, inputLocked: false },
    guest: { ...playerDTO(guest ? players[0] : players[1]), offer: stake, formation: 1, ready: !guest, inputLocked: false },
    formations: [1, 1], scores: { host: 0, guest: 0 }, state: P.initialState([1, 1]),
    winner: null, reason: null, lastRound: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    turnStartedAt: null, turnExpiresAt: null, serverNow: new Date().toISOString(),
  });
  const beginTurn = () => { const now = Date.now(); match.turnStartedAt = new Date(now).toISOString(); match.turnExpiresAt = new Date(now + 60000).toISOString(); };
  const touch = () => { if (match) match.updatedAt = new Date(Date.now() + calls.length).toISOString(); };
  const snapshot = () => ({ ok: true, user: user && { id: user.id, name: user.name }, wallet: user && structuredClone(wallet),
    lobby: { online: user ? players.filter(item => item.id !== user.id).map((item, index) => ({ ...playerDTO(item), busy: index === 1 })) : [], queue: pendingQueue && structuredClone(pendingQueue), incoming: structuredClone(incoming), outgoing: structuredClone(outgoing) }, match: match && {...structuredClone(match), serverNow: new Date().toISOString()} });
  return {
    get calls() { return calls; }, get match() { return match; },
    addInvitation() { const item = { id: uuid(), from: playerDTO(players[1]), stake: 400, formation: 2, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }; incoming.push(item); return item.id; },
    pair() { const queued = pendingQueue; pendingQueue = null; match = makeMatch(false, queued?.stake || 100); },
    delayLobby() { held = {}; held.promise = new Promise(resolve => { held.release = resolve; }); held.entered = new Promise(resolve => { held.enter = resolve; }); return held; },
    async handle(route) {
      const req = route.request(), url = new URL(req.url()), input = req.method() === 'POST' ? req.postDataJSON() : undefined;
      calls.push({ path: url.pathname, method: req.method(), input });
      const send = async (status, value) => {
        if (req.failure()) return route.abort('aborted').catch(() => {});
        try { await route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store' }, body: JSON.stringify(value) }); }
        catch (error) { if (!req.failure()) throw error; }
      };
      if (url.pathname === '/api/login') {
        user = players.find(item => item.attendanceNumber === Number(input.attendanceNo) && item.pin === input.pin);
        if (!user) return send(401, { ok: false, error: { code: 'INVALID_ACCOUNT_CREDENTIALS', message: '確認してください。' } });
        match = null; incoming = []; outgoing = []; pendingQueue = null; return send(200, snapshot());
      }
      if (url.pathname === '/api/logout') { user = null; match = null; incoming = []; outgoing = []; pendingQueue = null; return send(200, { ok: true }); }
      if (url.pathname === '/api/session') return send(200, snapshot());
      if (!user) return send(401, { ok: false, error: { code: 'AUTHENTICATION_REQUIRED', message: 'ログインしてください。' } });
      if (url.pathname === paths.lobby) {
        const value = snapshot();
        if (held) { const delayed = held; held = null; delayed.enter(); await delayed.promise; }
        return send(200, value);
      }
      if ([paths.heartbeat, paths.leave].includes(url.pathname)) return send(200, snapshot());
      if (url.pathname === paths.challenge) {
        const to = players.find(item => item.id === input.targetId);
        outgoing = [{ id: uuid(), to: playerDTO(to), stake: input.stake, formation: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }];
        return send(200, snapshot());
      }
      if (url.pathname === paths.withdraw) { outgoing = outgoing.filter(item => item.id !== input.invitationId); return send(200, snapshot()); }
      if (url.pathname === paths.decline) { incoming = incoming.filter(item => item.id !== input.invitationId); return send(200, snapshot()); }
      if (url.pathname === paths.accept) { incoming = []; outgoing = []; pendingQueue = null; match = makeMatch(true, input.stake); return send(200, snapshot()); }
      if (url.pathname === paths.queue) { pendingQueue = { joinedAt: new Date().toISOString(), position: 1, stake: input.stake, formation: 0 }; return send(200, snapshot()); }
      if (url.pathname === paths.unqueue) { pendingQueue = null; return send(200, snapshot()); }
      if (url.pathname === '/api/match') return send(200, snapshot());
      if (url.pathname === '/api/formation') return send(409, { ok: false, error: { code: 'FORMATION_FIXED', message: '陣形は自動で決まります。' } });
      if (url.pathname === '/api/offer') { const role = match.guest.memberId === user.id ? 'guest' : 'host'; match[role].offer = input.stake; match.host.ready = false; match.guest.ready = false; touch(); return send(200, snapshot()); }
      if (url.pathname === '/api/ready') { match.status = 'playing'; match.stake = match.host.offer; match.escrow = 2 * match.stake; match.host.ready = true; match.guest.ready = true; wallet.balance -= match.stake; wallet.totalIncome -= match.stake; wallet.walletRevision++; wallet.escrow = match.stake; beginTurn(); touch(); return send(200, snapshot()); }
      if (url.pathname === '/api/input') {
        const role = match.guest.memberId === user.id ? 'guest' : 'host';
        const inputs = { host: { angle: 0, power: 0, piece: 0 }, guest: { angle: 0, power: 0, piece: 0 } }; inputs[role] = { angle: input.angle, power: input.power, piece: input.piece };
        const result = P.simulate(match.state, [inputs.host, inputs.guest], match.formations);
        match.lastRound = { round: match.round, version: 2, inputs, goal: null, frames: result.frames, state: result.state, resultHash: 'synthetic-matchmaking-result' };
        match.state = result.state; match.round++; match.turn = role === 'host' ? 'guest' : 'host'; beginTurn(); touch(); return send(200, snapshot());
      }
      if (url.pathname === '/api/cancel') { match.status = 'cancelled'; match.escrow = 0; touch(); const value = snapshot(); match = null; return send(200, value); }
      return send(404, { ok: false, error: { code: 'NOT_FOUND', message: '不明な検証ルート' } });
    },
  };
}
async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible', timeout: 10000 }); }
async function browserScenarios(origin) {
  const parsedOrigin = new URL(origin).origin;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    await scenario(name + ' online roster, direct opponent, FIFO wait, no codes and eight-piece slingshot', async () => {
      const proxy = process.env.APP_ORIGIN && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
      const browser = await engine.launch(name === 'chromium' ? { headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'], proxy } : { headless: true, executablePath: process.env.WEBKIT_PATH || '/workspace/scratch/webkit-runtime/pw-run.sh', proxy });
      try {
        const context = await browser.newContext({ viewport: { width: 320, height: 740 }, reducedMotion: 'reduce' });
        const fixture = matchmakingFixture();
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin === parsedOrigin && url.pathname.startsWith('/api/')) return fixture.handle(route);
          return url.origin === parsedOrigin ? route.continue() : route.abort();
        });
        const page = await context.newPage(); page.on('pageerror', error => browserErrors.push({ browser: name, message: error.message }));
        await page.goto(origin, { waitUntil: 'networkidle' }); await visible(page, '#login-view');
        await page.selectOption('#attendance', '1'); await page.fill('#pin', players[0].pin); await page.click('#login-submit'); await visible(page, '#lobby-view');
        for (const selector of ['#create-form', '#join-form', '#join-code', '#room-code', '#copy-invite']) eq(await page.locator(selector).count(), 0, 'No room-code UI: ' + selector);
        await visible(page, '[data-challenge-user="' + players[1].id + '"]');
        eq(await page.locator('[data-challenge-user]').count(), players.length - 1);
        ok(await page.locator('[data-challenge-user="' + players[2].id + '"]').isDisabled(), 'Busy users cannot be directly selected');
        eq(await page.locator('[id*="formation"]').count(), 0, 'Formation controls are absent');
        await page.fill('#lobby-stake', '700');
        await page.click('[data-challenge-user="' + players[1].id + '"]');
        const challengeCall = fixture.calls.find(item => item.path === paths.challenge);
        eq(challengeCall.input.targetId, players[1].id); eq(challengeCall.input.stake, 700);
        eq(Object.keys(challengeCall.input).sort(), ['requestId', 'stake', 'targetId'], 'A challenge carries no formation preference');
        ok(await page.locator('#lobby-view').isVisible(), 'Sending a challenge does not start a game without acceptance');
        await visible(page, '[data-cancel-invitation]'); await page.locator('[data-cancel-invitation]').click();
        await page.waitForFunction(() => !document.querySelector('[data-cancel-invitation]'));
        let invitationId = fixture.addInvitation(); await page.click('#refresh-lobby');
        await visible(page, '[data-decline-invitation="' + invitationId + '"]'); await page.click('[data-decline-invitation="' + invitationId + '"]');
        await page.waitForFunction(() => !document.querySelector('[data-decline-invitation]'));
        invitationId = fixture.addInvitation(); await page.click('#refresh-lobby');
        await visible(page, '[data-accept-invitation="' + invitationId + '"]'); await page.click('[data-accept-invitation="' + invitationId + '"]');
        await visible(page, '#room-view');
        const acceptCall = fixture.calls.find(item => item.path === paths.accept);
        eq(acceptCall.input.stake, 700);
        eq(Object.keys(acceptCall.input).sort(), ['invitationId', 'requestId', 'stake'], 'Accept carries no formation preference');
        eq(await page.locator('[id*="formation"]').count(), 0, 'The matched room has no manual formation picker');
        sharedFormation(fixture.match);
        await page.click('#leave-room'); await visible(page, '#lobby-view');
        await page.click('#random-button'); await visible(page, '#queue-wait');
        eq(Object.keys(fixture.calls.find(item => item.path === paths.queue).input).sort(), ['requestId', 'stake'], 'Random waiting carries no formation preference');
        ok(/待機|1/.test(await page.locator('#queue-status').textContent()));
        const otherDevice = await browser.newContext({viewport:{width:320,height:740},reducedMotion:'reduce'});
        try {
          await otherDevice.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===parsedOrigin&&url.pathname.startsWith('/api/'))return fixture.handle(route);return url.origin===parsedOrigin?route.continue():route.abort();});
          const restored=await otherDevice.newPage();restored.on('pageerror',error=>browserErrors.push({browser:name,message:error.message}));
          await restored.goto(origin,{waitUntil:'networkidle'});await visible(restored,'#queue-wait');
          eq(await restored.inputValue('#lobby-stake'),'700','A fresh local preference cache displays the server accepted queue amount');
          eq(await restored.locator('[id*="formation"]').count(),0,'A fresh device has no formation controls');
          ok(await restored.locator('#lobby-stake').isDisabled(),'Queued choices remain locked to the accepted server settings');
        } finally {await otherDevice.close();}
        const queueSnapshot = fixture.delayLobby(); await page.click('#refresh-lobby');
        await Promise.race([queueSnapshot.entered, delay(5000).then(() => {throw Error('Missing held queue snapshot');})]);
        await page.click('#queue-cancel'); await page.waitForFunction(() => document.getElementById('queue-wait').hidden);
        queueSnapshot.release(); await page.waitForTimeout(100);
        ok(await page.locator('#queue-wait').isHidden(), 'A delayed pre-cancellation snapshot cannot requeue the user');
        ok(await page.locator('#lobby-view').isVisible(), 'Cancelling waiting stays in the lobby');
        await page.click('#random-button'); await visible(page, '#queue-wait'); fixture.pair(); await page.click('#refresh-lobby');
        await visible(page, '#room-view');
        await page.click('#ready-button'); await visible(page, '#game-view');
        await page.waitForFunction(() => !document.getElementById('lock-input').disabled);
        ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile game has no horizontal overflow');
        const own = fixture.match.state.players[4], canvas = page.locator('#pitch'); await canvas.scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        const x = box.x + own.x * box.width / 640, y = box.y + own.y * box.height / 960;
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + 25, { steps: 4 }); await page.mouse.up();
        await page.waitForFunction(() => document.getElementById('lock-input').disabled);
        const shots = fixture.calls.filter(item => item.path === '/api/input');
        eq(shots.length, 1); eq(shots[0].input.piece, 4); eq(shots[0].input.version, 2); eq(shots[0].input.angle, 270);
        ok(shots[0].input.power > 0, 'Pull distance still sets nonzero shot power');
        await page.reload({ waitUntil: 'networkidle' }); await visible(page, '#game-view');
        ok(await page.locator('#lock-input').isDisabled(), 'Refresh resumes the same inactive turn');
        eq(fixture.calls.filter(item => item.path === '/api/match').every(item => item.input === undefined), true);
        await page.screenshot({ path: path.join(reportDir, 'matchmaking-' + name + '-game-320.png'), fullPage: true });
        await page.click('#cancel-button'); await visible(page, '#confirm-cancel'); await page.click('#confirm-cancel');
        await visible(page, '#back-lobby'); await page.click('#back-lobby'); await visible(page, '#lobby-view');
        const oldAccountSnapshot = fixture.delayLobby(); await page.click('#refresh-lobby');
        await Promise.race([oldAccountSnapshot.entered, delay(5000).then(() => {throw Error('Missing held old-account lobby snapshot');})]);
        await page.click('#logout-button'); await visible(page, '#login-view');
        await page.selectOption('#attendance', '2'); await page.fill('#pin', players[1].pin); await page.click('#login-submit'); await visible(page, '#lobby-view');
        oldAccountSnapshot.release(); await page.waitForTimeout(100);
        eq(await page.locator('#account-name').textContent(), players[1].name);
        eq(await page.locator('[data-challenge-user=\"' + players[1].id + '\"]').count(), 0, 'A delayed old-account roster cannot show the current account as a possible opponent');
        ok(await page.locator('#game-view').isHidden(), 'Late old-account matchmaking data cannot reopen its game');
        await page.screenshot({ path: path.join(reportDir, 'matchmaking-' + name + '-lobby-320.png'), fullPage: true });
        for (const width of [320, 390, 1280]) { await page.setViewportSize({ width, height: 844 }); ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Lobby fits width ' + width); }
        ok(!fixture.calls.some(item => item.path === '/api/rooms' || item.path === '/api/rooms/join'), 'Fresh matchmaking users never need legacy code endpoints');
        await context.close();
      } finally { await browser.close(); }
    });
  }
  eq(browserErrors, [], 'Both browsers have no uncaught application errors');
}
async function main() {
  let browser, failure;
  await fs.mkdir(reportDir, { recursive: true });
  try {
    if (process.env.MATCHMAKING_BROWSER_ONLY !== '1') {
      const databaseUrl = await createDatabase();
      await startIdentity(); await startApp(databaseUrl);
      browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      await actualScenarios(browser); await browser.close(); browser = null;
    }
    if (process.env.MATCHMAKING_API_ONLY !== '1') await browserScenarios(process.env.APP_ORIGIN || appBase || await startStatic());
  } catch (error) { failure = error; }
  finally {
    if (browser) await browser.close();
    try {await cleanup();} catch(error) {failure ||= error;}
    if(databaseErrors.length)failure ||= Error('Local database pool failed: '+databaseErrors.map(item=>item.code).join(','));
    const filename = process.env.APP_ORIGIN ? 'matchmaking-public-qa.json' : process.env.MATCHMAKING_BROWSER_ONLY === '1' ? 'matchmaking-browser-qa.json' : process.env.MATCHMAKING_API_ONLY === '1' ? 'matchmaking-api-qa.json' : 'matchmaking-qa.json';
    await fs.writeFile(path.join(reportDir, filename), JSON.stringify({ status: failure ? 'failed' : 'passed', checks, results, browserErrors, databaseErrors, hostedWrites: false, syntheticIdentity: true, apiMode: process.env.MATCHMAKING_BROWSER_ONLY === '1' ? 'locally-fulfilled' : process.env.MATCHMAKING_API_ONLY === '1' ? 'actual-local-browser-api-and-database' : 'actual-local-and-locally-fulfilled-browser' }, null, 2) + '\n');
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ matchmakingIntegration: 'passed', checks, scenarios: results.length, hostedWrites: false }));
}
main().catch(error => { console.error('Matchmaking QA failed: ' + redact(error.stack || error)); process.exitCode = 1; });

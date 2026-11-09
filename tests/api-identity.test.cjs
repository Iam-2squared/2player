'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../server/identity.cjs');
const {getConfig} = require('../server/config.cjs');
const member = {id: '22222222-2222-4222-8222-222222222222', name: '検証'};
const config = {test: true, kgsOrigin: 'http://127.0.0.1:5001', integrationSecret: 'integration-test-only', cookieSecret: 'cookie-test-only',
  sessionCookie: 'two_player_session', attemptCookie: 'two_player_attempt'};
function response(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}}); }
async function withFetch(stub, run) { const previous = global.fetch; global.fetch = stub; try { await run(); } finally { global.fetch = previous; } }
function sink() { const values = new Map(); return {values, getHeader: name => values.get(name), setHeader: (name, value) => values.set(name, value)}; }

test('the dedicated two-player bridge sends its server credential and strips extra identity data', async () => {
  const input = {attendanceNumber: 99, accountPin: '0134', attemptId: 'A'.repeat(43)};
  await withFetch(async (url, options) => {
    assert.equal(url, config.kgsOrigin + '/api/integrations/two-player/login');
    assert.equal(options.headers.Authorization, 'Bearer ' + config.integrationSecret);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), input);
    return response({member: {...member, pin: '0134'}, token: 'B'.repeat(43), expiresAt: new Date(Date.now() + 3600000).toISOString()});
  }, async () => {
    const result = await identity.callIdentity('login', input, config);
    assert.deepEqual(result.member, member);
    assert.equal(Object.hasOwn(result.member, 'pin'), false);
  });
});

test('identity configuration failures do not become guest sessions or incorrect PIN errors', async () => {
  await withFetch(async () => response({error: {code: 'INTEGRATION_SECRET_INVALID'}}, 401), async () => {
    await assert.rejects(identity.callIdentity('verify', {token: 'B'.repeat(43)}, config), error => error.status === 503 && error.code === 'IDENTITY_UNAVAILABLE');
  });
  await withFetch(async () => response({error: {code: 'INVALID_ACCOUNT_CREDENTIALS'}}, 401), async () => {
    await assert.rejects(identity.callIdentity('login', {}, config), error => error.status === 401 && error.code === 'INVALID_ACCOUNT_CREDENTIALS');
  });
});

test('expired verified sessions clear their cookie', async () => {
  const res = sink();
  await withFetch(async () => response({error: {code: 'SESSION_EXPIRED'}}, 401), async () => {
    await assert.rejects(identity.requireMember({headers: {cookie: 'two_player_session=' + 'B'.repeat(43)}}, res, config), error => error.status === 401);
  });
  assert.match(res.values.get('Set-Cookie')[0], /two_player_session=;.*Max-Age=0/);
});

test('oversized and malformed identity responses are bounded', async () => {
  for (const result of [response({padding: 'x'.repeat(17000)}), new Response('not json', {headers: {'content-type': 'text/plain'}})]) {
    await withFetch(async () => result, async () => {
      await assert.rejects(identity.callIdentity('verify', {token: 'B'.repeat(43)}, config), error => error.status === 503);
    });
  }
});

test('per-device login attempt identifiers require a valid cookie signature', () => {
  const first = sink();
  const token = identity.attemptIdentity({headers: {}}, first, config);
  const cookie = first.values.get('Set-Cookie')[0].split(';')[0];
  assert.equal(identity.attemptIdentity({headers: {cookie}}, sink(), config), token);
  const forged = cookie.replace(token, 'C'.repeat(43));
  assert.notEqual(identity.attemptIdentity({headers: {cookie: forged}}, sink(), config), 'C'.repeat(43));
});

test('production configuration forbids the loopback database test transport', () => {
  const settings = {NODE_ENV: 'production', TWO_PLAYER_RPC_SECRET: 'r'.repeat(40), TWO_PLAYER_COOKIE_SECRET: 'c'.repeat(40),
    TWO_PLAYER_KGS_INTEGRATION_SECRET: 'i'.repeat(40), KGS_IDENTITY_URL: 'https://kgs.example.com', TWO_PLAYER_ALLOWED_ORIGINS: 'https://soccer.example.com',
    TWO_PLAYER_DATABASE_URL: 'postgres://test:test@127.0.0.1/two_player_api_test'};
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try { assert.throws(() => getConfig(), error => error.status === 503); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

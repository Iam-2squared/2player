'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {boundedText} = require('../server/http.cjs');
const {callIdentity} = require('../server/identity.cjs');
const {lobbyRpc} = require('../server/store.cjs');
const {createHandler} = require('../server/router.cjs');
const {REQUEST_BUDGET_MS, requestConfig, upstreamTimeout} = require('../server/deadline.cjs');
const {requestFailure, upstreamFailure} = require('../server/diagnostics.cjs');
const member = {id: '22222222-2222-4222-8222-222222222222', name: 'private-member-name'};
const config = {test: true, origins: ['http://localhost'], kgsOrigin: 'http://127.0.0.1:5001',
  supabaseOrigin: 'https://test.supabase.co', publishableKey: 'private-publishable-key', rpcSecret: 'private-rpc-secret',
  integrationSecret: 'private-integration-secret', cookieSecret: 'private-cookie-secret', sessionCookie: 'two_player_session'};
const token = 'S'.repeat(43);
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});

async function capture(run) {
  const previousFetch = global.fetch, previousWarn = console.warn, entries = [];
  console.warn = value => entries.push(JSON.parse(value));
  try { await run(entries); } finally { global.fetch = previousFetch; console.warn = previousWarn; }
}

test('rejected response headers cancel bodies before returning an error', async () => {
  for (const headers of [{'Content-Type': 'text/html'}, {'Content-Type': 'application/json', 'Content-Length': '99999'}]) {
    let cancellations = 0;
    const body = new ReadableStream({cancel() { cancellations += 1; }});
    await assert.rejects(boundedText(new Response(body, {headers}), 16), /response (format|size)/);
    assert.equal(cancellations, 1);
  }
});

test('streamed oversized responses cancel their reader', async () => {
  let cancellations = 0;
  const body = new ReadableStream({start(controller) { controller.enqueue(new Uint8Array(32)); }, cancel() { cancellations += 1; }});
  await assert.rejects(boundedText(new Response(body, {headers: {'Content-Type': 'application/json'}}), 16), /response size/);
  assert.equal(cancellations, 1);
});

test('upstream diagnostics retain safe protocol codes without leaking request or error details', async () => {
  await capture(async entries => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return json({code: 'PGRST202', message: 'private-database-message',
      details: config.rpcSecret, hint: member.name}, 503); };
    await assert.rejects(lobbyRpc('snapshot', {memberId: member.id, name: member.name, token}, config), error => error.status === 503 && error.code === 'STORAGE_UNAVAILABLE');
    assert.equal(calls, 1);
    assert.equal(entries.length, 1);
    assert.deepEqual({...entries[0], elapsedMs: 0}, {event: 'two_player_upstream_failure', upstream: 'storage', operation: 'lobby.snapshot',
      elapsedMs: 0, kind: 'http', status: 503, code: 'PGRST202'});
    const output = JSON.stringify(entries);
    for (const privateValue of [...Object.values(config), member.id, member.name, token, 'private-database-message']) {
      if (typeof privateValue === 'string') assert.equal(output.includes(privateValue), false);
    }
  });
});

test('network failures are classified and mutations are never automatically replayed', async () => {
  await capture(async entries => {
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error(config.rpcSecret, {cause: {code: 'ECONNRESET', message: token}}); };
    await assert.rejects(lobbyRpc('queue', {requestId: '11111111-1111-4111-8111-111111111111'}, config), error => error.status === 503);
    assert.equal(calls, 1);
    assert.equal(entries[0].kind, 'connection');
    assert.equal(JSON.stringify(entries).includes(config.rpcSecret), false);
    assert.equal(JSON.stringify(entries).includes(token), false);
  });
});

test('fresh request configs have independent monotonic deadlines and preserve the source config', () => {
  const first = requestConfig(config), second = requestConfig(config);
  assert.notEqual(first, second);
  assert.equal(config.requestDeadline, undefined);
  assert.equal(first.rpcSecret, config.rpcSecret);
  assert.ok(first.requestDeadline - performance.now() <= REQUEST_BUDGET_MS);
  assert.ok(first.requestDeadline - performance.now() > REQUEST_BUDGET_MS - 100);
  assert.equal(upstreamTimeout(config, 10000), 10000);
  assert.equal(upstreamTimeout({...config, requestDeadline: performance.now() + 30000}, 12000), 12000);
});

test('identity and storage share one bounded budget, and exhausted requests do not issue another fetch', async () => {
  await capture(async entries => {
    const budget = {...config, requestDeadline: performance.now() + 5000};
    const timeouts = [], originalTimeout = AbortSignal.timeout;
    let calls = 0;
    AbortSignal.timeout = milliseconds => { timeouts.push(milliseconds); return originalTimeout(milliseconds); };
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) return json({member, expiresAt: new Date(Date.now() + 3600000).toISOString()});
      return json({ok: true});
    };
    try {
      await callIdentity('verify', {token}, budget);
      budget.requestDeadline = performance.now() + 1000;
      await lobbyRpc('snapshot', {}, budget);
      assert.equal(timeouts.length, 2);
      assert.ok(timeouts[0] > 1000 && timeouts[0] <= 5000);
      assert.ok(timeouts[1] > 0 && timeouts[1] <= 1000);
      budget.requestDeadline = performance.now() - 1;
      await assert.rejects(lobbyRpc('queue', {}, budget), error => error.code === 'STORAGE_UNAVAILABLE' && error.status === 503);
      await assert.rejects(callIdentity('verify', {token}, budget), error => error.code === 'IDENTITY_UNAVAILABLE' && error.status === 503);
      assert.equal(calls, 2);
      assert.deepEqual(entries.map(entry => entry.kind), ['timeout', 'timeout']);
    } finally { AbortSignal.timeout = originalTimeout; }
  });
});

test('diagnostic labels reject arbitrary paths, codes, operations and methods', async () => {
  await capture(async entries => {
    upstreamFailure('storage', token, performance.now(), {code: token, kind: token});
    assert.equal(entries.length, 0);
    requestFailure('/api/lobby?token=' + token, token, performance.now(), 999, token);
    assert.equal(entries[0].route, 'unknown');
    assert.equal(entries[0].method, 'OTHER');
    assert.equal(entries[0].code, 'SERVICE_UNAVAILABLE');
    assert.equal(entries[0].status, 503);
    assert.equal(JSON.stringify(entries).includes(token), false);
  });
});

test('request diagnostics expose only bounded query shape and fixed processing phases', async () => {
  await capture(async entries => {
    requestFailure('/api/lobby', 'GET', performance.now(), 400, 'INVALID_INPUT', {
      phase: 'query', hasPathCapture: true, pathMatchesRoute: true, queryKeyCount: 1, otherQueryCount: 0,
      query: token, member: member.name, path: token
    });
    assert.equal(entries[0].phase, 'query');
    assert.equal(entries[0].hasPathCapture, true);
    assert.equal(entries[0].pathMatchesRoute, true);
    assert.equal(entries[0].queryKeyCount, 1);
    assert.equal(entries[0].otherQueryCount, 0);
    assert.equal(JSON.stringify(entries).includes(token), false);
    assert.equal(JSON.stringify(entries).includes(member.name), false);
    requestFailure('/api/lobby', 'GET', performance.now(), 400, 'INVALID_INPUT', {
      phase: token, hasPathCapture: token, pathMatchesRoute: 1, queryKeyCount: 513, otherQueryCount: -1
    });
    assert.equal(Object.hasOwn(entries[1], 'phase'), false);
    assert.equal(Object.hasOwn(entries[1], 'queryKeyCount'), false);
    assert.equal(Object.hasOwn(entries[1], 'otherQueryCount'), false);
    assert.equal(Object.hasOwn(entries[1], 'hasPathCapture'), false);
    assert.equal(Object.hasOwn(entries[1], 'pathMatchesRoute'), false);
  });
});

test('router logs pre-RPC rejections using normalized route without the query, body or origin', async () => {
  await capture(async entries => {
    const handler = createHandler({getConfig: () => config});
    const response = {setHeader() {}, end(body) { this.body = body; this.writableEnded = true; }};
    await handler({url: '/api/index?route=lobby%2Fheartbeat', query: {route: 'lobby/heartbeat'}, method: 'POST',
      headers: {origin: 'https://private-origin.example', host: 'localhost'}, body: {token, name: member.name}}, response);
    assert.equal(response.statusCode, 403);
    assert.equal(entries[0].route, 'lobby/heartbeat');
    assert.equal(entries[0].code, 'ORIGIN_REJECTED');
    assert.equal(JSON.stringify(entries).includes('private-origin'), false);
    assert.equal(JSON.stringify(entries).includes(token), false);
    assert.equal(JSON.stringify(entries).includes(member.name), false);
  });
});

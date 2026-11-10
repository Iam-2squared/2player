'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createServer} = require('../scripts/dev.cjs');
const {HttpError} = require('../server/errors.cjs');
const {lobbyDTO, requestUrl} = require('../server/router.cjs');
const physics = require('../public/physics.js');

const member = {id: '11111111-1111-4111-8111-111111111111', name: '自分'};
const other = {memberId: '22222222-2222-4222-8222-222222222222', name: '相手'};
const matchId = '33333333-3333-4333-8333-333333333333';
const invitationId = '44444444-4444-4444-8444-444444444444';
const token = 'A'.repeat(43), secondToken = 'B'.repeat(43);
const wallet = {balance: 1000, totalIncome: 1000, spent: 0, walletRevision: 1, gameNet: 0, escrow: 0};
const now = '2026-11-09T12:00:00.000Z';
function snapshot(extra = {}) {
  return {ok: true, wallet, match: null, lobby: {online: [{...other, busy: false}], queue: null, incoming: [], outgoing: []}, ...extra};
}
function match() {
  return {id: matchId, code: 'SECRET', status: 'waiting', version: 2, round: 1, turn: 'host', mode: 'alternating', state: physics.initialState(),
    scores: {host: 0, guest: 0}, host: {memberId: member.id, name: member.name, offer: 100, formation: 0, ready: false},
    guest: {...other, offer: 100, formation: 0, ready: false}};
}
async function fixture(t, overrides = {}) {
  const calls = [], identityCalls = []; let authCount = 0;
  const config = {test: true, origins: [], cookieSecret: 'c'.repeat(40), sessionCookie: 'two_player_session', attemptCookie: 'two_player_attempt'};
  const server = createServer({getConfig: () => config,
    identity: {requireMember: async req => {
      authCount++;
      if (![token, secondToken].some(value => req.headers.cookie === 'two_player_session=' + value)) throw new HttpError(401, 'ログインしてください。', 'AUTHENTICATION_REQUIRED');
      return member;
    }, callIdentity: async (action, input) => { identityCalls.push({action, input}); return {ok: true}; }},
    rpc: async (action, input) => { calls.push({transport: 'game', action, input}); return {ok: true, wallet, match: match()}; },
    lobbyRpc: async (action, input) => { calls.push({transport: 'lobby', action, input}); return action === 'logout' ? {ok: true} : snapshot(); },
    ...overrides});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port; config.origins = [base];
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (route, body, headers = {}) => fetch(base + '/api/' + route, {method: body === undefined ? 'GET' : 'POST',
    headers: {origin: base, cookie: 'two_player_session=' + token, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {request, calls, identityCalls, authCount: () => authCount, config};
}

test('lobby actions require same-origin verified identity before any presence or matching write', async t => {
  const f = await fixture(t);
  for (const [route, body] of [['lobby/heartbeat', {}], ['lobby/leave', {}], ['queue', {requestId: crypto.randomUUID(), stake: 100, formation: 0}],
    ['challenge', {requestId: crypto.randomUUID(), targetId: other.memberId, stake: 100, formation: 0}]]) {
    assert.equal((await f.request(route, body, {origin: 'https://foreign.invalid'})).status, 403);
  }
  assert.equal(f.authCount(), 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.request('lobby', undefined, {cookie: ''})).status, 401);
  assert.equal((await f.request('queue/cancel', {requestId: crypto.randomUUID()}, {cookie: ''})).status, 401);
  assert.equal(f.calls.length, 0);
});

test('server-derived session hashes distinguish devices without leaking opaque KGS tokens', async t => {
  const f = await fixture(t);
  for (const value of [token, secondToken]) assert.equal((await f.request('lobby/heartbeat', {}, {cookie: 'two_player_session=' + value})).status, 200);
  assert.deepEqual(f.calls.map(value => value.action), ['heartbeat', 'heartbeat']);
  for (let i = 0; i < 2; i++) {
    const input = f.calls[i].input;
    assert.deepEqual(Object.keys(input).sort(), ['memberId', 'name', 'sessionId']);
    assert.equal(input.memberId, member.id); assert.equal(input.name, member.name);
    assert.equal(input.sessionId, crypto.createHmac('sha256', f.config.cookieSecret).update('two-player-lobby-session\0' + [token, secondToken][i]).digest('hex'));
    assert.equal(JSON.stringify(input).includes([token, secondToken][i]), false);
  }
  assert.notEqual(f.calls[0].input.sessionId, f.calls[1].input.sessionId);
  assert.equal((await f.request('lobby/heartbeat', {sessionId: 'x'.repeat(64)})).status, 400);
  assert.equal(f.calls.length, 2);
});

test('authenticated Vercel source captures reach lobby and heartbeat without weakening query checks', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('index?route=lobby&path=lobby')).status, 200);
  assert.equal((await f.request('index?route=lobby%2Fheartbeat&path=lobby%2Fheartbeat', {})).status, 200);
  assert.deepEqual(f.calls.map(call => call.action), ['snapshot', 'heartbeat']);
  assert.equal(f.authCount(), 2);
  for (const call of f.calls) {
    assert.equal(call.input.memberId, member.id);
    assert.equal(call.input.name, member.name);
    assert.match(call.input.sessionId, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(call.input).sort(), ['memberId', 'name', 'sessionId']);
  }
  for (const query of ['route=lobby&path=logout', 'route=lobby&path=lobby&path=lobby',
    'route=lobby&path=lobby&memberId=' + other.memberId, 'route=lobby&path=lobby&unexpected=1', 'path=lobby']) {
    assert.equal((await f.request('index?' + query)).status, query === 'path=lobby' ? 404 : 400);
  }
  assert.equal((await f.request('index?route=lobby%2Fheartbeat&path=lobby%2Fheartbeat', {memberId: other.memberId})).status, 400);
  assert.equal((await f.request('index?route=lobby%2Fheartbeat&path=lobby%2Fheartbeat', {}, {origin: 'https://foreign.invalid'})).status, 403);
  assert.equal((await f.request('index?route=lobby&path=lobby', undefined, {cookie: ''})).status, 401);
  assert.equal(f.calls.length, 2);
});

test('challenge and queue inputs bind actor, bound preferences and reject self or forged authority', async t => {
  const f = await fixture(t);
  const valid = {requestId: crypto.randomUUID(), targetId: other.memberId, stake: 100, formation: 2};
  for (const extra of [{memberId: other.memberId}, {name: 'forged'}, {sessionId: 'x'.repeat(64)}, {winner: 'host'}, {code: 'ABCDEF'}]) {
    assert.equal((await f.request('challenge', {...valid, ...extra})).status, 400);
  }
  for (const value of [member.id, member.id.toUpperCase(), 'missing']) assert.equal((await f.request('challenge', {...valid, targetId: value})).status, 400);
  for (const stake of [0, 99, 101, 100001, 10000000000100, Number.MAX_SAFE_INTEGER + 1, '100']) assert.equal((await f.request('queue', {requestId: crypto.randomUUID(), stake, formation: 0})).status, 400);
  for (const formation of [-1, 3, 1.5, '1']) assert.equal((await f.request('queue', {requestId: crypto.randomUUID(), stake: 100, formation})).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('challenge', valid)).status, 200);
  assert.equal(f.calls[0].action, 'challenge');
  assert.deepEqual(Object.fromEntries(Object.entries(f.calls[0].input).filter(([key]) => key !== 'sessionId')), {...valid, memberId: member.id, name: member.name});
  assert.equal((await f.request('queue', {requestId: crypto.randomUUID(), stake: 200, formation: 1})).status, 200);
  assert.equal(f.calls[1].action, 'queue');
});

test('accept preserves the receiver preferences; decline and cancel cannot assert funding or a target', async t => {
  const f = await fixture(t);
  const input = {requestId: crypto.randomUUID(), invitationId, stake: 1000, formation: 2};
  assert.equal((await f.request('challenge/accept', {requestId: input.requestId, invitationId})).status, 400);
  assert.equal((await f.request('challenge/accept', {...input, ready: true})).status, 400);
  assert.equal((await f.request('challenge/accept', input)).status, 200);
  assert.equal(f.calls[0].action, 'accept'); assert.equal(f.calls[0].input.stake, 1000); assert.equal(f.calls[0].input.formation, 2);
  for (const [route, action] of [['challenge/decline', 'decline'], ['challenge/cancel', 'invite_cancel'], ['queue/cancel', 'queue_cancel']]) {
    const body = {requestId: crypto.randomUUID(), ...(action === 'queue_cancel' ? {} : {invitationId})};
    assert.equal((await f.request(route, {...body, memberId: other.memberId})).status, 400);
    assert.equal((await f.request(route, body)).status, 200);
    assert.equal(f.calls.at(-1).action, action);
  }
});

test('stake-only lobby clients receive the same strict actor and compatible SQL envelope', async t => {
  const f = await fixture(t);
  for (const [route, action, extra] of [['queue', 'queue', {}], ['challenge', 'challenge', {targetId: other.memberId}],
    ['challenge/accept', 'accept', {invitationId}]]) {
    const body = {requestId: crypto.randomUUID(), stake: 200, ...extra};
    assert.equal((await f.request(route, body)).status, 200);
    const call = f.calls.at(-1);
    assert.equal(call.action, action);
    assert.equal(call.input.formation, 0);
    assert.equal(call.input.stake, 200);
    assert.equal(call.input.requestId, body.requestId);
    assert.equal(call.input.memberId, member.id);
    assert.equal((await f.request(route, {...body, memberId: other.memberId})).status, 400);
  }
});

test('challenge, acceptance and queue preserve stakes above the former cap and integer range', async t => {
  const f = await fixture(t);
  for (const stake of [100100, 1000000, 3000000000, 10000000000000]) {
    for (const [route, action, extra] of [['queue', 'queue', {}], ['challenge', 'challenge', {targetId: other.memberId}],
      ['challenge/accept', 'accept', {invitationId}]]) {
      const body = {requestId: crypto.randomUUID(), stake, ...extra};
      assert.equal((await f.request(route, body)).status, 200, `${action} accepts ${stake}`);
      const call = f.calls.at(-1);
      assert.equal(call.action, action);
      assert.equal(call.input.stake, stake);
      assert.equal(call.input.formation, 0);
      assert.equal(call.input.memberId, member.id);
      assert.equal(call.input.requestId, body.requestId);
    }
  }
});

test('large queue and incoming or outgoing invitation amounts survive strict lobby DTO validation', () => {
  for (const stake of [100100, 3000000000, 10000000000000]) {
    const queue = {joinedAt: now, position: 1, stake, formation: 0};
    const invitation = {id: invitationId, stake, formation: 0, createdAt: now, expiresAt: now};
    const raw = snapshot({lobby: {online: [], queue, incoming: [{...invitation, from: other}], outgoing: [{...invitation, to: other}]}});
    const output = lobbyDTO(raw, member.id);
    assert.equal(output.lobby.queue.stake, stake);
    assert.equal(output.lobby.incoming[0].stake, stake);
    assert.equal(output.lobby.outgoing[0].stake, stake);
  }
  for (const stake of [10000000000100, Number.MAX_SAFE_INTEGER + 1, 3000000001, '3000000000']) {
    for (const direction of ['queue', 'incoming', 'outgoing']) {
      const lobby = {online: [], queue: null, incoming: [], outgoing: []};
      if (direction === 'queue') lobby.queue = {joinedAt: now, position: 1, stake, formation: 0};
      else lobby[direction] = [{id: invitationId, [direction === 'incoming' ? 'from' : 'to']: other, stake, formation: 0, createdAt: now, expiresAt: now}];
      assert.throws(() => lobbyDTO(snapshot({lobby}), member.id), error => error.code === 'INVALID_LOBBY_STATE');
    }
  }
});

test('lobby DTO excludes session, internal invitation fields, private claims and room codes', () => {
  const value = snapshot({match: {...match(), claimToken: 'private-claim'}, _processing: {secret: 'private-claim'}});
  value.lobby.online.push({memberId: member.id, name: member.name, busy: false});
  value.lobby.online[0].sessionId = 'private-session';
  value.lobby.sessionId = 'private-session'; value.lobby.requests = ['private-request'];
  value.lobby.queue = {joinedAt: now, position: 2, stake: 500, formation: 2, sessionId: 'private-session'};
  value.lobby.incoming = [{id: invitationId, from: {...other, sessionId: 'private-session'}, stake: 100, formation: 2, createdAt: now, expiresAt: now, requestId: 'private-request'}];
  const output = lobbyDTO(value, member.id), serialized = JSON.stringify(output);
  assert.deepEqual(output.lobby.online, [{...other, busy: false}]);
  assert.deepEqual(output.lobby.queue, {joinedAt: now, position: 2, stake: 500, formation: 2});
  assert.equal(output.lobby.incoming[0].from.memberId, other.memberId);
  assert.equal(serialized.includes('private-'), false); assert.equal(serialized.includes('SECRET'), false);
  assert.equal(output.match.state.players.length, 16);
  for (const invalid of [{position: 0}, {stake: 101}, {stake: '500'}, {formation: 3}, {formation: '2'}]) {
    assert.throws(() => lobbyDTO(snapshot({lobby: {online: [], incoming: [], outgoing: [],
      queue: {position: 1, joinedAt: now, stake: 500, formation: 2, ...invalid}}}), member.id), error => error.code === 'INVALID_LOBBY_STATE');
  }
});

test('match reads accept one exact authenticated selector and no mixed or duplicate identity', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('match?matchId=' + matchId)).status, 200);
  assert.deepEqual(f.calls[0], {transport: 'game', action: 'state', input: {memberId: member.id, name: member.name, matchId}});
  for (const query of ['matchId=' + matchId + '&code=ABCDEF', 'matchId=' + matchId + '&matchId=' + matchId,
    'matchId=' + matchId + '&memberId=' + member.id, 'matchId=invalid']) assert.equal((await f.request('match?' + query)).status, 400);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('lobby?memberId=' + member.id)).status, 400);
});

test('resuming a pending shot from the lobby preserves its roster while removing the private claim', async t => {
  const claim = {matchId, round: 1, version: 2, claimToken: crypto.randomUUID(), formations: [0, 0], state: physics.initialState(),
    inputs: {host: {piece: 0, angle: 0, power: 0}, guest: {piece: 0, angle: 0, power: 0}}};
  const f = await fixture(t, {lobbyRpc: async () => snapshot({match: match(), _processing: claim}),
    rpc: async action => { assert.equal(action, 'resolve'); return {ok: true, wallet, match: {...match(), round: 2, turn: 'guest'}}; }});
  const response = await f.request('lobby');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.match.round, 2); assert.deepEqual(result.lobby.online, [{...other, busy: false}]);
  assert.equal(JSON.stringify(result).includes(claim.claimToken), false);
  assert.equal(Object.hasOwn(result, '_processing'), false);
});

test('logout fences exactly the verified session before KGS logout and still clears cookies on cleanup failure', async t => {
  const events = [];
  const f = await fixture(t, {identity: {
    requireMember: async () => { events.push('verify'); return member; },
    callIdentity: async () => { events.push('kgs-logout'); throw new HttpError(503, '連携を確認してください。', 'IDENTITY_UNAVAILABLE'); }
  }, lobbyRpc: async (action, input, config, options) => {
    events.push(action); assert.equal(input.memberId, member.id); assert.match(input.sessionId, /^[a-f0-9]{64}$/); assert.equal(options.timeoutMs, 2000);
    throw new HttpError(503, '接続できません。', 'STORAGE_UNAVAILABLE');
  }});
  const response = await f.request('logout', {});
  assert.equal(response.status, 503);
  assert.deepEqual(events, ['verify', 'logout', 'kgs-logout']);
  assert.match(response.headers.get('set-cookie'), /two_player_session=;.*Max-Age=0/);
});

test('temporary leave retains the KGS cookie and cloud rewrites cover every new route', async t => {
  const f = await fixture(t);
  const response = await f.request('lobby/leave', {});
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.calls[0].action, 'leave'); assert.equal(f.identityCalls.length, 0);
  for (const route of ['lobby', 'lobby/heartbeat', 'lobby/leave', 'challenge', 'challenge/accept', 'challenge/decline', 'challenge/cancel', 'queue', 'queue/cancel']) {
    assert.equal(requestUrl({url: '/api/index?route=' + route, query: {route}}).pathname, '/api/' + route);
  }
});

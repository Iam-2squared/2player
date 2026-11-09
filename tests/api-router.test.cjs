'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const http = require('node:http');
const {createServer} = require('../scripts/dev.cjs');
const {HttpError} = require('../server/errors.cjs');
const {publicDTO, requestUrl} = require('../server/router.cjs');
const identity = require('../server/identity.cjs');
const {unpack} = require('../server/store.cjs');
const {checkOrigin} = require('../server/config.cjs');
const physics = require('../public/physics.js');

const member = {id: '22222222-2222-4222-8222-222222222222', name: 'テスト'};
const matchId = '33333333-3333-4333-8333-333333333333';
const wallet = {balance: 900, totalIncome: 1000, spent: 100, walletRevision: 3, gameNet: 0, escrow: 100};
const token = 'A'.repeat(43);
function match(extra = {}) {
  return {id: matchId, code: 'ABCDEF', status: 'playing', mode: 'alternating', turn: 'host', stake: 100, escrow: 200,
    round: 1, version: 2, scores: {host: 0, guest: 0}, state: physics.initialState(),
    host: {memberId: member.id, name: member.name, offer: 100, formation: 0, ready: true, inputLocked: false},
    guest: {memberId: randomUUID(), name: '相手', offer: 100, formation: 0, ready: true, inputLocked: false}, ...extra};
}
async function fixture(t, extra = {}) {
  const calls = [];
  let authenticated = 0;
  let base;
  const config = {test: true, origins: [], cookieSecret: 'c'.repeat(40), sessionCookie: 'two_player_session', attemptCookie: 'two_player_attempt'};
  const server = createServer({getConfig: () => config,
    identity: {requireMember: async req => { authenticated++; if (!req.headers.cookie?.includes('two_player_session=' + token)) throw new HttpError(401, 'ログインしてください。', 'AUTHENTICATION_REQUIRED'); return member; }},
    rpc: async (action, input) => { calls.push({action, input}); return {ok: true, wallet, match: match()}; }, ...extra});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  config.origins = [base];
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (route, body, headers = {}) => fetch(base + '/api/' + route, {method: body === undefined ? 'GET' : 'POST',
    headers: {origin: base, cookie: 'two_player_session=' + token, ...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {base, config, request, calls, authCount: () => authenticated};
}

test('origin rejection occurs before authentication and business calls', async t => {
  const f = await fixture(t);
  for (const headers of [{origin: 'https://evil.example'}, {'sec-fetch-site': 'cross-site'}]) {
    const response = await f.request('rooms', {requestId: randomUUID(), stake: 100}, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
  }
  assert.equal(f.authCount(), 0);
  assert.equal(f.calls.length, 0);
  assert.throws(() => checkOrigin({headers: {origin: f.base, host: 'other.example'}}, f.config), error => error.status === 403);
});

test('anonymous session is safe and protected operations require identity', async t => {
  const f = await fixture(t);
  const response = await f.request('session', undefined, {cookie: ''});
  assert.deepEqual(await response.json(), {ok: true, user: null, wallet: null});
  assert.equal((await f.request('rooms', undefined, {cookie: ''})).status, 401);
  assert.equal(f.calls.length, 0);
});

test('request bodies and content types are bounded before business writes', async t => {
  const f = await fixture(t);
  const oversized = await f.request('rooms', {requestId: randomUUID(), stake: 100, padding: 'x'.repeat(5000)});
  assert.equal(oversized.status, 413);
  const wrongType = await f.request('rooms', {requestId: randomUUID(), stake: 100}, {'content-type': 'text/plain'});
  assert.equal(wrongType.status, 415);
  assert.equal(f.calls.length, 0);
});

test('client winners, state, actor IDs and processing claims cannot reach RPC', async t => {
  const f = await fixture(t);
  const input = {requestId: randomUUID(), matchId, round: 1, version: 2, piece: 0, angle: 270, power: 80};
  for (const field of ['winner', 'state', 'memberId', 'claimToken']) {
    const response = await f.request('input', {...input, [field]: 'forged'});
    assert.equal(response.status, 400);
  }
  for (const bad of [{angle: 360}, {power: -1}, {power: 1.5}, {round: 41}, {version: 1}, {piece: -1}, {piece: 8}, {piece: 1.5}]) {
    assert.equal((await f.request('input', {...input, ...bad})).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('formation choices are authenticated, bounded and bind the acting member', async t => {
  const f = await fixture(t);
  const input = {requestId: randomUUID(), matchId, formation: 2};
  assert.equal((await f.request('formation', input, {cookie: ''})).status, 401);
  assert.equal((await f.request('formation', input, {origin: 'https://evil.example'})).status, 403);
  for (const value of [-1, 3, 1.5, '1']) assert.equal((await f.request('formation', {...input, formation: value})).status, 400);
  assert.equal((await f.request('formation', {...input, memberId: randomUUID()})).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('formation', input)).status, 200);
  assert.deepEqual(f.calls[0], {action: 'formation', input: {...input, memberId: member.id, name: member.name}});
});

test('stake and request identifiers are validated while authenticated actors are bound', async t => {
  const f = await fixture(t);
  for (const stake of [0, 101, 100001, '100']) assert.equal((await f.request('rooms', {requestId: randomUUID(), stake})).status, 400);
  assert.equal((await f.request('rooms', {requestId: 'same', stake: 100})).status, 400);
  const id = randomUUID();
  const response = await f.request('rooms', {requestId: id, stake: 100});
  assert.equal(response.status, 200);
  assert.deepEqual(f.calls[0], {action: 'create', input: {requestId: id, stake: 100, memberId: member.id, name: member.name}});
});

test('one active flick is simulated on the server and resolution secrets are withheld', async t => {
  const calls = [];
  const initial = physics.initialState();
  const claim = {matchId, round: 1, version: 2, claimToken: randomUUID(), state: initial, inputs: {host: {piece: 0, angle: 270, power: 80}, guest: {piece: 0, angle: 0, power: 0}}};
  const f = await fixture(t, {rpc: async (action, input) => {
    calls.push({action, input});
    if (action === 'input') return {ok: true, wallet, match: match({status: 'processing'}), _processing: claim};
    return {ok: true, wallet, match: match({turn: 'guest', round: 2, lastRound: {...input, inputs: claim.inputs}, claimToken: claim.claimToken}), _processing: {secret: true}};
  }});
  const response = await f.request('input', {requestId: randomUUID(), matchId, round: 1, version: 2, piece: 0, angle: 270, power: 80});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(calls.map(call => call.action), ['input', 'resolve']);
  const expected = physics.simulate(initial, [claim.inputs.host, claim.inputs.guest]);
  assert.deepEqual(calls[1].input.state, expected.state);
  assert.deepEqual(calls[1].input.frames, expected.frames);
  assert.equal(calls[1].input.claimToken, claim.claimToken);
  assert.equal(result.match.turn, 'guest');
  assert.equal(result.match.lastRound.frames.length, expected.frames.length);
  assert.equal(JSON.stringify(result).includes(claim.claimToken), false);
  assert.equal(Object.hasOwn(result, '_processing'), false);
});

test('only the server claim chooses the piece and formations used for simulation', async t => {
  const formations = [2, 1];
  const initial = physics.initialState(formations);
  const calls = [];
  const claim = {matchId, round: 1, version: 2, claimToken: randomUUID(), state: initial, formations,
    inputs: {host: {piece: 7, angle: 270, power: 80}, guest: {piece: 0, angle: 0, power: 0}}};
  const f = await fixture(t, {rpc: async (action, input) => {
    calls.push({action, input});
    return action === 'input' ? {ok: true, wallet, match: match(), _processing: claim} : {ok: true, wallet, match: match()};
  }, simulate: (state, inputs, actualFormations) => {
    assert.deepEqual(state, initial);
    assert.deepEqual(inputs, [claim.inputs.host, claim.inputs.guest]);
    assert.deepEqual(actualFormations, formations);
    return {state: initial, frames: [initial], goal: null};
  }});
  const response = await f.request('input', {requestId: randomUUID(), matchId, round: 1, version: 2, piece: 3, angle: 10, power: 20});
  assert.equal(response.status, 200);
  assert.equal(calls[0].input.piece, 3);
  assert.equal(calls[1].action, 'resolve');
});

test('polling resumes a leased pending shot after a cold start', async t => {
  const actions = [];
  const f = await fixture(t, {rpc: async action => {
    actions.push(action);
    return action === 'state' ? {ok: true, wallet, match: match(), _processing: {matchId, round: 1, version: 2, claimToken: randomUUID(),
      state: physics.initialState(), inputs: {host: {piece: 0, angle: 270, power: 30}, guest: {piece: 0, angle: 0, power: 0}}}} : {ok: true, wallet, match: match({round: 2, turn: 'guest'})};
  }});
  assert.equal((await f.request('match?code=ABCDEF')).status, 200);
  assert.deepEqual(actions, ['state', 'resolve']);
});

test('DTO allowlists omit unpublished inputs and limit summaries', () => {
  const raw = match({inputs: {host: {power: 99}}, claimToken: 'private', _processing: {secret: true}});
  raw.state.ball.secret = 'private';
  raw.host.pin = '1234';
  const result = publicDTO({ok: true, wallet: {...wallet, internal: 'private'}, match: raw, _processing: {secret: 'private'}, rooms: Array.from({length: 25}, () => raw)});
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('1234'), false);
  assert.equal(result.rooms.length, 20);
  assert.equal(result.match.escrow, 200);
  assert.deepEqual(result.match.formations, [0, 0]);
  assert.equal(result.match.state.players.length, 16);
});

test('identity cookies are host only, HttpOnly and Secure in production', () => {
  const headers = new Map();
  const res = {getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value)};
  identity.setSession(res, token, new Date(Date.now() + 3600000).toISOString(), {test: false, sessionCookie: '__Host-two_player_session'});
  const cookie = headers.get('Set-Cookie')[0];
  assert.match(cookie, /^__Host-two_player_session=/);
  assert.match(cookie, /; HttpOnly; SameSite=Strict;/);
  assert.match(cookie, /; Secure$/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.equal(identity.sessionToken({headers: {cookie: 'a=x; two_player_session=' + token + '; two_player_session=' + token}}, {sessionCookie: 'two_player_session'}), null);
});

test('database error mapping preserves safe statuses and refuses untyped success', () => {
  assert.throws(() => unpack({error: {status: 409, code: 'OUT_OF_TURN', message: '相手の番です。'}}), error => error.status === 409 && error.code === 'OUT_OF_TURN');
  assert.throws(() => unpack({ok: false}), error => error.status === 503);
});

test('unknown paths and methods do not invoke business RPC', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('resolve', {requestId: randomUUID(), winner: 'host'})).status, 404);
  assert.equal((await f.request('session', {})).status, 405);
  assert.equal(f.calls.length, 0);
});

test('malformed HTTP request targets cannot terminate the development server', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.base, {path: 'http://['}, response => { response.resume(); resolve(response.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await f.request('session')).status, 200);
});

test('Vercel rewrite metadata is normalized exactly and duplicate routes are rejected', () => {
  assert.equal(requestUrl({url: '/api/index?route=match&code=ABCDEF', query: {route: 'match', code: 'ABCDEF'}}).pathname, '/api/match');
  assert.equal(requestUrl({url: '/api/index?route=match&code=ABCDEF'}).search, '?code=ABCDEF');
  assert.equal(requestUrl({url: '/api/index', query: {route: 'session'}}).pathname, '/api/session');
  assert.equal(requestUrl({url: '/api/index?route=formation'}).pathname, '/api/formation');
  for (const req of [{url: '/api/index?route=login&route=logout'}, {url: '/api/index?route=session', query: {route: ['session']}},
    {url: '/api/index?route=session', query: {route: 'logout'}}, {url: '/api/index?route=../session'}, {url: '/api/rooms?route=session'}]) assert.throws(() => requestUrl(req));
});

test('the actual Vercel entry accepts a rewritten anonymous session request', async () => {
  const settings = {NODE_ENV: 'test', TWO_PLAYER_RPC_SECRET: 'r'.repeat(40), TWO_PLAYER_COOKIE_SECRET: 'c'.repeat(40),
    TWO_PLAYER_KGS_INTEGRATION_SECRET: 'i'.repeat(40), KGS_IDENTITY_URL: 'http://127.0.0.1:5001', TWO_PLAYER_ALLOWED_ORIGINS: 'http://127.0.0.1:5000',
    TWO_PLAYER_DATABASE_URL: 'postgres://test:test@127.0.0.1/two_player_api_test'};
  const previous = Object.fromEntries([...Object.keys(settings), 'VERCEL'].map(key => [key, process.env[key]]));
  Object.assign(process.env, settings); delete process.env.VERCEL;
  try {
    const response = {headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = JSON.parse(body); this.writableEnded = true; }};
    await require('../api/index.js')({url: '/api/index?route=session', query: {route: 'session'}, method: 'GET', headers: {host: '127.0.0.1:5000'}}, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {ok: true, user: null, wallet: null});
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

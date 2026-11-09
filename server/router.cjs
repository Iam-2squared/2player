'use strict';
const crypto = require('node:crypto');
const {getConfig, checkOrigin, checkReadOrigin} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
const {securityHeaders, readJson, sendJson} = require('./http.cjs');
const identity = require('./identity.cjs');
const store = require('./store.cjs');

function invalid() { return new HttpError(400, '送信内容を確認してください。', 'INVALID_INPUT'); }
function exact(body, keys) {
  if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw invalid();
}
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function uuid(value) { return typeof value === 'string' && identity.UUID.test(value); }
function stake(value) { return integer(value, 100, 100000) && value % 100 === 0; }
function code(value) { return typeof value === 'string' && /^[A-Z0-9]{6,10}$/.test(value); }
function mutationInput(action, body) {
  const fields = {create: ['stake'], join: ['code'], offer: ['matchId', 'stake'], ready: ['matchId', 'ready'],
    input: ['matchId', 'round', 'version', 'piece', 'angle', 'power'], formation: ['matchId', 'formation'], cancel: ['matchId']}[action];
  exact(body, ['requestId', ...fields]);
  if (!uuid(body.requestId) || (fields.includes('matchId') && !uuid(body.matchId)) ||
      (fields.includes('stake') && !stake(body.stake)) || (fields.includes('code') && !code(body.code)) ||
      (action === 'formation' && !integer(body.formation, 0, 2)) ||
      (action === 'ready' && body.ready !== true) || (action === 'input' &&
      (!integer(body.round, 1, 40) || body.version !== 2 || !integer(body.piece, 0, 7) || !integer(body.angle, 0, 359) || !integer(body.power, 0, 100)))) throw invalid();
  return body;
}
function select(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
  return Object.fromEntries(keys.filter(key => Object.hasOwn(object, key)).map(key => [key, object[key]]));
}
function stateDTO(state) {
  if (!state || !Array.isArray(state.players) || state.players.length !== 16 || !state.ball) return null;
  const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y) ? {x: value.x, y: value.y} : null;
  const players = state.players.map(point), ball = point(state.ball);
  return ball && players.every(Boolean) ? {players, ball} : null;
}
function matchDTO(match, summary = false) {
  if (!match) return null;
  const result = select(match, ['id', 'code', 'status', 'mode', 'turn', 'stake', 'escrow', 'round', 'version', 'winner', 'reason', 'expiresAt', 'createdAt', 'updatedAt']);
  for (const seat of ['host', 'guest']) result[seat] = select(match[seat], ['memberId', 'name', 'offer', 'formation', 'ready', 'inputLocked', 'cancelRequested']);
  result.formations = [match.host?.formation ?? 0, match.guest?.formation ?? 0];
  result.scores = select(match.scores, ['host', 'guest']);
  result.state = stateDTO(match.state);
  if (!summary && match.lastRound) {
    result.lastRound = select(match.lastRound, ['round', 'version', 'goal', 'resultHash']);
    result.lastRound.state = stateDTO(match.lastRound.state);
    // Inputs are revealed only in a completed round, never from a pending claim.
    result.lastRound.inputs = {host: select(match.lastRound.inputs?.host, ['piece', 'angle', 'power']), guest: select(match.lastRound.inputs?.guest, ['piece', 'angle', 'power'])};
    if (Array.isArray(match.lastRound.frames) && match.lastRound.frames.length <= 181) {
      result.lastRound.frames = match.lastRound.frames.map(stateDTO);
      if (result.lastRound.frames.some(frame => !frame)) throw new HttpError(503, '対戦データを確認できませんでした。', 'INVALID_MATCH_STATE');
    }
  }
  return result;
}
function publicDTO(result) {
  const output = {ok: true};
  if (Object.hasOwn(result, 'wallet')) output.wallet = select(result.wallet, ['balance', 'totalIncome', 'spent', 'walletRevision', 'gameNet', 'escrow']);
  if (Object.hasOwn(result, 'match')) output.match = matchDTO(result.match);
  if (Array.isArray(result.rooms)) output.rooms = result.rooms.slice(0, 20).map(room => matchDTO(room, true));
  return output;
}
function resolutionId(claim) {
  const hex = crypto.createHash('sha256').update('two-player-resolution\0' + claim.claimToken).digest('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}
function requestUrl(req) {
  if (typeof req.url !== 'string' || req.url.length > 1024) throw new HttpError(414, 'URLが長すぎます。', 'URL_TOO_LONG');
  const url = new URL(req.url, 'http://localhost');
  const routes = url.searchParams.getAll('route');
  const metadata = req.query?.route;
  if (routes.length > 1 || (metadata !== undefined && typeof metadata !== 'string')) throw invalid();
  if (routes.length && metadata !== undefined && routes[0] !== metadata) throw invalid();
  const route = routes[0] ?? metadata;
  if (route !== undefined) {
    if (!/^(?:session|login|logout|rooms|rooms\/join|match|offer|ready|formation|input|cancel)$/.test(route)) throw invalid();
    const pathname = '/api/' + route;
    if (!['/api/index', '/api/index.js', pathname].includes(url.pathname)) throw invalid();
    url.pathname = pathname;
    url.searchParams.delete('route');
  }
  return url;
}
function createHandler(overrides = {}) {
  const configFor = overrides.getConfig || getConfig;
  const auth = {...identity, ...overrides.identity};
  const rpc = overrides.rpc || store.rpc;
  const simulate = overrides.simulate || ((state, inputs, formations) => require('../public/physics.js').simulate(state, inputs, formations));
  async function processResult(result, member, config) {
    if (!result._processing) return result;
    const claim = result._processing;
    if (!claim || claim.version !== 2 || !uuid(claim.matchId) || !integer(claim.round, 1, 40) ||
        typeof claim.claimToken !== 'string' || claim.claimToken.length > 200 || !claim.inputs?.host || !claim.inputs?.guest) {
      throw new HttpError(503, '対戦データを確認できませんでした。', 'INVALID_MATCH_STATE');
    }
    const formations = claim.formations ?? [result.match?.host?.formation ?? 0, result.match?.guest?.formation ?? 0];
    if (!Array.isArray(formations) || formations.length !== 2 || formations.some(value => !integer(value, 0, 2))) {
      throw new HttpError(503, '対戦データを確認できませんでした。', 'INVALID_MATCH_STATE');
    }
    const outcome = simulate(claim.state, [claim.inputs.host, claim.inputs.guest], formations);
    if (!stateDTO(outcome.state) || !Array.isArray(outcome.frames) || outcome.frames.length > 181 ||
        ![0, 1, null].includes(outcome.goal) || Buffer.byteLength(JSON.stringify(outcome.frames)) > 220 * 1024) {
      throw new HttpError(503, '対戦の計算を完了できませんでした。', 'SIMULATION_UNAVAILABLE');
    }
    return rpc('resolve', {memberId: member.id, name: member.name, requestId: resolutionId(claim),
      matchId: claim.matchId, round: claim.round, version: claim.version, claimToken: claim.claimToken,
      state: outcome.state, frames: outcome.frames, goal: outcome.goal === 0 ? 'host' : outcome.goal === 1 ? 'guest' : null}, config);
  }
  return async function handler(req, res) {
    securityHeaders(res);
    try {
      const url = requestUrl(req);
      const routes = {'/api/session': ['GET'], '/api/login': ['POST'], '/api/logout': ['POST'], '/api/rooms': ['GET', 'POST'],
        '/api/rooms/join': ['POST'], '/api/match': ['GET'], '/api/offer': ['POST'], '/api/ready': ['POST'], '/api/formation': ['POST'], '/api/input': ['POST'], '/api/cancel': ['POST']};
      const allowed = routes[url.pathname];
      if (!allowed) throw new HttpError(404, '見つかりません。', 'NOT_FOUND');
      if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); throw new HttpError(405, 'この操作には対応していません。', 'METHOD_NOT_ALLOWED'); }
      const config = configFor();
      if (req.method === 'POST') checkOrigin(req, config); else checkReadOrigin(req, config);
      if (url.pathname === '/api/session' && !auth.sessionToken(req, config)) return sendJson(res, 200, {ok: true, user: null, wallet: null});
      if (url.pathname === '/api/login') {
        const body = await readJson(req);
        exact(body, ['attendanceNo', 'pin']);
        const attendanceNo = typeof body.attendanceNo === 'string' && /^\d{1,2}$/.test(body.attendanceNo) ? Number(body.attendanceNo) : body.attendanceNo;
        if ((!integer(attendanceNo, 1, 40) && attendanceNo !== 99) || typeof body.pin !== 'string' || !/^\d{4}$/.test(body.pin)) throw invalid();
        const result = await auth.callIdentity('login', {attendanceNumber: attendanceNo, accountPin: body.pin, attemptId: auth.attemptIdentity(req, res, config)}, config);
        auth.setSession(res, result.token, result.expiresAt, config);
        const wallet = await rpc('wallet', {memberId: result.member.id, name: result.member.name}, config);
        return sendJson(res, 200, {...publicDTO(wallet), user: result.member});
      }
      if (url.pathname === '/api/logout') {
        const body = await readJson(req); exact(body, []);
        const token = auth.sessionToken(req, config);
        try { if (token) await auth.callIdentity('logout', {token}, config); }
        finally { auth.clearSession(res, config); }
        return sendJson(res, 200, {ok: true});
      }
      const member = await auth.requireMember(req, res, config);
      const actor = {memberId: member.id, name: member.name};
      if (url.pathname === '/api/session') return sendJson(res, 200, {...publicDTO(await rpc('wallet', actor, config)), user: member});
      if (url.pathname === '/api/rooms' && req.method === 'GET') return sendJson(res, 200, publicDTO(await rpc('list', actor, config)));
      if (url.pathname === '/api/match') {
        const roomCode = url.searchParams.get('code');
        if (!code(roomCode) || [...url.searchParams.keys()].some(key => key !== 'code') || url.searchParams.getAll('code').length !== 1) throw invalid();
        const result = await rpc('state', {...actor, code: roomCode}, config);
        return sendJson(res, 200, publicDTO(await processResult(result, member, config)));
      }
      const action = {'/api/rooms': 'create', '/api/rooms/join': 'join', '/api/offer': 'offer', '/api/ready': 'ready', '/api/formation': 'formation', '/api/input': 'input', '/api/cancel': 'cancel'}[url.pathname];
      const input = mutationInput(action, await readJson(req));
      const result = await rpc(action, {...input, ...actor}, config);
      return sendJson(res, 200, publicDTO(await processResult(result, member, config)));
    } catch (error) {
      const known = error instanceof HttpError;
      if (known && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!res.writableEnded) sendJson(res, known ? error.status : 503, {ok: false, error: {
        code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '処理を完了できませんでした。時間をおいて再試行してください。'}});
    }
  };
}
module.exports = {createHandler, mutationInput, publicDTO, stateDTO, requestUrl};

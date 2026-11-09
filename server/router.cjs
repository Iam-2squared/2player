'use strict';
const crypto = require('node:crypto');
const {getConfig, checkOrigin, checkReadOrigin} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
const {securityHeaders, readJson, sendJson} = require('./http.cjs');
const identity = require('./identity.cjs');
const store = require('./store.cjs');
const {requestFailure} = require('./diagnostics.cjs');
const {requestConfig} = require('./deadline.cjs');

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
function lobbyInput(action, body, memberId) {
  const fields = {snapshot: [], heartbeat: [], leave: [], challenge: ['requestId', 'targetId', 'stake', 'formation'],
    accept: ['requestId', 'invitationId', 'stake', 'formation'], decline: ['requestId', 'invitationId'],
    invite_cancel: ['requestId', 'invitationId'], queue: ['requestId', 'stake', 'formation'], queue_cancel: ['requestId']}[action];
  if (!fields) throw invalid();
  exact(body, fields);
  if ((fields.includes('requestId') && !uuid(body.requestId)) ||
      (fields.includes('targetId') && (!uuid(body.targetId) || body.targetId.toLowerCase() === memberId.toLowerCase())) ||
      (fields.includes('invitationId') && !uuid(body.invitationId)) ||
      (fields.includes('stake') && !stake(body.stake)) ||
      (fields.includes('formation') && !integer(body.formation, 0, 2))) throw invalid();
  return body;
}
function lobbyActor(req, member, config, auth = identity) {
  const token = auth.sessionToken(req, config);
  if (!identity.TOKEN.test(token || '')) throw new HttpError(401, 'ログインしてください。', 'AUTHENTICATION_REQUIRED');
  return {memberId: member.id, name: member.name, sessionId: crypto.createHmac('sha256', config.cookieSecret)
    .update('two-player-lobby-session\0' + token).digest('hex')};
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
function lobbyDTO(result, memberId) {
  const failed = () => new HttpError(503, '対戦相手を確認できませんでした。', 'INVALID_LOBBY_STATE');
  const value = result?.lobby;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.online) || value.online.length > 100 ||
      !Array.isArray(value.incoming) || value.incoming.length > 50 || !Array.isArray(value.outgoing) || value.outgoing.length > 50) throw failed();
  const person = raw => {
    if (!raw || !uuid(raw.memberId) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 20) throw failed();
    return {memberId: raw.memberId, name: raw.name};
  };
  const timestamp = raw => { if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) throw failed(); return raw; };
  const invitation = (raw, direction) => {
    if (!raw || !uuid(raw.id) || !stake(raw.stake) || !integer(raw.formation, 0, 2)) throw failed();
    return {id: raw.id, [direction]: person(raw[direction]), stake: raw.stake, formation: raw.formation,
      createdAt: timestamp(raw.createdAt), expiresAt: timestamp(raw.expiresAt)};
  };
  const online = value.online.map(raw => {
    if (typeof raw?.busy !== 'boolean') throw failed();
    return {...person(raw), busy: raw.busy};
  }).filter(raw => raw.memberId.toLowerCase() !== memberId.toLowerCase());
  if (new Set(online.map(raw => raw.memberId.toLowerCase())).size !== online.length) throw failed();
  let queue = null;
  if (value.queue !== null) {
    if (!value.queue || !integer(value.queue.position, 1, 500) || !stake(value.queue.stake) ||
        !integer(value.queue.formation, 0, 2)) throw failed();
    queue = {joinedAt: timestamp(value.queue.joinedAt), position: value.queue.position,
      stake: value.queue.stake, formation: value.queue.formation};
  }
  const output = publicDTO({...(Object.hasOwn(result, 'wallet') ? {wallet: result.wallet} : {}),
    ...(Object.hasOwn(result, 'match') ? {match: result.match} : {})});
  if (output.match) delete output.match.code;
  output.lobby = {online, queue, incoming: value.incoming.map(raw => invitation(raw, 'from')),
    outgoing: value.outgoing.map(raw => invitation(raw, 'to'))};
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
    if (!/^(?:session|login|logout|rooms|rooms\/join|match|offer|ready|formation|input|cancel|lobby(?:\/(?:heartbeat|leave))?|challenge(?:\/(?:accept|decline|cancel))?|queue(?:\/cancel)?)$/.test(route)) throw invalid();
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
  const lobbyRpc = overrides.lobbyRpc || store.lobbyRpc;
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
    const started = performance.now();
    let diagnosticPath;
    const diagnosticContext = {phase: 'auth'};
    try {
      const url = requestUrl(req);
      diagnosticPath = url.pathname;
      const captures = url.searchParams.getAll('path');
      diagnosticContext.hasPathCapture = captures.length > 0;
      diagnosticContext.pathMatchesRoute = captures.length === 1 && captures[0] === url.pathname.slice(5);
      diagnosticContext.queryKeyCount = url.searchParams.size;
      diagnosticContext.otherQueryCount = url.searchParams.size - captures.length;
      const routes = {'/api/session': ['GET'], '/api/login': ['POST'], '/api/logout': ['POST'], '/api/rooms': ['GET', 'POST'],
        '/api/rooms/join': ['POST'], '/api/match': ['GET'], '/api/offer': ['POST'], '/api/ready': ['POST'], '/api/formation': ['POST'], '/api/input': ['POST'], '/api/cancel': ['POST'],
        '/api/lobby': ['GET'], '/api/lobby/heartbeat': ['POST'], '/api/lobby/leave': ['POST'], '/api/challenge': ['POST'],
        '/api/challenge/accept': ['POST'], '/api/challenge/decline': ['POST'], '/api/challenge/cancel': ['POST'], '/api/queue': ['POST'], '/api/queue/cancel': ['POST']};
      const allowed = routes[url.pathname];
      if (!allowed) throw new HttpError(404, '見つかりません。', 'NOT_FOUND');
      if (!allowed.includes(req.method)) { res.setHeader('Allow', allowed.join(', ')); throw new HttpError(405, 'この操作には対応していません。', 'METHOD_NOT_ALLOWED'); }
      const config = requestConfig(configFor());
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
        try {
          if (token) {
            // Verify the actor before touching presence. A per-session tombstone
            // prevents a heartbeat already waiting on the database from reviving
            // this session after logout. Cleanup failure never traps the cookie.
            try {
              const member = await auth.requireMember(req, res, config);
              await lobbyRpc('logout', lobbyActor(req, member, config, auth), config, {timeoutMs: 2000});
            } catch { /* Presence also expires without heartbeats. */ }
            await auth.callIdentity('logout', {token}, config);
          }
        }
        finally { auth.clearSession(res, config); }
        return sendJson(res, 200, {ok: true});
      }
      const member = await auth.requireMember(req, res, config);
      const actor = {memberId: member.id, name: member.name};
      const lobbyAction = {'/api/lobby': 'snapshot', '/api/lobby/heartbeat': 'heartbeat', '/api/lobby/leave': 'leave',
        '/api/challenge': 'challenge', '/api/challenge/accept': 'accept', '/api/challenge/decline': 'decline',
        '/api/challenge/cancel': 'invite_cancel', '/api/queue': 'queue', '/api/queue/cancel': 'queue_cancel'}[url.pathname];
      if (lobbyAction) {
        diagnosticContext.phase = 'query';
        if (url.search) throw invalid();
        diagnosticContext.phase = 'input';
        const input = lobbyInput(lobbyAction, req.method === 'GET' ? {} : await readJson(req), member.id);
        diagnosticContext.phase = 'rpc';
        const result = await lobbyRpc(lobbyAction, {...input, ...lobbyActor(req, member, config, auth)}, config);
        // Resolving an abandoned shot returns game fields only. Keep the
        // already bounded lobby snapshot while the allowlist removes claims.
        const processed = await processResult(result, member, config);
        diagnosticContext.phase = 'dto';
        return sendJson(res, 200, lobbyDTO({...result, ...processed}, member.id));
      }
      if (url.pathname === '/api/session') return sendJson(res, 200, {...publicDTO(await rpc('wallet', actor, config)), user: member});
      if (url.pathname === '/api/rooms' && req.method === 'GET') return sendJson(res, 200, publicDTO(await rpc('list', actor, config)));
      if (url.pathname === '/api/match') {
        const parameters = [...url.searchParams];
        if (parameters.length !== 1 || !['code', 'matchId'].includes(parameters[0][0]) ||
            (parameters[0][0] === 'code' ? !code(parameters[0][1]) : !uuid(parameters[0][1]))) throw invalid();
        const result = await rpc('state', {...actor, [parameters[0][0]]: parameters[0][1]}, config);
        return sendJson(res, 200, publicDTO(await processResult(result, member, config)));
      }
      const action = {'/api/rooms': 'create', '/api/rooms/join': 'join', '/api/offer': 'offer', '/api/ready': 'ready', '/api/formation': 'formation', '/api/input': 'input', '/api/cancel': 'cancel'}[url.pathname];
      const input = mutationInput(action, await readJson(req));
      const result = await rpc(action, {...input, ...actor}, config);
      return sendJson(res, 200, publicDTO(await processResult(result, member, config)));
    } catch (error) {
      const known = error instanceof HttpError;
      requestFailure(diagnosticPath, req.method, started, known ? error.status : 503, known ? error.code : 'SERVICE_UNAVAILABLE', diagnosticContext);
      if (known && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!res.writableEnded) sendJson(res, known ? error.status : 503, {ok: false, error: {
        code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '処理を完了できませんでした。時間をおいて再試行してください。'}});
    }
  };
}
module.exports = {createHandler, mutationInput, lobbyInput, lobbyActor, publicDTO, lobbyDTO, stateDTO, requestUrl};

'use strict';

// Never pass upstream error objects, request input, URLs or headers to logs.
// Only these fixed labels and database protocol codes may leave this module.
const OPERATIONS = {
  identity: new Set(['login', 'verify', 'logout']),
  storage: new Set([
    ...['wallet', 'list', 'create', 'join', 'offer', 'ready', 'formation', 'state', 'input', 'resolve', 'cancel', 'expire'].map(action => 'soccer.' + action),
    ...['snapshot', 'heartbeat', 'leave', 'logout', 'challenge', 'accept', 'decline', 'invite_cancel', 'queue', 'queue_cancel'].map(action => 'lobby.' + action)
  ])
};
const SQL_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '21000', '22001', '22003', '22007', '22012', '22023', '22P02', '23000', '23502', '23503', '23505', '23514',
  '25006', '28000', '28P01', '3D000', '3F000', '40001', '40P01', '42501', '42601', '42702', '42703',
  '42804', '42883', '42P01', '42P02', '42P18', '53000', '53100', '53200', '53300', '53400',
  '54000', '54001', '55000', '55P03', '57014', '57P01', '57P02', '57P03', '58000', '58030', 'P0001', 'XX000']);
const KINDS = new Set(['http', 'response', 'database', 'timeout', 'aborted', 'dns', 'connection', 'tls', 'network']);
const ROUTES = new Set(['session', 'login', 'logout', 'rooms', 'rooms/join', 'match', 'offer', 'ready', 'formation', 'input', 'cancel',
  'lobby', 'lobby/heartbeat', 'lobby/leave', 'challenge', 'challenge/accept', 'challenge/decline', 'challenge/cancel', 'queue', 'queue/cancel']);
const REQUEST_CODES = new Set(['CONFIGURATION_REQUIRED', 'ORIGIN_REJECTED', 'BODY_TOO_LARGE', 'CONTENT_TYPE_REQUIRED', 'INVALID_INPUT',
  'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'AUTHENTICATION_REQUIRED', 'IDENTITY_UNAVAILABLE', 'INVALID_ACCOUNT_CREDENTIALS', 'RATE_LIMITED',
  'SESSION_EXPIRED', 'INVALID_LOBBY_STATE', 'INVALID_MATCH_STATE', 'METHOD_NOT_ALLOWED', 'NOT_FOUND', 'SERVICE_UNAVAILABLE',
  'SIMULATION_UNAVAILABLE', 'URL_TOO_LONG', 'DATABASE_REJECTED', 'STORAGE_UNAVAILABLE', 'ACTIVE_MATCH', 'CAPACITY_LIMIT', 'CREATE_LIMIT',
  'INPUT_LOCKED', 'INSUFFICIENT_BALANCE', 'INVALID_REQUEST', 'INVALID_RESULT', 'INVALID_SETTINGS', 'INVALID_STAKE', 'INVITATION_LIMIT',
  'INVITATION_NOT_FOUND', 'LOBBY_LIMIT', 'MATCH_NOT_FOUND', 'MATCH_STARTED', 'NOT_READY', 'NOT_YOUR_TURN', 'NO_INPUT', 'PLAYER_UNAVAILABLE',
  'QUEUE_SETTINGS_LOCKED', 'RATE_LIMIT', 'REQUEST_CONFLICT', 'RESULT_CONFLICT', 'ROOM_UNAVAILABLE', 'RPC_FORBIDDEN', 'SESSION_LEFT',
  'SESSION_LIMIT', 'STAKE_MISMATCH', 'STALE_CLAIM', 'STALE_INPUT', 'FORMATION_FIXED', 'TURN_PENDING']);

function elapsedMs(started) {
  const elapsed = performance.now() - started;
  return Number.isFinite(elapsed) ? Math.max(0, Math.min(60000, Math.round(elapsed))) : 0;
}
function write(event) {
  try { console.warn(JSON.stringify(event)); } catch { /* Diagnostics must not change request results. */ }
}

function databaseCode(value) {
  return typeof value === 'string' && (SQL_CODES.has(value) || /^PGRST\d{3}$/.test(value)) ? value : undefined;
}

function networkKind(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  if (error?.name === 'AbortError') return 'aborted';
  const code = error?.cause?.code ?? error?.code;
  if (['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'].includes(code)) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'connection';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return 'tls';
  return 'network';
}

function upstreamFailure(upstream, operation, started, {status, code, kind} = {}) {
  if (!Object.hasOwn(OPERATIONS, upstream) || !OPERATIONS[upstream].has(operation)) return;
  const event = {event: 'two_player_upstream_failure', upstream, operation,
    elapsedMs: elapsedMs(started),
    kind: KINDS.has(kind) ? kind : 'response'};
  if (Number.isInteger(status) && status >= 100 && status <= 599) event.status = status;
  const safeCode = databaseCode(code);
  if (safeCode) event.code = safeCode;
  write(event);
}

function requestFailure(pathname, method, started, status, code, context = {}) {
  const route = typeof pathname === 'string' && pathname.startsWith('/api/') ? pathname.slice(5) : '';
  const event = {event: 'two_player_request_failure', route: ROUTES.has(route) ? route : 'unknown',
    method: ['GET', 'POST'].includes(method) ? method : 'OTHER', elapsedMs: elapsedMs(started),
    status: [400, 401, 403, 404, 405, 409, 410, 413, 414, 415, 429, 503, 507].includes(status) ? status : 503,
    code: REQUEST_CODES.has(code) ? code : 'SERVICE_UNAVAILABLE'};
  if (['auth', 'query', 'input', 'rpc', 'dto'].includes(context.phase)) event.phase = context.phase;
  for (const key of ['hasPathCapture', 'pathMatchesRoute']) if (typeof context[key] === 'boolean') event[key] = context[key];
  for (const key of ['queryKeyCount', 'otherQueryCount']) if (Number.isInteger(context[key]) && context[key] >= 0 && context[key] <= 512) event[key] = context[key];
  write(event);
}

module.exports = {databaseCode, networkKind, upstreamFailure, requestFailure};

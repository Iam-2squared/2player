'use strict';
const {getConfig} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
const {boundedText} = require('./http.cjs');
const {databaseCode, networkKind, upstreamFailure} = require('./diagnostics.cjs');
const {upstreamTimeout} = require('./deadline.cjs');
let pool;
function unavailable() { return new HttpError(503, '共有サーバーに接続できませんでした。時間をおいて再試行してください。', 'STORAGE_UNAVAILABLE'); }
function unpack(result) {
  if (result?.error) {
    const error = result.error;
    const status = [400, 401, 403, 404, 409, 410, 429, 503, 507].includes(error.status) ? error.status : 503;
    const code = typeof error.code === 'string' && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : 'DATABASE_REJECTED';
    const message = typeof error.message === 'string' && error.message.length <= 200 ? error.message : '共有サーバーで処理できませんでした。';
    throw new HttpError(status, message, code, {retryAfter: Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86400 ? error.retryAfter : undefined});
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.ok !== true) throw unavailable();
  return result;
}
async function callRpc(functionName, action, input, config, timeoutMs = 12000) {
  // The function name is selected only by the two fixed server wrappers below.
  if (!['two_player_rpc', 'two_player_lobby_rpc'].includes(functionName)) throw unavailable();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw unavailable();
  const started = performance.now();
  const operation = (functionName === 'two_player_lobby_rpc' ? 'lobby.' : 'soccer.') + action;
  let status, upstreamCode, received = false;
  try {
    if (config.databaseUrl) {
      if (!pool) {
        const {Pool} = require('pg');
        pool = new Pool({connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 10000,
          statement_timeout: 12000, idleTimeoutMillis: 10000, application_name: 'two-player-test'});
        pool.on('error', () => {});
      }
      const result = await pool.query('SELECT public.' + functionName + '($1,$2,$3::jsonb) AS result', [config.rpcSecret, action, JSON.stringify(input)]);
      return unpack(result.rows[0]?.result);
    }
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
    if (config.publishableKey.split('.').length === 3) headers.Authorization = 'Bearer ' + config.publishableKey;
    const response = await fetch(config.supabaseOrigin + '/rest/v1/rpc/' + functionName, {method: 'POST', headers,
      body: JSON.stringify({p_secret: config.rpcSecret, p_action: action, p_input: input}), signal: AbortSignal.timeout(upstreamTimeout(config, timeoutMs)), redirect: 'error'});
    status = response.status;
    received = true;
    if (!response.ok) {
      try { upstreamCode = databaseCode(JSON.parse(await boundedText(response, 16384))?.code); }
      catch { /* Error payloads stay private and bounded; HTTP status is sufficient. */ }
      throw unavailable();
    }
    return unpack(JSON.parse(await boundedText(response, 512 * 1024)));
  } catch (error) {
    if (!(error instanceof HttpError) || error.code === 'STORAGE_UNAVAILABLE') {
      const transport = networkKind(error);
      upstreamFailure('storage', operation, started, {status,
        code: upstreamCode ?? (config.databaseUrl ? databaseCode(error?.code) : undefined),
        kind: config.databaseUrl ? 'database' : !received || transport !== 'network' ? transport : status >= 400 ? 'http' : 'response'});
    }
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
async function rpc(action, input = {}, config = getConfig()) { return callRpc('two_player_rpc', action, input, config); }
async function lobbyRpc(action, input = {}, config = getConfig(), {timeoutMs = 12000} = {}) {
  return callRpc('two_player_lobby_rpc', action, input, config, timeoutMs);
}
async function closeStore() { const previous = pool; pool = undefined; if (previous) await previous.end(); }
module.exports = {rpc, lobbyRpc, unpack, closeStore};

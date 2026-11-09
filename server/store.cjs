'use strict';
const {getConfig} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
const {boundedText} = require('./http.cjs');
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
async function rpc(action, input = {}, config = getConfig()) {
  try {
    if (config.databaseUrl) {
      if (!pool) {
        const {Pool} = require('pg');
        pool = new Pool({connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 10000,
          statement_timeout: 12000, idleTimeoutMillis: 10000, application_name: 'two-player-test'});
        pool.on('error', () => {});
      }
      const result = await pool.query('SELECT public.two_player_rpc($1,$2,$3::jsonb) AS result', [config.rpcSecret, action, JSON.stringify(input)]);
      return unpack(result.rows[0]?.result);
    }
    const headers = {'Content-Type': 'application/json', apikey: config.publishableKey};
    if (config.publishableKey.split('.').length === 3) headers.Authorization = 'Bearer ' + config.publishableKey;
    const response = await fetch(config.supabaseOrigin + '/rest/v1/rpc/two_player_rpc', {method: 'POST', headers,
      body: JSON.stringify({p_secret: config.rpcSecret, p_action: action, p_input: input}), signal: AbortSignal.timeout(12000), redirect: 'error'});
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    return unpack(JSON.parse(await boundedText(response, 512 * 1024)));
  } catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
}
async function closeStore() { const previous = pool; pool = undefined; if (previous) await previous.end(); }
module.exports = {rpc, unpack, closeStore};

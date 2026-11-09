'use strict';
const crypto = require('node:crypto');
const {getConfig} = require('./config.cjs');
const {HttpError} = require('./errors.cjs');
const {boundedText} = require('./http.cjs');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function readCookie(req, name) {
  const values = String(req.headers?.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
function writeCookie(res, name, value, seconds, config = getConfig()) {
  const cookie = name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.max(0, Math.floor(seconds)) + (config.test ? '' : '; Secure');
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), cookie]);
}
function digest(value, config) { return crypto.createHmac('sha256', config.cookieSecret).update('two-player-attempt\0' + value).digest('hex'); }
function attemptIdentity(req, res, config = getConfig()) {
  const existing = readCookie(req, config.attemptCookie);
  if (existing) {
    const [token, signature, extra] = existing.split('.');
    if (!extra && TOKEN.test(token || '') && /^[a-f0-9]{64}$/.test(signature || '') &&
        crypto.timingSafeEqual(Buffer.from(digest(token, config), 'hex'), Buffer.from(signature, 'hex'))) return token;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  writeCookie(res, config.attemptCookie, token + '.' + digest(token, config), 86400, config);
  return token;
}
function sessionToken(req, config = getConfig()) {
  const token = readCookie(req, config.sessionCookie);
  return TOKEN.test(token || '') ? token : null;
}
function clearSession(res, config = getConfig()) { writeCookie(res, config.sessionCookie, '', 0, config); }
function setSession(res, token, expiresAt, config = getConfig()) {
  const seconds = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  if (!TOKEN.test(token || '') || !Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 86400 + 60) throw unavailable();
  writeCookie(res, config.sessionCookie, token, Math.min(seconds, 7 * 86400), config);
}
function unavailable() { return new HttpError(503, 'KGS 11thのアカウント連携に接続できませんでした。時間をおいて再試行してください。', 'IDENTITY_UNAVAILABLE'); }
function parseIdentity(result, requireToken) {
  const member = result?.member, expires = Date.parse(result?.expiresAt);
  if (!member || !UUID.test(member.id || '') || typeof member.name !== 'string' || !member.name.trim() || member.name.length > 20 ||
      !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 7 * 86400000 + 60000 ||
      (requireToken && !TOKEN.test(result.token || ''))) throw unavailable();
  return {member: {id: member.id, name: member.name}, expiresAt: result.expiresAt, ...(requireToken ? {token: result.token} : {})};
}
async function callIdentity(action, input, config = getConfig()) {
  if (!['login', 'verify', 'logout'].includes(action)) throw new Error('Unknown identity action');
  try {
    const response = await fetch(config.kgsOrigin + '/api/integrations/two-player/' + action, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.integrationSecret},
      body: JSON.stringify(input), signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    const result = JSON.parse(await boundedText(response, 16384));
    if (!response.ok) {
      const code = typeof result?.error?.code === 'string' ? result.error.code : '';
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        throw new HttpError(429, '入力回数が多いため、時間をおいてお試しください。', 'RATE_LIMITED',
          {retryAfter: Number.isSafeInteger(retry) && retry > 0 && retry <= 86400 ? retry : 900});
      }
      if (response.status === 401 && !/INTEGRATION|SERVICE|SECRET/.test(code)) throw new HttpError(401,
        action === 'login' ? '出席番号またはPINが違います。' : 'ログインの期限が切れました。もう一度ログインしてください。',
        action === 'login' ? 'INVALID_ACCOUNT_CREDENTIALS' : 'SESSION_EXPIRED');
      throw unavailable();
    }
    if (action === 'logout') { if (result?.ok !== true) throw unavailable(); return {ok: true}; }
    return parseIdentity(result, action === 'login');
  } catch (error) { if (error instanceof HttpError) throw error; throw unavailable(); }
}
async function requireMember(req, res, config = getConfig()) {
  const token = sessionToken(req, config);
  if (!token) throw new HttpError(401, 'ログインしてください。', 'AUTHENTICATION_REQUIRED');
  try { return (await callIdentity('verify', {token}, config)).member; }
  catch (error) { if (error instanceof HttpError && error.status === 401) clearSession(res, config); throw error; }
}
module.exports = {TOKEN, UUID, readCookie, writeCookie, attemptIdentity, sessionToken, clearSession, setSession, parseIdentity, callIdentity, requireMember};

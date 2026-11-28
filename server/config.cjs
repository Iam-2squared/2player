'use strict';
const {HttpError} = require('./errors.cjs');

function configurationError() {
  return new HttpError(503, '共有サーバーの設定を確認しています。', 'CONFIGURATION_REQUIRED');
}

function origin(value, test) {
  let parsed;
  try { parsed = new URL(value); } catch { throw configurationError(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      (parsed.protocol !== 'https:' && !(test && loopback && parsed.protocol === 'http:'))) throw configurationError();
  return parsed.origin;
}

function getConfig() {
  const test = process.env.NODE_ENV === 'test' && process.env.VERCEL !== '1';
  const keys = ['TWO_PLAYER_RPC_SECRET', 'TWO_PLAYER_COOKIE_SECRET', 'TWO_PLAYER_KGS_INTEGRATION_SECRET'];
  if (keys.some(key => typeof process.env[key] !== 'string' || process.env[key].length < 32 ||
      process.env[key].length > 512 || /\s/.test(process.env[key])) ||
      process.env.TWO_PLAYER_RPC_SECRET.length > 256 ||
      new Set(keys.map(key => process.env[key])).size !== keys.length ||
      process.env.TWO_PLAYER_RPC_SECRET === process.env.TARGET_RPC_SECRET ||
      !process.env.KGS_IDENTITY_URL || !process.env.TWO_PLAYER_ALLOWED_ORIGINS) throw configurationError();
  const origins = process.env.TWO_PLAYER_ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.length > 20 || origins.some(value => origin(value, test) !== value)) throw configurationError();
  const kgsOrigin = origin(process.env.KGS_IDENTITY_URL, test);
  const databaseUrl = process.env.TWO_PLAYER_DATABASE_URL;
  let supabaseOrigin, publishableKey;
  if (databaseUrl) {
    let database;
    try { database = new URL(databaseUrl); } catch { throw configurationError(); }
    if (!test || !['postgres:', 'postgresql:'].includes(database.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
        !/^\/two_player_(?:[a-z0-9_]+_)?test$/.test(database.pathname) || database.search || database.hash) throw configurationError();
  } else {
    if (!process.env.TWO_PLAYER_SUPABASE_URL || !process.env.TWO_PLAYER_SUPABASE_PUBLISHABLE_KEY) throw configurationError();
    supabaseOrigin = origin(process.env.TWO_PLAYER_SUPABASE_URL, false);
    if (!/^[a-z0-9]+\.supabase\.co$/.test(new URL(supabaseOrigin).hostname)) throw configurationError();
    publishableKey = process.env.TWO_PLAYER_SUPABASE_PUBLISHABLE_KEY;
    if (publishableKey.length < 20 || publishableKey.length > 4096 || /\s/.test(publishableKey)) throw configurationError();
  }
  return {test, origins, kgsOrigin, databaseUrl, supabaseOrigin, publishableKey,
    rpcSecret: process.env.TWO_PLAYER_RPC_SECRET,
    cookieSecret: process.env.TWO_PLAYER_COOKIE_SECRET,
    integrationSecret: process.env.TWO_PLAYER_KGS_INTEGRATION_SECRET,
    sessionCookie: test ? 'two_player_session' : '__Host-two_player_session',
    attemptCookie: test ? 'two_player_attempt' : '__Host-two_player_attempt'};
}

function checkOrigin(req, config = getConfig()) {
  const requestOrigin = req.headers?.origin;
  if (!config.origins.includes(requestOrigin) || req.headers?.['sec-fetch-site'] === 'cross-site' ||
      new URL(requestOrigin).host !== req.headers?.host) {
    throw new HttpError(403, 'この送信元からは操作できません。', 'ORIGIN_REJECTED');
  }
}

function checkReadOrigin(req, config = getConfig()) {
  if (req.headers?.['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'この送信元からは表示できません。', 'ORIGIN_REJECTED');
  if (req.headers?.origin) checkOrigin(req, config);
}

module.exports = {getConfig, checkOrigin, checkReadOrigin, origin};

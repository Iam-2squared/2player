'use strict';
const {HttpError} = require('./errors.cjs');
const MAX_BODY = 4096;
const MAX_RESPONSE = 256 * 1024;

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || '')) ||
      (req.headers?.['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
    throw new HttpError(415, 'JSON形式で送信してください。', 'CONTENT_TYPE_REQUIRED');
  }
  const length = req.headers?.['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BODY)) throw new HttpError(413, '送信内容が大きすぎます。', 'BODY_TOO_LARGE');
  // Vercel may parse the body before invoking the handler. Bound both paths.
  if (req.body !== undefined) {
    let raw;
    try { raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body); }
    catch { throw new HttpError(400, '送信内容を確認してください。', 'INVALID_INPUT'); }
    if (Buffer.byteLength(raw || '') > MAX_BODY) throw new HttpError(413, '送信内容が大きすぎます。', 'BODY_TOO_LARGE');
    return parseJson(raw);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new HttpError(413, '送信内容が大きすぎます。', 'BODY_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

function parseJson(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, '送信内容を確認してください。', 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '送信内容を確認してください。', 'INVALID_INPUT');
  return value;
}

function sendJson(res, status, value) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > MAX_RESPONSE) throw new HttpError(503, '対戦データを読み込めませんでした。', 'RESPONSE_TOO_LARGE');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(raw);
}

async function boundedText(response, limit) {
  const rejectBody = async message => {
    // Rejected gateway/oversized responses must release their pooled connection.
    await response.body?.cancel().catch(() => {});
    throw new Error(message);
  };
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) return rejectBody('response format');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) return rejectBody('response size');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response missing');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('response size');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {MAX_BODY, MAX_RESPONSE, securityHeaders, readJson, sendJson, boundedText};

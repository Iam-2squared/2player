'use strict';

const REQUEST_BUDGET_MS = 26000;

function requestConfig(config) {
  return {...config, requestDeadline: performance.now() + REQUEST_BUDGET_MS};
}

function upstreamTimeout(config, cap) {
  if (!Number.isFinite(config.requestDeadline)) return cap;
  const remaining = Math.floor(config.requestDeadline - performance.now());
  if (remaining <= 0) throw new DOMException('Upstream deadline exceeded', 'TimeoutError');
  return Math.min(cap, remaining);
}

module.exports = {REQUEST_BUDGET_MS, requestConfig, upstreamTimeout};

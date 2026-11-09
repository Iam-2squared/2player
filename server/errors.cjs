'use strict';

class HttpError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = extra.retryAfter;
  }
}

module.exports = {HttpError};

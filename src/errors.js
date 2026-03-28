"use strict";

function classifyErrorType(statusCode, error) {
  if (statusCode === 400 || statusCode === 413 || statusCode === 422) {
    return "invalid_request_error";
  }

  if (statusCode === 401 || statusCode === 403) {
    return "authentication_error";
  }

  if (statusCode === 404) {
    return "not_found_error";
  }

  if (statusCode === 408) {
    return "timeout_error";
  }

  if (statusCode === 429) {
    return "rate_limit_error";
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 529) {
    return "overloaded_error";
  }

  if (
    error &&
    /timed out|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed/i.test(
      String(error.message || error)
    )
  ) {
    return "api_connection_error";
  }

  return "api_error";
}

function resolveResultError(result) {
  const metadata = (result.finalMessage && result.finalMessage.metadata) || {};

  return {
    errorCode: Number(metadata.errorCode || 0) || null,
    errorMessage:
      (result.channelResponse && result.channelResponse.content) ||
      metadata.rawError ||
      result.finalText ||
      "Unknown bridge error"
  };
}

module.exports = {
  classifyErrorType,
  resolveResultError
};

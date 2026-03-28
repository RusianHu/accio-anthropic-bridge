"use strict";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const BODY_READ_TIMEOUT_MS = 30 * 1000;

function createStatusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      finalize(createStatusError(408, `Request body read timed out after ${BODY_READ_TIMEOUT_MS}ms`));
      req.destroy();
    }, BODY_READ_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    const finalize = (error, body) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (error) {
        reject(error);
        return;
      }

      resolve(body);
    };

    const onData = (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        finalize(createStatusError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    };

    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        finalize(null, text ? JSON.parse(text) : {});
      } catch (error) {
        finalize(error);
      }
    };

    const onError = (error) => {
      finalize(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

module.exports = {
  BODY_READ_TIMEOUT_MS,
  MAX_BODY_BYTES,
  createStatusError,
  readJsonBody
};

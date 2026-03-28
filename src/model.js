"use strict";

function normalizeRequestedModel(model) {
  const value = String(model || "").trim();

  if (!value || ["accio-bridge", "auto", "default"].includes(value)) {
    return null;
  }

  return value;
}

module.exports = {
  normalizeRequestedModel
};

// Backward-compatibility shim — DR-022
// wix-adapter.js was split into Layer 1 (wix-connector) and Layer 2 (wix/wix-adapter).
// Any existing require('./adapters/wix-adapter') or require('../adapters/wix-adapter')
// now resolves to the Wix Connector (Layer 1 — handleWebhook entry point).
module.exports = require('./wix/wix-connector');

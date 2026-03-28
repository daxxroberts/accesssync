// Backward-compatibility shim — DR-022
// kisi-adapter.js was split into Layer 6 (kisi/kisi-adapter) and Layer 7 (kisi/kisi-connector).
// Any existing require('./adapters/kisi-adapter') now resolves to the Kisi Adapter (Layer 6 — business methods).
module.exports = require('./kisi/kisi-adapter');

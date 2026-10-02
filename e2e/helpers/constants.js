/**
 * e2e/helpers/constants.js
 * IDs shared by the e2e helpers. No imports on purpose: auth.js needs these without
 * pulling in the DB connection that seed.js opens.
 */
'use strict';

// Real production client the webhook/member specs target.
const HOG_CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

module.exports = { HOG_CLIENT_ID };

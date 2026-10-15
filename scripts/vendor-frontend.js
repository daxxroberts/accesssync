/**
 * scripts/vendor-frontend.js
 * Copies the browser builds of React, ReactDOM and Babel-standalone from node_modules into
 * admin/public/vendor/ so the Trace Timeline and Members islands load them from our own origin.
 *
 * Why: until 2026-10-15 these three files came from unpkg.com at runtime. When that CDN was slow
 * or blocked, the Trace Timeline panel sat on "Loading…" forever (on the Owner dashboard and on
 * the client dashboard's Logs tab) and the Members page could not mount at all.
 *
 * Runs as part of `npm run build` (after `vite build`), which Railway runs on every deploy.
 * admin/public/vendor/ is gitignored — it is build output, like admin/public/dist/.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'admin', 'public', 'vendor');

const FILES = [
  ['react/umd/react.production.min.js',         'react.production.min.js'],
  ['react-dom/umd/react-dom.production.min.js', 'react-dom.production.min.js'],
  ['@babel/standalone/babel.min.js',            'babel.min.js'],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [src, dest] of FILES) {
  const from = path.join(ROOT, 'node_modules', src);
  if (!fs.existsSync(from)) {
    console.error(`vendor-frontend: missing ${from} — run npm install`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(OUT, dest));
  console.log(`vendor-frontend: ${dest} (${Math.round(fs.statSync(from).size / 1024)} KB)`);
}

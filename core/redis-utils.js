/**
 * @file redis-utils.js
 * @layer core/shared
 * @role redis-connection
 * @reads env:REDIS_URL
 * @exports parseRedisUrl(url) → { host, port, password }, getRedisConnection(), getRedisClient(), pingRedis()
 *
 * redis-utils.js
 * Shared BullMQ Redis connection helper.
 *
 * BullMQ requires parsed host/port/password — does not support { url } format reliably.
 * Used by webhook-processor.js, queue-worker.js, and admin routes that connect to the queue.
 *
 * getRedisConnection() is a CONFIG object for BullMQ, not a client: it has no lpush/get/ping.
 * Code that talks to Redis itself (hmac-monitor, /health) uses getRedisClient().
 */

function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port) || 6379,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      username: u.username ? decodeURIComponent(u.username) : undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

function getRedisConnection() {
  return process.env.REDIS_URL
    ? parseRedisUrl(process.env.REDIS_URL)
    : { host: 'localhost', port: 6379 };
}

// One shared ioredis client for direct commands, built on first use. Fail fast rather than
// queue: a command waits at most COMMAND_TIMEOUT_MS, so a Redis outage can never stall the
// webhook request or the health check that called it.
const COMMAND_TIMEOUT_MS = 2000;
let _client = null;

function getRedisClient() {
  if (_client) return _client;
  const IORedis = require('ioredis');
  _client = new IORedis({
    ...getRedisConnection(),
    maxRetriesPerRequest: 1,
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: 5000,
  });
  // ioredis emits 'error' on every failed reconnect; without a listener Node prints each one
  // as an unhandled error. The command that fails is what callers see and log.
  _client.on('error', () => {});
  return _client;
}

/** true when Redis answers PING within the command timeout. Never throws. */
async function pingRedis() {
  try {
    return (await getRedisClient().ping()) === 'PONG';
  } catch {
    return false;
  }
}

module.exports = { parseRedisUrl, getRedisConnection, getRedisClient, pingRedis };

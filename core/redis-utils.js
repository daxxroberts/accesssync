/**
 * redis-utils.js
 * Shared BullMQ Redis connection helper.
 *
 * BullMQ requires parsed host/port/password — does not support { url } format reliably.
 * Used by webhook-processor.js, queue-worker.js, and admin routes that connect to the queue.
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

module.exports = { parseRedisUrl, getRedisConnection };

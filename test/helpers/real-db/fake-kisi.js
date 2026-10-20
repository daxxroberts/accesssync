/**
 * fake-kisi.js — an in-memory door system standing in for adapters/hardware-adapter.js.
 *
 * It keeps real state (users, role assignments, suspended flags), so a test can ask the
 * question the owner cares about — "can this person still open the door?" — instead of
 * counting mock calls. failNext(method, err) makes the next call to that method throw,
 * which is how a Kisi timeout or 5xx is simulated.
 *
 * Usage:
 *   jest.mock('../../adapters/hardware-adapter', () => require('../helpers/real-db/fake-kisi').adapter);
 *   const kisi = require('../helpers/real-db/fake-kisi');
 *   beforeEach(() => kisi.reset());
 */

'use strict';

const state = { users: new Map(), roles: new Map(), nextId: 1000, failures: new Map() };

function reset() {
  state.users.clear();
  state.roles.clear();
  state.nextId = 1000;
  state.failures.clear();
  for (const fn of Object.values(adapter)) if (fn && fn.mockClear) fn.mockClear();
}

/** The next call to `method` throws `err` (default: a retryable Kisi 503). */
function failNext(method, err) {
  const e = err || Object.assign(new Error(`Kisi ${method} timed out (503)`), { statusCode: 503 });
  const queue = state.failures.get(method) || [];
  queue.push(e);
  state.failures.set(method, queue);
}

function maybeFail(method) {
  const queue = state.failures.get(method);
  if (queue && queue.length) throw queue.shift();
}

function notFound(what) {
  return Object.assign(new Error(`${what} not found`), { statusCode: 404, code: 'HARDWARE_RESOURCE_NOT_FOUND' });
}

function wrap(method, impl) {
  return jest.fn(async (...args) => { maybeFail(method); return impl(...args); });
}

const adapter = {
  findUserByEmail: wrap('findUserByEmail', (_p, _k, email) => {
    for (const [id, u] of state.users) if (u.email === email) return id;
    return null;
  }),
  createUser: wrap('createUser', (_p, _k, email, name) => {
    const id = String(state.nextId++);
    state.users.set(id, { email, name, suspended: false });
    return id;
  }),
  getUserById: wrap('getUserById', (_p, _k, userId) => {
    const u = state.users.get(String(userId));
    return u ? { id: String(userId), ...u } : null;
  }),
  assignRole: wrap('assignRole', (_p, _k, userId, groupId) => {
    if (!state.users.has(String(userId))) throw notFound('user');
    const id = String(state.nextId++);
    state.roles.set(id, { userId: String(userId), groupId: String(groupId) });
    return id;
  }),
  removeRole: wrap('removeRole', (_p, _k, roleAssignmentId) => {
    state.roles.delete(String(roleAssignmentId)); // Kisi DELETE is 404-idempotent
    return true;
  }),
  suspendAccess: wrap('suspendAccess', (_p, _k, userId) => {
    const u = state.users.get(String(userId));
    if (u) u.suspended = true;
    return true;
  }),
  enableAccess: wrap('enableAccess', (_p, _k, userId) => {
    const u = state.users.get(String(userId));
    if (u) u.suspended = false;
    return true;
  }),
  getRoleAssignmentsForUser: wrap('getRoleAssignmentsForUser', (_p, _k, userId) =>
    [...state.roles.entries()]
      .filter(([, r]) => r.userId === String(userId))
      .map(([id, r]) => ({ id, group_id: r.groupId }))),
  deleteUser: wrap('deleteUser', (_p, _k, userId) => {
    const id = String(userId);
    state.users.delete(id);
    for (const [raId, r] of state.roles) if (r.userId === id) state.roles.delete(raId);
    return true;
  }),
  createGroupLink: wrap('createGroupLink', () => ({ id: String(state.nextId++) })),
  deleteGroupLink: wrap('deleteGroupLink', () => true),
  supportsDayPass: jest.fn(() => true),
  getRateLimit: jest.fn(() => 5),
};

/** True when the door system would open `groupId` for `userId` right now. */
function canOpen(userId, groupId) {
  const u = state.users.get(String(userId));
  if (!u || u.suspended) return false;
  for (const r of state.roles.values()) if (r.userId === String(userId) && r.groupId === String(groupId)) return true;
  return false;
}

module.exports = { adapter, reset, failNext, canOpen, state };

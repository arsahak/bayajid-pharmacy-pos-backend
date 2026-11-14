/**
 * Short-lived in-memory cache for authenticated users.
 *
 * The auth middleware used to load the user + role from MongoDB on every
 * request (2 sequential round trips). Caching for a few seconds removes that
 * cost from almost every API call. Any user/role write clears the cache, so
 * permission or status changes still apply immediately on this process.
 */
const TTL_MS = 30 * 1000;
const MAX_ENTRIES = 1000;
const cache = new Map();

const get = (userId) => {
  const hit = cache.get(String(userId));
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(String(userId));
    return null;
  }
  return hit.user;
};

const set = (userId, user) => {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(String(userId), { user, expires: Date.now() + TTL_MS });
};

const clear = () => cache.clear();

module.exports = { get, set, clear };

/**
 * In-memory POS product catalogue with incremental sync.
 *
 * The whole catalogue is loaded from MongoDB once. After that only products
 * whose updatedAt moved forward are fetched again (one small query), and they
 * are patched into the cache. Clients do the same: they send the serverTime of
 * their last sync as ?since= and receive only what changed since then.
 *
 * Refreshes happen right after a local product write (productEvents) or at most
 * every REFRESH_MS otherwise, so writes made by another process (e.g. an older
 * deployment using the same database) are also picked up.
 */
const Product = require("../model/Product");
const productEvents = require("./productEvents");

// Fields used by the dashboard POS screen, plus sync bookkeeping
const POS_FIELDS =
  "name price cost discountPrice discountPercentage category stock sku barcode " +
  "isPrescription isControlled genericName dosage strength unit manufacturer " +
  "hasExpiry expiryDate batchNumber taxRate reorderLevel mainImage location " +
  "isActive createdAt updatedAt";

const OVERLAP_MS = 60 * 1000; // re-check a window before `since` (clock skew, slow transactions)
const REFRESH_MS = 5 * 1000;

const state = {
  items: new Map(), // id -> lean product
  removed: new Map(), // id -> Date it became inactive (seen since full load)
  loadedAt: null, // when the full load started
  syncedAt: null, // when the last DB query started
  lastRefresh: 0,
  dirty: true,
  pending: null,
};

productEvents.onChange(() => {
  state.dirty = true;
});

async function fullLoad() {
  const startedAt = new Date();
  const docs = await Product.find({ isActive: true }).select(POS_FIELDS).lean();
  state.items = new Map(docs.map((d) => [String(d._id), d]));
  state.removed = new Map();
  state.loadedAt = startedAt;
  state.syncedAt = startedAt;
}

async function deltaLoad() {
  const startedAt = new Date();
  const docs = await Product.find({
    updatedAt: { $gte: new Date(state.syncedAt.getTime() - OVERLAP_MS) },
  })
    .select(POS_FIELDS)
    .lean();
  for (const d of docs) {
    const id = String(d._id);
    if (d.isActive) {
      state.items.set(id, d);
      state.removed.delete(id);
    } else {
      state.items.delete(id);
      state.removed.set(id, d.updatedAt || startedAt);
    }
  }
  state.syncedAt = startedAt;
}

async function refresh() {
  if (state.pending) return state.pending;
  const needFull = !state.loadedAt;
  const stale = state.dirty || Date.now() - state.lastRefresh > REFRESH_MS;
  if (!needFull && !stale) return;

  state.dirty = false;
  state.pending = (needFull ? fullLoad() : deltaLoad())
    .then(() => {
      state.lastRefresh = Date.now();
    })
    .catch((e) => {
      state.dirty = true; // try again on the next request
      if (needFull) state.loadedAt = null;
      throw e;
    })
    .finally(() => {
      state.pending = null;
    });
  return state.pending;
}

const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);

/**
 * since: ISO string from the client's previous sync (optional).
 * Returns { full: true, products } or { full: false, changed, removed }, plus serverTime.
 */
async function getCatalog(since) {
  try {
    await refresh();
  } catch (e) {
    if (!state.loadedAt) throw e; // nothing cached yet
    console.error("POS catalogue refresh failed, serving cached data:", e.message);
  }
  const serverTime = state.syncedAt.toISOString();
  const sinceDate = since ? new Date(since) : null;

  // No previous sync, bad value, or older than this cache (server restarted, so
  // deletions before that are unknown): send everything.
  if (!sinceDate || isNaN(sinceDate) || sinceDate < state.loadedAt) {
    return { full: true, products: [...state.items.values()].sort(byNewest), serverTime };
  }

  const from = sinceDate.getTime() - OVERLAP_MS;
  const changed = [];
  for (const p of state.items.values()) {
    if (new Date(p.updatedAt || 0).getTime() >= from) changed.push(p);
  }
  const removed = [];
  for (const [id, at] of state.removed) {
    if (new Date(at).getTime() >= from) removed.push(id);
  }
  return { full: false, changed, removed, serverTime };
}

/** Load the catalogue in the background at startup so the first POS visit is fast. */
function warmUp() {
  refresh().catch((e) => console.error("POS catalogue warm-up failed:", e.message));
}

module.exports = { getCatalog, warmUp, POS_FIELDS };

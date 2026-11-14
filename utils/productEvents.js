/**
 * Product change notifications.
 *
 * Product model hooks call changed() after any write (sale, stock adjustment,
 * edit, import, delete). Listeners (the POS catalogue cache) are told right
 * away, and connected Socket.IO clients get a debounced "products:changed"
 * signal. The signal carries no product data (sockets are not authenticated);
 * clients fetch the changes through the authenticated API.
 */
const listeners = new Set();
let io = null;
let timer = null;

const setIo = (socketServer) => {
  io = socketServer;
};

const onChange = (fn) => listeners.add(fn);

const changed = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error("product change listener failed:", e.message);
    }
  }
  if (timer) return; // several writes in a burst (e.g. one sale) → one signal
  timer = setTimeout(() => {
    timer = null;
    if (io) io.emit("products:changed", { at: Date.now() });
  }, 300);
};

module.exports = { setIo, onChange, changed };

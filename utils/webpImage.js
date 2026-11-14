/**
 * Serve ImgBB images as WebP.
 *
 * Images stay stored in MongoDB with their original ImgBB URL (jpg/png/gif/webp).
 * When the API responds, every "https://i.ibb.co/<id>/<file>" string is rewritten
 * to "<IMAGE_PROXY_BASE>/img/ibb/<id>/<file>.webp". That route downloads the
 * original once, converts it with sharp, caches the result on disk and serves it.
 *
 * Enabled only when IMAGE_PROXY_BASE is set (e.g. https://api.bayajid.com), so
 * environments without it (Vercel) keep returning the original URLs.
 */
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const IBB_URL_RE = /^https:\/\/i\.ibb\.co\/([A-Za-z0-9]{3,32})\/([^/?#\\]+)$/;
const ID_RE = /^[A-Za-z0-9]{3,32}$/;

const BASE = (process.env.IMAGE_PROXY_BASE || "").replace(/\/+$/, "");
const CACHE_DIR =
  process.env.IMAGE_CACHE_DIR || path.join(__dirname, "..", ".image-cache");
const MAX_SOURCE_BYTES = 15 * 1024 * 1024; // refuse anything above 15 MB
const MAX_WIDTH = 2000;
const WEBP_QUALITY = 80;

let sharp = null;
try {
  sharp = require("sharp");
} catch (e) {
  console.warn("⚠️  sharp not available - images will be served in original format");
}

const enabled = Boolean(BASE && sharp);
if (enabled) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`🖼️  WebP image proxy enabled: ${BASE}/img (cache: ${CACHE_DIR})`);
}

/** "https://i.ibb.co/abc/photo.jpg" -> "https://api.example.com/img/ibb/abc/photo.jpg.webp" */
function toWebpUrl(url) {
  const m = IBB_URL_RE.exec(url);
  if (!m) return url;
  return `${BASE}/img/ibb/${m[1]}/${m[2]}.webp`;
}

/** JSON replacer for app.set("json replacer"): rewrites ImgBB URLs anywhere in a response. */
function jsonReplacer(key, value) {
  if (typeof value === "string" && value.startsWith("https://i.ibb.co/")) {
    return toWebpUrl(value);
  }
  return value;
}

const inflight = new Map();

async function convert(sourceUrl, width, cacheFile) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`source ${response.status}`);
  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`source is ${type || "not an image"}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_SOURCE_BYTES) throw new Error("source too large");

  const input = Buffer.from(await response.arrayBuffer());
  if (input.length > MAX_SOURCE_BYTES) throw new Error("source too large");

  let output;
  if (type === "image/webp" && !width) {
    // Already WebP: serve as-is, re-encoding would only lose quality
    output = input;
  } else {
    let img = sharp(input, { animated: true, limitInputPixels: 100_000_000 }).rotate();
    if (width) img = img.resize({ width, withoutEnlargement: true });
    output = await img.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer();
  }

  const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, output);
  await fsp.rename(tmp, cacheFile);
  return cacheFile;
}

/** Express handler for GET /img/ibb/:id/:file  (file = "<original name>.webp", optional ?w=) */
async function serveIbbImage(req, res) {
  const { id, file } = req.params;
  if (!ID_RE.test(id) || !file.endsWith(".webp") || file.length > 300) {
    return res.status(404).end();
  }
  const original = file.slice(0, -".webp".length);
  if (!original || /[/\\]/.test(original) || original.includes("..")) {
    return res.status(404).end();
  }
  const sourceUrl = `https://i.ibb.co/${id}/${encodeURIComponent(original)}`;

  let width = parseInt(req.query.w, 10);
  width = Number.isFinite(width) && width > 0 ? Math.min(width, MAX_WIDTH) : 0;

  res.set("Cross-Origin-Resource-Policy", "cross-origin"); // used by other subdomains

  if (!enabled) return res.redirect(302, sourceUrl);

  const key = crypto.createHash("sha1").update(`${id}/${original}/${width}`).digest("hex");
  const cacheFile = path.join(CACHE_DIR, `${key}.webp`);

  try {
    if (!fs.existsSync(cacheFile)) {
      if (!inflight.has(key)) {
        inflight.set(
          key,
          convert(sourceUrl, width, cacheFile).finally(() => inflight.delete(key))
        );
      }
      await inflight.get(key);
    }
    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(cacheFile);
  } catch (error) {
    console.error(`WebP conversion failed for ${sourceUrl}: ${error.message}`);
    // Never break the image: fall back to the original
    res.set("Cache-Control", "no-store");
    return res.redirect(302, sourceUrl);
  }
}

module.exports = { enabled, toWebpUrl, jsonReplacer, serveIbbImage };

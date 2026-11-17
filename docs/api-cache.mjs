/**
 * Cache only PUBLIC, keyless third-party movie metadata. Never caches the
 * password, the decrypted private library or movies.enc.json.
 * Cached data are stored unencrypted in this browser profile. See README.
 */
const NAME = 'cinelist-public-metadata-v1';
const DAY = 86400000;
const MAX = 220;
const DEFAULT_TTL = DAY;
const TTL_SEARCH = 7 * DAY;
const ALLOWED = new Set(['api.streamx.qzz.io','streamx-api.pages.dev','v3-cinemeta.strem.io','api.tvmaze.com']);
let cachePromise;
function cacheStore() {
  if(!globalThis.isSecureContext || !('caches' in globalThis)) return Promise.resolve(null);
  return cachePromise ||= caches.open(NAME).catch(() => null);
}
function validUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol==='https:' && ALLOWED.has(parsed.hostname); }
  catch { return false; }
}
async function readCached(cache, url) {
  if(!cache) return null;
  try {
    const result = await cache.match(url);
    if(!result) return null;
    const saved = Number(result.headers.get('x-cinelist-saved'));
    const data = await result.json();
    if(!data || data.ok===false) return null;
    return {saved, data};
  } catch { return null; }
}
async function saveCached(cache, url, data) {
  if(!cache) return;
  try {
    const response = new Response(JSON.stringify(data), {
      status:200,
      headers:{'content-type':'application/json;charset=utf-8','x-cinelist-saved':String(Date.now())}
    });
    await cache.put(url,response);
    const keys = await cache.keys();
    if(keys.length>MAX)await Promise.all(keys.slice(0,keys.length-MAX).map(key=>cache.delete(key)));
  } catch { /* Storage may be disabled/full. Online mode still works. */ }
}
export async function cachedJSON(url,signal) {
  if(!validUrl(url))throw new Error('Nepodporovaný zdroj online informací');
  if(signal?.aborted)throw new DOMException('Request canceled','AbortError');
  const cache = await cacheStore();
  const cached = await readCached(cache,url);
  const ttl = url.includes('/search') || url.includes('/catalog') ? TTL_SEARCH : DEFAULT_TTL;
  if(cached && (Date.now() - cached.saved)<ttl)return cached.data;
  const timeout = new AbortController();
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener('abort',abort,{once:true});
  timeout.signal.addEventListener('abort',abort,{once:true});
  const t = setTimeout(()=>timeout.abort(),9000);
  try {
    const response = await fetch(url,{signal:ctl.signal,credentials:'omit',cache:'default'});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if(!result || result.ok===false)throw new Error('API vrací chybu nebo prázdná data');
    // Only successful public metadata. No passwords or encrypted archive.
    await saveCached(cache,url,result);
    return result;
  } catch(err) {
    if(signal?.aborted)throw err;
    // Stale data are preferable to an empty detail when the provider is down.
    if(cached && Date.now()-cached.saved<14*DAY)return cached.data;
    throw err;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort',abort);
  }
}

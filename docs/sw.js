/* CINELIST: caches public poster/cast artwork only, never the private library. */
'use strict';
const CACHE = 'cinelist-public-images-v1';
const MAX = 240;
const ALLOWED = new Set(['api.streamx.qzz.io','streamx-api.pages.dev','images.metahub.space','image.tmdb.org','static.tvmaze.com','upload.wikimedia.org','commons.wikimedia.org','v3-cinemeta.strem.io']);
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request=event.request;
  if(request.method!=='GET' || request.destination!=='image')return;
  const url=new URL(request.url);
  if(url.protocol!=='https:' || !(ALLOWED.has(url.hostname) || url.hostname.endsWith('.media-amazon.com') || url.hostname.endsWith('.metahub.space') || url.hostname.endsWith('.wikimedia.org') || url.hostname.endsWith('.strem.io')))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(request);
    if(cached)return cached;
    try {
      const response=await fetch(request);
      if(response.ok || response.type==='opaque'){
        try {
          await cache.put(request,response.clone());
          const keys=await cache.keys();
          if(keys.length>MAX)await Promise.all(keys.slice(0,keys.length-MAX).map(key=>cache.delete(key)));
        } catch { /* quota exceeded */ }
      }
      return response;
    } catch { return Response.error(); }
  })());
});

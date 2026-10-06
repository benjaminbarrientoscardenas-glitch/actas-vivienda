/* Guarda la app en el teléfono para que abra sin señal. Cambia VER al publicar una versión nueva. */
const VER="actas-v57";
const FILES=["./","index.html","manifest.json","icon-180.png","icon-192.png","icon-512.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VER).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:"reload"})))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VER).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  if(new URL(e.request.url).origin!==location.origin)return;
  if(e.request.url.includes("__ping"))return; /* prueba de conexión: siempre va a la red */
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{
    if(res.ok){const cp=res.clone();caches.open(VER).then(c=>c.put(e.request,cp))}return res
  }).catch(()=>e.request.mode==="navigate"?caches.match("index.html"):Response.error())))
});

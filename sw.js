/* Guarda la app en el teléfono para que abra sin señal. Cambia VER al publicar una versión nueva. */
const VER="actas-v82";
const FILES=["./","index.html","manifest.json","icon-180.png","icon-192.png","icon-512.png"];
/* Bibliotecas grandes que no cambian entre versiones (lector de PDF): se descargan la primera vez que se usan
   y quedan guardadas aparte, para no bajarlas de nuevo con cada versión. */
const LIBS=["lib-pdfjs-6.3.289"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VER).then(c=>c.addAll(FILES.map(f=>new Request(f,{cache:"reload"})))).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VER&&!LIBS.includes(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET")return;
  const u=new URL(e.request.url);
  if(u.origin!==location.origin)return;
  if(e.request.url.includes("__ping"))return; /* prueba de conexión: siempre va a la red */
  const lib=u.pathname.match(/\/lib\/([^/]+)\//);
  if(lib&&LIBS.includes("lib-"+lib[1])){
    e.respondWith(caches.open("lib-"+lib[1]).then(c=>c.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{if(res.ok)c.put(e.request,res.clone());return res}))));
    return;
  }
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(r=>r||fetch(e.request).then(res=>{
    if(res.ok){const cp=res.clone();caches.open(VER).then(c=>c.put(e.request,cp))}return res
  }).catch(()=>e.request.mode==="navigate"?caches.match("index.html"):Response.error())))
});

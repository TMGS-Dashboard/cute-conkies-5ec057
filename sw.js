const C='everything-v5';
const SHELL=['./','index.html','fitness-coach.html','manifest.webmanifest','icon-192.png','icon-512.png','apple-touch-icon.png'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(SHELL).catch(()=>{})));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const req=e.request;if(req.method!=='GET')return;
  const sameOrigin=new URL(req.url).origin===location.origin;
  e.respondWith(fetch(req).then(res=>{if(sameOrigin){const cp=res.clone();caches.open(C).then(c=>c.put(req,cp));}return res;})
    .catch(()=>caches.match(req).then(m=>m|| (req.mode==='navigate'?caches.match('index.html'):undefined))));});

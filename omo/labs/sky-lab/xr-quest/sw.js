// Omo Space service worker (step 6). Small on purpose: Quest PWAs have a limited storage quota.
// - Precaches only the offline page, the manifest and one icon. It never caches the room, the terminals or anything
//   under /live/ (those carry the private desk token and must always come from your own server).
// - Page loads go to the network first. If the network or the desk server cannot be reached, it shows the offline
//   page, which tells the user a connection is needed (VRC.Quest.Functional.7).
'use strict';
const CACHE = 'omo-pwa-v1';
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/pwa/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
  }
  // everything else: straight to the network (no respondWith), so nothing private is ever stored
});

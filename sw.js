// Service Worker: アプリの画面ファイルをキャッシュして素早く起動させる。
// データ(Supabase)は常にネット経由で取得するため、ここではキャッシュしない。
// index.html などを更新したら VERSION を上げると、利用中の端末にも反映される。
const VERSION = "v1";
const CACHE = `wishlist-${VERSION}`;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./config.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("wishlist-") && k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase や CDN はそのまま通す

  // 画面(HTML)はネット優先: 更新がすぐ反映され、圏外のときだけキャッシュを使う
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // アイコンはキャッシュ優先、それ以外(config.js など)はネット優先
  if (url.pathname.includes("/icons/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

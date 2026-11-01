// POC-only link and service-worker status. The coordinates module does not
// use this. navigator.onLine is only the network interface: Wi-Fi, mobile
// data, or a VPN adapter can be up while this host is unreachable. The page
// does not probe the host. A probe would hang until timeout inside the tunnel,
// and a cached response could not tell the two cases apart.

let started = false;

export function startOfflineStatus(element) {
  if (typeof window === "undefined" || started) return;
  started = true;

  const status = {
    link: navigator.onLine ? "up" : "down",
    cache: "serviceWorker" in navigator ? "installing" : "unavailable",
  };
  const linkEl = element?.querySelector("[data-offline-link]") ?? null;
  const cacheEl = element?.querySelector("[data-offline-cache]") ?? null;

  function paint() {
    if (linkEl) linkEl.textContent = status.link === "up" ? "Länk: uppe" : "Länk: nere";
    if (cacheEl) {
      if (status.cache === "active") cacheEl.textContent = "Offline-cache: aktiv";
      else if (status.cache === "unavailable") cacheEl.textContent = "Offline-cache: inte tillgänglig";
      else cacheEl.textContent = "Offline-cache: installeras…";
    }
  }

  function noteLink() {
    status.link = navigator.onLine ? "up" : "down";
    paint();
  }

  function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (navigator.serviceWorker.controller) status.cache = "active";
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      status.cache = navigator.serviceWorker.controller ? "active" : "installing";
      paint();
    });
    navigator.serviceWorker
      .register("./sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => {
        status.cache = navigator.serviceWorker.controller ? "active" : "installing";
        paint();
      })
      .catch(() => {
        status.cache = "unavailable";
        paint();
      });
  }

  window.addEventListener("online", noteLink);
  window.addEventListener("offline", noteLink);
  registerWorker();
  paint();
}

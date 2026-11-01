// POC-only link, origin, and service-worker status. The coordinates module
// does not use this. navigator.onLine is only the network interface: Wi-Fi,
// mobile data, or a VPN adapter can be up while this host is unreachable.
// The origin probe bypasses the service worker and is aborted quickly.

const PROBE_TIMEOUT_MS = 2500;
const MIN_PROBE_GAP_MS = 10000;

let started = false;

export function startOfflineStatus(element) {
  if (typeof window === "undefined" || started) return;
  started = true;

  const status = {
    link: navigator.onLine ? "up" : "down",
    origin: navigator.onLine ? "checking" : "unreachable",
    cache: "serviceWorker" in navigator ? "installing" : "unavailable",
  };
  let probeGeneration = 0;
  let lastProbeStarted = 0;
  const linkEl = element?.querySelector("[data-offline-link]") ?? null;
  const originEl = element?.querySelector("[data-offline-origin]") ?? null;
  const cacheEl = element?.querySelector("[data-offline-cache]") ?? null;

  function paint() {
    if (linkEl) linkEl.textContent = status.link === "up" ? "Länk: uppe" : "Länk: nere";
    if (originEl) {
      if (status.origin === "reachable") originEl.textContent = "Värd: nås";
      else if (status.origin === "unreachable") originEl.textContent = "Värd: nås inte";
      else originEl.textContent = "Värd: kontrolleras…";
    }
    if (cacheEl) {
      if (status.cache === "active") cacheEl.textContent = "Offline-cache: aktiv";
      else if (status.cache === "unavailable") cacheEl.textContent = "Offline-cache: inte tillgänglig";
      else cacheEl.textContent = "Offline-cache: installeras…";
    }
  }

  function noteLink() {
    if (navigator.onLine) {
      status.link = "up";
      paint();
      return;
    }
    probeGeneration += 1;
    status.link = "down";
    status.origin = "unreachable";
    paint();
  }

  async function probeOrigin(force) {
    noteLink();
    if (status.link !== "up") return;
    const now = Date.now();
    if (!force && now - lastProbeStarted < MIN_PROBE_GAP_MS) return;
    lastProbeStarted = now;
    const generation = ++probeGeneration;
    status.origin = "checking";
    paint();
    const probeController = new AbortController();
    const timer = setTimeout(() => probeController.abort(), PROBE_TIMEOUT_MS);
    let reachable = false;
    try {
      const probe = new URL(window.location.href);
      probe.search = "?origin-probe=1";
      const response = await fetch(probe, {
        method: "GET",
        cache: "no-store",
        signal: probeController.signal,
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    } finally {
      clearTimeout(timer);
    }
    if (generation !== probeGeneration) return;
    status.origin = reachable ? "reachable" : "unreachable";
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

  window.addEventListener("online", () => {
    noteLink();
    void probeOrigin(true);
  });
  window.addEventListener("offline", () => {
    noteLink();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void probeOrigin(false);
  });
  registerWorker();
  void probeOrigin(true);
  paint();
}

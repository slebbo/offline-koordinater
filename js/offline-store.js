// Link, origin, and service-worker status.
//
// navigator.onLine is only the network interface: Wi-Fi, mobile data, or a VPN
// adapter can be up while this host is unreachable. The origin probe bypasses
// the service worker and is aborted quickly, so a black-holed tunnel does not
// look like a working public internet and does not stall the page.

const PROBE_TIMEOUT_MS = 2500;
const MIN_PROBE_GAP_MS = 10000;

let probeGeneration = 0;
let lastProbeStarted = 0;

export function registerOfflineStore(Alpine) {
  Alpine.store("offline", {
    link: navigator.onLine ? "up" : "down",
    origin: navigator.onLine ? "checking" : "unreachable",
    cache: "serviceWorker" in navigator ? "installing" : "unavailable",
    init() {
      window.addEventListener("online", () => {
        this.noteLink();
        void this.probeOrigin(true);
      });
      window.addEventListener("offline", () => {
        this.noteLink();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void this.probeOrigin(false);
      });
      this.registerWorker();
      void this.probeOrigin(true);
    },
    noteLink() {
      if (navigator.onLine) {
        this.link = "up";
        return;
      }
      probeGeneration += 1;
      this.link = "down";
      this.origin = "unreachable";
    },
    async probeOrigin(force) {
      this.noteLink();
      if (this.link !== "up") return;
      const now = Date.now();
      if (!force && now - lastProbeStarted < MIN_PROBE_GAP_MS) return;
      lastProbeStarted = now;
      const generation = ++probeGeneration;
      this.origin = "checking";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let reachable = false;
      try {
        const probe = new URL(window.location.href);
        probe.search = "?origin-probe=1";
        const response = await fetch(probe, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        reachable = response.ok;
      } catch {
        reachable = false;
      } finally {
        clearTimeout(timer);
      }
      if (generation !== probeGeneration) return;
      this.origin = reachable ? "reachable" : "unreachable";
    },
    registerWorker() {
      if (!("serviceWorker" in navigator)) return;
      if (navigator.serviceWorker.controller) this.cache = "active";
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        this.cache = navigator.serviceWorker.controller ? "active" : "installing";
      });
      navigator.serviceWorker
        .register("./sw.js")
        .then(() => navigator.serviceWorker.ready)
        .then(() => {
          this.cache = navigator.serviceWorker.controller ? "active" : "installing";
        })
        .catch(() => {
          this.cache = "unavailable";
        });
    },
  });
}

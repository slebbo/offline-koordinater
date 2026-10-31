// Link and service-worker status.
//
// navigator.onLine is only the network interface: Wi-Fi, mobile data, or a VPN
// adapter can be up while this host is unreachable. The page does not probe
// the host. A probe would hang until timeout inside the tunnel, and a cached
// response could not tell the two cases apart. The service worker serves the
// precache without asking the network.

export function registerOfflineStore(Alpine) {
  Alpine.store("offline", {
    link: navigator.onLine ? "up" : "down",
    cache: "serviceWorker" in navigator ? "installing" : "unavailable",
    init() {
      window.addEventListener("online", () => {
        this.link = "up";
      });
      window.addEventListener("offline", () => {
        this.link = "down";
      });
      this.registerWorker();
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

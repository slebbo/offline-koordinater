// Network status and service-worker registration. The worker only serves the
// precache; this store reports whether that cache is in control.

export function registerOfflineStore(Alpine) {
  Alpine.store("offline", {
    online: navigator.onLine,
    cache: "serviceWorker" in navigator ? "installing" : "unavailable",
    init() {
      window.addEventListener("online", () => {
        this.online = true;
      });
      window.addEventListener("offline", () => {
        this.online = false;
      });
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

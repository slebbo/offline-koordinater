import Alpine from "../vendor/alpinejs/module.esm.js";
import persist from "../vendor/@alpinejs/persist/module.esm.js";
import { registerGeoStore } from "./geo-store.js";
import { registerOfflineStore } from "./offline-store.js";
import { registerComponents } from "./components.js";

Alpine.plugin(persist);

Alpine.store("ui", {
  mode: null,
  open(mode) {
    this.mode = mode;
  },
  close() {
    this.mode = null;
  },
});

registerGeoStore(Alpine);
registerOfflineStore(Alpine);
registerComponents(Alpine);

Alpine.start();

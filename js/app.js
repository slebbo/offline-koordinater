// POC layout. Every page loads this file. Alpine and the coordinates
// store start here, in the background. Markup decides whether this page
// shows the controls, a readout, or neither. The service worker belongs
// to the offline demo, not to the coordinates module.

import Alpine from "../vendor/alpinejs/module.esm.js";
import persist from "../vendor/@alpinejs/persist/module.esm.js";
import { startCoordinates } from "./coordinates/index.js";
import { startOfflineStatus } from "./offline-status.js";

window.Alpine = Alpine;
Alpine.plugin(persist);

startCoordinates({
  // Ask on load when the context allows it. Left off unless the page opts
  // in, so the confirm dialog stays the demo's only prompt.
  requestAccessOnLoad: document.documentElement.dataset.requestAccess === "true"
    || new URLSearchParams(window.location.search).has("request-access"),
});

startOfflineStatus(document.querySelector("[data-offline-status]"));

Alpine.start();

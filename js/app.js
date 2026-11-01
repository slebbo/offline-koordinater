// POC layout. Every page loads this file. The coordinates engine starts
// here, in the background. Markup decides whether this page shows the
// controls, a readout, or neither. The service worker belongs to the
// offline demo, not to the coordinates module.

import {
  mountCoordinatesPanel,
  mountCoordinatesReadout,
  startCoordinates,
} from "./coordinates/index.js";
import { startOfflineStatus } from "./offline-status.js";

startCoordinates({
  // Ask on load when the context allows it. Left off unless the page opts
  // in, so the confirm dialog stays the demo's only prompt.
  requestAccessOnLoad: document.documentElement.dataset.requestAccess === "true"
    || new URLSearchParams(window.location.search).has("request-access"),
});

startOfflineStatus(document.querySelector("[data-offline-status]"));

const panel = document.querySelector("[data-coordinates-panel]");
if (panel) mountCoordinatesPanel(panel);

const readout = document.querySelector("[data-coordinates-readout]");
if (readout) mountCoordinatesReadout(readout);

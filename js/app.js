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

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode");
const interval = params.get("interval");

startCoordinates({
  // Ask on load when the context allows it. Left off unless the page opts
  // in, so the confirm dialog stays the demo's only prompt.
  requestAccessOnLoad: document.documentElement.dataset.requestAccess === "true"
    || params.has("request-access"),
  // `?mode=poll` or `?mode=load` lets the demo start in that mode.
  // `?interval=60000` sets the sample interval in milliseconds.
  ...(mode ? { mode } : {}),
  ...(interval ? { pollIntervalMs: Number(interval) } : {}),
});

startOfflineStatus(document.querySelector("[data-offline-status]"));

const panel = document.querySelector("[data-coordinates-panel]");
if (panel) mountCoordinatesPanel(panel);

const readout = document.querySelector("[data-coordinates-readout]");
if (readout) mountCoordinatesReadout(readout);

// Embeddable coordinates module. No service worker and no framework.
// Call startCoordinates() once from the shared layout. Mount the panel
// only on the page that should show the controls.

export { startCoordinates, getCoordinates } from "./engine.js";
export { mountCoordinatesPanel, mountCoordinatesReadout } from "./panel.js";

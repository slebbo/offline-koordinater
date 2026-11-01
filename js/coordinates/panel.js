// Controls and readout for the coordinates engine. Mount the panel on the
// one page that should show the switches. Mount the readout anywhere the
// position should be visible. Both subscribe; neither starts a second tracker.

import { startCoordinates } from "./engine.js";
import { describeCoordinates } from "./status.js";

const DIALOG_TEXT = {
  oneshot:
    "Får enheten hämta position en gång? Träffen sparas i webbläsaren. Du kan byta sida medan hämtningen pågår.",
  poll: "Får enheten hämta position löpande? Reglaget stänger av pollningen, även om du har bytt sida.",
};

const mounts = new WeakMap();
let mountSequence = 0;

/**
 * Render status, the fetch button, the poll switch, and the confirm dialog
 * into `element`. Returns a function that removes that UI. The engine keeps
 * running. Must run in the browser, after `element` is in the document.
 * @param {HTMLElement} element
 * @returns {() => void}
 */
export function mountCoordinatesPanel(element) {
  return mount(element, { controls: true });
}

/**
 * Render status and the latest fix, without controls.
 * @param {HTMLElement} element
 * @returns {() => void}
 */
export function mountCoordinatesReadout(element) {
  return mount(element, { controls: false });
}

function mount(element, { controls }) {
  if (typeof document === "undefined") {
    throw new Error("Coordinates UI must be mounted in the browser.");
  }
  if (!(element instanceof HTMLElement)) {
    throw new Error("Coordinates UI must be mounted on an HTMLElement.");
  }
  mounts.get(element)?.();

  const coordinates = startCoordinates();
  const id = ++mountSequence;
  const addedLabel = !element.hasAttribute("aria-label");
  const addedRole = element.tagName !== "SECTION" && !element.hasAttribute("role");
  element.classList.add("coordinates");
  if (addedRole) element.setAttribute("role", "region");
  if (addedLabel) element.setAttribute("aria-label", "Enhetens position");
  element.innerHTML = controls ? panelMarkup(id) : readoutMarkup();

  const status = element.querySelector(".coordinates-status");
  const spinner = element.querySelector(".coordinates-spinner");
  const statusText = element.querySelector(".coordinates-status-text");
  const position = element.querySelector(".coordinates-position");
  const updated = element.querySelector(".coordinates-updated");
  const input = element.querySelector(".coordinates-switch-input");
  const dialog = element.querySelector(".coordinates-dialog");
  const dialogText = element.querySelector(".coordinates-dialog-text");
  let pendingMode = null;

  function paint(state) {
    const view = describeCoordinates(state);
    element.dataset.phase = view.phase;
    element.setAttribute("aria-busy", view.busy ? "true" : "false");
    spinner.hidden = !view.busy;
    statusText.textContent = view.statusText;
    position.textContent = view.positionText;
    position.dataset.empty = view.positionEmpty;
    updated.textContent = view.updatedText;
    updated.dataset.empty = view.updatedEmpty;
    if (input) input.checked = Boolean(state.polling);
  }

  function openDialog(mode) {
    pendingMode = mode;
    if (dialogText) dialogText.textContent = DIALOG_TEXT[mode] ?? "";
    if (dialog && !dialog.open) dialog.showModal();
  }

  const unsubscribe = coordinates.subscribe(paint);

  element.querySelector(".coordinates-action-fetch")?.addEventListener("click", () => {
    if (coordinates.getState().polling) {
      coordinates.refreshNow();
      return;
    }
    openDialog("oneshot");
  });

  input?.addEventListener("change", () => {
    if (input.checked) {
      input.checked = false;
      openDialog("poll");
      return;
    }
    coordinates.stopPolling();
  });

  element.querySelector(".coordinates-dialog-allow")?.addEventListener("click", () => {
    const mode = pendingMode;
    // Read position before closing. The tap has to reach getCurrentPosition
    // in this same turn, or mobile Safari never shows its prompt.
    if (mode === "poll" || mode === "oneshot") coordinates.request(mode);
    pendingMode = null;
    if (dialog?.open) dialog.close();
  });

  element.querySelector(".coordinates-dialog-cancel")?.addEventListener("click", () => {
    pendingMode = null;
    if (dialog?.open) dialog.close();
  });

  dialog?.addEventListener("close", () => {
    pendingMode = null;
  });

  status?.setAttribute("aria-live", "polite");

  function dispose() {
    unsubscribe();
    if (dialog?.open) dialog.close();
    element.replaceChildren();
    element.classList.remove("coordinates");
    element.removeAttribute("data-phase");
    element.removeAttribute("aria-busy");
    if (addedRole) element.removeAttribute("role");
    if (addedLabel) element.removeAttribute("aria-label");
    mounts.delete(element);
  }

  mounts.set(element, dispose);
  return dispose;
}

function readoutMarkup() {
  return `
    <p class="coordinates-status">
      <span class="coordinates-spinner" hidden></span>
      <span class="coordinates-status-text">Ingen hämtning pågår.</span>
    </p>
    <dl class="coordinates-readout">
      <div>
        <dt>Position (long, lat)</dt>
        <dd class="coordinates-position" data-empty="true">Ingen position ännu</dd>
      </div>
      <div>
        <dt>Senast uppdaterad</dt>
        <dd class="coordinates-updated" data-empty="true">Inte uppdaterad</dd>
      </div>
    </dl>
  `;
}

function panelMarkup(id) {
  const hintId = `coordinates-hint-${id}`;
  const titleId = `coordinates-title-${id}`;
  return `
    ${readoutMarkup()}
    <div class="coordinates-controls">
      <button class="coordinates-action coordinates-action-fetch" type="button">Hämta position</button>
      <label class="coordinates-switch">
        <input class="coordinates-switch-input" type="checkbox" role="switch" aria-describedby="${hintId}">
        <span class="coordinates-track" aria-hidden="true"><span class="coordinates-thumb"></span></span>
        <span>Polla position</span>
      </label>
      <p class="coordinates-hint" id="${hintId}">På läser positionen löpande. Av stoppar pollningen.</p>
    </div>
    <dialog class="coordinates-dialog" aria-labelledby="${titleId}">
      <h2 class="coordinates-dialog-title" id="${titleId}">Bekräfta position</h2>
      <p class="coordinates-dialog-text"></p>
      <div class="coordinates-dialog-actions">
        <button class="coordinates-dialog-cancel" type="button">Avbryt</button>
        <button class="coordinates-action coordinates-dialog-allow" type="button">Tillåt</button>
      </div>
    </dialog>
  `;
}

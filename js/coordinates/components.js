// Alpine components for the coordinates store. Register them from
// startCoordinates(), before Alpine.start(). Markup lives in the host
// template so the controls can sit beside the host's other components.

import { describeCoordinates } from "./status.js";

const DIALOG_TEXT = {
  oneshot:
    "Får enheten hämta position en gång? Träffen sparas i webbläsaren. Du kan byta sida medan hämtningen pågår.",
  poll: "Får enheten hämta position löpande? Reglaget stänger av pollningen, även om du har bytt sida.",
};

export function registerCoordinatesComponents(Alpine) {
  Alpine.data("coordinatesStatus", () => ({
    get view() {
      return describeCoordinates(this.$store.geo);
    },
  }));

  Alpine.data("coordinatesControls", () => ({
    init() {
      this.$refs.input.checked = Boolean(this.$store.geo.polling);
      this.$watch("$store.geo.polling", (value) => {
        this.$refs.input.checked = Boolean(value);
      });
    },
    ask() {
      const geo = this.$store.geo;
      if (geo.polling) {
        geo.refreshNow();
        return;
      }
      this.$store.coordinatesUi.open("oneshot");
    },
    onChange(event) {
      if (event.target.checked) {
        event.target.checked = false;
        this.$store.coordinatesUi.open("poll");
        return;
      }
      this.$store.geo.stopPolling();
    },
  }));

  Alpine.data("coordinatesConfirm", () => ({
    init() {
      const dialog = this.$el;
      this.$watch("$store.coordinatesUi.mode", (mode) => {
        if (mode && !dialog.open) dialog.showModal();
        if (!mode && dialog.open) dialog.close();
      });
      dialog.addEventListener("close", () => {
        if (this.$store.coordinatesUi.mode) this.$store.coordinatesUi.close();
      });
    },
    get text() {
      return DIALOG_TEXT[this.$store.coordinatesUi.mode] ?? "";
    },
    allow() {
      const mode = this.$store.coordinatesUi.mode;
      if (mode === "poll" || mode === "oneshot") this.$store.geo.request(mode);
      this.$store.coordinatesUi.close();
    },
    cancel() {
      this.$store.coordinatesUi.close();
    },
  }));
}

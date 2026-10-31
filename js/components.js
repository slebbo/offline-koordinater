// Page components. Each factory is registered with Alpine.data and keeps its
// own DOM behavior; shared position and offline flags live in Alpine stores.

const STATUS_TEXT = {
  idle: "Ingen hämtning pågår.",
  checking: "Kontrollerar om enheten kan hämta position…",
  acquiring: "Hämtar position…",
  polling: "Pollar position.",
  ready: "Senaste position är lagrad i webbläsaren.",
  unsupported: "Enheten kan inte hämta position.",
  insecure: "Position kan bara hämtas via localhost eller https.",
  denied: "Tillstånd att hämta position nekades.",
  unavailable: "Positionen gick inte att läsa från enheten.",
  timeout: "Hämtningen tog för lång tid och avbröts.",
};

const DIALOG_TEXT = {
  oneshot:
    "Får enheten hämta position en gång? Träffen sparas i webbläsaren. Du kan byta sida medan hämtningen pågår.",
  poll: "Får enheten hämta position löpande? Reglaget längst ned stänger av pollningen, även om du har bytt sida.",
};

const updatedFormatter = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function registerComponents(Alpine) {
  Alpine.data("statusPlate", statusPlate);
  Alpine.data("fetchPosition", fetchPosition);
  Alpine.data("pollSwitch", pollSwitch);
  Alpine.data("confirmDialog", confirmDialog);
}

function hasPosition(geo) {
  return Number.isFinite(geo.longitude) && Number.isFinite(geo.latitude);
}

function statusPlate() {
  return {
    get geo() {
      return this.$store.geo;
    },
    get offline() {
      return this.$store.offline;
    },
    get key() {
      const geo = this.geo;
      if (geo.checking && !geo.acquiring) return "checking";
      if (geo.error && !geo.acquiring) return geo.error;
      if (geo.acquiring) return "acquiring";
      if (geo.polling) return "polling";
      if (hasPosition(geo)) return "ready";
      return "idle";
    },
    get busy() {
      const key = this.key;
      return key === "checking" || key === "acquiring";
    },
    get phase() {
      const key = this.key;
      if (key === "checking" || key === "acquiring") return "acquiring";
      if (key === "polling") return "polling";
      if (this.geo.error && !this.geo.acquiring) return "error";
      return "idle";
    },
    get statusText() {
      return STATUS_TEXT[this.key] ?? STATUS_TEXT.idle;
    },
    get positionText() {
      if (!hasPosition(this.geo)) return "Ingen position ännu";
      return `${this.geo.longitude.toFixed(6)}, ${this.geo.latitude.toFixed(6)}`;
    },
    get positionEmpty() {
      return hasPosition(this.geo) ? "false" : "true";
    },
    get updatedText() {
      if (!Number.isFinite(this.geo.updatedAt)) return "Inte uppdaterad";
      return updatedFormatter.format(new Date(this.geo.updatedAt));
    },
    get updatedEmpty() {
      return Number.isFinite(this.geo.updatedAt) ? "false" : "true";
    },
    get linkText() {
      return this.offline.link === "up" ? "Länk: uppe" : "Länk: nere";
    },
    get originText() {
      if (this.offline.origin === "reachable") return "Värd: nås";
      if (this.offline.origin === "unreachable") return "Värd: nås inte";
      return "Värd: kontrolleras…";
    },
    get cacheText() {
      if (this.offline.cache === "active") return "Offline-cache: aktiv";
      if (this.offline.cache === "unavailable") return "Offline-cache: inte tillgänglig";
      return "Offline-cache: installeras…";
    },
  };
}

function fetchPosition() {
  return {
    ask() {
      const geo = this.$store.geo;
      if (geo.polling) {
        geo.refreshNow();
        return;
      }
      this.$store.ui.open("oneshot");
    },
  };
}

function pollSwitch() {
  return {
    init() {
      this.$refs.input.checked = Boolean(this.$store.geo.polling);
      this.$watch("$store.geo.polling", (value) => {
        this.$refs.input.checked = Boolean(value);
      });
    },
    onChange(event) {
      if (event.target.checked) {
        event.target.checked = false;
        this.$store.ui.open("poll");
        return;
      }
      this.$store.geo.stopPolling();
    },
  };
}

function confirmDialog() {
  return {
    init() {
      const dialog = this.$el;
      this.$watch("$store.ui.mode", (mode) => {
        if (mode && !dialog.open) dialog.showModal();
        if (!mode && dialog.open) dialog.close();
      });
      dialog.addEventListener("close", () => {
        if (this.$store.ui.mode) this.$store.ui.close();
      });
    },
    get text() {
      return DIALOG_TEXT[this.$store.ui.mode] ?? "";
    },
    allow() {
      const mode = this.$store.ui.mode;
      this.$store.ui.close();
      if (mode === "poll" || mode === "oneshot") this.$store.geo.request(mode);
    },
    cancel() {
      this.$store.ui.close();
    },
  };
}

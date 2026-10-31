const STATUS_TEXT = {
  idle: "Ingen hämtning pågår.",
  checking: "Service workern kontrollerar om enheten kan hämta position…",
  acquiring: "Hämtar position…",
  polling: "Pollar position.",
  ready: "Senaste position är lagrad i service workern.",
  unsupported: "Enheten kan inte hämta position.",
  insecure: "Position kan bara hämtas via localhost eller https.",
  denied: "Tillstånd att hämta position nekades.",
  unavailable: "Positionen gick inte att läsa från enheten.",
  timeout: "Hämtningen tog för lång tid och avbröts.",
};

const DIALOG_TEXT = {
  oneshot:
    "Får enheten hämta position en gång? Service workern kontrollerar att det går och lagrar resultatet. Du kan byta sida medan hämtningen pågår.",
  poll: "Får enheten hämta position löpande? Reglaget längst ned stänger av pollningen, även om du har bytt sida.",
};

const ONESHOT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 };
const ERROR_CODES = { 1: "denied", 2: "unavailable", 3: "timeout" };

const updatedFormatter = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const statusPlate = document.querySelector("#status-plate");
const statusText = document.querySelector("#status-text");
const spinner = document.querySelector("#spinner");
const positionValue = document.querySelector("#position-value");
const updatedValue = document.querySelector("#updated-value");
const connectivity = document.querySelector("#connectivity");
const cacheState = document.querySelector("#cache-state");
const pollToggle = document.querySelector("#poll-toggle");
const fetchButton = document.querySelector("#fetch-position");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmText = document.querySelector("#confirm-text");
const confirmAllow = document.querySelector("#confirm-allow");
const confirmCancel = document.querySelector("#confirm-cancel");

const EMPTY_STATE = {
  longitude: null,
  latitude: null,
  updatedAt: null,
  polling: false,
  acquiring: false,
  decision: null,
  error: null,
  revision: -1,
};

let registration = null;
let lastState = { ...EMPTY_STATE };
let seenRevision = -1;
let baselineRevision = -1;
let pendingCheck = false;
let pendingMode = null;
let syncingControl = false;
let activeMode = null;
let watchId = null;
let generation = 0;
let leaving = false;
let workerReady = false;

function hasPosition(next) {
  return Number.isFinite(next.longitude) && Number.isFinite(next.latitude);
}

function formatPair(next) {
  return `${next.longitude.toFixed(6)}, ${next.latitude.toFixed(6)}`;
}

function statusKey(next) {
  if (pendingCheck && !next.acquiring && !next.error) return "checking";
  if (next.error && !next.acquiring) return next.error;
  if (next.acquiring) return "acquiring";
  if (next.polling) return "polling";
  if (hasPosition(next)) return "ready";
  return "idle";
}

function render(next) {
  lastState = next;
  const key = statusKey(next);
  const acquiring = key === "checking" || key === "acquiring";
  statusPlate.dataset.phase = acquiring ? "acquiring" : key === "polling" ? "polling" : next.error ? "error" : "idle";
  statusPlate.setAttribute("aria-busy", acquiring ? "true" : "false");
  statusText.textContent = STATUS_TEXT[key] ?? STATUS_TEXT.idle;
  spinner.hidden = !acquiring;
  positionValue.textContent = hasPosition(next) ? formatPair(next) : "Ingen position ännu";
  updatedValue.textContent =
    Number.isFinite(next.updatedAt) ? updatedFormatter.format(new Date(next.updatedAt)) : "Inte uppdaterad";
  positionValue.dataset.empty = hasPosition(next) ? "false" : "true";
  updatedValue.dataset.empty = Number.isFinite(next.updatedAt) ? "false" : "true";
  syncingControl = true;
  pollToggle.checked = Boolean(next.polling);
  syncingControl = false;
  renderRuntime();
}

function renderRuntime() {
  const online = navigator.onLine;
  connectivity.textContent = online ? "Nätverk: online" : "Nätverk: offline";
  cacheState.textContent = navigator.serviceWorker.controller
    ? "Offline-cache: aktiv"
    : "Offline-cache: installeras…";
}

function send(message) {
  const worker = registration?.active;
  if (!worker) return Promise.reject(new Error("no-worker"));
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.onmessage = null;
      reject(new Error("timeout"));
    }, 4000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

function shouldTrack(next) {
  return Boolean(next.polling || (next.acquiring && next.acquireMode === "oneshot"));
}

function applyState(data) {
  if (!data || data.type !== "STATE" || !data.state) return;
  if (data.state.revision < seenRevision) return;
  if (pendingCheck && data.state.revision <= baselineRevision) return;
  seenRevision = data.state.revision;
  if (data.state.decision || data.state.acquiring || data.state.error) pendingCheck = false;
  render(data.state);
  if (leaving) return;
  if (data.command === "start-watch") {
    startWatch();
    return;
  }
  if (data.command === "start-oneshot") {
    startOneShot();
    return;
  }
  if (!shouldTrack(data.state)) stopTracking();
}

async function refreshState() {
  const data = await send({ type: "GET_STATE" });
  applyState(data);
}

function capabilityReport() {
  return {
    geolocationAvailable: "geolocation" in navigator,
    secureContext: window.isSecureContext,
  };
}

function stopTracking() {
  generation += 1;
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  activeMode = null;
}

function sendFix(position) {
  return send({
    type: "POSITION_FIX",
    fix: {
      longitude: position.coords.longitude,
      latitude: position.coords.latitude,
      timestamp: position.timestamp,
    },
  }).then(applyState);
}

function sendGeoError(error) {
  const code = ERROR_CODES[error.code] ?? "unavailable";
  if (code === "denied") stopTracking();
  else if (activeMode === "oneshot") activeMode = null;
  return send({ type: "POSITION_ERROR", error: code }).then(applyState);
}

function startOneShot() {
  if (activeMode === "oneshot" || activeMode === "watch") return;
  if (!("geolocation" in navigator)) return;
  activeMode = "oneshot";
  const token = ++generation;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (token !== generation) return;
      activeMode = null;
      void sendFix(position);
    },
    (error) => {
      if (token !== generation) return;
      void sendGeoError(error);
    },
    ONESHOT_OPTIONS,
  );
}

function startWatch() {
  if (activeMode === "watch" || !("geolocation" in navigator)) return;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  activeMode = "watch";
  const token = ++generation;
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (token !== generation) return;
      void sendFix(position);
    },
    (error) => {
      if (token !== generation) return;
      void sendGeoError(error);
    },
    WATCH_OPTIONS,
  );
}

function requestImmediateFix() {
  if (!("geolocation" in navigator)) return;
  const token = generation;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      if (token !== generation) return;
      void sendFix(position);
    },
    (error) => {
      if (token !== generation) return;
      void sendGeoError(error);
    },
    ONESHOT_OPTIONS,
  );
}

function begin(mode) {
  baselineRevision = lastState.revision ?? -1;
  pendingCheck = true;
  render(lastState);
  const capability = capabilityReport();
  if (capability.geolocationAvailable && capability.secureContext) {
    if (mode === "poll") startWatch();
    else if (lastState.polling) requestImmediateFix();
    else startOneShot();
  }
  void send({ type: "DECIDE_START", mode, capability })
    .then(applyState)
    .catch(() => {
      pendingCheck = false;
      statusText.textContent = "Service workern svarade inte.";
      spinner.hidden = true;
    });
}

function openDialog(mode) {
  pendingMode = mode;
  confirmText.textContent = DIALOG_TEXT[mode];
  confirmDialog.showModal();
}

function setControlsEnabled(enabled) {
  workerReady = enabled;
  if (fetchButton) fetchButton.disabled = !enabled;
  pollToggle.disabled = !enabled;
}

if (fetchButton) {
  fetchButton.disabled = true;
  fetchButton.addEventListener("click", () => {
    if (!workerReady) return;
    if (lastState.polling && lastState.decision === "accepted") {
      begin("oneshot");
      return;
    }
    openDialog("oneshot");
  });
}

pollToggle.disabled = true;
pollToggle.addEventListener("change", () => {
  if (syncingControl || !workerReady) return;
  if (pollToggle.checked) {
    pollToggle.checked = false;
    openDialog("poll");
    return;
  }
  stopTracking();
  pendingCheck = false;
  void send({ type: "SET_POLLING", enabled: false }).then(applyState);
});

confirmAllow.addEventListener("click", () => {
  const mode = pendingMode;
  pendingMode = null;
  confirmDialog.close();
  if (mode) begin(mode);
});

confirmCancel.addEventListener("click", () => {
  pendingMode = null;
  confirmDialog.close();
});

window.addEventListener("online", renderRuntime);
window.addEventListener("offline", renderRuntime);
window.addEventListener("pagehide", () => {
  leaving = true;
  stopTracking();
  registration?.active?.postMessage({ type: "RELEASE_TRACKING" });
});
window.addEventListener("pageshow", () => {
  leaving = false;
  if (registration?.active) void refreshState().catch(() => {});
});

navigator.serviceWorker.addEventListener("message", (event) => {
  applyState(event.data);
});
navigator.serviceWorker.addEventListener("controllerchange", renderRuntime);

render(EMPTY_STATE);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then((next) => {
      registration = next;
      return navigator.serviceWorker.ready;
    })
    .then(() => refreshState())
    .then(() => {
      setControlsEnabled(true);
      renderRuntime();
    })
    .catch(() => {
      cacheState.textContent = "Offline-cache: inte tillgänglig";
    });
} else {
  cacheState.textContent = "Offline-cache: inte tillgänglig";
}

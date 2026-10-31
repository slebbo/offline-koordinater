// Position state for the open page. Alpine Persist writes each field to
// localStorage so a hard navigation can resume. The Geolocation API exists
// only on documents, so this module — not the service worker — reads it.
// One visible document holds a Web Lock and is the only caller; other tabs
// render the stored fields and take over when the lock is released.

const ACQUIRE_STALE_MS = 120000;
const LOCK_NAME = "offline-koordinater-geo";
const PERSISTED_FIELDS = [
  "longitude",
  "latitude",
  "updatedAt",
  "polling",
  "acquiring",
  "acquiringSince",
  "acquireMode",
  "error",
];
const ONESHOT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 };
const ERROR_CODES = { 1: "denied", 2: "unavailable", 3: "timeout" };

let alpine = null;
let desired = false;
let running = false;
let leading = false;
let locksBroken = false;
/** @type {AbortController | null} */
let leaderAbort = null;
/** @type {number | null} */
let watchId = null;
let watchToken = 0;
let oneshotToken = 0;

function state() {
  return alpine.store("geo");
}

export function registerGeoStore(Alpine) {
  alpine = Alpine;
  Alpine.store("geo", {
    longitude: Alpine.$persist(null).as("ok.longitude"),
    latitude: Alpine.$persist(null).as("ok.latitude"),
    updatedAt: Alpine.$persist(null).as("ok.updatedAt"),
    polling: Alpine.$persist(false).as("ok.polling"),
    acquiring: Alpine.$persist(false).as("ok.acquiring"),
    acquiringSince: Alpine.$persist(null).as("ok.acquiringSince"),
    acquireMode: Alpine.$persist(null).as("ok.acquireMode"),
    error: Alpine.$persist(null).as("ok.error"),
    checking: false,
    immediate: false,
    request(mode) {
      return beginRequest(mode);
    },
    refreshNow() {
      beginRefresh();
    },
    stopPolling() {
      haltPolling();
    },
    init() {
      installRuntime();
    },
  });
}

function installRuntime() {
  expireStaleAcquire();
  window.addEventListener("storage", onStorage);
  window.addEventListener("visibilitychange", syncTracking);
  window.addEventListener("pagehide", () => {
    desired = false;
    leaderAbort?.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) pullPersistedFields();
    syncTracking();
  });
  syncTracking();
}

function expireStaleAcquire() {
  const geo = state();
  if (!geo.acquiring || geo.polling) return;
  const started = geo.acquiringSince ?? 0;
  if (Date.now() - started < ACQUIRE_STALE_MS) return;
  geo.acquiring = false;
  geo.acquireMode = null;
  geo.error = "timeout";
}

async function queryPermission() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function decide() {
  if (!("geolocation" in navigator)) return { ok: false, error: "unsupported" };
  if (!window.isSecureContext) return { ok: false, error: "insecure" };
  const permission = await queryPermission();
  if (permission === "denied") return { ok: false, error: "denied" };
  return { ok: true };
}

async function beginRequest(mode) {
  const geo = state();
  if (geo.checking) return;
  if (mode === "poll" && geo.polling) return;
  if (mode !== "poll" && geo.acquiring && !geo.polling) return;
  geo.checking = true;
  const decision = await decide();
  geo.checking = false;
  if (!decision.ok) {
    const fatal = decision.error === "denied" || decision.error === "unsupported" || decision.error === "insecure";
    geo.acquiring = false;
    geo.acquiringSince = null;
    geo.error = decision.error;
    geo.immediate = false;
    if (fatal || mode === "poll") geo.polling = false;
    if (fatal || mode === "poll" || !geo.polling) geo.acquireMode = null;
    syncTracking();
    return;
  }
  geo.error = null;
  geo.acquiring = true;
  geo.acquiringSince = Date.now();
  if (mode === "poll") {
    geo.polling = true;
    geo.acquireMode = "poll";
    geo.immediate = false;
  } else if (geo.polling) {
    geo.immediate = true;
  } else {
    geo.acquireMode = "oneshot";
    geo.immediate = false;
  }
  followState();
}

function beginRefresh() {
  const geo = state();
  if (!("geolocation" in navigator)) {
    geo.error = "unsupported";
    geo.polling = false;
    geo.acquiring = false;
    geo.acquiringSince = null;
    geo.acquireMode = null;
    geo.immediate = false;
    syncTracking();
    return;
  }
  if (!window.isSecureContext) {
    geo.error = "insecure";
    geo.polling = false;
    geo.acquiring = false;
    geo.acquiringSince = null;
    geo.acquireMode = null;
    geo.immediate = false;
    syncTracking();
    return;
  }
  geo.error = null;
  geo.acquiring = true;
  geo.acquiringSince = Date.now();
  geo.immediate = true;
  followState();
}

function haltPolling() {
  const geo = state();
  geo.polling = false;
  geo.immediate = false;
  if (geo.acquireMode === "poll") {
    geo.acquiring = false;
    geo.acquiringSince = null;
    geo.acquireMode = null;
  }
  syncTracking();
}

function shouldTrack() {
  const geo = state();
  return Boolean(geo.polling || geo.immediate || (geo.acquiring && geo.acquireMode === "oneshot"));
}

function followState() {
  if (leading) poke();
  syncTracking();
}

function syncTracking() {
  desired = shouldTrack() && document.visibilityState === "visible";
  if (desired && !running) {
    void lead();
    return;
  }
  if (!desired && running) leaderAbort?.abort();
}

async function lead() {
  if (running) return;
  running = true;
  const controller = new AbortController();
  leaderAbort = controller;
  try {
    const hold = async () => {
      if (controller.signal.aborted || !desired) return;
      leading = true;
      poke();
      await waitForAbort(controller.signal);
    };
    if (!locksBroken && navigator.locks?.request) {
      await navigator.locks.request(LOCK_NAME, { mode: "exclusive", signal: controller.signal }, hold);
    } else {
      await hold();
    }
  } catch (error) {
    if (error?.name !== "AbortError") locksBroken = true;
  } finally {
    leading = false;
    stopHardware();
    running = false;
    leaderAbort = null;
    if (desired && document.visibilityState === "visible") void lead();
  }
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function poke() {
  if (!leading) return;
  const geo = state();
  if (geo.polling) startWatch();
  if (geo.immediate || (geo.acquiring && geo.acquireMode === "oneshot" && !geo.polling)) startOneshot();
}

function stopHardware() {
  watchToken += 1;
  oneshotToken += 1;
  if (watchId != null && "geolocation" in navigator) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function startWatch() {
  if (watchId != null || !("geolocation" in navigator)) return;
  const token = ++watchToken;
  try {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (token !== watchToken) return;
        applyFix(position);
      },
      (error) => {
        if (token !== watchToken) return;
        applyError(ERROR_CODES[error.code] ?? "unavailable");
      },
      WATCH_OPTIONS,
    );
  } catch {
    watchId = null;
    applyError("unsupported");
  }
}

function startOneshot() {
  if (!("geolocation" in navigator)) return;
  const token = ++oneshotToken;
  state().immediate = false;
  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (token !== oneshotToken) return;
        applyFix(position);
      },
      (error) => {
        if (token !== oneshotToken) return;
        applyError(ERROR_CODES[error.code] ?? "unavailable");
      },
      ONESHOT_OPTIONS,
    );
  } catch {
    applyError("unsupported");
  }
}

function normalizeFix(position) {
  const longitude = Number(position?.coords?.longitude);
  const latitude = Number(position?.coords?.latitude);
  const timestamp = Number(position?.timestamp);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {
    longitude,
    latitude,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

function applyFix(position) {
  const fix = normalizeFix(position);
  if (!fix) return;
  const geo = state();
  geo.longitude = fix.longitude;
  geo.latitude = fix.latitude;
  geo.updatedAt = fix.timestamp;
  geo.acquiring = false;
  geo.acquiringSince = null;
  geo.error = null;
  geo.immediate = false;
  if (!geo.polling) geo.acquireMode = null;
  syncTracking();
}

function applyError(code) {
  const geo = state();
  const fatal = code === "denied" || code === "unsupported" || code === "insecure";
  geo.acquiring = false;
  geo.acquiringSince = null;
  geo.error = code;
  geo.immediate = false;
  if (fatal) {
    geo.polling = false;
    geo.acquireMode = null;
    stopHardware();
  } else if (geo.acquireMode === "oneshot") {
    geo.acquireMode = null;
  }
  syncTracking();
}

function onStorage(event) {
  if (!event.key?.startsWith("ok.")) return;
  const field = event.key.slice(3);
  if (!PERSISTED_FIELDS.includes(field) || event.newValue == null) return;
  let value;
  try {
    value = JSON.parse(event.newValue);
  } catch {
    return;
  }
  const geo = state();
  if (Object.is(geo[field], value)) return;
  geo[field] = value;
  if (field === "polling" || field === "acquiring" || field === "acquireMode") syncTracking();
}

function pullPersistedFields() {
  const geo = state();
  let trackingChanged = false;
  for (const field of PERSISTED_FIELDS) {
    const raw = localStorage.getItem(`ok.${field}`);
    if (raw == null) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Object.is(geo[field], value)) continue;
    geo[field] = value;
    if (field === "polling" || field === "acquiring" || field === "acquireMode") trackingChanged = true;
  }
  if (trackingChanged) syncTracking();
}

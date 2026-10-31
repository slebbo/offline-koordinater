// Position state for the open page. Alpine Persist writes each field to
// localStorage so a hard navigation can resume. The Geolocation API exists
// only on documents, so this module — not the service worker — reads it.
// One visible document holds a Web Lock and is the only caller; other tabs
// render the stored fields and take over when the lock is released.
//
// Mobile Safari shows the location prompt only when getCurrentPosition runs in
// the same turn as the tap. A permission query or Web Lock await before that
// call drops the gesture: no prompt, and often no error callback. The tap
// therefore starts the read immediately. Permission, policy, and a stall
// watch explain the cases where the browser still never asks.

const ACQUIRE_STALE_MS = 120000;
const PERMISSION_QUERY_MS = 2500;
const PROMPT_STALL_MS = 10000;
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
// High accuracy asks the device for GPS. Wi-Fi and cell positioning often call a
// location service on the public internet, which this POC does not have inside
// its VPN tunnel.
const ONESHOT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 };
const ERROR_CODES = { 1: "denied", 2: "unavailable", 3: "timeout" };
const FATAL_ERRORS = new Set(["denied", "unsupported", "insecure", "policy", "blocked"]);

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
let oneshotActive = false;
// True while the tap's getCurrentPosition is the call that must surface the prompt.
// watchPosition is held back so an early watch error cannot cancel that call.
let gesturePending = false;
let attempt = 0;
let granted = false;
let permissionState = "unknown";
/** @type {number | null} */
let promptTimer = null;
/** @type {PermissionStatus | null} */
let permissionStatus = null;

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
  geo.acquiringSince = null;
  geo.acquireMode = null;
  if (!geo.error) geo.error = "timeout";
}

function isFatal(code) {
  return FATAL_ERRORS.has(code);
}

function canReadLocation() {
  return typeof navigator.geolocation?.getCurrentPosition === "function";
}

function geolocationAllowedByPolicy() {
  const policy = document.permissionsPolicy ?? document.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== "function") return true;
  try {
    return policy.allowsFeature("geolocation");
  } catch {
    return true;
  }
}

// Synchronous gates only. Anything awaited here would run outside the tap and
// Safari would skip the prompt.
function syncBlocker() {
  if (!canReadLocation()) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  if (!geolocationAllowedByPolicy()) return "policy";
  return null;
}

function queryPermission() {
  if (typeof navigator.permissions?.query !== "function") {
    return Promise.resolve({ state: "unknown", status: null });
  }
  const query = navigator.permissions.query({ name: "geolocation" }).then(
    (status) => ({ state: status?.state || "unknown", status: status ?? null }),
    () => ({ state: "unknown", status: null }),
  );
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: "timeout", status: null, late: query }), PERMISSION_QUERY_MS);
  });
  return Promise.race([query, timeout]).finally(() => clearTimeout(timer));
}

function clearPromptTimer() {
  if (promptTimer != null) clearTimeout(promptTimer);
  promptTimer = null;
}

function armPromptWatch(token) {
  if (promptTimer != null) return;
  promptTimer = setTimeout(() => {
    promptTimer = null;
    if (token !== attempt || granted) return;
    const geo = state();
    if (geo.error) return;
    if (!geo.acquiring && !geo.polling) return;
    geo.error = "blocked";
  }, PROMPT_STALL_MS);
}

function noteGrant() {
  granted = true;
  clearPromptTimer();
  const geo = state();
  if (geo.error === "blocked" || geo.error === "denied") geo.error = null;
  ensureWatch();
}

function applyPermissionState(value, token) {
  if (token !== attempt || granted) return;
  permissionState = value;
  if (value === "granted") {
    noteGrant();
    return;
  }
  if (value === "denied") {
    clearPromptTimer();
    state().error = "denied";
    return;
  }
  if (value === "prompt" || value === "timeout") armPromptWatch(token);
}

function bindPermissionStatus(status, token) {
  if (permissionStatus && permissionStatus !== status) permissionStatus.onchange = null;
  permissionStatus = status;
  status.onchange = () => applyPermissionState(status.state, token);
  applyPermissionState(status.state, token);
}

async function diagnosePermission(token) {
  const result = await queryPermission();
  if (token !== attempt) return;
  if (result.status) {
    bindPermissionStatus(result.status, token);
  } else {
    applyPermissionState(result.state, token);
  }
  if (result.late) {
    void result.late.then((late) => {
      if (!late?.status || token !== attempt || granted) return;
      bindPermissionStatus(late.status, token);
    });
  }
}

function startAttempt() {
  attempt += 1;
  granted = false;
  permissionState = "pending";
  clearPromptTimer();
  void diagnosePermission(attempt);
}

function applyPreflight(code, mode) {
  stopHardware();
  clearPromptTimer();
  const geo = state();
  geo.checking = false;
  geo.acquiring = false;
  geo.acquiringSince = null;
  geo.error = code;
  geo.immediate = false;
  if (isFatal(code) || mode === "poll") geo.polling = false;
  if (isFatal(code) || mode === "poll" || !geo.polling) geo.acquireMode = null;
  syncTracking();
}

function beginRequest(mode) {
  const geo = state();
  if (mode === "poll" && geo.polling && !geo.error) return;
  if (mode !== "poll" && geo.acquiring && !geo.polling && !geo.error) return;
  const blocker = syncBlocker();
  if (blocker) {
    applyPreflight(blocker, mode);
    return;
  }
  stopHardware();
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
  // Permission diagnosis awaits. Start it, then read position before this
  // turn ends so the browser still counts the tap.
  startAttempt();
  kickFromGesture();
}

function beginRefresh() {
  const geo = state();
  const blocker = syncBlocker();
  if (blocker) {
    applyPreflight(blocker, "oneshot");
    return;
  }
  stopHardware();
  geo.error = null;
  geo.acquiring = true;
  geo.acquiringSince = Date.now();
  geo.immediate = true;
  startAttempt();
  kickFromGesture();
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

function kickFromGesture() {
  gesturePending = true;
  desired = shouldTrack() && document.visibilityState === "visible";
  if (desired) poke(true);
  if (!oneshotActive) gesturePending = false;
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
      poke(false);
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
    // A rejected lock must not drop the tap's getCurrentPosition. That call is
    // what shows the prompt; cancelling it leaves Safari silent.
    const keepTap = gesturePending && desired && document.visibilityState === "visible";
    if (keepTap) {
      watchToken += 1;
      if (watchId != null && canReadLocation()) navigator.geolocation.clearWatch(watchId);
      watchId = null;
    } else {
      stopHardware();
    }
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

function poke(fromGesture) {
  if (!leading && !fromGesture) return;
  if (!fromGesture && attempt === 0) startAttempt();
  const geo = state();
  const wantOneshot = fromGesture
    ? Boolean(geo.acquiring || geo.immediate)
    : Boolean(geo.immediate || (geo.acquiring && geo.acquireMode === "oneshot" && !geo.polling));
  if (wantOneshot) startOneshot();
  if (!fromGesture) ensureWatch();
}

function ensureWatch() {
  if (gesturePending || document.visibilityState !== "visible") return;
  if (!state().polling) return;
  startWatch();
}

function stopHardware() {
  watchToken += 1;
  oneshotToken += 1;
  oneshotActive = false;
  gesturePending = false;
  if (watchId != null && canReadLocation()) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function startWatch() {
  if (gesturePending || watchId != null || !canReadLocation()) return;
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
  if (oneshotActive || !canReadLocation()) return;
  oneshotActive = true;
  const token = ++oneshotToken;
  state().immediate = false;
  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (token !== oneshotToken) return;
        oneshotActive = false;
        gesturePending = false;
        applyFix(position);
      },
      (error) => {
        if (token !== oneshotToken) return;
        oneshotActive = false;
        gesturePending = false;
        applyError(ERROR_CODES[error.code] ?? "unavailable");
      },
      ONESHOT_OPTIONS,
    );
  } catch {
    oneshotActive = false;
    gesturePending = false;
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
  granted = true;
  clearPromptTimer();
  const geo = state();
  geo.longitude = fix.longitude;
  geo.latitude = fix.latitude;
  geo.updatedAt = fix.timestamp;
  geo.acquiring = false;
  geo.acquiringSince = null;
  geo.error = null;
  geo.immediate = false;
  if (!geo.polling) geo.acquireMode = null;
  ensureWatch();
  syncTracking();
}

function applyError(code) {
  if (
    code === "timeout"
    && !granted
    && permissionState !== "granted"
    && permissionState !== "unknown"
  ) {
    code = "blocked";
  }
  const geo = state();
  if (geo.error === "denied" && code !== "denied") code = "denied";
  clearPromptTimer();
  const fatal = isFatal(code);
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
    ensureWatch();
  } else {
    ensureWatch();
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

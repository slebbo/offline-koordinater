// Background position tracker. The Geolocation API exists only on documents,
// so the host layout starts this on every page. State lives in Alpine.store
// ("geo") and Alpine Persist. Controls are Alpine components in components.js.
// Nothing here talks to a service worker or the network.
//
// Mobile Safari shows the location prompt only when getCurrentPosition runs
// in the same turn as a tap. A permission query or Web Lock await before
// that call drops the gesture: no prompt, and often no error callback. A
// click therefore starts the read immediately. The load-time option has no
// gesture to preserve, so it may ask the Permissions API first and skip
// browsers that would swallow the call.

import { registerCoordinatesComponents } from "./components.js";

const ACQUIRE_STALE_MS = 120000;
const PERMISSION_QUERY_MS = 2500;
const PROMPT_STALL_MS = 10000;
const DEFAULT_LOCK_NAME = "offline-koordinater-geo";
const DEFAULT_PREFIX = "ok";
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
const TRACKING_FIELDS = new Set(["polling", "acquiring", "acquireMode"]);
// High accuracy asks the device for GPS. Wi-Fi and cell positioning often
// call a location service on the public internet.
const ONESHOT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 };
const ERROR_CODES = { 1: "denied", 2: "unavailable", 3: "timeout" };
const FATAL_ERRORS = new Set(["denied", "unsupported", "insecure", "policy", "blocked"]);

const REGISTERED = "__offlineKoordinater";

/**
 * @typedef {"denied" | "blocked" | "unavailable" | "timeout" | "unsupported" | "insecure" | "policy"} CoordinatesError
 * @typedef {"oneshot" | "poll" | null} AcquireMode
 * @typedef {Object} CoordinatesState
 * @property {number | null} longitude
 * @property {number | null} latitude
 * @property {number | null} updatedAt
 * @property {boolean} polling
 * @property {boolean} acquiring
 * @property {number | null} acquiringSince
 * @property {AcquireMode} acquireMode
 * @property {CoordinatesError | null} error
 * @typedef {Object} StartCoordinatesOptions
 * @property {boolean} [requestAccessOnLoad=false]
 *   On this page load, ask for location when the context allows it.
 *   Secure context, a geolocation API, and a Permissions Policy that permits
 *   geolocation are required. A denied permission is not asked again. When
 *   permission is already granted and a fix is stored, this does not read
 *   GPS again; polling, if it is on, was already resumed. With no usable
 *   fix, a granted permission reads once, including in Safari. When the
 *   browser still needs a user gesture to show the prompt (Safari, and
 *   every browser on iPhone and iPad), a pending prompt is skipped and the
 *   controls remain the way to ask.
 * @property {string} [storagePrefix="ok"]
 * @property {string} [lockName="offline-koordinater-geo"]
 * @property {object} [Alpine]
 *   Host Alpine instance. Defaults to `window.Alpine`.
 */

/**
 * Register the geo store and the controls on the host's Alpine, once.
 * Call it after `Alpine.plugin(persist)` and before `Alpine.start()`.
 * A later `requestAccessOnLoad: true` still asks, once, if the first call
 * did not. Without `window` (SSR) this does nothing.
 * The host's other components read `$store.geo`.
 * @param {StartCoordinatesOptions} [options]
 */
export function startCoordinates(options = {}) {
  if (typeof window === "undefined") return;
  const Alpine = options.Alpine ?? window.Alpine;
  if (!Alpine?.store) {
    throw new Error("Set window.Alpine, or pass options.Alpine, before startCoordinates().");
  }
  if (typeof Alpine.$persist !== "function") {
    throw new Error("Register @alpinejs/persist before startCoordinates().");
  }
  const existing = window[REGISTERED];
  if (existing) {
    if (options.requestAccessOnLoad) existing.askOnLoad();
    return;
  }
  const askOnLoad = createEngine(Alpine, normalizeOptions(options));
  window[REGISTERED] = { askOnLoad };
}

function normalizeOptions(options) {
  const prefix = typeof options.storagePrefix === "string" ? options.storagePrefix.trim() : "";
  const lockName = typeof options.lockName === "string" ? options.lockName.trim() : "";
  return {
    requestAccessOnLoad: Boolean(options.requestAccessOnLoad),
    storagePrefix: prefix || DEFAULT_PREFIX,
    lockName: lockName || DEFAULT_LOCK_NAME,
  };
}

function createEngine(Alpine, options) {
  const prefix = options.storagePrefix;
  const lockName = options.lockName;
  /** @type {object | null} */
  let geo = null;

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
  // True while a getCurrentPosition call must not be cancelled by the lock
  // releasing, and while watchPosition should wait so an early watch error
  // cannot cancel that call. On a click this is the user gesture.
  let gesturePending = false;
  let attempt = 0;
  let granted = false;
  let permissionState = "unknown";
  /** @type {number | null} */
  let promptTimer = null;
  /** @type {PermissionStatus | null} */
  let permissionStatus = null;
  let accessGeneration = 0;
  let accessStarted = false;
  let accessWaitInstalled = false;

  // Alpine Persist writes the wrapped fields. Assigning the store proxy is
  // enough for both the open page and localStorage.
  function adopt(patch) {
    let trackingChanged = false;
    for (const field of Object.keys(patch)) {
      const value = patch[field];
      if (Object.is(geo[field], value)) continue;
      geo[field] = value;
      if (TRACKING_FIELDS.has(field)) trackingChanged = true;
    }
    return trackingChanged;
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
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
    if (!geo.acquiring || geo.polling) return;
    const started = geo.acquiringSince ?? 0;
    if (Date.now() - started < ACQUIRE_STALE_MS) return;
    const patch = {
      acquiring: false,
      acquiringSince: null,
      acquireMode: null,
    };
    if (!geo.error) patch.error = "timeout";
    adopt(patch);
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

  // Synchronous gates only. Anything awaited here would run outside a tap
  // and Safari would skip the prompt. The load-time path may await; it has
  // no tap to lose.
  function syncBlocker() {
    if (!canReadLocation()) return "unsupported";
    if (!window.isSecureContext) return "insecure";
    if (!geolocationAllowedByPolicy()) return "policy";
    return null;
  }

  // WebKit shows the location prompt only from a user gesture, and often
  // never calls back when that gesture is missing. Other engines can ask
  // during a page load.
  function canPromptWithoutGesture() {
    const ua = navigator.userAgent || "";
    const iOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iOS) return false;
    const safari = /Safari\//.test(ua)
      && !/Chrom(?:e|ium)|Edg\/|OPR\/|FxiOS|CriOS|Android/.test(ua);
    return !safari;
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
      if (geo.error) return;
      if (!geo.acquiring && !geo.polling) return;
      // Leave the geolocation call alive. A late answer still applies, and
      // cancelling it is what makes Safari stay silent.
      adopt({ error: "blocked" });
    }, PROMPT_STALL_MS);
  }

  function noteGrant() {
    granted = true;
    clearPromptTimer();
    if (geo.error === "blocked" || geo.error === "denied") adopt({ error: null });
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
      adopt({ error: "denied" });
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
    const fatal = isFatal(code);
    const patch = {
      acquiring: false,
      acquiringSince: null,
      error: code,
      immediate: false,
    };
    if (fatal || mode === "poll") patch.polling = false;
    if (fatal || mode === "poll" || !geo.polling) patch.acquireMode = null;
    adopt(patch);
    syncTracking();
  }

  function beginRequest(mode) {
    // A click supersedes an in-flight load-time ask.
    accessGeneration += 1;
    if (mode === "poll" && geo.polling && !geo.error) return;
    if (mode !== "poll" && geo.acquiring && !geo.polling && !geo.error) return;
    const blocker = syncBlocker();
    if (blocker) {
      applyPreflight(blocker, mode);
      return;
    }
    stopHardware();
    const patch = {
      error: null,
      acquiring: true,
      acquiringSince: Date.now(),
    };
    if (mode === "poll") {
      patch.polling = true;
      patch.acquireMode = "poll";
      patch.immediate = false;
    } else if (geo.polling) {
      patch.immediate = true;
    } else {
      patch.acquireMode = "oneshot";
      patch.immediate = false;
    }
    adopt(patch);
    // Permission diagnosis awaits. Start it, then read position before this
    // turn ends so a click still counts.
    startAttempt();
    kickFromGesture();
  }

  function beginRefresh() {
    accessGeneration += 1;
    const blocker = syncBlocker();
    if (blocker) {
      applyPreflight(blocker, "oneshot");
      return;
    }
    stopHardware();
    adopt({
      error: null,
      acquiring: true,
      acquiringSince: Date.now(),
      immediate: true,
    });
    startAttempt();
    kickFromGesture();
  }

  function haltPolling() {
    const patch = {
      polling: false,
      immediate: false,
    };
    if (geo.acquireMode === "poll") {
      patch.acquiring = false;
      patch.acquiringSince = null;
      patch.acquireMode = null;
    }
    adopt(patch);
    syncTracking();
  }

  function shouldTrack() {
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
    const abortController = new AbortController();
    leaderAbort = abortController;
    try {
      const hold = async () => {
        if (abortController.signal.aborted || !desired) return;
        leading = true;
        poke(false);
        await waitForAbort(abortController.signal);
      };
      if (!locksBroken && navigator.locks?.request) {
        await navigator.locks.request(
          lockName,
          { mode: "exclusive", signal: abortController.signal },
          hold,
        );
      } else {
        await hold();
      }
    } catch (error) {
      if (error?.name !== "AbortError") locksBroken = true;
    } finally {
      leading = false;
      // A rejected lock must not drop the tap's getCurrentPosition. That call
      // is what shows the prompt; cancelling it leaves Safari silent.
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
    const wantOneshot = fromGesture
      ? Boolean(geo.acquiring || geo.immediate)
      : Boolean(geo.immediate || (geo.acquiring && geo.acquireMode === "oneshot" && !geo.polling));
    if (wantOneshot) startOneshot();
    if (!fromGesture) ensureWatch();
  }

  function ensureWatch() {
    if (gesturePending || document.visibilityState !== "visible") return;
    if (!geo.polling) return;
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
    // A callback that runs before watchPosition returns must not start a
    // second watch. Browsers call back later; the sentinel covers the rest.
    watchId = -1;
    let id = null;
    try {
      id = navigator.geolocation.watchPosition(
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
      if (token !== watchToken) return;
      watchId = null;
      applyError("unsupported");
      return;
    }
    if (token !== watchToken) {
      if (id != null && canReadLocation()) navigator.geolocation.clearWatch(id);
      return;
    }
    watchId = id;
  }

  function startOneshot() {
    if (oneshotActive || !canReadLocation()) return;
    oneshotActive = true;
    const token = ++oneshotToken;
    adopt({ immediate: false });
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
    const patch = {
      longitude: fix.longitude,
      latitude: fix.latitude,
      updatedAt: fix.timestamp,
      acquiring: false,
      acquiringSince: null,
      error: null,
      immediate: false,
    };
    if (!geo.polling) patch.acquireMode = null;
    adopt(patch);
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
    if (geo.error === "denied" && code !== "denied") code = "denied";
    clearPromptTimer();
    const fatal = isFatal(code);
    const patch = {
      acquiring: false,
      acquiringSince: null,
      error: code,
      immediate: false,
    };
    if (fatal) {
      patch.polling = false;
      patch.acquireMode = null;
    } else if (geo.acquireMode === "oneshot") {
      patch.acquireMode = null;
    }
    adopt(patch);
    if (fatal) stopHardware();
    else ensureWatch();
    syncTracking();
  }

  function onStorage(event) {
    const head = `${prefix}.`;
    if (!event.key?.startsWith(head)) return;
    const field = event.key.slice(head.length);
    if (!PERSISTED_FIELDS.includes(field) || event.newValue == null) return;
    let value;
    try {
      value = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const trackingChanged = adopt({ [field]: value });
    if (trackingChanged) syncTracking();
  }

  function pullPersistedFields() {
    const patch = {};
    for (const field of PERSISTED_FIELDS) {
      const raw = storageGet(`${prefix}.${field}`);
      if (raw == null) continue;
      try {
        patch[field] = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const trackingChanged = adopt(patch);
    if (trackingChanged) syncTracking();
  }

  function onVisibleForAccess() {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisibleForAccess);
    accessWaitInstalled = false;
    requestAccessOnLoad();
  }

  function requestAccessOnLoad() {
    if (accessStarted || accessWaitInstalled) return;
    if (document.visibilityState !== "visible") {
      accessWaitInstalled = true;
      document.addEventListener("visibilitychange", onVisibleForAccess);
      return;
    }
    accessStarted = true;
    const generation = ++accessGeneration;
    void runAccessOnLoad(generation);
  }

  async function runAccessOnLoad(generation) {
    if (generation !== accessGeneration || shouldTrack()) return;
    const blocker = syncBlocker();
    if (generation !== accessGeneration) return;
    if (blocker) {
      applyPreflight(blocker, "oneshot");
      return;
    }
    const result = await queryPermission();
    if (generation !== accessGeneration || shouldTrack()) return;
    if (result.state === "denied") {
      applyPreflight("denied", "oneshot");
      return;
    }
    if (result.state === "granted") {
      // Access is already decided. Read a fix only when the page has nothing
      // usable to show. Polling, when on, was resumed before this runs.
      const haveFix = Number.isFinite(geo.longitude) && Number.isFinite(geo.latitude);
      if (haveFix && !geo.error) return;
      beginRequest("oneshot");
      return;
    }
    // WebKit cannot show the prompt from a page load. Leave it for a click.
    if (!canPromptWithoutGesture()) return;
    beginRequest("oneshot");
  }

  function persisted(initial, name) {
    return Alpine.$persist(initial).as(`${prefix}.${name}`);
  }

  Alpine.store("coordinatesUi", {
    mode: null,
    open(mode) {
      this.mode = mode;
    },
    close() {
      this.mode = null;
    },
  });

  Alpine.store("geo", {
    longitude: persisted(null, "longitude"),
    latitude: persisted(null, "latitude"),
    updatedAt: persisted(null, "updatedAt"),
    polling: persisted(false, "polling"),
    acquiring: persisted(false, "acquiring"),
    acquiringSince: persisted(null, "acquiringSince"),
    acquireMode: persisted(null, "acquireMode"),
    error: persisted(null, "error"),
    immediate: false,
    request(mode) {
      if (mode !== "oneshot" && mode !== "poll") return;
      beginRequest(mode);
    },
    refreshNow() {
      beginRefresh();
    },
    stopPolling() {
      haltPolling();
    },
    init() {
      // `this` is the store. init can run inside Alpine.store(), before it returns.
      geo = this;
      installRuntime();
      if (options.requestAccessOnLoad) requestAccessOnLoad();
    },
  });
  geo = Alpine.store("geo");
  registerCoordinatesComponents(Alpine);
  return requestAccessOnLoad;
}

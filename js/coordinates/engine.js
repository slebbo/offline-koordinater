// Background position tracker. The Geolocation API exists only on documents,
// so the host layout starts this on every page. Controls are optional and
// live in panel.js. Nothing here talks to a service worker or the network.
//
// Mobile Safari shows the location prompt only when getCurrentPosition runs
// in the same turn as a tap. A permission query or Web Lock await before
// that call drops the gesture: no prompt, and often no error callback. A
// click therefore starts the read immediately. The load-time option has no
// gesture to preserve, so it may ask the Permissions API first and skip
// browsers that would swallow the call.

import {
  DEFAULT_POLL_INTERVAL_MS,
  canonicalPollInterval,
  usesDevicePace,
} from "./interval.js";

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
  "pollIntervalMs",
  "readOnLoad",
  "acquiring",
  "acquiringSince",
  "acquireMode",
  "error",
];
const TRACKING_FIELDS = new Set(["polling", "acquiring", "acquireMode"]);
// High accuracy asks the device for GPS. Desktop Chrome still starts its
// network location provider in parallel and POSTs to
// https://www.googleapis.com/geolocation/v1/geolocate from the browser process.
// Page script cannot cancel that request. Android Chrome asks the platform
// location service instead, so a GPS fix can arrive while that request fails.
const ONESHOT_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 };
// maximumAge here allows a cached fix. It does not set how often the device
// delivers one. High accuracy often arrives about once a second.
const WATCH_OPTIONS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 60000 };
const ERROR_CODES = { 1: "denied", 2: "unavailable", 3: "timeout" };
const FATAL_ERRORS = new Set(["denied", "unsupported", "insecure", "policy", "blocked"]);

const IDLE_STATE = {
  longitude: null,
  latitude: null,
  updatedAt: null,
  polling: false,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  readOnLoad: false,
  acquiring: false,
  acquiringSince: null,
  acquireMode: null,
  error: null,
};

const GLOBAL_SLOT = "__offlineKoordinater";

/**
 * @typedef {"denied" | "blocked" | "unavailable" | "timeout" | "unsupported" | "insecure" | "policy"} CoordinatesError
 * @typedef {"oneshot" | "poll" | null} AcquireMode
 * @typedef {Object} CoordinatesState
 * @property {number | null} longitude
 * @property {number | null} latitude
 * @property {number | null} updatedAt
 * @property {boolean} polling
 * @property {number} pollIntervalMs
 * @property {boolean} readOnLoad
 *   When true, each document load reads one fresh fix. A route change inside
 *   the same document does not. The switch that turns this on has to call
 *   `request("load")` in the tap, so Safari can show its prompt.
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
 * @typedef {Object} CoordinatesController
 * @property {() => CoordinatesState} getState
 * @property {(listener: (state: CoordinatesState) => void) => () => void} subscribe
 * @property {(mode: "oneshot" | "poll" | "load") => void} request
 * @property {() => void} refreshNow
 * @property {() => void} stopPolling
 * @property {() => void} stopReadOnLoad
 * @property {(ms: number) => void} setPollInterval
 *   Snap to the nearest allowed interval and, when polling is already on,
 *   use it for the next read. Does not ask for permission.
 */

/**
 * Start the background tracker once per document. Later calls return the
 * same controller. A later `requestAccessOnLoad: true` still asks, once,
 * if the first call did not. Without `window` (SSR) this returns an idle
 * controller and does not touch storage.
 * @param {StartCoordinatesOptions} [options]
 * @returns {CoordinatesController}
 */
export function startCoordinates(options = {}) {
  if (typeof window === "undefined") return serverController();
  const existing = window[GLOBAL_SLOT];
  if (existing?.api) {
    if (options.requestAccessOnLoad) existing.askOnLoad();
    return existing.api;
  }
  const created = createEngine(normalizeOptions(options));
  window[GLOBAL_SLOT] = created;
  return created.api;
}

/**
 * Controller from the layout's startCoordinates() call.
 * @returns {CoordinatesController}
 */
export function getCoordinates() {
  if (typeof window === "undefined") return serverController();
  const existing = window[GLOBAL_SLOT];
  if (!existing?.api) {
    throw new Error("Call startCoordinates() before getCoordinates().");
  }
  return existing.api;
}

function serverController() {
  return {
    getState() {
      return { ...IDLE_STATE };
    },
    subscribe(listener) {
      if (typeof listener === "function") listener({ ...IDLE_STATE });
      return () => {};
    },
    request() {},
    refreshNow() {},
    stopPolling() {},
    stopReadOnLoad() {},
    setPollInterval() {},
  };
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

function createEngine(options) {
  const prefix = options.storagePrefix;
  const lockName = options.lockName;
  const geo = { ...IDLE_STATE, immediate: false };
  /** @type {Set<(state: CoordinatesState) => void>} */
  const listeners = new Set();
  let notifyQueued = false;

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
  // Coarser than device pace: one getCurrentPosition per interval. The timer
  // is armed only while this document holds the lock.
  let sampleTimer = null;
  let sampleGeneration = 0;
  // Local time when the current one-shot read started. Used so the gap is
  // measured between attempts, not between the moments fixes arrive.
  let sampleStartedAt = 0;
  // Local time of the latest accepted fix, or 0 when there is none.
  let lastSuccessAt = 0;
  // Earliest local time a failed interval read may be tried again.
  let backoffUntil = 0;
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

  function publicState() {
    return {
      longitude: geo.longitude,
      latitude: geo.latitude,
      updatedAt: geo.updatedAt,
      polling: geo.polling,
      pollIntervalMs: geo.pollIntervalMs,
      readOnLoad: geo.readOnLoad,
      acquiring: geo.acquiring,
      acquiringSince: geo.acquiringSince,
      acquireMode: geo.acquireMode,
      error: geo.error,
    };
  }

  function scheduleNotify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const snapshot = publicState();
      for (const listener of [...listeners]) {
        try {
          listener(snapshot);
        } catch (error) {
          console.error(error);
        }
      }
    });
  }

  function adopt(patch, { persist = true, notify = true } = {}) {
    let changed = false;
    let trackingChanged = false;
    for (const field of Object.keys(patch)) {
      const value = patch[field];
      if (Object.is(geo[field], value)) continue;
      geo[field] = value;
      changed = true;
      if (persist && PERSISTED_FIELDS.includes(field)) storageSet(`${prefix}.${field}`, value);
      if (TRACKING_FIELDS.has(field)) trackingChanged = true;
    }
    if (changed && notify) scheduleNotify();
    return trackingChanged;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new Error("subscribe() expects a function.");
    }
    listeners.add(listener);
    listener(publicState());
    return () => listeners.delete(listener);
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Private mode and quota failures still leave the in-memory fix.
    }
  }

  function hydrate() {
    const patch = {};
    for (const field of PERSISTED_FIELDS) {
      const raw = storageGet(`${prefix}.${field}`);
      if (raw == null) continue;
      try {
        patch[field] = JSON.parse(raw);
      } catch {
        // Ignore a broken value and keep the idle field.
      }
    }
    const storedInterval = Object.prototype.hasOwnProperty.call(patch, "pollIntervalMs")
      ? patch.pollIntervalMs
      : undefined;
    normalizeStoredPatch(patch);
    adopt(patch, { persist: false, notify: false });
    if (storedInterval !== undefined && storedInterval !== geo.pollIntervalMs) {
      storageSet(`${prefix}.pollIntervalMs`, geo.pollIntervalMs);
    }
    seedSchedule();
  }

  function normalizeStoredPatch(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, "pollIntervalMs")) {
      patch.pollIntervalMs = canonicalPollInterval(patch.pollIntervalMs);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "readOnLoad")) {
      patch.readOnLoad = patch.readOnLoad === true;
    }
    return patch;
  }

  function seedSchedule() {
    const now = Date.now();
    const stamp = Number(geo.updatedAt);
    lastSuccessAt = Number.isFinite(stamp) && stamp > 0 && stamp <= now + 2000
      ? Math.min(stamp, now)
      : 0;
    backoffUntil = 0;
    sampleStartedAt = 0;
  }

  function devicePace() {
    return usesDevicePace(geo.pollIntervalMs);
  }

  function noteSuccess(timestamp) {
    const now = Date.now();
    if (!devicePace() && sampleStartedAt > 0 && sampleStartedAt <= now) {
      lastSuccessAt = sampleStartedAt;
    } else {
      const stamp = Number(timestamp);
      lastSuccessAt = Number.isFinite(stamp) ? Math.min(Math.max(stamp, 0), now) : now;
    }
    backoffUntil = 0;
  }

  function noteSampleFailure() {
    backoffUntil = Date.now() + geo.pollIntervalMs;
  }

  function sampleWait() {
    const fromSuccess = lastSuccessAt ? lastSuccessAt + geo.pollIntervalMs : 0;
    const due = Math.max(fromSuccess, backoffUntil);
    return Math.max(0, due - Date.now());
  }

  function installRuntime() {
    hydrate();
    expireStaleAcquire();
    window.addEventListener("storage", onStorage);
    window.addEventListener("visibilitychange", syncTracking);
    window.addEventListener("pagehide", () => {
      desired = false;
      leaderAbort?.abort();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        pullPersistedFields();
        // Returning from the back-forward cache is another opening of the page.
        if (geo.readOnLoad) readForLoad();
      }
      syncTracking();
    });
    syncTracking();
    if (geo.readOnLoad) readForLoad();
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
    ensureSampling();
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
    if (fatal) patch.readOnLoad = false;
    if (fatal || mode === "poll" || !geo.polling) patch.acquireMode = null;
    adopt(patch);
    syncTracking();
  }

  function beginRequest(mode) {
    // A click supersedes an in-flight load-time ask.
    accessGeneration += 1;
    if (mode === "load") adopt({ readOnLoad: true });
    if (mode === "poll" && geo.polling && !geo.error) return;
    // The mode is already stored. A read that is already running on this
    // document covers the tap; the next document load reads again.
    if (mode === "load" && geo.acquiring && !geo.polling && !geo.error) return;
    if (mode === "oneshot" && geo.acquiring && !geo.polling && !geo.error) return;
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
    } else if (mode === "load") {
      patch.readOnLoad = true;
      if (geo.polling) patch.immediate = true;
      else {
        patch.acquireMode = "oneshot";
        patch.immediate = false;
      }
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

  // One fresh fix per document when the user asked for a read on each open.
  // Permission was granted by the switch's tap. This call has no new tap, so
  // it does not try to preserve a user gesture.
  function readForLoad() {
    if (!geo.readOnLoad || oneshotActive) return;
    const blocker = syncBlocker();
    if (blocker) {
      applyPreflight(blocker, "oneshot");
      return;
    }
    accessGeneration += 1;
    stopHardware();
    const patch = {
      error: null,
      acquiring: true,
      acquiringSince: Date.now(),
    };
    if (geo.polling) patch.immediate = true;
    else {
      patch.acquireMode = "oneshot";
      patch.immediate = false;
    }
    adopt(patch);
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

  function haltLoadRead() {
    const patch = { readOnLoad: false };
    if (!geo.polling && geo.acquireMode === "oneshot") {
      patch.acquiring = false;
      patch.acquiringSince = null;
      patch.acquireMode = null;
      patch.immediate = false;
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
    if (!fromGesture) ensureSampling();
  }

  // Device pace keeps a watch. Every coarser interval waits, then reads once,
  // so the device is not asked on every GPS tick.
  function ensureSampling() {
    if (gesturePending || oneshotActive || document.visibilityState !== "visible") return;
    if (!geo.polling || !leading) return;
    if (devicePace()) {
      clearSampleTimer();
      startWatch();
      return;
    }
    stopWatchOnly();
    if (sampleTimer != null) return;
    scheduleSample();
  }

  function retargetSampling() {
    clearSampleTimer();
    if (!devicePace()) stopWatchOnly();
    ensureSampling();
  }

  function clearSampleTimer() {
    sampleGeneration += 1;
    if (sampleTimer != null) clearTimeout(sampleTimer);
    sampleTimer = null;
  }

  function scheduleSample() {
    if (sampleTimer != null) return;
    const generation = sampleGeneration;
    const wait = sampleWait();
    sampleTimer = setTimeout(() => {
      if (generation !== sampleGeneration) return;
      sampleTimer = null;
      startScheduledSample();
    }, wait);
  }

  function startScheduledSample() {
    if (document.visibilityState !== "visible" || !leading) return;
    if (oneshotActive || gesturePending || !geo.polling || devicePace()) return;
    if (!canReadLocation()) return;
    adopt({
      acquiring: true,
      acquiringSince: Date.now(),
      error: null,
    });
    startOneshot();
  }

  function stopWatchOnly() {
    if (watchId == null) return;
    watchToken += 1;
    if (canReadLocation()) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function stopHardware() {
    watchToken += 1;
    oneshotToken += 1;
    oneshotActive = false;
    gesturePending = false;
    clearSampleTimer();
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
    sampleStartedAt = Date.now();
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
    noteSuccess(fix.timestamp);
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
    ensureSampling();
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
    if (!fatal && geo.polling && !devicePace()) noteSampleFailure();
    const patch = {
      acquiring: false,
      acquiringSince: null,
      error: code,
      immediate: false,
    };
    if (fatal) {
      patch.polling = false;
      patch.readOnLoad = false;
      patch.acquireMode = null;
    } else if (geo.acquireMode === "oneshot") {
      patch.acquireMode = null;
    }
    adopt(patch);
    if (fatal) stopHardware();
    else ensureSampling();
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
    const patch = normalizeStoredPatch({ [field]: value });
    const previousInterval = geo.pollIntervalMs;
    const trackingChanged = adopt(patch, { persist: false });
    if (geo.pollIntervalMs !== previousInterval) retargetSampling();
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
    normalizeStoredPatch(patch);
    const previousInterval = geo.pollIntervalMs;
    const trackingChanged = adopt(patch, { persist: false });
    if (geo.pollIntervalMs !== previousInterval) retargetSampling();
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

  const api = {
    getState: publicState,
    subscribe,
    request(mode) {
      if (mode !== "oneshot" && mode !== "poll" && mode !== "load") return;
      beginRequest(mode);
    },
    refreshNow() {
      beginRefresh();
    },
    stopPolling() {
      haltPolling();
    },
    stopReadOnLoad() {
      haltLoadRead();
    },
    setPollInterval(ms) {
      const next = canonicalPollInterval(ms);
      if (next === geo.pollIntervalMs) return;
      adopt({ pollIntervalMs: next });
      retargetSampling();
    },
  };

  installRuntime();
  if (options.requestAccessOnLoad) requestAccessOnLoad();
  return { api, askOnLoad: requestAccessOnLoad };
}

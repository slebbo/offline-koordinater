// Coordinates the offline position POC.
// The Geolocation API exists only on documents, not in service workers.
// This worker decides whether a fix may start, stores the latest fix, and
// tells whichever page is open to keep reading so a hard navigation can continue.

const CACHE_NAME = "offline-koordinater-v4";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/about.html",
  "/css/app.css",
  "/js/page.js",
];
const DB_NAME = "offline-koordinater";
const DB_STORE = "kv";
const STATE_KEY = "geo-state";
const ACQUIRE_STALE_MS = 120000;

/** @type {GeoState | null} */
let state = null;
/** @type {Promise<GeoState> | null} */
let statePromise = null;
/** @type {string | null} */
let trackerId = null;
let messageQueue = Promise.resolve();

/**
 * @typedef {Object} GeoState
 * @property {number | null} longitude
 * @property {number | null} latitude
 * @property {number | null} updatedAt
 * @property {boolean} polling
 * @property {boolean} acquiring
 * @property {number | null} acquiringSince
 * @property {"oneshot" | "poll" | null} acquireMode
 * @property {"accepted" | "rejected" | null} decision
 * @property {string | null} error
 * @property {number} revision
 */

/** @returns {GeoState} */
function freshState() {
  return {
    longitude: null,
    latitude: null,
    updatedAt: null,
    polling: false,
    acquiring: false,
    acquiringSince: null,
    acquireMode: null,
    decision: null,
    error: null,
    revision: 0,
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(key) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readonly");
        const request = tx.objectStore(DB_STORE).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

function idbSet(key, value) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function loadState() {
  if (!statePromise) {
    statePromise = idbGet(STATE_KEY)
      .then((stored) => {
        state = stored ? { ...freshState(), ...stored } : freshState();
        expireStaleAcquire();
        return state;
      })
      .catch(() => {
        state = freshState();
        return state;
      });
  }
  return statePromise;
}

function expireStaleAcquire() {
  if (!state?.acquiring || state.polling) return;
  const started = state.acquiringSince ?? 0;
  if (Date.now() - started < ACQUIRE_STALE_MS) return;
  state.acquiring = false;
  state.acquireMode = null;
  state.error = "timeout";
  state.revision += 1;
}

function snapshot() {
  return { ...state };
}

async function persist() {
  state.revision += 1;
  await idbSet(STATE_KEY, snapshot());
}

async function queryGeoPermission() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const status = await Promise.race([
      navigator.permissions.query({ name: "geolocation" }),
      new Promise((resolve) => {
        setTimeout(() => resolve(null), 1000);
      }),
    ]);
    return status?.state ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function decide(capability) {
  if (!capability?.geolocationAvailable) {
    return { ok: false, error: "unsupported" };
  }
  if (!self.isSecureContext) {
    return { ok: false, error: "insecure" };
  }
  const permission = await queryGeoPermission();
  if (permission === "denied") {
    return { ok: false, error: "denied" };
  }
  return { ok: true };
}

function normalizeFix(fix) {
  const longitude = Number(fix?.longitude);
  const latitude = Number(fix?.latitude);
  const timestamp = Number(fix?.timestamp);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return {
    longitude,
    latitude,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

function commandFor(clientId, trackerId) {
  const tracking = state.polling || (state.acquiring && state.acquireMode === "oneshot");
  if (!tracking || clientId !== trackerId) return "stop";
  return state.polling ? "start-watch" : "start-oneshot";
}

function chooseTracker(windows, preferredClient) {
  const alive = new Set(windows.map((client) => client.id));
  if (trackerId && alive.has(trackerId)) return trackerId;
  const next =
    windows.find((client) => client.focused) ??
    windows.find((client) => preferredClient && client.id === preferredClient.id) ??
    windows[windows.length - 1] ??
    null;
  trackerId = next?.id ?? null;
  return trackerId;
}

async function publish(preferredClient) {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const activeTrackerId = chooseTracker(windows, preferredClient);
  const body = snapshot();
  await Promise.all(
    windows.map((client) => {
      const message = {
        type: "STATE",
        state: body,
        command: commandFor(client.id, activeTrackerId),
      };
      return Promise.resolve(client.postMessage(message));
    }),
  );
  return { state: body, command: commandFor(preferredClient?.id, activeTrackerId) };
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim())
      .then(() => loadState()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.mode === "navigate") {
      const pathname = new URL(request.url).pathname;
      const byPath = await cache.match(pathname === "/" ? "/index.html" : pathname);
      if (byPath) return byPath;
      const home = await cache.match("/index.html");
      if (home) return home;
    }
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("message", (event) => {
  const run = messageQueue.then(() => onMessage(event));
  messageQueue = run.catch(() => {});
  event.waitUntil(run);
});

async function onMessage(event) {
  await loadState();
  const message = event.data ?? {};
  const reply = (payload) => {
    event.ports[0]?.postMessage(payload);
  };

  if (message.type === "RELEASE_TRACKING") {
    if (event.source && event.source.id === trackerId) trackerId = null;
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "GET_STATE") {
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "DECIDE_START") {
    if (event.source) trackerId = event.source.id;
    const decision = await decide(message.capability);
    if (!decision.ok) {
      state.decision = "rejected";
      state.error = decision.error;
      state.acquiring = false;
      state.acquiringSince = null;
      if (message.mode === "poll") {
        state.polling = false;
        state.acquireMode = null;
      } else if (!state.polling) {
        state.acquireMode = null;
      }
    } else {
      state.decision = "accepted";
      state.error = null;
      state.acquiring = true;
      state.acquiringSince = Date.now();
      if (message.mode === "poll") {
        state.polling = true;
        state.acquireMode = "poll";
      } else if (!state.polling) {
        state.acquireMode = "oneshot";
      }
    }
    await persist();
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "SET_POLLING" && message.enabled === false) {
    state.polling = false;
    if (state.acquireMode === "poll") {
      state.acquiring = false;
      state.acquiringSince = null;
      state.acquireMode = null;
    }
    await persist();
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "MARK_ACQUIRING") {
    state.acquiring = true;
    state.acquiringSince = Date.now();
    state.error = null;
    await persist();
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "POSITION_FIX") {
    if (state.decision === "rejected") {
      const published = await publish(event.source);
      reply({ type: "STATE", ...published });
      return;
    }
    const fix = normalizeFix(message.fix);
    if (!fix) {
      reply({ type: "STATE", state: snapshot(), command: "stop" });
      return;
    }
    state.longitude = fix.longitude;
    state.latitude = fix.latitude;
    state.updatedAt = fix.timestamp;
    state.acquiring = false;
    state.acquiringSince = null;
    state.error = null;
    state.decision = "accepted";
    if (!state.polling) state.acquireMode = null;
    await persist();
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
    return;
  }

  if (message.type === "POSITION_ERROR") {
    const fatal = message.error === "denied" || message.error === "unsupported" || message.error === "insecure";
    state.acquiring = false;
    state.acquiringSince = null;
    state.error = typeof message.error === "string" ? message.error : "unavailable";
    if (fatal) {
      state.polling = false;
      state.acquireMode = null;
      state.decision = "rejected";
    } else if (state.acquireMode === "oneshot") {
      state.acquireMode = null;
    }
    await persist();
    const published = await publish(event.source);
    reply({ type: "STATE", ...published });
  }
}

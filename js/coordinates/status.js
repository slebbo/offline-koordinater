// Swedish copy for the coordinates panel. Strings are UI text. The module
// does not render them until describeCoordinates() runs, so importing this
// file during SSR does not touch the browser.

import { DEVICE_PACE_MS, canonicalPollInterval } from "./interval.js";

const updatedFormatter = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const STATUS_TEXT = {
  idle: "Ingen hämtning pågår.",
  acquiring: "Hämtar position…",
  ready: "Senaste position är lagrad i webbläsaren.",
  unsupported: "Enheten kan inte hämta position.",
  insecure: "Position kan bara hämtas via localhost eller https.",
  unavailable: "Positionen gick inte att läsa från enheten. Kontrollera att platstjänster är på och tillåtna för webbläsaren.",
  timeout: "Hämtningen tog för lång tid och avbröts.",
  policy: "Webbläsaren tillåter inte att den här sidan läser position.",
};

function locationAdvice() {
  if (isIosLocation()) {
    return " Om en fråga visas, svara på den. Annars slå på Platstjänster och tillåt Safari: Inställningar → Integritet och säkerhet → Platstjänster → Safari.";
  }
  return " Om en fråga visas, svara på den. Annars tillåt plats för den här sidan i webbläsarens inställningar.";
}

function isIosLocation() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function statusKey(state) {
  if (state.error) return state.error;
  if (state.acquiring) return "acquiring";
  if (state.polling) return "polling";
  if (state.readOnLoad) return "load";
  if (hasPosition(state)) return "ready";
  return "idle";
}

function phaseFor(key) {
  if (key === "acquiring") return "acquiring";
  if (key === "polling") return "polling";
  if (key === "load") return "load";
  if (key === "idle" || key === "ready") return "idle";
  return "error";
}

function textFor(key, state) {
  if (key === "polling") return `Pollar position ${pollIntervalCadence(state.pollIntervalMs)}.`;
  if (key === "load") return "Nästa sidladdning hämtar en ny position.";
  if (key === "denied") return `Tillstånd att hämta position saknas.${locationAdvice()}`;
  if (key === "blocked") {
    return `Webbläsaren frågade inte om position, eller så kom inget svar.${locationAdvice()}`;
  }
  return STATUS_TEXT[key] ?? STATUS_TEXT.idle;
}

export function pollIntervalLabel(ms) {
  const value = canonicalPollInterval(ms);
  if (value < 60000) {
    const seconds = value / 1000;
    return seconds === 1 ? "1 sekund" : `${seconds} sekunder`;
  }
  const minutes = value / 60000;
  if (minutes < 60) return minutes === 1 ? "1 minut" : `${minutes} minuter`;
  const hours = minutes / 60;
  return hours === 1 ? "1 timme" : `${hours} timmar`;
}

export function pollIntervalOptionLabel(ms) {
  const value = canonicalPollInterval(ms);
  if (value === DEVICE_PACE_MS) return "1 sekund (enhetens takt)";
  return pollIntervalLabel(value);
}

export function pollIntervalCadence(ms) {
  const value = canonicalPollInterval(ms);
  if (value < 60000) {
    const seconds = value / 1000;
    if (seconds === 1) return "en gång i sekunden";
    return `en gång var ${seconds}:e sekund`;
  }
  const minutes = value / 60000;
  if (minutes < 60) {
    if (minutes === 1) return "en gång i minuten";
    return `en gång var ${minutes}:e minut`;
  }
  const hours = minutes / 60;
  if (hours === 1) return "en gång i timmen";
  return `en gång var ${hours}:e timme`;
}

function hasPosition(state) {
  return Number.isFinite(state.longitude) && Number.isFinite(state.latitude);
}

export function describeCoordinates(state) {
  const key = statusKey(state);
  const positioned = hasPosition(state);
  const updated = Number.isFinite(state.updatedAt);
  return {
    key,
    phase: phaseFor(key),
    busy: key === "acquiring",
    statusText: textFor(key, state),
    positionText: positioned
      ? `${state.longitude.toFixed(6)}, ${state.latitude.toFixed(6)}`
      : "Ingen position ännu",
    positionEmpty: positioned ? "false" : "true",
    updatedText: updated ? updatedFormatter.format(new Date(state.updatedAt)) : "Inte uppdaterad",
    updatedEmpty: updated ? "false" : "true",
  };
}

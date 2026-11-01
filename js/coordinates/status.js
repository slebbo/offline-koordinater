// Swedish copy for the coordinates panel. Strings are UI text. The module
// does not render them until describeCoordinates() runs, so importing this
// file during SSR does not touch the browser.

const updatedFormatter = new Intl.DateTimeFormat("sv-SE", {
  dateStyle: "medium",
  timeStyle: "medium",
});

const STATUS_TEXT = {
  idle: "Ingen hämtning pågår.",
  acquiring: "Hämtar position…",
  polling: "Pollar position.",
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
  if (hasPosition(state)) return "ready";
  return "idle";
}

function phaseFor(key) {
  if (key === "acquiring") return "acquiring";
  if (key === "polling") return "polling";
  if (key === "idle" || key === "ready") return "idle";
  return "error";
}

function textFor(key) {
  if (key === "denied") return `Tillstånd att hämta position saknas.${locationAdvice()}`;
  if (key === "blocked") {
    return `Webbläsaren frågade inte om position, eller så kom inget svar.${locationAdvice()}`;
  }
  return STATUS_TEXT[key] ?? STATUS_TEXT.idle;
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
    statusText: textFor(key),
    positionText: positioned
      ? `${state.longitude.toFixed(6)}, ${state.latitude.toFixed(6)}`
      : "Ingen position ännu",
    positionEmpty: positioned ? "false" : "true",
    updatedText: updated ? updatedFormatter.format(new Date(state.updatedAt)) : "Inte uppdaterad",
    updatedEmpty: updated ? "false" : "true",
  };
}

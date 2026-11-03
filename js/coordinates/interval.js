// Allowed sample intervals for continuous polling. The Geolocation API has
// no sample rate: watchPosition delivers fixes at the device's own pace,
// often about once a second when high accuracy is on. That pace is the
// finest choice. Coarser choices are a minimum gap between reads.

export const DEVICE_PACE_MS = 1000;
export const DEFAULT_POLL_INTERVAL_MS = 15000;
export const POLL_INTERVALS_MS = [
  DEVICE_PACE_MS,
  5000,
  15000,
  30000,
  60000,
  300000,
  900000,
  3600000,
];

/**
 * Snap a stored or requested interval to the nearest allowed value.
 * Missing and non-positive values use the default.
 * @param {unknown} value
 * @returns {number}
 */
export function canonicalPollInterval(value) {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_INTERVAL_MS;
  let best = POLL_INTERVALS_MS[0];
  let bestDiff = Infinity;
  for (const candidate of POLL_INTERVALS_MS) {
    const diff = Math.abs(candidate - ms);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * True when polling should follow the device stream instead of a timer.
 * @param {unknown} value
 * @returns {boolean}
 */
export function usesDevicePace(value) {
  return canonicalPollInterval(value) === DEVICE_PACE_MS;
}

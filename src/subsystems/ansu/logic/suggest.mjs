/**
 * Pure suggestion logic for the Release loop. Given the actor's history log,
 * produce the non-binding GM "chips" shown around release saves. Nothing here
 * applies anything — chips only whisper flavor or nudge the GM. Vitest-covered.
 */

const OUTCOMES = new Set(["criticalSuccess", "success", "failure", "criticalFailure"]);

/** Trailing run of clean releases (a critical success counts double). Resets on any failure. */
export function computeStreak(releases) {
  let streak = 0;
  for (let i = releases.length - 1; i >= 0; i -= 1) {
    const o = releases[i]?.data?.outcome;
    if (o === "criticalSuccess") streak += 2;
    else if (o === "success") streak += 1;
    else break;
  }
  return streak;
}

/**
 * @param {Array} log   the actor's full history log
 * @param {object} opts { enabled:boolean }
 * @returns {Array} chips: { key, labelKey, action }
 */
export function suggestChips(log, opts = {}) {
  if (opts.enabled === false) return [];
  const releases = (log ?? []).filter((e) => e.type === "release" && OUTCOMES.has(e.data?.outcome));
  if (!releases.length) return [];

  const last = releases[releases.length - 1].data.outcome;
  const streak = computeStreak(releases);
  const chips = [];

  // A run of clean releases: the Ansu acknowledges discipline — reward progress.
  if (streak >= 3) {
    chips.push({ key: "discipline", labelKey: "SHARDS.Ansu.Chip.discipline", action: "suggestDiscipline" });
  }
  if (last === "criticalFailure") {
    // The seizure itself is automated; the chip reminds the table what it looks like.
    chips.push({ key: "seized", labelKey: "SHARDS.Ansu.Chip.seized", action: "suggestSeized" });
  } else if (last === "failure") {
    chips.push({ key: "urge", labelKey: "SHARDS.Ansu.Chip.urge", action: "suggestUrge" });
  }
  return chips;
}

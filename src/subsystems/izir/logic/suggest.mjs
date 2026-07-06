/**
 * Pure suggestion logic. Given the actor's history log, produce the non-binding GM
 * "chips" shown after temptation rolls. Nothing here applies anything — chips only
 * navigate or prefill in the panel. Fully vitest-covered.
 */

const OUTCOMES = new Set(["criticalSuccess", "success", "failure", "criticalFailure"]);

/** Trailing run of successes (a critical success counts double). Resets on any failure. */
export function computeStreak(temptations) {
  let streak = 0;
  for (let i = temptations.length - 1; i >= 0; i -= 1) {
    const o = temptations[i]?.data?.outcome;
    if (o === "criticalSuccess") streak += 2;
    else if (o === "success") streak += 1;
    else break;
  }
  return streak;
}

/**
 * @param {Array} log   the actor's full history log
 * @param {object} opts { enabled:boolean, streak:number }
 * @returns {Array} chips: { key, labelKey, action }
 */
export function suggestChips(log, opts = {}) {
  if (opts.enabled === false) return [];
  const temptations = (log ?? []).filter((e) => e.type === "temptation" && OUTCOMES.has(e.data?.outcome));
  if (!temptations.length) return [];

  const last = temptations[temptations.length - 1].data.outcome;
  const streak = computeStreak(temptations);
  const need = Number.isInteger(opts.streak) ? opts.streak : 3;
  const chips = [];

  if (streak >= need) {
    chips.push({ key: "suppress", labelKey: "SHARDS.Izir.Chip.suppress", action: "suggestSuppress" });
  }
  if (last === "criticalFailure") {
    chips.push({ key: "deepen", labelKey: "SHARDS.Izir.Chip.deepen", action: "suggestDeepen" });
    chips.push({ key: "unsuppress", labelKey: "SHARDS.Izir.Chip.unsuppress", action: "suggestUnsuppress" });
    chips.push({ key: "surge", labelKey: "SHARDS.Izir.Chip.surge", action: "suggestSurge" });
  } else if (last === "failure") {
    chips.push({ key: "remind", labelKey: "SHARDS.Izir.Chip.remind", action: "suggestRemind" });
  }
  return chips;
}

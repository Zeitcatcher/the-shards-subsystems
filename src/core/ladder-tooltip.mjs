/**
 * Hover descriptions for the ladder chips of the GM panels (Ansu and Izir).
 *
 * Shared by both panels. Nothing is built at render time: the description is
 * baked and enriched the first time a chip is hovered (after Foundry's own
 * tooltip delay, so a pointer sweeping across the ladder enriches nothing),
 * then cached under the entry id plus a hash of the numbers it was baked with.
 * The popup itself is Foundry's tooltip (game.tooltip.activate), so it takes
 * the core look and theme.
 *
 * The top half (escapeHtml, tipHtml, TipCache) is pure and vitest-covered; the
 * rest needs a browser and Foundry.
 */

/** Minimal HTML escape for header text (names and tags come from content). */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The popup's markup: a header with the entry name, its cost glyph, its level
 * label and its tag, then the (already enriched) description body.
 */
export function tipHtml({ name, cost = "", levelLabel = "", tag = "", bodyHtml = "" } = {}) {
  const head = [
    `<strong class="shards-tip-name">${escapeHtml(name)}</strong>`,
    cost ? `<span class="shards-tip-cost">${escapeHtml(cost)}</span>` : "",
    levelLabel ? `<span class="shards-tip-level">${escapeHtml(levelLabel)}</span>` : "",
    tag ? `<span class="shards-tip-tag">${escapeHtml(tag)}</span>` : "",
  ].join("");
  return `<header class="shards-tip-head">${head}</header><div class="shards-tip-body">${bodyHtml}</div>`;
}

/** A small insertion-ordered cache; the oldest key goes first once `limit` is hit. */
export class TipCache {
  constructor(limit = 200) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  has(key) {
    return this.map.has(key);
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return value;
  }
  get size() {
    return this.map.size;
  }
}

/* ------------------------------------------------------------------ */
/* Foundry side                                                         */
/* ------------------------------------------------------------------ */

/**
 * Enrich a description and flatten it for a popup nobody can click: links and
 * inline checks become spans with their classes kept (so they stay styled),
 * repost icons and nested tooltips are dropped.
 */
export async function enrichPlain(text, options = {}) {
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  const html = await TE.enrichHTML(String(text ?? ""), options);
  const box = document.createElement("div");
  box.innerHTML = html;
  for (const el of box.querySelectorAll("[data-pf2-repost]")) el.remove();
  for (const a of box.querySelectorAll("a")) {
    const span = document.createElement("span");
    span.className = `${a.className} shards-tip-link`.trim();
    span.innerHTML = a.innerHTML;
    a.replaceWith(span);
  }
  for (const el of box.querySelectorAll("[data-tooltip]")) el.removeAttribute("data-tooltip");
  return box.innerHTML;
}

const BOUND = new WeakSet();

/**
 * Wire lazy tooltips on `root` once (ApplicationV2 keeps its root element across
 * renders, so this is safe to call from every _onRender).
 *
 * @param {HTMLElement} root
 * @param {object} opts
 * @param {string} opts.selector       chips that get a popup
 * @param {TipCache} opts.cache        where enriched popups live
 * @param {(el: HTMLElement) => Promise<{key: string, build: () => Promise<string>}|null>} opts.resolve
 *        cheap: names the cache key for this chip and how to build its markup
 * @param {string} [opts.cssClass]     added to Foundry's tooltip element
 */
export function bindLadderTooltips(root, { selector, cache, resolve, cssClass = "shards-ladder-tip" }) {
  if (!root || BOUND.has(root)) return;
  BOUND.add(root);
  const timers = new WeakMap();
  const delay = () => game.tooltip?.constructor?.TOOLTIP_ACTIVATION_MS ?? 500;

  root.addEventListener(
    "pointerenter",
    (event) => {
      const chip = event.target?.closest?.(selector);
      if (!chip || !root.contains(chip)) return;
      // A button or icon inside the chip has its own tooltip; Foundry shows that one.
      const own = event.target.closest("[data-tooltip]");
      if (own && own !== chip && chip.contains(own)) return;
      if (timers.has(chip) || game.tooltip?.element === chip) return;
      const timer = setTimeout(async () => {
        timers.delete(chip);
        if (!chip.isConnected || !chip.matches(":hover")) return;
        try {
          const tip = await resolve(chip);
          if (!tip) return;
          let html = cache.get(tip.key);
          if (html === undefined) html = cache.set(tip.key, await tip.build());
          if (!chip.isConnected || !chip.matches(":hover")) return;
          const box = document.createElement("div");
          box.className = "shards-tip";
          box.innerHTML = html;
          game.tooltip.activate(chip, { html: box, cssClass });
        } catch (err) {
          console.warn("the-shards-subsystems | ladder tooltip failed", err);
        }
      }, delay());
      timers.set(chip, timer);
    },
    true,
  );

  root.addEventListener(
    "pointerleave",
    (event) => {
      const chip = event.target;
      if (!(chip instanceof HTMLElement) || !timers.has(chip)) return;
      clearTimeout(timers.get(chip));
      timers.delete(chip);
    },
    true,
  );
}

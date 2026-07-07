/**
 * The subsystem switcher — one window, independent systems.
 *
 * A slim tab strip injected at the top of every subsystem panel. Clicking the
 * other tab closes the current app and opens the target at the SAME position and
 * size, so the two panels read as one window with tabs while staying fully
 * separate applications (zero coupling between playtested subsystems).
 */

import { getSubsystems } from "./subsystems.mjs";

/**
 * Inject (or refresh) the strip inside an app's window content. Call from the
 * panel's _onRender — AppV2 re-renders replace the part's DOM, so the strip is
 * rebuilt idempotently each time.
 */
export function renderSubsystemSwitcher(app, activeId) {
  const content = app.element?.querySelector(".window-content");
  if (!content) return;
  content.querySelector(":scope > .shards-subswitch")?.remove();

  const subs = getSubsystems();
  if (subs.length < 2) return; // nothing to switch between

  const strip = document.createElement("nav");
  strip.className = "shards-subswitch";
  for (const sub of subs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `shards-subswitch-tab${sub.id === activeId ? " active" : ""}`;
    btn.dataset.sub = sub.id;
    btn.innerHTML = `<i class="${sub.icon}"></i> <span>${game.i18n.localize(sub.titleKey)}</span>`;
    if (sub.id !== activeId) {
      btn.addEventListener("click", () => switchTo(app, sub));
    }
    strip.appendChild(btn);
  }
  content.prepend(strip);
}

/** Close the current panel and open the target at the same spot. */
function switchTo(app, sub) {
  const { left, top, width, height } = app.position ?? {};
  const position = { left, top, width, height };
  app.close();
  try {
    sub.openPanel(null, { position });
  } catch (err) {
    console.warn("the-shards-subsystems | subsystem switch failed", err);
  }
}

/** Apply a handed-off window position after opening (used by both panels). */
export function applyHandoffPosition(app, opts = {}) {
  const p = opts?.position;
  if (!p || !Number.isFinite(p.left) || !Number.isFinite(p.top)) return;
  // The first render may still be laying out; set the position on the next tick.
  setTimeout(() => {
    try {
      app.setPosition({ left: p.left, top: p.top, width: p.width, height: p.height });
    } catch {
      /* position handoff is best-effort */
    }
  }, 0);
}

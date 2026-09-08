/**
 * Export an actor's Izir history log to a JournalEntry (one HTML page), creating it
 * the first time and updating it in place thereafter. Fits the vault continuity flow:
 * the GM can paste the page into session notes.
 */

import { MODULE_ID } from "../../core/constants.mjs";
import { readIzir, patchIzir } from "./state.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Human, localized one-line description of a log entry's payload. */
export function describeEntry(entry) {
  const d = entry.data ?? {};
  switch (entry.type) {
    case "mark":
      return game.i18n.localize("SHARDS.Izir.Log.marked");
    case "level":
      return game.i18n.format("SHARDS.Izir.Log.level", { from: d.from ?? "?", to: d.to ?? "?" });
    case "suppress":
      return game.i18n.format(d.on === false ? "SHARDS.Izir.Log.unsuppress" : "SHARDS.Izir.Log.suppress", { id: d.id ?? "?" });
    case "reveal":
      return game.i18n.format(d.on === false ? "SHARDS.Izir.Log.hide" : "SHARDS.Izir.Log.reveal", { id: d.id ?? "?" });
    case "temptation": {
      const outcome = d.outcome ? game.i18n.localize(`SHARDS.Izir.Outcome.${d.outcome}`) : "—";
      const slide = d.slideDelta > 0 ? ` (+${d.slideDelta} ${game.i18n.localize("SHARDS.Izir.SlideShort")})` : "";
      return game.i18n.format("SHARDS.Izir.Log.temptation", { dc: d.dc ?? "?", outcome }) + slide;
    }
    case "slide":
      return game.i18n.format("SHARDS.Izir.Log.slide", { from: d.from ?? 0, to: d.to ?? 0 });
    case "transform":
      return game.i18n.format("SHARDS.Izir.Log.transform", {
        path: game.i18n.localize(d.path === "subjugated" ? "SHARDS.Izir.Tier.subjugated" : "SHARDS.Izir.Tier.nineveh"),
      });
    case "reason":
      return game.i18n.format("SHARDS.Izir.Log.reason", { id: d.id ?? "?" });
    case "art":
      return game.i18n.localize("SHARDS.Izir.Log.art");
    default:
      return entry.type;
  }
}

function renderLogHtml(actor, st) {
  const rows = [...st.log]
    .reverse()
    .map((e) => {
      const when = new Date(e.t).toLocaleString();
      const desc = describeEntry(e);
      const note = e.note ? ` — <em>${esc(e.note)}</em>` : "";
      return `<tr><td>${esc(when)}</td><td>${esc(desc)}${note}</td></tr>`;
    })
    .join("\n");
  const title = game.i18n.format("SHARDS.Izir.JournalHeading", { name: actor.name, level: st.level });
  return `<h2>${esc(title)}</h2>
<table>
  <thead><tr><th>${game.i18n.localize("SHARDS.Izir.JournalWhen")}</th><th>${game.i18n.localize("SHARDS.Izir.JournalEvent")}</th></tr></thead>
  <tbody>
${rows || `<tr><td colspan="2"><em>—</em></td></tr>`}
  </tbody>
</table>`;
}

function pageData(html, actor) {
  return {
    name: game.i18n.localize("SHARDS.Izir.JournalPageName"),
    type: "text",
    text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    flags: ownerFlags(actor),
  };
}

/** The uuid stamped on an entry/page so it can be recognised as this actor's. */
const ownerOf = (doc) => doc?.getFlag?.(MODULE_ID, "izirActor") ?? null;
const ownerFlags = (actor) => ({ [MODULE_ID]: { izirActor: actor.uuid } });

/**
 * Create or update the actor's history journal and open it.
 *
 * The journal id lives in the actor flag, so duplicating a marked actor — or
 * dropping an unlinked token of one that had already exported — handed the copy
 * the original's journal. The copy then overwrote the original's page under the
 * original's name, and the two could never hold separate journals. The entry and
 * its page carry the owning actor's uuid now; anything else belongs to someone
 * else and a fresh entry is made instead. (F26)
 */
export async function exportLog(actor) {
  const st = readIzir(actor);
  const html = renderLogHtml(actor, st);

  let entry = st.journalId ? game.journal.get(st.journalId) : null;
  if (entry && ownerOf(entry) && ownerOf(entry) !== actor.uuid) entry = null;

  if (entry) {
    const page = entry.pages.find((p) => ownerOf(p) === actor.uuid) ?? entry.pages.contents[0];
    if (page) await page.update({ "text.content": html, ...(ownerOf(page) ? {} : { flags: ownerFlags(actor) }) });
    else await entry.createEmbeddedDocuments("JournalEntryPage", [pageData(html, actor)]);
    // An entry made before this rule gets stamped so it is never taken from us.
    if (!ownerOf(entry)) await entry.update({ flags: ownerFlags(actor) });
  } else {
    entry = await JournalEntry.create({
      name: game.i18n.format("SHARDS.Izir.JournalName", { name: actor.name }),
      pages: [pageData(html, actor)],
      flags: ownerFlags(actor),
    });
    await patchIzir(actor, { journalId: entry.id });
  }
  entry.sheet?.render(true);
  ui.notifications?.info(game.i18n.localize("SHARDS.Izir.JournalExported"));
  return entry;
}

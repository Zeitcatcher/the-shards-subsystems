/**
 * Export an actor's Izir history log to a JournalEntry (one HTML page), creating it
 * the first time and updating it in place thereafter. Fits the vault continuity flow:
 * the GM can paste the page into session notes.
 */

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
      return game.i18n.format("SHARDS.Izir.Log.temptation", { dc: d.dc ?? "?", outcome });
    }
    case "transform":
      return game.i18n.format("SHARDS.Izir.Log.transform", {
        path: game.i18n.localize(d.path === "subjugated" ? "SHARDS.Izir.Tier.subjugated" : "SHARDS.Izir.Tier.nineveh"),
      });
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

function pageData(html) {
  return {
    name: game.i18n.localize("SHARDS.Izir.JournalPageName"),
    type: "text",
    text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
  };
}

/** Create or update the actor's history journal and open it. */
export async function exportLog(actor) {
  const st = readIzir(actor);
  const html = renderLogHtml(actor, st);

  let entry = st.journalId ? game.journal.get(st.journalId) : null;
  if (entry) {
    const page = entry.pages.contents[0];
    if (page) await page.update({ "text.content": html });
    else await entry.createEmbeddedDocuments("JournalEntryPage", [pageData(html)]);
  } else {
    entry = await JournalEntry.create({
      name: game.i18n.format("SHARDS.Izir.JournalName", { name: actor.name }),
      pages: [pageData(html)],
    });
    await patchIzir(actor, { journalId: entry.id });
  }
  entry.sheet?.render(true);
  ui.notifications?.info(game.i18n.localize("SHARDS.Izir.JournalExported"));
  return entry;
}

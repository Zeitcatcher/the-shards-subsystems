/**
 * Export an actor's Ansu history log to a JournalEntry (one HTML page), creating it
 * the first time and updating it in place thereafter. Fits the vault continuity flow:
 * the GM can paste the page into session notes.
 */

import { readAnsu, patchAnsu } from "./state.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Human, localized one-line description of a log entry's payload. */
export function describeEntry(entry) {
  const d = entry.data ?? {};
  switch (entry.type) {
    case "mark":
      return game.i18n.localize("SHARDS.Ansu.Log.attuned");
    case "level":
      return game.i18n.format("SHARDS.Ansu.Log.level", { from: d.from ?? "?", to: d.to ?? "?" });
    case "climb":
      return game.i18n.format("SHARDS.Ansu.Log.climb", { from: d.from ?? 0, to: d.to ?? 0 });
    case "suppress":
      return game.i18n.format(d.on === false ? "SHARDS.Ansu.Log.unsuppress" : "SHARDS.Ansu.Log.suppress", { id: d.id ?? "?" });
    case "communion":
      return game.i18n.localize(d.on ? "SHARDS.Ansu.Log.communionOn" : "SHARDS.Ansu.Log.communionOff");
    case "lingering":
      return game.i18n.localize("SHARDS.Ansu.Log.lingering");
    case "release": {
      const outcome = d.outcome ? game.i18n.localize(`SHARDS.Ansu.Outcome.${d.outcome}`) : "—";
      const climb = d.climbDelta > 0 ? ` (+${d.climbDelta} ${game.i18n.localize("SHARDS.Ansu.ClimbShort")})` : "";
      return game.i18n.format("SHARDS.Ansu.Log.release", { dc: d.dc ?? "?", outcome }) + climb;
    }
    case "refuses":
      return game.i18n.format("SHARDS.Ansu.Log.refuses", { id: d.entryId ?? "?", minutes: d.minutes ?? "?" });
    case "seizure":
      if (d.on) return game.i18n.localize(d.auto ? "SHARDS.Ansu.Log.seizureAuto" : "SHARDS.Ansu.Log.seizureOn");
      return game.i18n.localize("SHARDS.Ansu.Log.seizureOff");
    case "transform":
      return game.i18n.format("SHARDS.Ansu.Log.transform", {
        path: game.i18n.localize(d.path === "subjugated" ? "SHARDS.Ansu.Tier.subjugated" : "SHARDS.Ansu.Tier.taken"),
      });
    case "art":
      return game.i18n.localize("SHARDS.Ansu.Log.art");
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
  const title = game.i18n.format("SHARDS.Ansu.JournalHeading", { name: actor.name, level: st.level });
  return `<h2>${esc(title)}</h2>
<table>
  <thead><tr><th>${game.i18n.localize("SHARDS.Ansu.JournalWhen")}</th><th>${game.i18n.localize("SHARDS.Ansu.JournalEvent")}</th></tr></thead>
  <tbody>
${rows || `<tr><td colspan="2"><em>—</em></td></tr>`}
  </tbody>
</table>`;
}

function pageData(html) {
  return {
    name: game.i18n.localize("SHARDS.Ansu.JournalPageName"),
    type: "text",
    text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
  };
}

/** Create or update the actor's history journal and open it. */
export async function exportLog(actor) {
  const st = readAnsu(actor);
  const html = renderLogHtml(actor, st);

  let entry = st.journalId ? game.journal.get(st.journalId) : null;
  if (entry) {
    const page = entry.pages.contents[0];
    if (page) await page.update({ "text.content": html });
    else await entry.createEmbeddedDocuments("JournalEntryPage", [pageData(html)]);
  } else {
    entry = await JournalEntry.create({
      name: game.i18n.format("SHARDS.Ansu.JournalName", { name: actor.name }),
      pages: [pageData(html)],
    });
    await patchAnsu(actor, { journalId: entry.id });
  }
  entry.sheet?.render(true);
  ui.notifications?.info(game.i18n.localize("SHARDS.Ansu.JournalExported"));
  return entry;
}

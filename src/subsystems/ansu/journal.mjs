/**
 * Export an actor's Ansu history log to a JournalEntry (one HTML page), creating it
 * the first time and updating it in place thereafter. Fits the vault continuity flow:
 * the GM can paste the page into session notes.
 */

import { readAnsu, patchAnsu } from "./state.mjs";
import { loadDeeds } from "./content.mjs";
import { valuesRows, deedLogLines, signed } from "./logic/panel.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/**
 * Human, localized one-line description of a log entry's payload. `deeds` (the
 * loadDeeds index) turns a deed id into its label; without it, or for an id it
 * lacks, the id shows.
 */
export function describeEntry(entry, deeds = null) {
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
    case "call": {
      const outcome = d.outcome ? game.i18n.localize(`SHARDS.Ansu.Outcome.${d.outcome}`) : "—";
      return game.i18n.format("SHARDS.Ansu.Log.call", { dc: d.dc ?? "?", outcome });
    }
    case "refuses":
      return game.i18n.format("SHARDS.Ansu.Log.refuses", { id: d.entryId ?? "?", minutes: d.minutes ?? "?" });
    case "seizure":
      if (!d.on) return game.i18n.localize("SHARDS.Ansu.Log.seizureOff");
      if (d.kind && d.kind !== "manual") {
        return game.i18n.format("SHARDS.Ansu.Log.takeover", { kind: game.i18n.localize(`SHARDS.Ansu.TakeoverKind.${d.kind}`) });
      }
      return game.i18n.localize("SHARDS.Ansu.Log.seizureOn");
    case "deed": {
      const pair = (v) => (Array.isArray(v) ? v : ["?", "?"]);
      const [lf, lt] = pair(d.loyalty);
      const [wf, wt] = pair(d.wrath);
      const deed = deeds?.byId?.get?.(d.deed)?.label ?? d.deed ?? "?";
      return game.i18n.format("SHARDS.Ansu.Log.deed", { deed, lf, lt, wf, wt });
    }
    case "conflict": {
      if (d.on) {
        return game.i18n.format("SHARDS.Ansu.Log.conflictOpen", {
          severity: game.i18n.localize(`SHARDS.Ansu.Severity.${d.severity ?? "minor"}`),
          dc: d.dc ?? "?",
        });
      }
      const outcome = d.outcome ? game.i18n.localize(`SHARDS.Ansu.Outcome.${d.outcome}`) : "?";
      const stage = game.i18n.localize(`SHARDS.Ansu.ConflictStage.${d.stage ?? "will"}`);
      return game.i18n.format("SHARDS.Ansu.Log.conflict", { stage, dc: d.dc ?? "?", outcome });
    }
    case "adjust": {
      const bar = game.i18n.localize(d.bar === "wrath" ? "SHARDS.Ansu.WrathTitle" : "SHARDS.Ansu.LoyaltyTitle");
      return game.i18n.format("SHARDS.Ansu.Log.adjust", { bar, from: d.from ?? "?", to: d.to ?? "?" });
    }
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

/** The deed index, or null when it can't load (the log then shows ids). */
export async function deedsOrNull() {
  try {
    return await loadDeeds();
  } catch {
    return null;
  }
}

function renderLogHtml(actor, st, deeds = null) {
  const rows = [...st.log]
    .reverse()
    .map((e) => {
      const when = new Date(e.t).toLocaleString();
      const desc = describeEntry(e, deeds);
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
  const html = renderLogHtml(actor, st, await deedsOrNull());

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

/* ------------------------------------------------------------------ */
/* "What the Ansu values": the bearer's own page (0.8)                  */
/* ------------------------------------------------------------------ */

/** A deed's effect in words: "+1 loyalty, Wrath -1", "Wrath to 0". */
export function deedEffectText(eff) {
  const parts = [];
  if (eff.loyalty) parts.push(game.i18n.format("SHARDS.Ansu.DeedEffectLoyalty", { n: signed(eff.loyalty) }));
  if (eff.wrathSet !== null && eff.wrathSet !== undefined) {
    parts.push(game.i18n.format("SHARDS.Ansu.DeedEffectWrathSet", { n: eff.wrathSet }));
  } else if (eff.wrath) {
    parts.push(game.i18n.format("SHARDS.Ansu.DeedEffectWrath", { n: signed(eff.wrath) }));
  }
  return parts.join(", ") || "-";
}

/** What a logged deed actually moved, in words ("+1 loyalty, Wrath -1"). */
function moveText(line) {
  const parts = [];
  if (line.loyalty && line.loyalty[0] !== line.loyalty[1]) {
    parts.push(game.i18n.format("SHARDS.Ansu.DeedEffectLoyalty", { n: signed(line.loyalty[1] - line.loyalty[0]) }));
  }
  if (line.wrath && line.wrath[0] !== line.wrath[1]) {
    parts.push(game.i18n.format("SHARDS.Ansu.DeedEffectWrath", { n: signed(line.wrath[1] - line.wrath[0]) }));
  }
  return parts.join(", ");
}

/** The values page HTML: the deed table and the last ten deed lines. */
export function renderValuesHtml(deeds, log) {
  const TONE = { good: "cs", warn: "f", bad: "cf" };
  const rows = valuesRows(deeds.deeds)
    .map(
      (g) =>
        `<tr class="ansu-values-${TONE[g.tone]}"><td><strong>${esc(deedEffectText(g))}</strong></td><td>${g.labels
          .map((l) => `${esc(l)}.`)
          .join(" ")}</td></tr>`,
    )
    .join("\n");
  const lines = deedLogLines(log, deeds.byId, 10)
    .map((l) => {
      const move = moveText(l);
      const note = l.note ? ` <em>(${esc(l.note)})</em>` : "";
      return `<li>${esc(l.label)}${move ? `: ${esc(move)}` : ""}${note}</li>`;
    })
    .join("\n");
  const recent = lines
    ? `<ul>\n${lines}\n</ul>`
    : `<p><em>${esc(game.i18n.localize("SHARDS.Ansu.ValuesNone"))}</em></p>`;
  return `<p>${esc(game.i18n.localize("SHARDS.Ansu.ValuesIntro"))}</p>
<table>
  <tbody>
${rows}
  </tbody>
</table>
<h3>${esc(game.i18n.localize("SHARDS.Ansu.ValuesRecent"))}</h3>
${recent}`;
}

/** The actor's player owners get Observer on the page; everyone else none. */
export function valuesOwnership(actor) {
  const LV = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS ?? { NONE: 0, OBSERVER: 2, OWNER: 3 };
  const ownership = { default: LV.NONE };
  for (const u of game.users?.contents ?? Array.from(game.users ?? [])) {
    if (u.isGM) continue;
    if (actor.testUserPermission?.(u, "OWNER")) ownership[u.id] = LV.OBSERVER;
  }
  return ownership;
}

/**
 * Create or rebuild the bearer's "What the Ansu values" journal page: the deed
 * table and the last ten deed lines, readable by the actor's owners. GM side;
 * a no-op where there is no journal (tests, a player client).
 */
export async function rebuildValuesPage(actor) {
  if (!game.user?.isGM || typeof JournalEntry === "undefined" || !game.journal) return null;
  try {
    const deeds = await loadDeeds();
    const st = readAnsu(actor);
    const html = renderValuesHtml(deeds, st.log);
    const ownership = valuesOwnership(actor);
    const page = {
      name: game.i18n.localize("SHARDS.Ansu.ValuesPageName"),
      type: "text",
      text: { content: html, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    };
    let entry = st.valuesJournalId ? game.journal.get(st.valuesJournalId) : null;
    if (entry) {
      // Owners can change hands; the page follows the actor every rebuild.
      await entry.update({ ownership });
      const first = entry.pages.contents[0];
      if (first) await first.update({ "text.content": html });
      else await entry.createEmbeddedDocuments("JournalEntryPage", [page]);
    } else {
      entry = await JournalEntry.create({
        name: game.i18n.format("SHARDS.Ansu.ValuesJournalName", { name: actor.name }),
        ownership,
        pages: [page],
      });
      if (entry) await patchAnsu(actor, { valuesJournalId: entry.id });
    }
    return entry;
  } catch (err) {
    console.error("the-shards-subsystems | ansu values page", err);
    return null;
  }
}

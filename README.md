# The Shards — Campaign Subsystems

GM-side campaign subsystems for the homebrew world **The Shards**, run in Pathfinder Second Edition (Remaster) on Foundry VTT.

> **Pre-release (v0.1.0).** The Izir engine is complete and tested; the active abilities are still being authored. See [Status](#status).

## Subsystem 1 — Izir

A GM-controlled corruption tracker for the **Nameless**. Mark any actor, set their Izir immersion from 0 to 10, and the module keeps a matching set of Pathfinder 2e effects and actions on them — scaling powers with a comparable, escalating price.

- **Immersion 0–10** across four tiers (Whisper, Grip, Call, Nineveh), set from a GM panel.
- **Powers and prices** applied automatically as pf2e effect/action items; both are individually suppressible with a reason label, so you can reward a character who resists.
- **Hidden prices** — negative effects are applied unidentified and revealed one at a time (a world setting flips to full transparency).
- **Temptation of Izir** — a Will-save loop: a whispered check card for players (or a direct roll for NPCs), logged, with non-binding GM suggestions.
- **The tenth step** — reaching 10 forces a choice: consumed into a Nineveh, or mastery (Subjugation).
- **History log** with journal export, and **per-tier portrait/token art swaps**.
- A **reusable compendium** ships every ability foldered by tier, so you can drag any power or price onto any token independently of the tracker.

## Requirements

- Foundry VTT **v14**
- Pathfinder 2e system **v8.2.0+**

## Install

In Foundry: **Add-on Modules → Install Module**, and paste the manifest URL:

```
https://github.com/Zeitcatcher/the-shards-subsystems/releases/latest/download/module.json
```

## Status

| Area | State |
| --- | --- |
| Immersion tracker, panel, reconciliation engine | Done |
| Temptation loop, history, journal export | Done |
| Level-10 fork, art swaps | Done |
| Passive powers + prices, levels 1–10 | Done |
| Active abilities (×9) | In progress |
| Full docs + screenshots | Pending release |

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Original homebrew content for The Shards; not published, endorsed, or approved by Paizo.

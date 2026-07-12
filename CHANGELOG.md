# Changelog

Notable changes, newest first. Every version is also on the [Releases page](https://github.com/Zeitcatcher/the-shards-subsystems/releases); to update inside Foundry VTT, press Update on the module.

## 0.6.3

Playtest round 2 fixes for Ansu.

- Release un-wedged. A Release card left un-rolled used to silently block every later Release: the sheet action returned without a word and the panel button disappeared. Clicking Release now replaces the stale card with a fresh one, the same rule the Call follows since 0.6.1. If a save was rolled from the sheet instead of the card, just click Release again or record the outcome in the panel.
- Deleting a running Communion effect now ends the state. It used to come back on its own with a full fresh timer, forever. An expired removal still resolves through the Release save; a manual delete counts as the GM ending it, with a whisper saying so.
- Maker's Wrath and Fair Battle add their damage themselves. Each carries a toggle (the same pattern as the summoner's Furious Strike): switch it on before the Strike and the extra dice or the flat 10 land in the damage roll, in the weapon's own damage type. Switch it off after — toggles don't clear themselves.

Verified on Pathfinder 2e (Foundry v14.364, pf2e 8.2.0). 144 tests green; content and pack checks clean.

## 0.6.2

A correctness and rules-language pass over both subsystems, from a full code and content audit. No new features — a lot of quieter things now work the way they already read.

Engine

- Communion no longer switches itself off mid-fight. A resync while a Communion timer was running used to blank its start time, so Foundry read the effect as long expired and quietly dropped every boon. The timer is preserved now.
- Saving throws and skill checks made from unlinked NPC tokens are captured correctly. Temptation outcomes, the Terror aura's frightened, and the Call and Release saves all resolve the token that rolled, instead of missing it and doing nothing.
- Void Lash keeps its 30-foot range, and Herald of Ruin grants a fly Speed again. Both were built on data shapes the pf2e 8.2 Remaster changed.
- The Seizure override behaves: you can't Release your way out of one, it lasts a full turn, a critical Call failure out of combat now hands you the Communion it promises, and an expired Communion resolves cleanly instead of restarting with a fresh timer.
- Duplicate effects can no longer pile up on an actor, a nudged level badge snaps back, and a spent power can't stay greyed out.

Pathfinder and Foundry

- The nameless and murkhor creature traits register the supported way and no longer leave stray data on player characters.
- Publication metadata reads ORC, matching the Remaster content it ships.

Content and rules text

- The Terror aura saves only on a first entry and then grants a minute of immunity, matching Frightful Presence. No more re-rolling by stepping out of the aura and back in.
- The Ansu Refuses shows its real cadence on the sheet: once every 10 minutes.
- Fixed a Shove that checked the wrong defense, an Engineer's Eye bonus that never applied, six broken save links in the browsable pack copies, and a wrong spell icon.
- A grammar and wording pass across both ability lists, in plain Remaster phrasing, and the campaign's private names taken out of the shipped text.

Verified on Pathfinder 2e (Foundry v14.364, pf2e 8.2.0). 141 tests green; content and pack checks clean.

## 0.6.1

Playtest fixes: a stale pending Call no longer wedges Invoke, condition links are ID-based so they resolve from module content, and every icon moved off art trees missing on hosted Foundry.

## 0.6.0

The Call. Every Invoke is now gated by an Intimidation check against a DC that climbs with attunement and never caps; a critical failure summons the Ansu anyway for a one-round seizure.

## 0.5.0

Ansu power pass: five new actives (Fair Battle, Hurl the Blade, The Ansu Refuses, Maker's Wrath, Salbarine Parry), Inheritance passives as bonus feats, and communion-gated actives.

## 0.4.0

The Ansu Communion subsystem — a ten-level mastery track with attunement, Release saves, the Climb, and the Seizure override — plus a one-window switcher between subsystems.

## 0.3.0

Native-first recharge for Izir's cooldown powers: a Use button, a rolled recharge effect with a real countdown, and a round sweep to clear it.

## 0.2.x

Module-owned use state, the save-first Terror aura, verified icons, and v14 flag-deletion fixes.

## 0.1.1

First engine preview of Izir: the immersion tracker, scaling boons and prices, and the temptation loop.

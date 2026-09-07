# Changelog

Notable changes, newest first. Every version is also on the [Releases page](https://github.com/Zeitcatcher/the-shards-subsystems/releases); to update inside Foundry VTT, press Update on the module.

## 0.6.6

An audit release for Ansu. Nine bugs that changed outcomes at the table, and a long tail of panel, card, and text fixes. Izir is untouched.

- The critical-failure Seizure lasts its full turn again. A bearer at the bottom of the initiative order got the body back at the end of the turn the seizure began on, because the return read the tracker's current round instead of the round the ended turn belonged to.
- Communion handed back after a Seizure runs its full duration. The fresh countdown was stamped at a turn end while Pathfinder resolves a rounds clock at a turn start, so at attunement 1 to 3 the player never got an action with it running.
- Communion no longer refills Ancestral Vigor when it expires. With Pathfinder's default effect automation the expired effect is deleted and rebuilt, which re-ran the temporary hit point grant. Whatever is left of the pool now carries through the transition instead.
- A Communion started outside a fight picks up its countdown when the fight begins. It used to stay untimed for the whole encounter, with no expiry and no Release save.
- The module reads the bearer's own encounter instead of the one on the scene the GM happens to be looking at.
- Two attuned tokens built from one statblock no longer block each other. Sync and expiry guards were keyed on the base actor's id, so one token's expiry could swallow the other's.
- NPC Call and Release rolls are whispered to the GM again. The visibility option was passed under a name Pathfinder no longer reads, so it was dropped and the checks went to the whole table.
- Call and Release cards roll for the bearer, not for whatever token the clicker has selected.
- A Call or Release rerolled with a hero point is no longer discarded. The GM is told the outcome changed and can record it, and the Climb pays only the difference.
- The Tenth Step is available at attunement 9. The button and both ladder chips used to be clickable at any attunement, including 0.
- The GM panel is GM-only. A player who could reach it was able to set their own attunement, drive the Climb, and press the one-way fork.
- An expiry is resolved out of combat and when an encounter ends, not only on a turn change.
- A Taken character no longer keeps Invoke and Release as dead buttons, and a subjugated master's Invoke is the free action the capstone promises.
- Panel: the countdown shows the final round instead of vanishing, a typed Release DC stays with the bearer it was typed for, Mastery chips carry the suppress control, active and lingering bearers are marked on the roster, reactions show their action glyph, locked ladder rows preview their own numbers, and the Return tooltip says where the body actually lands.
- The Attunement badge steps down to 0, and it picks up a changed Release DC.
- Stepping attunement down leaves the Climb one point short of full instead of full and stuck, and the Climb report no longer announces movement the cap swallowed.
- A Seizure no longer swallows a pending Call, and its whisper matches what the code does.
- Art thresholds work for an unlinked bearer and no longer rewrite every token sharing the statblock.
- Roar of the Old Blood reads the way Demoralize resolves: your check improves by one degree, and a critical success is what brings Frightened 3 and Fleeing.
- The compendium copy of Ancestral Vigor (Union) grants 21 temporary hit points, matching its own text, instead of 3.
- Remove attunement clears the actor's Ansu data. The deletion payload was malformed, so the flag namespace survived.
- Chat cards and dialogs escape actor names.
- Content validation rejects two entries that share a family and a rank, and the validator's own rejection rules are covered by tests.

Verified on Pathfinder 2e (Foundry v14.367, pf2e 8.5.0). 412 tests green; content and pack checks clean.

## 0.6.5

Ansu expiry and Release fixes, and the platform bump to Foundry 14.367 and pf2e 8.5.0.

- Platform: audited against Foundry builds 14.366 and 14.367 and a full source diff of pf2e 8.2.0 through 8.5.0. Nothing the module uses changed (effect expiry, rule elements, chat-card flags, inline checks, the end-of-turn hook, item schemas, condition ids), so there are no code changes for it. The manifest now declares pf2e 8.5.0 as verified and keeps 8.2.0 as the minimum.
- One Release card when the Communion timer runs out. Two identical Will-save cards used to go up at once, and only the second one counted: a player who clicked the first saw the roll do nothing, and the dead marker it left behind then stopped the next end-of-turn save from appearing at all. The expiry is resolved once now, whichever watcher notices it first.
- Every posted card counts. A roll from a card that was replaced or duplicated is recorded instead of dropped, with a console line naming both card ids. A save rolled anywhere else still needs the card or the panel's manual recorder, so an unrelated save at the same DC can't be taken for a Release.
- The end-of-turn re-save while Lingering now comes from Pathfinder's own end-of-turn signal instead of being read off the combat tracker, and it posts a fresh card every turn. An un-rolled card from the previous turn is replaced rather than left to block the next one.

Verified on Pathfinder 2e (Foundry v14.367, pf2e 8.5.0). 174 tests green; content and pack checks clean.

## 0.6.4

Compatibility release for Foundry VTT build 14.365 (Stable 7). The build is additive upstream: no deprecations or removals, and nothing in it touches the APIs this module uses (ApplicationV2, DialogV2, flag deletion, scene controls, FilePicker, effect items, compendium packs, macros). No behavior changes in the module itself.

Verified on Pathfinder 2e (Foundry v14.365, pf2e 8.2.0). 144 tests green; content and pack checks clean.

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

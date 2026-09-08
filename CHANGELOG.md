# Changelog

Notable changes, newest first. Every version is also on the [Releases page](https://github.com/Zeitcatcher/the-shards-subsystems/releases); to update inside Foundry VTT, press Update on the module.

## 0.7.0

An audit release for Izir. Four bugs that changed outcomes at the table, and a long tail of panel, content, and platform fixes. Ansu is untouched.

- The Izir panel is GM-only. The scene-control button was hidden from players, but the launcher macro and the module API were not, and a player who reached the panel could set their own immersion, suppress their own prices and press the one-way fork.
- Void Lash rolls the Izir attack bonus for a player character. Pathfinder reads a fixed attack modifier on NPC actors only, so on a PC the strike quietly used the character's own unarmed math while the panel advertised a different number.
- A temptation save rerolled with a hero point replaces the first result. The reroll used to be discarded: the slide, the immersion level and the history all kept the outcome the table had thrown away. The track rewinds to where it stood before the first result and the new one is applied from there. Terror saves reconcile the same way, and frightened comes off when the reroll succeeds.
- Removing the mark puts the original portrait and token art back. Unmark deletes the actor's Izir data, and the captured originals lived inside it, so a transformed character kept Izir's face with no record of their own.
- Two tokens built from one statblock no longer block each other. Sync, recharge and temptation guards were keyed on the base actor's id, so one token's work could swallow the other's.
- The GM's NPC temptation roll is whispered again. The visibility option was passed under a name Pathfinder no longer reads, so the save went to the whole table.
- Recharge reads the bearer's own encounter instead of the one on the scene the GM happens to be looking at. Cooldowns end with the fight that gave them meaning, and an expired marker the world never removed no longer greys out the Use button.
- Out of combat there is no cooldown, and the ability texts say so. A recharge marker dropped on an actor by hand between fights stays where the GM put it instead of vanishing.
- The recharge die is rolled to the GM rather than the table.
- Aura effects and recharge markers moved to a second compendium that players can read. Pathfinder resolves a self-effect on the clicking client and grants an aura effect on the receiving one, so both used to fail silently from a GM-only pack.
- Nine reminder notes attached to every roll the character made are down to two, on the checks they belong to. Their text is still in the ability descriptions and on the ladder.
- Re-sync rebuilds every tracked item instead of skipping when nothing looks changed, and reports how many it actually rebuilt. Upgrading runs that rebuild once on its own.
- Turning the Izir Immersion token icon off now reaches the effect.
- A temptation DC typed for one Nameless stays with them instead of following the GM to the next actor in the roster.
- The Tenth Step chips on the ladder are dead below immersion 9 and each one names the fate it stands for. Forcing the fork early is still possible from the stepper button, which says plainly that the character has not walked the whole track.
- Izir's Terror prompts once per encounter, the way Frightful Presence works. A minute-long immunity let a long fight re-prompt the same foe, while a marker left from an earlier fight ate the first save of the next one.
- The panel keeps its scroll position through a level nudge or a suppression toggle, and the temptation fields keep focus.
- Two quick clicks on the slide no longer lose one, and two suppress toggles no longer clobber each other.
- The history records what the slide actually did. A failed save at immersion 0, or on a full bar at 9, used to log points that never moved, and said nothing about why.
- A temptation that was never rolled clears itself. Calling one on an actor with no Will save, or closing the check dialog, left the panel waiting forever, and a Nineveh fork left an hourglass on the roster with no way to remove it.
- Subjugation capstones carry their action cost, their frequency and their suppress control once subjugation happens. A greyed replaced chip now warns that suppressing it takes the live rank off the sheet too, and a consumed character no longer shows a ladder of abilities that no longer exist.
- Rewording a suppression reason writes its own history line instead of a second Suppressed entry.
- Stepping the immersion down leaves the slide one point short of full instead of full and ready to level again.
- The token badge steps down to immersion 0, matching the panel stepper.
- Art thresholds: a revert holds until you apply art by hand or edit a row, so the next failed save no longer stamps the horror portrait back on. A revert also releases the capture, so a later swap remembers the art that is actually there. Clearing a row that is currently applied takes that art off the actor.
- Duplicating a marked actor gives the copy its own history journal instead of overwriting the original's.
- A second GM's panel follows what the first one does, and Shift-Re-sync tells them when only the active GM can run it.
- The roster follows tokens as they are placed and deleted, and a handler with nothing selected says so instead of doing nothing.
- A rejected macro write at world load no longer takes the whole subsystem down with it, and the hooks are registered before the content file is fetched rather than after.
- When the content file cannot be read the panel says so where the ladder would be, and the Tenth Step refuses instead of committing a terminal it cannot finish.
- Izir Wave I, Izir Wave II and Devour Light roll at least one die at character level 1. They rolled none, while the basic save still prompted.
- The Voice of Izir applies stupefied 1 and doomed 1. It named both conditions and granted neither, so dying thresholds and spell DCs were untouched.
- The Body Betrays is a -3 penalty. At -2 it duplicated The Face Fades and changed no number at level 8.
- Strength of the Void says Speeds, which is what the bonus has always applied to.
- The compendium card for Anathema to the Holy prints the scaling clause once.
- The selected roster row is visible under Foundry's dark theme, and the suppress, reveal and reason controls can be reached with the keyboard.
- The Art window names the actor it belongs to and stays with them when the roster selection moves.
- Content validation rejects an action entry carrying rules, a recharge that is not a die formula, a pack id that could never resolve, and an aura pointing somewhere other than the effect it declares. The validator's own rejection rules are covered by tests.
- The module is distributed from GitHub only, so Foundry will not offer it an update badge. The README says to paste the manifest URL again.

Verified on Pathfinder 2e (Foundry v14.367, pf2e 8.5.0). 479 tests green; content and pack checks clean.

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

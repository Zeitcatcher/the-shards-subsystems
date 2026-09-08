# The Shards Subsystems

GM tools for the homebrew world The Shards, run in Pathfinder Second Edition (Remaster) on Foundry VTT.

> Pre-release. Izir is playtested end to end; Ansu is engine-complete and in playtest. Screenshots come with the stable release.

## Izir

A corruption tracker for the Nameless. The GM marks an actor and sets their immersion in Izir from 0 to 10. The module keeps one composed effect on the actor with every power and price of that depth, plus the active abilities as usable sheet actions and strikes.

- Ten levels in four tiers: Whisper, Grip, Call, and the terminal tenth step, where the GM chooses Nineveh (consumed) or Subjugation (mastery).
- Every level pairs a passive, an active ability, and a price. Prices apply unidentified and are revealed one at a time; the GM can suppress any single entry and note why.
- Temptation saves (DC 20 at immersion 1, +3 per level) fill a slide bar. Three failures per current level raise the immersion on its own, and the token badge doubles as a level control.
- Izir casting matches a true caster at immersion 5 and gains one step per level after that.
- Actives recharge on 1d6 rounds like a dragon's breath. The cooldown is an encounter thing: in a fight the roll and the marker are automatic and the Use button stays spent until it ends, while out of combat there is nothing to count and the ability is simply available. Ending the encounter clears every marker it rolled.
- Terror aura prompts a Will save when an enemy enters; frightened lands only on a failed roll.
- A compendium ships every ability as a browsable item, foldered by tier, usable on any token without the tracker. A second, smaller one holds the machinery the players' own clients have to read — aura effects and recharge markers.

## Ansu

A mastery track for murkhor bearers. The GM attunes an actor and grows their bond with the Ansu from 0 to 10. The power is borrowed, not owned: the bearer invokes Communion for a burst of boons, then has to wrestle the Ansu back down to end it.

- Ten levels in four tiers: Trial, Discipline, Union, and the terminal tenth step, where the GM chooses Mastery (the Ansu subjugated) or Taken (the Ansu wins the body — and at the GM's call that can happen at any level).
- The power is never owed: invoking it takes an Intimidation check against the Call DC (20 + 2 per level, uncapped — 22 to 38). Fail and the action is wasted; critically fail and the Ansu comes anyway, seizing the body for a round before handing it back.
- Communion lasts 1 round at Trial, 3 rounds at Discipline, a minute at Union, and forever at Mastery. In combat the countdown and the Release save on expiry run on their own.
- Ending Communion takes a Will save: DC 20 + 2 per attunement level, frozen at 30 from level 5 — the wrestle stays real deep into the campaign. Failure means the Ansu lingers with the boons still on; a critical failure hands the body to the GM for a round.
- Clean releases fill the Climb (2 + level points); a full bar raises attunement on its own, and the token badge doubles as a level control.
- Two knowledge passives live as bonus feats in the Feats tab and stay on even while the power sleeps; every other boon and active materializes only inside Communion.
- A GM override seizes the body at any attunement with the full level-10 kit and restores the exact prior state on return.
- One window serves both subsystems: tabs at the top switch between Izir and Ansu, and an actor can sit on both tracks at once.
- A second compendium ships every Ansu ability as a browsable item.

## Requirements

- Foundry VTT v14
- Pathfinder 2e system v8.2.0+

Verified on Foundry 14.367 with Pathfinder 2e 8.5.0.

## Install

In Foundry: Add-on Modules, Install Module, paste the manifest URL:

```
https://github.com/Zeitcatcher/the-shards-subsystems/releases/latest/download/module.json
```

The module is distributed from GitHub only, not through Foundry's package listing, so Foundry will not offer it an update badge. Paste the same manifest URL again to pull a new version.

Engine, content, and both compendia are done. Screenshots and the stable-release polish are still ahead.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Original homebrew content for The Shards; not published, endorsed, or approved by Paizo.

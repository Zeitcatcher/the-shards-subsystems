/**
 * Scene-control launch buttons (GM-only) and a fallback launcher macro per subsystem.
 * Scene-control layouts differ between Foundry generations, so tools are inserted
 * defensively for both the array shape and the v13+ record shape.
 */

import { MODULE_ID } from "./constants.mjs";
import { getSubsystems } from "./subsystems.mjs";

export function registerControls() {
  Hooks.on("getSceneControlButtons", (controls) => {
    if (!game.user?.isGM) return;
    for (const sub of getSubsystems()) {
      const tool = {
        name: `shards-${sub.id}`,
        title: sub.titleKey,
        icon: sub.icon,
        button: true,
        order: 999,
        visible: true,
        onClick: () => sub.openPanel(),
        onChange: () => sub.openPanel(),
      };
      try {
        insertTool(controls, tool);
      } catch (err) {
        console.warn(`${MODULE_ID} | could not add a scene control button`, err);
      }
    }
  });
}

function insertTool(controls, tool) {
  if (Array.isArray(controls)) {
    const group = controls.find((c) => c.name === "token") ?? controls[0];
    group?.tools?.push(tool);
  } else if (controls && typeof controls === "object") {
    const group = controls.tokens ?? controls.token ?? Object.values(controls)[0];
    if (!group) return;
    if (Array.isArray(group.tools)) group.tools.push(tool);
    else if (group.tools && typeof group.tools === "object") group.tools[tool.name] = tool;
  }
}

/** Create a launcher macro per subsystem, or repair its image if the path changed. */
export async function ensureLauncherMacros() {
  for (const sub of getSubsystems()) {
    const name = game.i18n.localize(sub.titleKey);
    const img = sub.macroImg ?? "icons/svg/d20.svg";
    // Match our own macro by flag first; fall back to a name AND command match for
    // macros created before the flag existed. Never adopt an unrelated user macro
    // that merely shares the localized title.
    const openCmd = `openPanel("${sub.id}")`;
    const existing = game.macros.find(
      (m) => m.getFlag?.(MODULE_ID, "launcher") === sub.id || (m.name === name && m.command?.includes(openCmd)),
    );
    if (existing) {
      const patch = {};
      if (existing.img !== img) patch.img = img;
      if (existing.getFlag?.(MODULE_ID, "launcher") !== sub.id) patch[`flags.${MODULE_ID}.launcher`] = sub.id;
      if (Object.keys(patch).length && existing.isOwner) await existing.update(patch);
      continue;
    }
    await Macro.create({
      name,
      type: "script",
      img,
      command: `game.modules.get("${MODULE_ID}").api.openPanel("${sub.id}");`,
      flags: { [MODULE_ID]: { launcher: sub.id } },
    });
  }
}

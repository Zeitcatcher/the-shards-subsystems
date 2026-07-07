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
    const existing = game.macros.find((m) => m.name === name);
    if (existing) {
      if (existing.img !== img && existing.isOwner) await existing.update({ img });
      continue;
    }
    await Macro.create({
      name,
      type: "script",
      img,
      command: `game.modules.get("${MODULE_ID}").api.openPanel("${sub.id}");`,
    });
  }
}

// Worked example of the map-script API (docs/overworld.md): Prof. Oak stops the player at
// Pallet Town's north exit and walks them to his lab - scripts/PalletTown.asm
// (PalletTownDefaultScript -> ...PlayerFollowsOakScript) and engine/overworld/auto_movement.asm
// (PalletMovementScript_*, RLEList_ProfOakWalkToLab / RLEList_PlayerWalkToLab).
//
// Not registered automatically: the story layer owns the real Pallet Town script.
//   import { registerPalletOakExample } from './src/overworld/examples/pallet_oak.js';
//   registerPalletOakExample();

import { registerMapScript } from '../scripts.js';

const OAK = 1; // PALLETTOWN_OAK (object 1)

export const palletTownOakScript = {
  /** PalletTownDefaultScript: the trigger is reaching y == 1 (the north exit). */
  *onStep(ctx, x, y) {
    if (y !== 1 || ctx.getFlag('EVENT_FOLLOWED_OAK_INTO_LAB') || ctx.getFlag('EVENT_OAK_APPEARED_IN_PALLET')) return ctx.DEFAULT;
    ctx.facePlayer('down');
    ctx.playMusic('MUSIC_MEET_PROF_OAK');
    ctx.setFlag('EVENT_OAK_APPEARED_IN_PALLET');

    // PalletTownOakText.HeyWaitDontGoOutText: no button wait; 10 frames; "!" over the player
    yield ctx.showText('_PalletTownOakHeyWaitDontGoOutText', { wait: false, close: false });
    yield ctx.wait(10);
    yield ctx.emote(0, 'shock');
    ctx.closeText();

    // Oak appears, faces up and walks to the cell below the player (FindPathToPlayer)
    ctx.showObject(OAK);
    ctx.faceNpc(OAK, 'up');
    yield ctx.wait(3);
    const oak = ctx.npc(OAK);
    yield ctx.moveNpc(OAK, ctx.pathTo(oak.x, oak.y, x, y + 1));

    ctx.facePlayer('down');
    yield ctx.showText('_PalletTownOakItsUnsafeText');

    // PalletMovementScript_OakMoveLeft / PlayerMoveLeft: line up on the left tile
    if (x === 11) {
      yield ctx.moveNpc(OAK, ['left']);
      yield ctx.movePlayer(['left']);
    }
    // PalletMovementScript_WalkToLab: Oak (DoScriptedNPCMovement, in sync) and the player
    // (simulated joypad) walk together; the player's last steps go through the lab door.
    const oakWalk = ctx.moveNpc(OAK, [['down', 5], ['left', 1], ['down', 5], ['right', 3], ['up', 1]], { sync: true });
    yield ctx.movePlayer([['down', 6], ['left', 1], ['down', 5], ['right', 3], ['up', 2]]);
    yield oakWalk;

    // PalletMovementScript_Done: hide Pallet Town's Oak (by toggle: we are in the lab now)
    ctx.hideToggle('TOGGLE_PALLET_TOWN_OAK');
    ctx.setFlag('EVENT_FOLLOWED_OAK_INTO_LAB');
  },
};

export function registerPalletOakExample() {
  return registerMapScript('PalletTown', palletTownOakScript);
}

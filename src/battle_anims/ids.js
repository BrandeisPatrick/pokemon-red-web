// Animation ids.
//
// Numbers 1-203 are pokered's wAnimationID values: 1-165 are the moves (POUND ... STRUGGLE,
// the move id doubles as its animation id), 166-202 the non-move constants that follow
// STRUGGLE in constants/move_constants.asm, 203 the extra pointer after NUM_ATTACK_ANIMS
// (ZigZagScreenAnim, never used). The string ids are battle-screen sequences that are not in
// the animation table but are part of the same rendering (intro slide, send-out, faint, ...),
// each transcribed from the engine routine named in its description.

/** Non-move animation ids (constants/move_constants.asm). */
export const ANIM = Object.freeze({
  SHOWPIC_ANIM: 0xa6,
  STATUS_AFFECTED_ANIM: 0xa7,
  ANIM_A8: 0xa8,
  ENEMY_HUD_SHAKE_ANIM: 0xa9,
  TRADE_BALL_DROP_ANIM: 0xaa,
  TRADE_BALL_SHAKE_ANIM: 0xab,
  TRADE_BALL_TILT_ANIM: 0xac,
  TRADE_BALL_POOF_ANIM: 0xad,
  XSTATITEM_ANIM: 0xae,
  XSTATITEM_DUPLICATE_ANIM: 0xaf,
  SHRINKING_SQUARE_ANIM: 0xb0,
  ANIM_B1: 0xb1,
  ANIM_B2: 0xb2,
  ANIM_B3: 0xb3,
  ANIM_B4: 0xb4,
  ANIM_B5: 0xb5,
  ANIM_B6: 0xb6,
  ANIM_B7: 0xb7,
  ANIM_B8: 0xb8,
  ANIM_B9: 0xb9,
  BURN_PSN_ANIM: 0xba,
  ANIM_BB: 0xbb,
  SLP_PLAYER_ANIM: 0xbc,
  SLP_ANIM: 0xbd,
  CONF_PLAYER_ANIM: 0xbe,
  CONF_ANIM: 0xbf,
  SLIDE_DOWN_ANIM: 0xc0,
  TOSS_ANIM: 0xc1,
  SHAKE_ANIM: 0xc2,
  POOF_ANIM: 0xc3,
  BLOCKBALL_ANIM: 0xc4,
  GREATTOSS_ANIM: 0xc5,
  ULTRATOSS_ANIM: 0xc6,
  SHAKE_SCREEN_ANIM: 0xc7,
  HIDEPIC_ANIM: 0xc8,
  ROCK_ANIM: 0xc9,
  BAIT_ANIM: 0xca,
  ZIGZAG_SCREEN_ANIM: 0xcb,
});

export const NUM_ATTACKS = 165;
export const NUM_ATTACK_ANIMS = 0xca;
export const GROWL = 45;
export const ROAR = 46;
export const AMNESIA = 133;
export const REST = 156;

/**
 * The non-move ids with the script they run and where the game plays them.
 * @type {ReadonlyArray<{id:number, name:string, script:string, use:string}>}
 */
export const NON_MOVE_ANIMS = Object.freeze([
  { id: 0xa6, name: 'SHOWPIC_ANIM', script: 'ShowPicAnim', use: 'Ball toss: the enemy pic reappears after it breaks free (TossBallAnimation)' },
  { id: 0xa7, name: 'STATUS_AFFECTED_ANIM', script: 'EnemyFlashAnim', use: 'Fly/charge move interrupted or missed: the attacker reappears (SE_SHOW_MON_PIC)' },
  { id: 0xa8, name: 'ANIM_A8', script: 'PlayerFlashAnim', use: 'unused: reloads the attacker pic (SE_FLASH_MON_PIC)' },
  { id: 0xa9, name: 'ENEMY_HUD_SHAKE_ANIM', script: 'EnemyHUDShakeAnim', use: 'The player poisoned/burned/froze/paralyzed the enemy: enemy HUD + pic shake' },
  { id: 0xaa, name: 'TRADE_BALL_DROP_ANIM', script: 'TradeBallDropAnim', use: 'Trade screen (engine/movie/trade.asm)' },
  { id: 0xab, name: 'TRADE_BALL_SHAKE_ANIM', script: 'TradeBallAppear1Anim', use: 'Trade screen' },
  { id: 0xac, name: 'TRADE_BALL_TILT_ANIM', script: 'TradeBallAppear2Anim', use: 'Trade screen' },
  { id: 0xad, name: 'TRADE_BALL_POOF_ANIM', script: 'TradeBallPoofAnim', use: 'Trade screen' },
  { id: 0xae, name: 'XSTATITEM_ANIM', script: 'XStatItemAnim', use: 'X Attack/Defend/Speed/Special, Dire Hit, Guard Spec.; Bide and charge turns on the player side' },
  { id: 0xaf, name: 'XSTATITEM_DUPLICATE_ANIM', script: 'XStatItemAnim', use: 'Same on the enemy side (Bide/charge turns, trainer AI X items)' },
  { id: 0xb0, name: 'SHRINKING_SQUARE_ANIM', script: 'ShrinkingSquareAnim', use: 'Thrash / Petal Dance start (player)' },
  { id: 0xb1, name: 'ANIM_B1', script: 'ShrinkingSquareAnim', use: 'Thrash / Petal Dance start (enemy)' },
  { id: 0xb2, name: 'ANIM_B2', script: 'XStatItemBlackAnim', use: 'unused' },
  { id: 0xb3, name: 'ANIM_B3', script: 'XStatItemBlackAnim', use: 'unused' },
  { id: 0xb4, name: 'ANIM_B4', script: 'ShrinkingSquareBlackAnim', use: 'unused' },
  { id: 0xb5, name: 'ANIM_B5', script: 'ShrinkingSquareBlackAnim', use: 'unused' },
  { id: 0xb6, name: 'ANIM_B6', script: 'UnusedAnim', use: 'unused (shoot many balls upward)' },
  { id: 0xb7, name: 'ANIM_B7', script: 'UnusedAnim', use: 'unused' },
  { id: 0xb8, name: 'ANIM_B8', script: 'ParalyzeAnim', use: 'unused (paralysis sparks)' },
  { id: 0xb9, name: 'ANIM_B9', script: 'ParalyzeAnim', use: 'unused' },
  { id: 0xba, name: 'BURN_PSN_ANIM', script: 'PoisonAnim', use: 'Hurt by poison / burn at the end of a turn (HandlePoisonBurnLeechSeed)' },
  { id: 0xbb, name: 'ANIM_BB', script: 'PoisonAnim', use: 'unused' },
  { id: 0xbc, name: 'SLP_PLAYER_ANIM', script: 'SleepPlayerAnim', use: 'Player mon is fast asleep' },
  { id: 0xbd, name: 'SLP_ANIM', script: 'SleepEnemyAnim', use: 'Enemy mon is fast asleep; REST on the enemy turn (ShareMoveAnimations)' },
  { id: 0xbe, name: 'CONF_PLAYER_ANIM', script: 'ConfusedPlayerAnim', use: 'Player mon is confused' },
  { id: 0xbf, name: 'CONF_ANIM', script: 'ConfusedEnemyAnim', use: 'Enemy mon is confused; AMNESIA on the enemy turn (ShareMoveAnimations)' },
  { id: 0xc0, name: 'SLIDE_DOWN_ANIM', script: 'SlideDownAnim', use: 'Dig charge turn (ChargeEffect)' },
  { id: 0xc1, name: 'TOSS_ANIM', script: 'BallTossAnim', use: 'Throw a ball: MoveAnimation runs the whole TossBallAnimation (toss, poof, shakes, breakout/catch, trainer block, ghost dodge)' },
  { id: 0xc2, name: 'SHAKE_ANIM', script: 'BallShakeAnim', use: 'Ball shakes (part of TossBallAnimation; repeats wNumShakes times)' },
  { id: 0xc3, name: 'POOF_ANIM', script: 'BallPoofAnim', use: 'Ball poof (TossBallAnimation; SendOutMon plays it on the enemy turn so it is mirrored to the player side)' },
  { id: 0xc4, name: 'BLOCKBALL_ANIM', script: 'BallBlockAnim', use: 'Trainer knocks the ball away' },
  { id: 0xc5, name: 'GREATTOSS_ANIM', script: 'GreatTossAnim', use: 'Great Ball throw (TossBallAnimation)' },
  { id: 0xc6, name: 'ULTRATOSS_ANIM', script: 'UltraTossAnim', use: 'Ultra / Master / Safari Ball throw (TossBallAnimation)' },
  { id: 0xc7, name: 'SHAKE_SCREEN_ANIM', script: 'ShakeScreenAnim', use: 'The enemy poisoned the player (PoisonEffect)' },
  { id: 0xc8, name: 'HIDEPIC_ANIM', script: 'HidePicAnim', use: 'Ball toss: the enemy disappears into the ball' },
  { id: 0xc9, name: 'ROCK_ANIM', script: 'ThrowRockAnim', use: 'Safari Zone: throw rock' },
  { id: 0xca, name: 'BAIT_ANIM', script: 'ThrowBaitAnim', use: 'Safari Zone: throw bait' },
  { id: 0xcb, name: 'ZIGZAG_SCREEN_ANIM', script: 'ZigZagScreenAnim', use: 'unused pointer after NUM_ATTACK_ANIMS (wavy screen)' },
]);

/** wAnimationType values (AnimationTypePointerTable): the applying-attack effect after an animation. */
export const ANIMATION_TYPE = Object.freeze({
  NONE: 0,
  SHAKE_SCREEN_VERTICALLY: 1,          // enemy used a damaging move without side effect
  SHAKE_SCREEN_HORIZONTALLY_HEAVY: 2,  // enemy used a damaging move with a side effect
  SHAKE_SCREEN_HORIZONTALLY_SLOW: 3,   // enemy used a non-damaging move (stat down etc.)
  BLINK_ENEMY_MON_SPRITE: 4,           // player used a damaging move without side effect (defender blinks)
  SHAKE_SCREEN_HORIZONTALLY_LIGHT: 5,  // player used a damaging move with a side effect
  SHAKE_SCREEN_HORIZONTALLY_SLOW_2: 6, // player used a non-damaging move
});

/**
 * Battle-screen sequences that are not in the animation table (string ids for playAnimation).
 * @type {ReadonlyArray<{id:string, routine:string, use:string}>}
 */
export const SEQUENCES = Object.freeze([
  { id: 'SLIDE_SILHOUETTES', routine: 'SlidePlayerAndEnemySilhouettesOnScreen', use: 'Battle intro: enemy pic slides in from the left, the player trainer from the right (head as sprites)' },
  { id: 'SLIDE_TRAINER_OFF_ENEMY', routine: 'SlideTrainerPicOffScreen (hlcoord 18,0, a=8)', use: 'Enemy trainer slides off to the right before sending out a mon (EnemySendOut)' },
  { id: 'SLIDE_TRAINER_OFF_PLAYER', routine: 'SlideTrainerPicOffScreen (hlcoord 1,5, a=9)', use: 'Player trainer slides off to the left before the first send-out (StartBattle)' },
  { id: 'SCROLL_TRAINER_PIC_IN', routine: '_ScrollTrainerPicAfterBattle', use: 'After winning a trainer battle the trainer pic scrolls in from the right' },
  { id: 'SEND_OUT_ENEMY_MON', routine: 'AnimateSendingOutMon (hlcoord 15,6, base -$31)', use: 'Enemy mon appears out of its ball (EnemySendOut)' },
  { id: 'SEND_OUT_PLAYER_MON', routine: 'POOF_ANIM on the enemy turn + AnimateSendingOutMon (hlcoord 4,11)', use: 'Player sends out a mon (SendOutMon)' },
  { id: 'RETREAT_PLAYER_MON', routine: 'AnimateRetreatingPlayerMon', use: 'Player mon is called back (switch)' },
  { id: 'FAINT_ENEMY_MON', routine: 'SlideDownFaintedMonPic (hlcoord 12,5 / decoord 12,6)', use: 'Enemy mon faints (FaintEnemyPokemon)' },
  { id: 'FAINT_PLAYER_MON', routine: 'SlideDownFaintedMonPic (hlcoord 1,10 / decoord 1,11)', use: 'Player mon faints (RemoveFaintedPlayerMon)' },
  { id: 'ENEMY_RAN', routine: 'AnimationSlideEnemyMonOff', use: 'Wild mon fled (EnemyRan) / blown away' },
  { id: 'HIDE_SUBSTITUTE_SHOW_MON', routine: 'HideSubstituteShowMonAnim', use: 'Substitute user attacks (or the substitute breaks): doll slides off/down, mon reappears' },
  { id: 'RESHOW_SUBSTITUTE', routine: 'ReshowSubstituteAnim', use: 'After the attack the doll slides back in' },
  { id: 'MAROWAK_UNVEIL', routine: 'MarowakAnim', use: 'Silph Scope: the ghost is unveiled as Marowak' },
  { id: 'ANIMATIONTYPE_SHAKE_SCREEN_VERTICALLY', routine: 'ShakeScreenVertically', use: 'wAnimationType 1 on its own' },
  { id: 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_HEAVY', routine: 'ShakeScreenHorizontallyHeavy', use: 'wAnimationType 2 on its own' },
  { id: 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW', routine: 'ShakeScreenHorizontallySlow', use: 'wAnimationType 3 on its own' },
  { id: 'ANIMATIONTYPE_BLINK_ENEMY_MON_SPRITE', routine: 'BlinkEnemyMonSprite', use: 'wAnimationType 4 on its own (defender blinks)' },
  { id: 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_LIGHT', routine: 'ShakeScreenHorizontallyLight', use: 'wAnimationType 5 on its own' },
  { id: 'ANIMATIONTYPE_SHAKE_SCREEN_HORIZONTALLY_SLOW_2', routine: 'ShakeScreenHorizontallySlow2', use: 'wAnimationType 6 on its own' },
]);

/**
 * Every playable id: moves (from the data), non-move ids, sequences.
 * @param {{animations: {id:number, const:string, kind:string}[]}} data
 * @returns {{id:number|string, name:string, kind:'move'|'battle'|'unused'|'sequence'}[]}
 */
export function listAnimations(data) {
  const out = data.animations.map((a) => ({ id: a.id, name: a.const, kind: a.kind }));
  for (const s of SEQUENCES) out.push({ id: s.id, name: s.id, kind: 'sequence' });
  return out;
}

/**
 * Resolve an id given as a number, a numeric string, an animation constant ('THUNDERBOLT',
 * 'TOSS_ANIM') or a sequence id.
 * @returns {number|string|null}
 */
export function resolveAnimId(data, id) {
  if (typeof id === 'number') return id;
  if (typeof id !== 'string') return null;
  if (/^\d+$/.test(id)) return Number(id);
  if (/^\$[0-9a-f]+$/i.test(id)) return parseInt(id.slice(1), 16);
  if (data.ids && id in data.ids) return data.ids[id];
  if (SEQUENCES.some((s) => s.id === id)) return id;
  return null;
}

// Battle constants transcribed from the disassembly (constants/battle_constants.asm,
// constants/move_effect_constants.asm, constants/move_constants.asm, data/battle/*.asm).
// Tests check every value against data/battle/*.json and data/moves.json.

/** Sides: index into Battle.side, also the value of hWhoseTurn. */
export const PLAYER = 0;
export const ENEMY = 1;

/** wPlayerSelectedMove / wEnemySelectedMove value for "cannot move" (trapped, ...). */
export const CANNOT_MOVE = 0xff;

/** wIsInBattle */
export const WILD_BATTLE = 1;
export const TRAINER_BATTLE = 2;

/** wBattleType */
export const BATTLE_TYPE_NORMAL = 0;
export const BATTLE_TYPE_OLD_MAN = 1;
export const BATTLE_TYPE_SAFARI = 2;

/** Battle status 1 bits (wPlayerBattleStatus1 / wEnemyBattleStatus1). */
export const STORING_ENERGY = 1 << 0; // Bide
export const THRASHING_ABOUT = 1 << 1; // Thrash / Petal Dance
export const ATTACKING_MULTIPLE_TIMES = 1 << 2;
export const FLINCHED = 1 << 3;
export const CHARGING_UP = 1 << 4; // Razor Wind, Solar Beam, Skull Bash, Sky Attack, Fly, Dig
export const USING_TRAPPING_MOVE = 1 << 5; // Wrap, Bind, Clamp, Fire Spin
export const INVULNERABLE = 1 << 6; // Fly / Dig
export const CONFUSED = 1 << 7;

/** Battle status 2 bits. */
export const USING_X_ACCURACY = 1 << 0;
export const PROTECTED_BY_MIST = 1 << 1;
export const GETTING_PUMPED = 1 << 2; // Focus Energy / Dire Hit
export const HAS_SUBSTITUTE_UP = 1 << 4;
export const NEEDS_TO_RECHARGE = 1 << 5; // Hyper Beam
export const USING_RAGE = 1 << 6;
export const SEEDED = 1 << 7;

/** Battle status 3 bits. */
export const BADLY_POISONED = 1 << 0;
export const HAS_LIGHT_SCREEN_UP = 1 << 1;
export const HAS_REFLECT_UP = 1 << 2;
export const TRANSFORMED = 1 << 3;

/** Party status byte (constants/battle_constants.asm). */
export const SLP_MASK = 0b111;
export const PSN = 1 << 3;
export const BRN = 1 << 4;
export const FRZ = 1 << 5;
export const PAR = 1 << 6;

/** PP byte: bits 6-7 = PP Ups used, bits 0-5 = current PP. */
export const PP_MASK = 0b00111111;
export const PP_UP_MASK = 0b11000000;

/** Stat modifier indices (MOD_*); 7 = neutral, 1..13 = -6..+6. 8 bytes per side (2 unused). */
export const MOD_ATTACK = 0;
export const MOD_DEFENSE = 1;
export const MOD_SPEED = 2;
export const MOD_SPECIAL = 3;
export const MOD_ACCURACY = 4;
export const MOD_EVASION = 5;
export const NUM_STAT_MODS = 8;
export const NEUTRAL_MOD = 7;
export const MAX_MOD = 13;

/** wDamageMultipliers */
export const BIT_STAB_DAMAGE = 7;
export const EFFECTIVENESS_MASK = 0x7f;
export const EFFECTIVE = 10;
export const SUPER_EFFECTIVE = 20;
export const NOT_VERY_EFFECTIVE = 5;

/** wAnimationType (AnimationTypePointerTable). */
export const ANIMATIONTYPE = Object.freeze({
  NONE: 0,
  SHAKE_SCREEN_VERTICALLY: 1,
  SHAKE_SCREEN_HORIZONTALLY_HEAVY: 2,
  SHAKE_SCREEN_HORIZONTALLY_SLOW: 3,
  BLINK_ENEMY_MON_SPRITE: 4,
  SHAKE_SCREEN_HORIZONTALLY_LIGHT: 5,
  SHAKE_SCREEN_HORIZONTALLY_SLOW_2: 6,
});

/** Move effect ids (constants/move_effect_constants.asm). */
export const EFFECT = Object.freeze({
  NO_ADDITIONAL_EFFECT: 0, EFFECT_01: 1, POISON_SIDE_EFFECT1: 2, DRAIN_HP_EFFECT: 3,
  BURN_SIDE_EFFECT1: 4, FREEZE_SIDE_EFFECT1: 5, PARALYZE_SIDE_EFFECT1: 6, EXPLODE_EFFECT: 7,
  DREAM_EATER_EFFECT: 8, MIRROR_MOVE_EFFECT: 9, ATTACK_UP1_EFFECT: 10, DEFENSE_UP1_EFFECT: 11,
  SPEED_UP1_EFFECT: 12, SPECIAL_UP1_EFFECT: 13, ACCURACY_UP1_EFFECT: 14, EVASION_UP1_EFFECT: 15,
  PAY_DAY_EFFECT: 16, SWIFT_EFFECT: 17, ATTACK_DOWN1_EFFECT: 18, DEFENSE_DOWN1_EFFECT: 19,
  SPEED_DOWN1_EFFECT: 20, SPECIAL_DOWN1_EFFECT: 21, ACCURACY_DOWN1_EFFECT: 22, EVASION_DOWN1_EFFECT: 23,
  CONVERSION_EFFECT: 24, HAZE_EFFECT: 25, BIDE_EFFECT: 26, THRASH_PETAL_DANCE_EFFECT: 27,
  SWITCH_AND_TELEPORT_EFFECT: 28, TWO_TO_FIVE_ATTACKS_EFFECT: 29, EFFECT_1E: 30, FLINCH_SIDE_EFFECT1: 31,
  SLEEP_EFFECT: 32, POISON_SIDE_EFFECT2: 33, BURN_SIDE_EFFECT2: 34, FREEZE_SIDE_EFFECT2: 35,
  PARALYZE_SIDE_EFFECT2: 36, FLINCH_SIDE_EFFECT2: 37, OHKO_EFFECT: 38, CHARGE_EFFECT: 39,
  SUPER_FANG_EFFECT: 40, SPECIAL_DAMAGE_EFFECT: 41, TRAPPING_EFFECT: 42, FLY_EFFECT: 43,
  ATTACK_TWICE_EFFECT: 44, JUMP_KICK_EFFECT: 45, MIST_EFFECT: 46, FOCUS_ENERGY_EFFECT: 47,
  RECOIL_EFFECT: 48, CONFUSION_EFFECT: 49, ATTACK_UP2_EFFECT: 50, DEFENSE_UP2_EFFECT: 51,
  SPEED_UP2_EFFECT: 52, SPECIAL_UP2_EFFECT: 53, ACCURACY_UP2_EFFECT: 54, EVASION_UP2_EFFECT: 55,
  HEAL_EFFECT: 56, TRANSFORM_EFFECT: 57, ATTACK_DOWN2_EFFECT: 58, DEFENSE_DOWN2_EFFECT: 59,
  SPEED_DOWN2_EFFECT: 60, SPECIAL_DOWN2_EFFECT: 61, ACCURACY_DOWN2_EFFECT: 62, EVASION_DOWN2_EFFECT: 63,
  LIGHT_SCREEN_EFFECT: 64, REFLECT_EFFECT: 65, POISON_EFFECT: 66, PARALYZE_EFFECT: 67,
  ATTACK_DOWN_SIDE_EFFECT: 68, DEFENSE_DOWN_SIDE_EFFECT: 69, SPEED_DOWN_SIDE_EFFECT: 70,
  SPECIAL_DOWN_SIDE_EFFECT: 71, CONFUSION_SIDE_EFFECT: 76, TWINEEDLE_EFFECT: 77,
  SUBSTITUTE_EFFECT: 79, HYPER_BEAM_EFFECT: 80, RAGE_EFFECT: 81, MIMIC_EFFECT: 82,
  METRONOME_EFFECT: 83, LEECH_SEED_EFFECT: 84, SPLASH_EFFECT: 85, DISABLE_EFFECT: 86,
});

const E = EFFECT;

/** data/battle/residual_effects_1.asm */
export const RESIDUAL_EFFECTS_1 = Object.freeze([
  E.CONVERSION_EFFECT, E.HAZE_EFFECT, E.SWITCH_AND_TELEPORT_EFFECT, E.MIST_EFFECT, E.FOCUS_ENERGY_EFFECT,
  E.CONFUSION_EFFECT, E.HEAL_EFFECT, E.TRANSFORM_EFFECT, E.LIGHT_SCREEN_EFFECT, E.REFLECT_EFFECT,
  E.POISON_EFFECT, E.PARALYZE_EFFECT, E.SUBSTITUTE_EFFECT, E.MIMIC_EFFECT, E.LEECH_SEED_EFFECT, E.SPLASH_EFFECT,
]);
/** data/battle/special_effects.asm (second half: SpecialEffectsCont) */
export const SPECIAL_EFFECTS_CONT = Object.freeze([E.THRASH_PETAL_DANCE_EFFECT, E.TRAPPING_EFFECT]);
/** data/battle/set_damage_effects.asm */
export const SET_DAMAGE_EFFECTS = Object.freeze([E.SUPER_FANG_EFFECT, E.SPECIAL_DAMAGE_EFFECT]);
/** data/battle/residual_effects_2.asm */
export const RESIDUAL_EFFECTS_2 = Object.freeze([
  E.EFFECT_01, E.ATTACK_UP1_EFFECT, E.DEFENSE_UP1_EFFECT, E.SPEED_UP1_EFFECT, E.SPECIAL_UP1_EFFECT,
  E.ACCURACY_UP1_EFFECT, E.EVASION_UP1_EFFECT, E.ATTACK_DOWN1_EFFECT, E.DEFENSE_DOWN1_EFFECT,
  E.SPEED_DOWN1_EFFECT, E.SPECIAL_DOWN1_EFFECT, E.ACCURACY_DOWN1_EFFECT, E.EVASION_DOWN1_EFFECT,
  E.BIDE_EFFECT, E.SLEEP_EFFECT, E.ATTACK_UP2_EFFECT, E.DEFENSE_UP2_EFFECT, E.SPEED_UP2_EFFECT,
  E.SPECIAL_UP2_EFFECT, E.ACCURACY_UP2_EFFECT, E.EVASION_UP2_EFFECT, E.ATTACK_DOWN2_EFFECT,
  E.DEFENSE_DOWN2_EFFECT, E.SPEED_DOWN2_EFFECT, E.SPECIAL_DOWN2_EFFECT, E.ACCURACY_DOWN2_EFFECT,
  E.EVASION_DOWN2_EFFECT,
]);
/** data/battle/always_happen_effects.asm */
export const ALWAYS_HAPPEN_SIDE_EFFECTS = Object.freeze([
  E.DRAIN_HP_EFFECT, E.EXPLODE_EFFECT, E.DREAM_EATER_EFFECT, E.PAY_DAY_EFFECT, E.TWO_TO_FIVE_ATTACKS_EFFECT,
  E.EFFECT_1E, E.ATTACK_TWICE_EFFECT, E.RECOIL_EFFECT, E.TWINEEDLE_EFFECT, E.RAGE_EFFECT,
]);
/** data/battle/special_effects.asm (SpecialEffects incl. SpecialEffectsCont) */
export const SPECIAL_EFFECTS = Object.freeze([
  E.DRAIN_HP_EFFECT, E.EXPLODE_EFFECT, E.DREAM_EATER_EFFECT, E.PAY_DAY_EFFECT, E.SWIFT_EFFECT,
  E.TWO_TO_FIVE_ATTACKS_EFFECT, E.EFFECT_1E, E.CHARGE_EFFECT, E.SUPER_FANG_EFFECT, E.SPECIAL_DAMAGE_EFFECT,
  E.FLY_EFFECT, E.ATTACK_TWICE_EFFECT, E.JUMP_KICK_EFFECT, E.RECOIL_EFFECT, E.THRASH_PETAL_DANCE_EFFECT,
  E.TRAPPING_EFFECT,
]);
/** AIMoveChoiceModification1 StatusAilmentMoveEffects */
export const STATUS_AILMENT_MOVE_EFFECTS = Object.freeze([E.EFFECT_01, E.SLEEP_EFFECT, E.POISON_EFFECT, E.PARALYZE_EFFECT]);

/** Move ids the engine compares against (constants/move_constants.asm). */
export const MOVE = Object.freeze({
  POUND: 1, KARATE_CHOP: 2, RAZOR_WIND: 13, WHIRLWIND: 18, FLY: 19, THRASH: 37, TWINEEDLE: 41,
  GROWL: 45, ROAR: 46, SONICBOOM: 49, DISABLE: 50, COUNTER: 68, SEISMIC_TOSS: 69, ABSORB: 71,
  LEECH_SEED: 73, RAZOR_LEAF: 75, SOLARBEAM: 76, PETAL_DANCE: 80, DRAGON_RAGE: 82, THUNDER_WAVE: 86,
  DIG: 91, TOXIC: 92, QUICK_ATTACK: 98, RAGE: 99, TELEPORT: 100, NIGHT_SHADE: 101, MIMIC: 102,
  MINIMIZE: 107, BIDE: 117, METRONOME: 118, MIRROR_MOVE: 119, SELFDESTRUCT: 120, SKULL_BASH: 130,
  AMNESIA: 133, SKY_ATTACK: 143, TRANSFORM: 144, PSYWAVE: 149, SPLASH: 150, CRABHAMMER: 152,
  EXPLOSION: 153, REST: 156, SLASH: 163, SUBSTITUTE: 164, STRUGGLE: 165,
});
export const NUM_ATTACKS = 165;

/** data/battle/critical_hit_moves.asm */
export const HIGH_CRITICAL_MOVES = Object.freeze([MOVE.KARATE_CHOP, MOVE.RAZOR_LEAF, MOVE.CRABHAMMER, MOVE.SLASH]);

/** Non-move animation ids (constants/move_constants.asm, = src/battle_anims/ids.js ANIM). */
export const ANIM = Object.freeze({
  SHOWPIC_ANIM: 0xa6, STATUS_AFFECTED_ANIM: 0xa7, ENEMY_HUD_SHAKE_ANIM: 0xa9, XSTATITEM_ANIM: 0xae,
  XSTATITEM_DUPLICATE_ANIM: 0xaf, SHRINKING_SQUARE_ANIM: 0xb0, BURN_PSN_ANIM: 0xba, SLP_PLAYER_ANIM: 0xbc,
  SLP_ANIM: 0xbd, CONF_PLAYER_ANIM: 0xbe, CONF_ANIM: 0xbf, SLIDE_DOWN_ANIM: 0xc0, TOSS_ANIM: 0xc1,
  SHAKE_ANIM: 0xc2, POOF_ANIM: 0xc3, BLOCKBALL_ANIM: 0xc4, GREATTOSS_ANIM: 0xc5, ULTRATOSS_ANIM: 0xc6,
  SHAKE_SCREEN_ANIM: 0xc7, HIDEPIC_ANIM: 0xc8, ROCK_ANIM: 0xc9, BAIT_ANIM: 0xca,
});

/** Stat names printed by stat-change effects (data/battle/stat_mod_names.asm). */
export const STAT_MOD_NAMES = Object.freeze(['ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL', 'ACCURACY', 'EVADE']);

/** Random thresholds (`n percent` = n*255/100 in rgbds, data/battle/constants.json). */
export const PERCENT = (n) => Math.floor((n * 255) / 100);

/** Badge bits (wObtainedBadges). */
export const BADGE = Object.freeze({
  BOULDER: 0, CASCADE: 1, THUNDER: 2, RAINBOW: 3, SOUL: 4, MARSH: 5, VOLCANO: 6, EARTH: 7,
});

/** Music played by the battle (audio/play_battle_music.asm, core.asm victory routines). */
export const MUSIC = Object.freeze({
  WILD: 'MUSIC_WILD_BATTLE',
  TRAINER: 'MUSIC_TRAINER_BATTLE',
  GYM_LEADER: 'MUSIC_GYM_LEADER_BATTLE',
  FINAL: 'MUSIC_FINAL_BATTLE',
  DEFEATED_WILD: 'MUSIC_DEFEATED_WILD_MON',
  DEFEATED_TRAINER: 'MUSIC_DEFEATED_TRAINER',
  DEFEATED_GYM_LEADER: 'MUSIC_DEFEATED_GYM_LEADER',
  EVOLUTION: 'MUSIC_SAFARI_ZONE', // EvolveMon plays the Safari Zone song
});

/** Party-ball tiles (gfx/battle/balls.png -> OAM $31-$34). */
export const BALL_TILE = Object.freeze({ NORMAL: 0x31, STATUS: 0x32, FAINTED: 0x33, EMPTY: 0x34 });

/** Maps where unidentified ghosts appear (IsGhostBattle: POKEMON_TOWER_1F .. _7F). */
export const POKEMON_TOWER_MAPS = Object.freeze([
  'POKEMON_TOWER_1F', 'POKEMON_TOWER_2F', 'POKEMON_TOWER_3F', 'POKEMON_TOWER_4F',
  'POKEMON_TOWER_5F', 'POKEMON_TOWER_6F', 'POKEMON_TOWER_7F',
]);
/** PrintBeginningBattleText checks POKEMON_TOWER_3F .. _7F for the ghost texts. */
export const POKEMON_TOWER_GHOST_TEXT_MAPS = Object.freeze(POKEMON_TOWER_MAPS.slice(2));

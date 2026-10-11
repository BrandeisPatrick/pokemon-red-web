// Shared overworld constants. Every number is taken from vendor/pokered (routine named in
// the comment) so it can be re-checked against the disassembly.

/** Facing / movement directions, in the GB's D-pad priority order (OverworldLoop checks
 *  DOWN, then UP, LEFT, RIGHT). */
export const DIRECTIONS = Object.freeze(['down', 'up', 'left', 'right']);

/** Step deltas per direction ([dx, dy], in steps / 16 px). */
export const DIR_DELTA = Object.freeze({
  down: Object.freeze([0, 1]),
  up: Object.freeze([0, -1]),
  left: Object.freeze([-1, 0]),
  right: Object.freeze([1, 0]),
});

export const OPPOSITE = Object.freeze({ down: 'up', up: 'down', left: 'right', right: 'left' });

/** wPlayerDirection / collision-data bits (PLAYER_DIR_RIGHT 1, LEFT 2, DOWN 4, UP 8). */
export const DIR_BIT = Object.freeze({ right: 1, left: 2, down: 4, up: 8 });

/** SPRITE_FACING_* values (image index base). */
export const FACING_VALUE = Object.freeze({ down: 0, up: 4, left: 8, right: 12 });

/** LoadSpinnerArrowTiles SpinnerPlayerFacingDirections: the facing shown next while spinning. */
export const SPIN_NEXT = Object.freeze({ down: 'left', up: 'right', left: 'up', right: 'down' });

/** PlayerSpinningFacingOrder (warp pad / teleport spin). */
export const SPIN_ORDER = Object.freeze(['down', 'left', 'up', 'right']);

/** OverworldLoop runs `DelayFrame` twice per iteration (OverworldLoopLessDelay: once). */
export const ITERATION_FRAMES = 2;
/** wWalkCounter: AdvancePlayerSprite iterations per step (2 px each). */
export const WALK_COUNTER_STEPS = 8;
/** TryWalking: x#SPRITESTATEDATA2_WALKANIMATIONCOUNTER = 16 NPC updates (1 px each). */
export const NPC_WALK_UPDATES = 16;
/** UpdateSpriteFacingOffsetAndDelayMovement: movement delay after being talked to. */
export const NPC_TALK_DELAY = 0x7f;
/** IgnoreInputForHalfSecond (wIgnoreInputCounter = 30, counted down every V-blank). */
export const IGNORE_INPUT_FRAMES = 30;
/** EmotionBubble: DelayFrames 60. */
export const EMOTE_FRAMES = 60;
/** SFX_Collision_1_Ch5: one 16-frame note; CollisionCheckOnLand only restarts it once it ended. */
export const COLLISION_SFX_FRAMES = 16;
/** EnterMap: wNumberOfNoRandomBattleStepsLeft after a battle (BIT_WILD_ENCOUNTER_COOLDOWN). */
export const NO_BATTLE_STEPS_AFTER_BATTLE = 3;
/** LoadMapData keeps the LCD off for about two frames (the screen shows blank/white). */
export const LCD_OFF_FRAMES = 2;

/** Player sprite screen position (wSpritePlayerStateData1Y/XPixels = $3c, $40). */
export const PLAYER_SCREEN_X = 0x40;
export const PLAYER_SCREEN_Y = 0x3c;
/** Sprites are drawn 4 px above their 16x16 cell. */
export const SPRITE_Y_OFFSET = -4;
/** LoadHoppingShadowOAM: shadow at OAM ($54, $48) = screen (64, 68). */
export const SHADOW_SCREEN_X = 0x48 - 8;
export const SHADOW_SCREEN_Y = 0x54 - 16;
/** PlayerJumpingYScreenCoords (engine/overworld/player_animations.asm), one per iteration. */
export const LEDGE_JUMP_Y = Object.freeze([0x38, 0x36, 0x34, 0x32, 0x31, 0x30, 0x30, 0x30, 0x31, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3c, 0x3c]);

/** Tile ids hard-coded in the engine. */
export const TILE = Object.freeze({
  WATER: 0x14, // CollisionCheckOnWater / TryDoWildEncounter
  SHORE_EAST: 0x32, // CollisionCheckOnWater (SHIP_PORT: boarding platform)
  SHORE_SAFARI: 0x48,
  SS_ANNE_BOW_WARP: 0x15, // IsSSAnneBowWarpTileInFrontOfPlayer
  STAIRS: 0x15, // CheckForCollisionWhenPushingBoulder
  DOOR_TOP: 0x0b, // PlayMapChangeSound: SFX_GO_INSIDE when the top-left tile is $0b
  FIRST_TEXT_TILE: 0x60, // MAP_TILESET_SIZE: tiles >= $60 are text/window tiles
});

/** Map constants used by engine special cases. */
export const MAP = Object.freeze({
  ROUTE_17: 'ROUTE_17', // Cycling Road: forced DOWN, no speed-up when holding UP/LEFT/RIGHT
  ROCK_TUNNEL_1F: 'ROCK_TUNNEL_1F', // dark (wMapPalOffset = 6) when entered from outside
  POWER_PLANT: 'POWER_PLANT', // CheckPlayerIsInFrontOfSprite bypass (Voltorb "items")
  POKEMON_TOWER_7F: 'POKEMON_TOWER_7F',
  SS_ANNE_BOW: 'SS_ANNE_BOW',
});

/** wMapPalOffset for dark maps: LoadGBPal uses FadePal4 - 6 bytes = FadePal2. */
export const DARK_FADE_STEP = 2;

/** Rival trainer classes leave after battling (SetEnemyTrainerToStayAndFaceAnyDirection). */
export const RIVAL_CLASSES = Object.freeze(['OPP_RIVAL1', 'OPP_RIVAL2', 'OPP_RIVAL3']);

/** Text speed option -> frames per letter (engine TEXT_SPEED fast/medium/slow). */
export const TEXT_SPEED_FRAMES = Object.freeze({ fast: 1, mid: 3, medium: 3, slow: 5 });

/** Walk / bike / surf state (wWalkBikeSurfState). */
export const MODE = Object.freeze({ WALK: 0, BIKE: 1, SURF: 2 });

/** Sentinel a map-script hook can return to ask for the engine's default behaviour. */
export const DEFAULT = Symbol('overworld.default');

// Gen 1 battle screen geometry, read from the disassembly. Tile coordinates are pokered's
// `hlcoord x, y` (20x18 tiles, 8 px each); pixel = tile * 8. The battle engine and the
// animation player both import these so they agree on where everything is.
//
// Sources: engine/battle/core.asm (DrawPlayerHUDAndHPBar, DrawEnemyHUDAndHPBar,
// LoadMonBackPic, LoadPlayerBackPic, SlidePlayerAndEnemySilhouettesOnScreen,
// MoveSelectionMenu), engine/battle/draw_hud_pokeball_gfx.asm (PlacePlayerHUDTiles,
// PlaceEnemyHUDTiles, party balls), engine/battle/animations.asm (DrawFrameBlock,
// GetMonSpriteTileMapPointerFromRowCount, CopyPicTiles), home/pokemon.asm (DrawHPBar),
// engine/pokemon/status_screen.asm (DrawHP), data/text_boxes.asm, constants/hardware.inc.

export const TILE = 8;
export const SCREEN_TILES_W = 20;
export const SCREEN_TILES_H = 18;
export const SCREEN_W = 160;
export const SCREEN_H = 144;

/** PIC_WIDTH = PIC_HEIGHT = 7 tiles; a pic is 49 tiles stored column-major (tile n = column n/7, row n%7). */
export const PIC_TILES_W = 7;
export const PIC_TILES_H = 7;
export const PIC_TILE_COUNT = 49;

/**
 * Enemy front pic box: hlcoord 12, 0 (7x7 tiles = pixels 96..151 x 0..55). Uses BG tiles
 * $00-$30 (vFrontPic). Front pics smaller than 56 px are bottom-aligned and centred at
 * column offset (8 - w/8) >> 1 (LoadUncompressedSpriteData).
 */
export const ENEMY_PIC = Object.freeze({ x: 12, y: 0, w: 7, h: 7, tileBase: 0x00 });
/**
 * Player back pic box: hlcoord 1, 5 (pixels 8..63 x 40..95). Uses BG tiles $31-$61
 * (vBackPic). Back pics are drawn doubled (ScaleSpriteByTwo of the top-left 28x28 of the
 * 32x32 pic) = assets/pokemon/back2x/*.png, 56x56.
 */
export const PLAYER_PIC = Object.freeze({ x: 1, y: 5, w: 7, h: 7, tileBase: 0x31 });

/** Positions the pics take while an animation moves them (AnimationMoveMonHorizontally). */
export const ENEMY_PIC_SHIFTED = Object.freeze({ x: 11, y: 0 });
export const PLAYER_PIC_SHIFTED = Object.freeze({ x: 2, y: 5 });

/**
 * Every tile any pic routine reads or writes lies in one of these rectangles (shake back and
 * forth clears 9 columns, the slide-off routines work on 8, trainer slides on 9).
 */
export const PLAYER_PIC_REGION = Object.freeze({ x: 0, y: 5, w: 9, h: 7 });
export const ENEMY_PIC_REGION = Object.freeze({ x: 11, y: 0, w: 9, h: 7 });

/**
 * Enemy HUD: ClearScreenArea (0,0) 12x4 then name (1,0) (CenterMonName), level at (4,1)
 * (<LV> + digits) or the status text at (5,1), HP bar at (2,2): "HP:" $71 at (2,2), $62 at
 * (3,2), 6 segments (4..9,2), end $6D at (10,2). Frame (PlaceEnemyHUDTiles): $73 at (1,2),
 * corner $74 at (1,3), $76 at (2..9,3), triangle $78 at (10,3). No HP numbers.
 */
export const ENEMY_HUD = Object.freeze({
  x: 0, y: 0, w: 12, h: 4,
  name: { x: 1, y: 0 },
  level: { x: 4, y: 1 },
  status: { x: 5, y: 1 },
  hpBar: { x: 2, y: 2 },
  frame: { bar: { x: 1, y: 2 }, corner: { x: 1, y: 3 }, line: { x: 2, y: 3, len: 8 }, end: { x: 10, y: 3 } },
  tiles: { bar: 0x73, corner: 0x74, line: 0x76, end: 0x78 },
});

/**
 * Player HUD: ClearScreenArea (9,7) 11x5, name (10,7), level (14,8) or status (15,8), HP bar
 * at (10,9) ("HP:" (10,9), $62 (11,9), segments (12..17,9), end $6D at (18,9)), HP numbers
 * "ccc/mmm" at (11,10) (DrawHP prints below the bar: hl + SCREEN_WIDTH + 1). Frame
 * (PlacePlayerHUDTiles): $73 at (18,9) [overwritten by the bar end] and (18,10), corner
 * $77 at (18,11), $76 at (10..17,11), triangle $6F at (9,11).
 */
export const PLAYER_HUD = Object.freeze({
  x: 9, y: 7, w: 11, h: 5,
  name: { x: 10, y: 7 },
  level: { x: 14, y: 8 },
  status: { x: 15, y: 8 },
  hpBar: { x: 10, y: 9 },
  hpNumbers: { x: 11, y: 10 },
  frame: { bar: { x: 18, y: 10 }, corner: { x: 18, y: 11 }, line: { x: 10, y: 11, len: 8 }, end: { x: 9, y: 11 } },
  tiles: { bar: 0x73, corner: 0x77, line: 0x76, end: 0x6f },
});

/** HP bar: 6 tiles x 8 px = 48 px (DrawHPBar, GetHPBarLength). */
export const HP_BAR = Object.freeze({ segments: 6, pixels: 48, label: 0x71, left: 0x62, empty: 0x63, full: 0x6b, endBattle: 0x6d, endParty: 0x6c });

/** Message box (TextBoxCoordTable MESSAGE_BOX): (0,12)-(19,17), text lines at (1,14) and (1,16). */
export const MESSAGE_BOX = Object.freeze({ x: 0, y: 12, w: 20, h: 6, line1: { x: 1, y: 14 }, line2: { x: 1, y: 16 } });
/** FIGHT/PKMN/ITEM/RUN (BATTLE_MENU_TEMPLATE): box (8,12)-(19,17), text at (10,14). */
export const BATTLE_MENU = Object.freeze({ x: 8, y: 12, w: 12, h: 6, text: { x: 10, y: 14 } });
/** Safari menu (SAFARI_BATTLE_MENU_TEMPLATE): box (0,12)-(19,17), text at (2,14). */
export const SAFARI_MENU = Object.freeze({ x: 0, y: 12, w: 20, h: 6, text: { x: 2, y: 14 } });
/** Move list (MoveSelectionMenu .regularmenu): TextBoxBorder at (4,12), 14x4 inside -> (4,12)-(19,17); moves at (6,13). */
export const MOVE_MENU = Object.freeze({ x: 4, y: 12, w: 16, h: 6, text: { x: 6, y: 13 }, cursorX: 5 });
/** Move info box (PrintMenuItem): TextBoxBorder at (0,8), 9x3 inside -> (0,8)-(10,12); "TYPE/" (1,9), type (2,10), PP (5,11)/(8,11). */
export const MOVE_INFO_BOX = Object.freeze({ x: 0, y: 8, w: 11, h: 5 });

/** Party Poké Ball sprites (SetupOwnPartyPokeballs / SetupEnemyPartyPokeballs), OAM coordinates. */
export const PARTY_BALLS = Object.freeze({
  player: { oamX: 0x60, oamY: 0x60, stepX: 8 },
  enemy: { oamX: 0x48, oamY: 0x20, stepX: -8 },
  tiles: { ball: 0x31, status: 0x32, fainted: 0x33, empty: 0x34 },
});

// ---------------------------------------------------------------------------- OAM / PPU

/** OAM coordinate offsets (hardware.inc): screen x = OAM X - 8, screen y = OAM Y - 16. */
export const OAM_X_OFS = 8;
export const OAM_Y_OFS = 16;
export const OAM_COUNT = 40;
export const SPRITES_PER_LINE = 10;
export const OAM_XFLIP = 0x20;
export const OAM_YFLIP = 0x40;
export const OAM_PAL1 = 0x10;
export const OAM_PRIO = 0x80;
/** OAM tile id of tile 0 of the loaded move-animation tileset (LoadMoveAnimationTiles: vSprites tile $31). */
export const ANIM_TILE_BASE = 0x31;
/** DrawFrameBlock mirror constants: Y' = 136 - Y, X' = 168 - X; HFLIP also adds 40 to Y. */
export const MIRROR_Y = 136;
export const MIRROR_X = 168;
export const HFLIP_Y_SHIFT = 40;

/** The battle screen is shown on the WINDOW layer: WX = 7, WY = 0. BG map 0 sits behind it. */
export const WX_NORMAL = 7;
export const WY_NORMAL = 0;

/** BG tile id of the blank tile (' ' = $7F). */
export const BLANK_TILE = 0x7f;

/** Screen tile -> pixel. */
export function tileToPixel(t) {
  return t * TILE;
}

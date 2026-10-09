export const HERMES_SKINS = ['white', 'lavender', 'peach', 'mint', 'sky', 'charcoal', 'butter'] as const;
export const HERMES_PIECES = ['none', 'classic', 'sport', 'explorer'] as const;
export const HERMES_EXPRESSIONS = ['open', 'wink', 'happy'] as const;
// The order is also the paint order: backpack behind the crossbody and bow tie.
export const HERMES_ACCESSORIES = ['backpack', 'crossbody', 'bowtie'] as const;

export type HermesSkin = typeof HERMES_SKINS[number];
export const HERMES_SKIN_COLORS: Record<HermesSkin, string> = {
  lavender: '#CDC5F0', peach: '#F6C9C7', butter: '#FCE0B5',
  mint: '#CDE5E5', sky: '#BED2F8', charcoal: '#444352', white: '#EEE8F7',
};
export type HermesPiece = typeof HERMES_PIECES[number];
export type HermesExpression = typeof HERMES_EXPRESSIONS[number];
export type HermesAccessory = typeof HERMES_ACCESSORIES[number];
export const HERMES_CHARMS = ['beret', 'headphones', 'star', 'moon', 'orbit', 'wings'] as const;
export type HermesCharm = typeof HERMES_CHARMS[number];
export const HERMES_CHARM_SLOT: Record<HermesCharm, string> = {
  beret: 'head', headphones: 'head', star: 'badge', moon: 'badge', orbit: 'antenna', wings: 'back',
};
export type HermesAppearance = {
  version: 1;
  skin: HermesSkin;
  top: HermesPiece;
  hat: HermesPiece;
  shoes: HermesPiece;
  expression: HermesExpression;
  /** Optional for version 1 snapshots saved before multi-accessory support. */
  accessories?: HermesAccessory[];
  /** Soft sprite family. Absence preserves the original version 1 clothing renderer. */
  style?: 'soft' | 'doodle';
  shape?: HermesDoodleShape;
  doodads?: HermesDoodad[];
  drawing?: HermesDrawingStroke[];
  charms?: HermesCharm[];
};

export const DEFAULT_HERMES_APPEARANCE: HermesAppearance = {
  version: 1, skin: 'lavender', top: 'none', hat: 'none', shoes: 'none', expression: 'open', style: 'doodle', shape: 'bean', doodads: [],
};

type HermesLookPieces = Pick<HermesAppearance, 'top' | 'hat' | 'shoes' | 'accessories' | 'style' | 'charms'>;
const softLook = (charms: HermesCharm[]): HermesLookPieces => ({ top: 'none', hat: 'none', shoes: 'none', accessories: [], style: 'soft', charms });
export const HERMES_LOOKS: { id: string; zh: string; en: string; pieces: HermesLookPieces }[] = [
  { id: 'original', zh: '原本的我', en: 'Just me', pieces: softLook([]) },
  { id: 'light', zh: '慢慢逛', en: 'Daydream', pieces: softLook(['beret', 'star']) },
  { id: 'focus', zh: '听听歌', en: 'Tune in', pieces: softLook(['headphones']) },
  { id: 'explore', zh: '追星星', en: 'Stargazer', pieces: softLook(['orbit', 'wings']) },
];

export function getHermesCharms(value: Pick<HermesAppearance, 'style' | 'charms'>): HermesCharm[] {
  return value.style === 'soft' ? HERMES_CHARMS.filter((id) => value.charms?.includes(id)) : [];
}

export function toggleHermesCharm(value: HermesAppearance, charm: HermesCharm): HermesAppearance {
  const current = getHermesCharms(value);
  const charms = current.includes(charm) ? current.filter((id) => id !== charm)
    : [...current.filter((id) => HERMES_CHARM_SLOT[id] !== HERMES_CHARM_SLOT[charm]), charm];
  return { ...value, ...softLook(HERMES_CHARMS.filter((id) => charms.includes(id))) };
}

export const HERMES_ACCESSORY_PIECE: Record<HermesAccessory, Exclude<HermesPiece, 'none'>> = {
  backpack: 'explorer', crossbody: 'sport', bowtie: 'classic',
};

export function getHermesAccessories(value: Pick<HermesAppearance, 'top' | 'accessories'>): HermesAccessory[] {
  const selected = value.accessories;
  if (selected !== undefined) return HERMES_ACCESSORIES.filter((id) => selected.includes(id));
  return HERMES_ACCESSORIES.filter((id) => HERMES_ACCESSORY_PIECE[id] === value.top);
}

export function toggleHermesAccessory(value: HermesAppearance, accessory: HermesAccessory): HermesAppearance {
  const current = getHermesAccessories(value);
  const accessories = HERMES_ACCESSORIES.filter((id) => id === accessory ? !current.includes(id) : current.includes(id));
  return { ...value, accessories, top: accessories[0] ? HERMES_ACCESSORY_PIECE[accessories[0]] : 'none' };
}

export function matchesHermesLook(value: HermesAppearance, pieces: typeof HERMES_LOOKS[number]['pieces']): boolean {
  if (value.style !== pieces.style) return false;
  if (value.style === 'soft') {
    const selected = getHermesCharms(value);
    const expected = getHermesCharms(pieces);
    return selected.length === expected.length && selected.every((id) => expected.includes(id));
  }
  const accessories = getHermesAccessories(value);
  const expected = getHermesAccessories(pieces);
  return value.hat === pieces.hat && value.shoes === pieces.shoes
    && accessories.length === expected.length && accessories.every((id) => expected.includes(id));
}

export function parseHermesAppearance(value: unknown): HermesAppearance | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1
    || !HERMES_SKINS.includes(item.skin as HermesSkin)
    || !HERMES_PIECES.includes(item.top as HermesPiece)
    || !HERMES_PIECES.includes(item.hat as HermesPiece)
    || !HERMES_PIECES.includes(item.shoes as HermesPiece)
    || !HERMES_EXPRESSIONS.includes(item.expression as HermesExpression)) return null;
  if (item.accessories !== undefined && (!Array.isArray(item.accessories)
    || item.accessories.length > HERMES_ACCESSORIES.length
    || item.accessories.some((id) => !HERMES_ACCESSORIES.includes(id as HermesAccessory))
    || new Set(item.accessories).size !== item.accessories.length)) return null;
  if (item.style !== undefined && item.style !== 'soft' && item.style !== 'doodle') return null;
  if (item.skin === 'butter' && item.style !== 'doodle') return null;
  if (item.style === 'doodle') {
    if (!HERMES_DOODLE_SHAPES.includes(item.shape as HermesDoodleShape)
      || !Array.isArray(item.doodads)
      || item.doodads.some((id) => !HERMES_DOODADS.includes(id as HermesDoodad))
      || new Set(item.doodads).size !== item.doodads.length) return null;
    if (item.drawing !== undefined && !isValidHermesDrawing(item.drawing)) return null;
  } else if (item.shape !== undefined || item.doodads !== undefined || item.drawing !== undefined) return null;
  if (item.charms !== undefined) {
    if (item.style !== 'soft' || !Array.isArray(item.charms) || item.charms.length > HERMES_CHARMS.length
      || item.charms.some((id) => !HERMES_CHARMS.includes(id as HermesCharm))
      || new Set(item.charms).size !== item.charms.length) return null;
    const slots = item.charms.map((id) => HERMES_CHARM_SLOT[id as HermesCharm]);
    if (new Set(slots).size !== slots.length) return null;
  }
  return item as HermesAppearance;
}


export const HERMES_DOODLE_SHAPES = ['round', 'bean', 'square', 'drop', 'cloud'] as const;
export type HermesDoodleShape = typeof HERMES_DOODLE_SHAPES[number];
// The seven choices correspond to the real accessories in the homepage cast.
export const HERMES_PLAYFUL_DOODADS = ['headphones', 'wizard-hat', 'bucket-hat', 'star-glasses', 'goggles', 'beret', 'beanie', 'cape', 'scarf', 'record', 'book', 'camera'] as const;
// Older locally saved and remote version-1 appearances remain readable.
export const HERMES_DOODADS = ['glasses', 'leaf', 'cap', 'pencil', 'crown', 'sparkle-cheeks', 'wings', 'bow-tie', 'flower', 'saturn', ...HERMES_PLAYFUL_DOODADS] as const;
export type HermesDoodad = typeof HERMES_DOODADS[number];
export const HERMES_DOODLE_COLORS = ['lavender', 'peach', 'butter', 'mint', 'sky'] as const;

export type HermesDrawingStroke = {
  color: string;
  width: number;
  /** Shape-independent canvas coordinates. */
  points: [number, number][];
};

export const HERMES_DRAWING_LIMITS = {
  maxStrokes: 60,
  maxPointsPerStroke: 300,
  maxTotalPoints: 2400,
  maxSerializedLength: 48000,
  minWidth: 2,
  maxWidth: 30,
  coordinateMax: 1000,
} as const;

export function isValidHermesDrawing(value: unknown): value is HermesDrawingStroke[] {
  if (!Array.isArray(value) || value.length > HERMES_DRAWING_LIMITS.maxStrokes) return false;
  let totalPoints = 0;
  const valid = Array.from(value).every((stroke: unknown) => {
    if (!stroke || typeof stroke !== 'object') return false;
    const item = stroke as Record<string, unknown>;
    if (Object.keys(item).some((key) => !['color', 'width', 'points'].includes(key))
      || typeof item.color !== 'string' || item.color.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(item.color)
      || typeof item.width !== 'number' || !Number.isFinite(item.width)
      || item.width < HERMES_DRAWING_LIMITS.minWidth || item.width > HERMES_DRAWING_LIMITS.maxWidth
      || !Array.isArray(item.points) || item.points.length < 1
      || item.points.length > HERMES_DRAWING_LIMITS.maxPointsPerStroke) return false;
    totalPoints += item.points.length;
    if (totalPoints > HERMES_DRAWING_LIMITS.maxTotalPoints) return false;
    return Array.from(item.points).every((point: unknown) => Array.isArray(point) && point.length === 2
      && Array.from(point).every((coordinate: unknown) => typeof coordinate === 'number' && Number.isFinite(coordinate)
        && coordinate >= 0 && coordinate <= HERMES_DRAWING_LIMITS.coordinateMax));
  });
  return valid && JSON.stringify(value).length <= HERMES_DRAWING_LIMITS.maxSerializedLength;
}

/** Editing an old avatar is an explicit opt-in to the new illustration family. */
export function asDoodleAppearance(value: HermesAppearance): HermesAppearance {
  if (value.style === 'doodle') {
    const replacements: Partial<Record<HermesDoodad, HermesDoodad>> = {
      glasses: 'star-glasses', cap: 'wizard-hat', crown: 'wizard-hat',
    };
    const selected = (value.doodads ?? []).map((id) => replacements[id] ?? id);
    const doodads = HERMES_PLAYFUL_DOODADS.filter((id) => selected.includes(id));
    return { ...value, doodads };
  }
  return { version: 1, style: 'doodle', shape: 'bean', skin: value.skin === 'white' ? 'lavender' : value.skin,
    expression: value.expression, top: 'none', hat: 'none', shoes: 'none', doodads: [] };
}

export function toggleHermesDoodad(value: HermesAppearance, id: HermesDoodad): HermesAppearance {
  const next = asDoodleAppearance(value);
  const selected = next.doodads ?? [];
  const slot = (part: HermesDoodad) => {
    if (['wizard-hat', 'bucket-hat', 'beret', 'beanie', 'goggles'].includes(part)) return 'head';
    if (['cape', 'scarf'].includes(part)) return 'neck';
    if (['book', 'camera', 'record'].includes(part)) return 'hold';
    return part;
  };
  const doodads = selected.includes(id) ? selected.filter((part) => part !== id)
    : [...selected.filter((part) => slot(part) !== slot(id)), id];
  return { ...next, doodads: HERMES_DOODADS.filter((part) => doodads.includes(part)) };
}

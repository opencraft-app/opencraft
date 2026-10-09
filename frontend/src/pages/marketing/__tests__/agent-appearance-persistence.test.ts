import { describe, expect, it } from 'vitest';

import { asDoodleAppearance, DEFAULT_HERMES_APPEARANCE, getHermesAccessories, HERMES_DRAWING_LIMITS, HERMES_PLAYFUL_DOODADS, isValidHermesDrawing, parseHermesAppearance, type HermesAppearance, type HermesDrawingStroke } from '@/lib/hermes-appearance';
import { buildProfileMetaWriteCommand, parseProfileMetaOutput, UI_META_APPEARANCE_KEY } from '@/lib/hermes-profile-meta';
import { buildBuddySetupPlan } from '@/pages/marketing/agent-buddy-setup';

describe('Hermes appearance persistence', () => {
  const appearance: HermesAppearance = { version: 1, style: 'soft', skin: 'mint', hat: 'explorer', top: 'none', shoes: 'none', expression: 'wink' };

  it('reads a saved appearance independently from the legacy avatar', () => {
    const output = `command output\n__LV_META__${JSON.stringify({ displayName: '小助手', ui_meta: {
      lightvela_avatar: 'blob:#C4B0FA', [UI_META_APPEARANCE_KEY]: appearance,
    } })}`;
    expect(parseProfileMetaOutput(output)).toMatchObject({
      displayName: '小助手', avatar: { shapeId: 'blob', color: '#C4B0FA' }, appearance,
    });
    expect(parseProfileMetaOutput(`__LV_META__${JSON.stringify({ ui_meta: { [UI_META_APPEARANCE_KEY]: { ...appearance, skin: 'invalid' } } })}`).appearance).toBeNull();
  });

  it('includes appearance in the required profile metadata step', () => {
    const plan = buildBuddySetupPlan({ profile: { name: '小助手', description: '' }, avatar: { shapeId: 'blob', color: '#C4B0FA' }, appearance, timestamp: '2026-10-03' });
    const meta = plan.find((step) => step.kind === 'profile-meta');
    expect(meta?.required).toBe(true);
    expect(meta?.command).toContain(UI_META_APPEARANCE_KEY);
    const direct = buildProfileMetaWriteCommand({ appearance });
    expect(direct).toContain(UI_META_APPEARANCE_KEY);
  });

  it('round-trips multiple accessories through the profile write payload and reader', () => {
    const mixed: HermesAppearance = { ...appearance, top: 'explorer', accessories: ['backpack', 'crossbody', 'bowtie'] };
    const command = buildProfileMetaWriteCommand({ appearance: mixed });
    const encoded = command.match(/data = json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
    const saved = parseProfileMetaOutput(`__LV_META__${JSON.stringify({ ui_meta: { [UI_META_APPEARANCE_KEY]: written.appearance } })}`);
    expect(saved.appearance).toEqual(mixed);
  });

  it('keeps legacy single accessories and respects an explicitly empty multi-selection', () => {
    const legacy = { ...appearance, style: undefined, charms: undefined, top: 'classic' as const };
    expect(parseHermesAppearance(legacy)).toEqual(legacy);
    expect(getHermesAccessories(legacy)).toEqual(['bowtie']);
    expect(getHermesAccessories({ ...legacy, accessories: [] })).toEqual([]);
  });

  it.each([null, 'bowtie', ['unknown'], ['bowtie', 'bowtie']])('rejects an invalid accessory collection: %j', (accessories) => {
    expect(parseHermesAppearance({ ...appearance, accessories })).toBeNull();
  });

  it('round-trips the new sprite family and all four independent slots through the real profile payload', () => {
    const mixed: HermesAppearance = { ...appearance, skin: 'charcoal', expression: 'happy', charms: ['beret', 'moon', 'orbit', 'wings'] };
    const command = buildProfileMetaWriteCommand({ appearance: mixed });
    const encoded = command.match(/data = json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    const written = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
    const saved = parseProfileMetaOutput(`__LV_META__${JSON.stringify({ ui_meta: { [UI_META_APPEARANCE_KEY]: written.appearance } })}`);
    expect(saved.appearance).toEqual(mixed);
  });

  it.each([null, 'star', ['unknown'], ['star', 'star'], ['star', 'moon'], ['beret', 'headphones']])('rejects malformed or conflicting charms: %j', (charms) => {
    expect(parseHermesAppearance({ ...appearance, charms })).toBeNull();
  });
});


describe('Doodle profile metadata', () => {
  it('round-trips shape, butter color, expression and all five accessories through the real payload', () => {
    const appearance: HermesAppearance = { ...DEFAULT_HERMES_APPEARANCE, shape: 'cloud', skin: 'butter', expression: 'wink', doodads: ['glasses', 'scarf', 'leaf', 'cap', 'pencil'] };
    const command = buildProfileMetaWriteCommand({ appearance });
    const encoded = command.match(/data = json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    const written = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
    expect(parseProfileMetaOutput(`__LV_META__${JSON.stringify({ ui_meta: { [UI_META_APPEARANCE_KEY]: written.appearance } })}`).appearance).toEqual(appearance);
  });
  it.each([{ shape: 'unknown' }, { doodads: ['unknown'] }, { doodads: ['cap', 'cap'] }, { doodads: null }, { style: 'soft' }])('rejects invalid doodle metadata %j', (patch) => {
    expect(parseHermesAppearance({ ...DEFAULT_HERMES_APPEARANCE, ...patch })).toBeNull();
  });

  it.each(['white', 'charcoal'] as const)('keeps legacy %s readable but converts it to a visible editing colour', (skin) => {
    for (const style of [undefined, 'soft', 'doodle'] as const) {
      const old: HermesAppearance = { version: 1, skin, style, expression: 'open', top: 'none', hat: 'none', shoes: 'none', ...(style === 'doodle' ? { shape: 'bean', doodads: [] } : {}) };
      expect(parseHermesAppearance(old)?.skin).toBe(skin);
      expect(asDoodleAppearance(old).skin).toBe('lavender');
      expect(old.skin).toBe(skin);
    }
  });

  it('uses the playful family for new avatars and explicitly converts older doodles only when edited', () => {
    expect(HERMES_PLAYFUL_DOODADS).toEqual(['headphones', 'wizard-hat', 'bucket-hat', 'star-glasses', 'goggles', 'beret', 'beanie', 'cape', 'scarf', 'record', 'book', 'camera']);
    expect(DEFAULT_HERMES_APPEARANCE.doodads).toEqual([]);
    const legacy: HermesAppearance = { version: 1, skin: 'white', top: 'classic', hat: 'sport', shoes: 'explorer', expression: 'wink' };
    expect(parseHermesAppearance(legacy)).toEqual(legacy);
    expect(asDoodleAppearance(legacy)).toMatchObject({ version: 1, style: 'doodle', skin: 'lavender', doodads: [] });
    const oldDoodle: HermesAppearance = { ...DEFAULT_HERMES_APPEARANCE, doodads: ['glasses', 'scarf', 'leaf', 'cap', 'pencil', 'crown', 'wings'], drawing: [{ color: '#Aa00Ff', width: 10, points: [[1, 2]] }] };
    expect(parseHermesAppearance(oldDoodle)).toEqual(oldDoodle);
    expect(asDoodleAppearance(oldDoodle)).toEqual({ ...oldDoodle, doodads: ['wizard-hat', 'star-glasses', 'scarf'] });
    expect(oldDoodle.doodads).toContain('pencil');
  });
});

describe('Doodle freehand drawing contract', () => {
  const stroke: HermesDrawingStroke = { color: '#Ab12fF', width: 12, points: [[0, 0], [450.5, 670.25], [1000, 1000]] };
  const points = (count: number): [number, number][] => Array.from({ length: count }, () => [500, 500]);

  it('round-trips all playful doodads and drawing through the profile payload at version 1', () => {
    const appearance: HermesAppearance = { ...DEFAULT_HERMES_APPEARANCE, doodads: [...HERMES_PLAYFUL_DOODADS], drawing: [stroke, { color: '#000000', width: 2, points: [[10, 20]] }] };
    const command = buildProfileMetaWriteCommand({ appearance });
    const encoded = command.match(/data = json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"\)/)?.[1];
    expect(encoded).toBeTruthy();
    const written = JSON.parse(Buffer.from(encoded!, 'base64').toString('utf8'));
    const saved = parseProfileMetaOutput(`__LV_META__${JSON.stringify({ ui_meta: { [UI_META_APPEARANCE_KEY]: written.appearance } })}`);
    expect(saved.appearance).toEqual(appearance);
    expect(saved.appearance?.version).toBe(1);
  });

  it('accepts legacy snapshots without drawing and empty drawings, only for doodle avatars', () => {
    expect(parseHermesAppearance(DEFAULT_HERMES_APPEARANCE)).toEqual(DEFAULT_HERMES_APPEARANCE);
    expect(parseHermesAppearance({ ...DEFAULT_HERMES_APPEARANCE, drawing: [] })?.drawing).toEqual([]);
    for (const style of [undefined, 'soft'] as const) {
      const legacy = { version: 1, skin: 'mint', top: 'none', hat: 'none', shoes: 'none', expression: 'open', style };
      expect(parseHermesAppearance(legacy)).toEqual(legacy);
      expect(parseHermesAppearance({ ...legacy, drawing: [] })).toBeNull();
    }
  });

  it.each([
    ['NaN coordinate', { points: [[Number.NaN, 0]] }],
    ['infinite coordinate', { points: [[0, Number.POSITIVE_INFINITY]] }],
    ['negative coordinate', { points: [[-0.01, 0]] }],
    ['oversize coordinate', { points: [[0, 1000.01]] }],
    ['string coordinate', { points: [['12', 0]] }],
    ['missing coordinate', { points: [[12]] }],
    ['extra coordinate', { points: [[1, 2, 3]] }],
    ['no points', { points: [] }],
    ['null points', { points: null }],
    ['sparse points', { points: new Array(1) }],
    ['NaN width', { width: Number.NaN }],
    ['infinite width', { width: Number.NEGATIVE_INFINITY }],
    ['small width', { width: 1.99 }],
    ['large width', { width: 30.01 }],
    ['string width', { width: '12' }],
    ['short color', { color: '#fff' }],
    ['named color', { color: 'red' }],
    ['alpha color', { color: '#123456ff' }],
    ['invalid hex color', { color: '#12345z' }],
    ['color suffix', { color: '#123456\n' }],
    ['extra fields', { extra: 'unsupported' }],
  ])('rejects %s before persistence', (_label, patch) => {
    const drawing = [{ ...stroke, ...patch }];
    expect(isValidHermesDrawing(drawing)).toBe(false);
    expect(parseHermesAppearance({ ...DEFAULT_HERMES_APPEARANCE, drawing })).toBeNull();
  });

  it.each([null, 'drawing', {}, [null], new Array(1)])('rejects a malformed drawing collection %j', (drawing) => {
    expect(isValidHermesDrawing(drawing)).toBe(false);
    expect(parseHermesAppearance({ ...DEFAULT_HERMES_APPEARANCE, drawing })).toBeNull();
  });

  it('accepts inclusive limits while rejecting excessive strokes and points', () => {
    expect(isValidHermesDrawing([{ ...stroke, width: 2 }, { ...stroke, width: 30 }])).toBe(true);
    expect(isValidHermesDrawing(Array.from({ length: HERMES_DRAWING_LIMITS.maxStrokes }, () => ({ ...stroke, points: [[0, 0]] })))).toBe(true);
    expect(isValidHermesDrawing(Array.from({ length: HERMES_DRAWING_LIMITS.maxStrokes + 1 }, () => stroke))).toBe(false);
    expect(isValidHermesDrawing([{ ...stroke, points: points(HERMES_DRAWING_LIMITS.maxPointsPerStroke) }])).toBe(true);
    expect(isValidHermesDrawing([{ ...stroke, points: points(HERMES_DRAWING_LIMITS.maxPointsPerStroke + 1) }])).toBe(false);
    const full = Array.from({ length: 8 }, () => ({ ...stroke, points: points(300) }));
    expect(isValidHermesDrawing(full)).toBe(true);
    expect(isValidHermesDrawing([...full, { ...stroke, points: [[0, 0]] }])).toBe(false);
  });

  it('rejects a serialized drawing that exceeds the profile-safe size budget', () => {
    const drawing = Array.from({ length: 8 }, () => ({ ...stroke, points: Array.from({ length: 300 }, (): [number, number] => [123.12345678901234, 456.98765432109876]) }));
    expect(JSON.stringify(drawing).length).toBeGreaterThan(HERMES_DRAWING_LIMITS.maxSerializedLength);
    expect(isValidHermesDrawing(drawing)).toBe(false);
    expect(parseHermesAppearance({ ...DEFAULT_HERMES_APPEARANCE, drawing })).toBeNull();
  });
});

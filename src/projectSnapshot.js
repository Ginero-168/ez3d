export const PROJECT_SCHEMA = 'ez3d.project';
export const PROJECT_VERSION = 1;

export function isProjectSnapshot(snapshot) {
  return snapshot?.schema === PROJECT_SCHEMA;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function vector3(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value)) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
  ];
}

function euler(value) {
  const rotation = vector3(value, [0, 0, 0]);
  const order = ['XYZ', 'YZX', 'ZXY', 'XZY', 'YXZ', 'ZYX'].includes(value?.[3]) ? value[3] : 'XYZ';
  return [...rotation, order];
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 240) : fallback;
}

function color(value, fallback = null) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

function clampPositive(value, fallback = 1, min = 0.001) {
  return Math.max(min, finiteNumber(value, fallback));
}

export function normalizeProjectSnapshot(snapshot) {
  if (!isProjectSnapshot(snapshot)) return null;

  const width = Math.max(1, Math.min(500, Math.round(finiteNumber(snapshot.space?.width, 15))));
  const length = Math.max(1, Math.min(500, Math.round(finiteNumber(snapshot.space?.length, 15))));
  const allowedObjectTypes = new Set(['backdrop', 'table', 'bookshelf', 'cashier', 'rollup', 'custom']);
  const allowedLightTypes = new Set(['ambient', 'hemisphere', 'directional', 'point', 'spot']);

  const objects = (Array.isArray(snapshot.objects) ? snapshot.objects : [])
    .filter(item => allowedObjectTypes.has(item?.type))
    .map(item => ({
      type: item.type,
      name: text(item.name, item.type),
      position: vector3(item.position),
      rotation: euler(item.rotation),
      scale: vector3(item.scale, [1, 1, 1]).map(v => clampPositive(v)),
      color: color(item.color),
      modelAssetId: text(item.modelAssetId),
      modelFileName: text(item.modelFileName, item.name || ''),
      format: text(item.format),
      baseDims: item.baseDims && typeof item.baseDims === 'object'
        ? {
            w: clampPositive(item.baseDims.w),
            h: clampPositive(item.baseDims.h),
            d: clampPositive(item.baseDims.d),
          }
        : null,
    }))
    .filter(item => item.type !== 'custom' || item.modelAssetId);

  const lights = (Array.isArray(snapshot.lights) ? snapshot.lights : [])
    .filter(item => allowedLightTypes.has(item?.type))
    .map(item => ({
      type: item.type,
      name: text(item.name, item.type),
      props: item.props && typeof item.props === 'object' ? { ...item.props } : {},
    }));

  const carpetTileCount = width * length;
  const carpet = (Array.isArray(snapshot.carpet) ? snapshot.carpet : [])
    .slice(0, carpetTileCount)
    .map(value => color(value, '#27272a'));
  while (carpet.length < carpetTileCount) carpet.push('#27272a');

  const comments = (Array.isArray(snapshot.comments) ? snapshot.comments : [])
    .map(pin => ({
      id: Math.max(1, Math.round(finiteNumber(pin?.id, 0))),
      position: vector3(pin?.position),
      text: text(pin?.text, '').slice(0, 1000),
    }))
    .filter(pin => pin.id > 0);

  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    savedAt: text(snapshot.savedAt, new Date().toISOString()),
    metadata: createSnapshotMetadata({ objects, lights, comments, carpet }),
    space: { width, length },
    settings: {
      gridSnapEnabled: snapshot.settings?.gridSnapEnabled !== false,
      gridSnapSize: clampPositive(snapshot.settings?.gridSnapSize, 0.5, 0.05),
      guidesVisible: snapshot.settings?.guidesVisible !== false,
      isLightMode: snapshot.settings?.isLightMode === true,
    },
    objects,
    lights,
    carpet,
    comments,
  };
}

export function createSnapshotMetadata({ objects, lights, comments, carpet }) {
  return {
    objectCount: objects.length,
    lightCount: lights.length,
    commentCount: comments.length,
    carpetTileCount: carpet.length,
  };
}

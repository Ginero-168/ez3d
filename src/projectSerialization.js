import { PROJECT_SCHEMA, PROJECT_VERSION, createSnapshotMetadata } from './projectSnapshot.js';

function serializeVec3(v) {
  return [v.x, v.y, v.z];
}

function serializeEuler(e) {
  return [e.x, e.y, e.z, e.order];
}

function getObjectColor(obj) {
  const target = obj.userData.targetColorMesh || obj;
  if (target.isMesh && !Array.isArray(target.material) && target.material?.color) {
    return `#${target.material.color.getHexString()}`;
  }

  let hex = null;
  target.traverse?.(child => {
    if (!hex && child.isMesh && !Array.isArray(child.material) && child.material?.color) {
      hex = `#${child.material.color.getHexString()}`;
    }
  });
  return hex;
}

function serializeObject(obj) {
  const type = obj.userData?.type;
  if (type === 'custom') {
    if (!obj.userData.modelAssetId) return null;
    return {
      type,
      name: obj.name,
      position: serializeVec3(obj.position),
      rotation: serializeEuler(obj.rotation),
      scale: serializeVec3(obj.scale),
      modelAssetId: obj.userData.modelAssetId,
      modelFileName: obj.userData.modelFileName || obj.name,
      format: obj.userData.format || null,
      baseDims: obj.userData.baseDims || null,
    };
  }

  if (!['backdrop', 'table', 'bookshelf', 'cashier', 'rollup'].includes(type)) return null;
  return {
    type,
    name: obj.name,
    position: serializeVec3(obj.position),
    rotation: serializeEuler(obj.rotation),
    scale: serializeVec3(obj.scale),
    color: getObjectColor(obj),
  };
}

function serializeLight(entry, getLightProps) {
  return {
    type: entry.type,
    name: entry.name,
    props: getLightProps(entry),
  };
}

function serializePin(pin) {
  return {
    id: pin.id,
    position: serializeVec3(pin.position),
    text: pin.text || '',
  };
}

export function createProjectSnapshotFromState({
  draggableObjects,
  sceneLights,
  floorTiles,
  commentPins,
  spaceWidth,
  spaceLength,
  gridSnapEnabled,
  gridSnapSize,
  guidesVisible,
  isLightMode,
  getLightProps,
}) {
  const objects = draggableObjects.map(serializeObject).filter(Boolean);
  const lights = sceneLights.map(entry => serializeLight(entry, getLightProps));
  const carpet = floorTiles.map(tile => tile.color);
  const comments = commentPins.filter(pin => !pin.isEditing).map(serializePin);

  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    metadata: createSnapshotMetadata({ objects, lights, comments, carpet }),
    space: { width: spaceWidth, length: spaceLength },
    settings: {
      gridSnapEnabled,
      gridSnapSize,
      guidesVisible,
      isLightMode,
    },
    objects,
    lights,
    carpet,
    comments,
  };
}

export function getLightProps(entry) {
  const light = entry.light;
  return {
    name: entry.name,
    color: `#${light.color.getHexString()}`,
    intensity: light.intensity,
    visible: light.visible,
    castShadow: light.castShadow,
    posX: light.position?.x ?? 0,
    posY: light.position?.y ?? 0,
    posZ: light.position?.z ?? 0,
    tgtX: light.target?.position.x ?? 0,
    tgtY: light.target?.position.y ?? 0,
    tgtZ: light.target?.position.z ?? 0,
    angle: light.angle,
    penumbra: light.penumbra,
    distance: light.distance,
    skyColor: entry.type === 'hemisphere' ? `#${light.color.getHexString()}` : null,
    groundColor: entry.type === 'hemisphere' ? `#${light.groundColor?.getHexString()}` : null,
  };
}

export function applyLightProps(entry, props) {
  const light = entry.light;
  if (props.name !== undefined) entry.name = props.name;
  if (props.color !== undefined) light.color.set(props.color);
  if (props.intensity !== undefined) light.intensity = props.intensity;
  if (props.visible !== undefined) light.visible = props.visible;
  if (props.castShadow !== undefined) light.castShadow = props.castShadow;
  if (props.posX !== undefined && light.position) light.position.set(props.posX, props.posY, props.posZ);
  if (props.tgtX !== undefined && light.target) light.target.position.set(props.tgtX, props.tgtY, props.tgtZ);
  if (props.angle !== undefined) light.angle = props.angle;
  if (props.penumbra !== undefined) light.penumbra = props.penumbra;
  if (props.distance !== undefined) light.distance = props.distance;
  if (props.groundColor && light.groundColor) light.groundColor.set(props.groundColor);
}

export function lightPropsChanged(prev, next) {
  return JSON.stringify(prev) !== JSON.stringify(next);
}

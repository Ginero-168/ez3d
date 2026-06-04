export const PROJECT_SCHEMA = 'ez3d.project';
export const PROJECT_VERSION = 1;

export function isProjectSnapshot(snapshot) {
  return snapshot?.schema === PROJECT_SCHEMA;
}

export function createSnapshotMetadata({ objects, lights, comments, carpet }) {
  return {
    objectCount: objects.length,
    lightCount: lights.length,
    commentCount: comments.length,
    carpetTileCount: carpet.length,
  };
}

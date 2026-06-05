import JSZip from 'jszip';
import { getModelAsset, saveModelAssetRecord } from './modelAssetStore.js';
import { isProjectSnapshot, normalizeProjectSnapshot } from './projectSnapshot.js';

const PROJECT_FILE = 'project.json';
const ASSET_MANIFEST_FILE = 'assets/manifest.json';

function safeAssetName(name) {
  return (name || 'model.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function customAssetIds(snapshot) {
  return [...new Set(
    (snapshot.objects || [])
      .filter(obj => obj.type === 'custom' && obj.modelAssetId)
      .map(obj => obj.modelAssetId)
  )];
}

export async function createProjectBundleBlob(snapshot) {
  if (!isProjectSnapshot(snapshot)) throw new Error('Invalid Ez3d project snapshot.');

  const zip = new JSZip();
  const manifest = [];

  zip.file(PROJECT_FILE, JSON.stringify(snapshot, null, 2));

  for (const id of customAssetIds(snapshot)) {
    const record = await getModelAsset(id);
    if (!record?.blob) continue;
    const path = `assets/${id}/${safeAssetName(record.name)}`;
    manifest.push({
      id,
      path,
      name: record.name,
      type: record.type,
      size: record.size,
      format: record.format,
      savedAt: record.savedAt,
    });
    zip.file(path, record.blob);
  }

  zip.file(ASSET_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function loadProjectBundleFile(file) {
  const zip = await JSZip.loadAsync(file);
  const projectEntry = zip.file(PROJECT_FILE);
  if (!projectEntry) throw new Error('Missing project.json in Ez3d bundle.');

  const snapshot = normalizeProjectSnapshot(JSON.parse(await projectEntry.async('string')));
  if (!snapshot) throw new Error('Invalid Ez3d project snapshot.');

  const manifestEntry = zip.file(ASSET_MANIFEST_FILE);
  const manifest = manifestEntry ? JSON.parse(await manifestEntry.async('string')) : [];

  for (const asset of manifest) {
    const assetEntry = zip.file(asset.path);
    if (!assetEntry) continue;
    const blob = await assetEntry.async('blob');
    await saveModelAssetRecord({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      size: asset.size || blob.size,
      format: asset.format,
      savedAt: asset.savedAt,
      blob,
    });
  }

  return snapshot;
}

import JSZip from 'jszip';
import { getModelAsset, saveModelAssetRecord } from './modelAssetStore.js';
import { isProjectSnapshot, normalizeProjectSnapshot } from './projectSnapshot.js';

const PROJECT_FILE = 'project.json';
const ASSET_MANIFEST_FILE = 'assets/manifest.json';

function safeAssetName(name) {
  return (name || 'model.bin').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function assetFiles(record) {
  if (Array.isArray(record?.files) && record.files.length) {
    return record.files.filter(file => file?.blob);
  }
  if (record?.blob) {
    return [{
      name: record.name,
      path: record.name,
      type: record.type,
      size: record.size,
      blob: record.blob,
      isMain: true,
    }];
  }
  return [];
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
    const files = assetFiles(record);
    if (!files.length) continue;
    const manifestFiles = [];
    files.forEach((file, index) => {
      const path = `assets/${id}/${index}-${safeAssetName(file.path || file.name)}`;
      manifestFiles.push({
        path,
        name: file.name,
        relativePath: file.path || file.name,
        type: file.type,
        size: file.size,
        isMain: file.isMain || file.name === record.mainFileName || file.name === record.name,
      });
      zip.file(path, file.blob);
    });
    manifest.push({
      id,
      name: record.name,
      type: record.type,
      size: record.size,
      format: record.format,
      mainFileName: record.mainFileName || record.name,
      savedAt: record.savedAt,
      files: manifestFiles,
    });
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
    const files = [];
    const manifestFiles = Array.isArray(asset.files) && asset.files.length
      ? asset.files
      : [{ path: asset.path, name: asset.name, relativePath: asset.name, type: asset.type, size: asset.size, isMain: true }];
    for (const file of manifestFiles) {
      const assetEntry = zip.file(file.path);
      if (!assetEntry) continue;
      files.push({
        name: file.name,
        path: file.relativePath || file.name,
        type: file.type,
        size: file.size,
        isMain: file.isMain,
        blob: await assetEntry.async('blob'),
      });
    }
    if (!files.length) continue;
    await saveModelAssetRecord({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      size: asset.size || files.reduce((total, file) => total + file.blob.size, 0),
      format: asset.format,
      mainFileName: asset.mainFileName || asset.name,
      savedAt: asset.savedAt,
      blob: files.find(file => file.isMain)?.blob || files[0].blob,
      files,
    });
  }

  return snapshot;
}

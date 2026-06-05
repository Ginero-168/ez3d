import { createProjectBundleBlob, loadProjectBundleFile } from './projectBundle.js';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), {
    download: filename,
    href: url,
  });
  link.click();
  URL.revokeObjectURL(url);
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function downloadProjectJson(snapshot, filename) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

export async function downloadProjectZip(snapshot, filename) {
  const blob = await createProjectBundleBlob(snapshot);
  downloadBlob(blob, filename);
}

export async function readProjectFileSnapshot(file) {
  if (/\.zip$/i.test(file.name)) {
    return loadProjectBundleFile(file);
  }
  return JSON.parse(await readTextFile(file));
}

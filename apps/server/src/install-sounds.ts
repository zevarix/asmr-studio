import { openStudio, studioDataRoot } from './runtime.js';

const studio = openStudio(studioDataRoot());
try {
  const assets = await studio.starterLibrary.install();
  console.log(`Ready: ${assets.length} starter sounds.`);
} finally { studio.store.close(); }

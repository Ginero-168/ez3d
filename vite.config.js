import { defineConfig } from 'vite';

export default defineConfig({
  // Sets asset paths to relative (./) instead of absolute (/)
  // This ensures assets load correctly on Hostinger, subdomains, or subdirectories
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/examples/jsm/controls')) return 'three-controls';
          if (id.includes('node_modules/three/examples/jsm/loaders')) return 'three-loaders';
          if (id.includes('node_modules/three')) return 'three-core';
        },
      },
    },
  }
});

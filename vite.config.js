import { defineConfig } from 'vite';

export default defineConfig({
  // Sets asset paths to relative (./) instead of absolute (/)
  // This ensures assets load correctly on Hostinger, subdomains, or subdirectories
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
});

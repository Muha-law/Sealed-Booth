import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/, so assets must be relative.
  base: './',
  root: 'web',
  // `public/` sits at the repo root, not under web/, because the keeper writes
  // pool.json into it and Vite copies the whole directory into the build
  // verbatim. pool.json is gitignored: it only ever exists in the artifact.
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});

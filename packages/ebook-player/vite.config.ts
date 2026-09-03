import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// publicDir carries the built exemplar EPUB (scripts/build-exemplar.mjs writes it there before
// `vite build` runs), so it ships alongside the reader at /modules/ebook-player/exemplar/.
export default defineConfig({ root: "src", base: "./", publicDir: "../public", plugins: [react()], build: { outDir: "../dist", emptyOutDir: true } });

import {defineConfig} from "vite";
// Relative asset URLs, so the built shell serves under a path prefix as well as at an origin root.
export default defineConfig({root:"src",base:"./",build:{outDir:"../dist",emptyOutDir:true}});

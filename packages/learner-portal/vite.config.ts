import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
// `base` is relative so one built bundle works wherever it is mounted: at the root of its own
// static origin, or under a path prefix when the LORB app process serves it. Absolute asset
// URLs would resolve to the origin root and 404 under a prefix.
export default defineConfig({root,base:'./',plugins:[react()],server:{port:5174},test:{root,environment:'node',setupFiles:'./src/test-setup.ts'}});

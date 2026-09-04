import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// `base` is relative so one built bundle works wherever it is mounted: at the root of its own
// static origin, or under a path prefix when the LORB app process serves it. Absolute asset
// URLs would resolve to the origin root and 404 under a prefix.
export default defineConfig({base:'./',plugins:[react()],server:{port:5173},test:{environment:'jsdom',setupFiles:['./src/test-setup.ts']}});

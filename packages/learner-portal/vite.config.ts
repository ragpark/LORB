import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({root,plugins:[react()],server:{port:5174},test:{root,environment:'node',setupFiles:'./src/test-setup.ts'}});

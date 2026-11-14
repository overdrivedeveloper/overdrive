import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The wallet flow reads the committed deployment files in ../app/deployments.
  server: {fs: {allow: ['..']}},
});

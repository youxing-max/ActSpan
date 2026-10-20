import { defineConfig } from 'vite';
import { resolve } from 'path';
import packageJson from './package.json';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // mcp.html 必须落在扩展根目录：运行时按 url:'mcp.html' 创建 offscreen 文档，
  // 以项目根为 root 时 Vite 会保留 src/offscreen/ 前缀，产物就永远找不到。
  root: resolve(__dirname, 'src/offscreen'),
  base: './',
  define: {
    'process.env': {},
    'process.env.APP_VERSION': JSON.stringify(packageJson.version),
  },
  build: {
    emptyOutDir: false,
    outDir: resolve(__dirname, 'build_version', packageJson.name),
    rollupOptions: {
      input: resolve(__dirname, 'src/offscreen/mcp.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3210',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader('Origin', 'http://127.0.0.1:3210');
            }
          });
        },
      },
    },
  },
  build: { target: 'es2022' },
});

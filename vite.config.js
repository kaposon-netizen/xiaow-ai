import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/anthropic/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        }
      },
      '/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/deepseek/, '')
      },
      '/qwen': {
        target: 'https://dashscope.aliyuncs.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/qwen/, '')
      },
      '/zhipu': {
        target: 'https://open.bigmodel.cn',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/zhipu/, '')
      },
      '/kimi': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/kimi/, '')
      },
      '/minimax': {
        target: 'https://api.minimax.chat',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/minimax/, '')
      },
      '/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/gemini/, '')
      },
    }
  }
})

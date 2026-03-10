import express from 'express';
import cors from 'cors';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// 将 Node.js 的 fetch 流量导向本地代理（Clash 默认端口 7897）
const proxyAgent = new ProxyAgent('http://127.0.0.1:7897');
setGlobalDispatcher(proxyAgent);

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { apiKey, messages, system } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system,
        messages, // 直接透传，前端负责构造包含图片的消息格式
        stream: true,
      }),
    });

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 逐块转发流式数据
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }

    res.end();
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { apiKey, messages } = req.body;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages,
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

app.listen(3001, () => console.log('✅ Proxy server running on http://localhost:3001'));

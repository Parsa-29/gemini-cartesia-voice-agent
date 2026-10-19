import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { WS_PATH } from '../shared/protocol.js';
import { handleBrowserSocket } from './browserSocket.js';
import type { AppConfig } from './config.js';
import { createVoiceSession, publicConfig } from './createSession.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DIST = join(ROOT, 'dist', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

/**
 * One HTTP server on one port: the web UI (Vite middleware in dev, `dist/web`
 * in production), `GET /api/config`, and the call WebSocket on `/ws`.
 */
export async function startServer(config: AppConfig, options: { port?: number; serveWeb?: boolean } = {}): Promise<RunningServer> {
  const serveWeb = options.serveWeb ?? true;
  let sessionCount = 0;

  const server = createServer();
  const vite =
    serveWeb && config.dev
      ? await (await import('vite')).createServer({
          configFile: join(ROOT, 'vite.config.ts'),
          server: { middlewareMode: true, hmr: { server } },
          appType: 'spa',
        })
      : null;

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(publicConfig(config)));
      return;
    }
    if (vite) {
      vite.middlewares(req, res);
      return;
    }
    if (serveWeb) {
      void serveStatic(req, res);
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      if (!vite) socket.destroy(); // in dev, Vite's HMR socket shares this server
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const id = ++sessionCount;
      const log = (message: string): void => console.log(`${new Date().toISOString()} [call ${id}] ${message}`);
      log('connected');
      handleBrowserSocket(ws, (overrides, output) => createVoiceSession(config, overrides, output, log), log);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? config.port, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : config.port);
    });
  });

  return {
    port,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await vite?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(WEB_DIST, relative);
  if (!file.startsWith(WEB_DIST + sep) && file !== WEB_DIST) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) file = join(WEB_DIST, 'index.html');
  } catch {
    file = join(WEB_DIST, 'index.html'); // SPA fallback
  }
  try {
    await stat(file);
  } catch {
    res.writeHead(404).end('Not built. Run `npm run build` first.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

import { startServer } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const server = await startServer(config);
  console.log(
    `Voice agent ready → http://localhost:${server.port}  (${config.gemini.model} + ${config.cartesia.model}, ${config.dev ? 'dev' : 'production'})`,
  );

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createZipLinkApp } from './src/server/app.ts';

async function startServer() {
  const { app, config, storage, previewStore } = await createZipLinkApp();

  // Initial expired share + temporary preview sweep + scheduled background cleanup
  await Promise.all([
    storage.purgeExpiredShares().catch((err) => {
      console.error('[ZipLink] Initial share cleanup error:', err instanceof Error ? err.message : err);
    }),
    previewStore.purgeExpiredPreviews().catch((err) => {
      console.error('[ZipLink] Initial preview cleanup error:', err instanceof Error ? err.message : err);
    }),
  ]);

  const cleanupTimer = setInterval(() => {
    storage.purgeExpiredShares().catch((err) => {
      console.error('[ZipLink] Scheduled share cleanup error:', err instanceof Error ? err.message : err);
    });
    previewStore.purgeExpiredPreviews().catch((err) => {
      console.error('[ZipLink] Scheduled preview cleanup error:', err instanceof Error ? err.message : err);
    });
  }, config.cleanupIntervalMs);
  cleanupTimer.unref();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { index: false }));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[ZipLink] Listening on http://0.0.0.0:${config.port} (storage=${storage.driverName})`,
    );
  });
}

startServer().catch((err) => {
  console.error('[ZipLink] Failed to start server:', err);
  process.exit(1);
});

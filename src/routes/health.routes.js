import { Router } from 'express';
import { prisma } from '../../prisma/PrismaClient.js';

const router = Router();

router.get('/live', (_req, res) => {
  res.json({ status: 'ok', service: 'unico-integra-backend' });
});

router.get('/ready', async (_req, res) => {
  try {
    await Promise.race([
      prisma.$queryRawUnsafe('SELECT 1'),
      new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new Error('database timeout')), 3000);
        timeout.unref();
      }),
    ]);
    return res.json({ status: 'ready', database: 'ok' });
  } catch {
    return res.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
});

export default router;

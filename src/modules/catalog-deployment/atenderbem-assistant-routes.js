import { Router } from 'express';
import { prisma } from '../../../prisma/PrismaClient.js';
import { apiKeyMiddleware } from '../../middlewares/apiKey.middleware.js';
import { createMcpClient } from './adapters/mcp.client.js';
import { decryptSecret } from './crypto.js';
import { catalogTargets } from './targets.js';
import { publicError } from './errors.js';
import { assistantInstaller } from './atenderbem-assistant.js';

const router = Router({ mergeParams: true });
router.use(apiKeyMiddleware);
const service = assistantInstaller({ database: prisma, makeClient: createMcpClient, decrypt: decryptSecret, targets: catalogTargets });
const handle = method => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { return res.json(await service[method](req.params.deploymentId, req.params.unitId, req.body || {})); }
  catch (error) { return res.status(error.statusCode || 500).json(publicError(error, req.params)); }
};
router.get('/', handle('inspect'));
router.post('/prepare', handle('prepare'));
router.post('/next', handle('next'));
router.post('/activate', handle('activate'));
export default router;

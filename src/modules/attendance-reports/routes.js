import { Router } from 'express';
import { integraSessionMiddleware } from '../../middlewares/integraSession.middleware.js';
import { ReportError } from './config.js';
import { createReportService } from './service.js';

export function createReportRouter({ sessionMiddleware = integraSessionMiddleware, service = createReportService() } = {}) {
  const router = Router();
  router.use(sessionMiddleware);
  const handle = action => async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    try { await action(req, res); }
    catch (error) {
      const known = error instanceof ReportError;
      res.status(known ? error.status : 500).json({
        code: known ? error.code : 'REPORT_INTERNAL_ERROR',
        message: known ? error.message : 'Não foi possível consultar os relatórios.',
      });
    }
  };
  router.get('/instances', handle(async (_req, res) => res.json({ data: service.listInstances() })));
  router.get('/:instanceKey/latest', handle(async (req, res) => res.json(await service.latest(req.params.instanceKey))));
  router.post('/:instanceKey/runs', handle(async (req, res) => {
    const run = await service.create(req.params.instanceKey, req.body ?? {});
    res.location(run.statusUrl).status(202).json(run);
  }));
  router.get('/:instanceKey/runs/:runId', handle(async (req, res) => res.json(await service.get(req.params.instanceKey, req.params.runId))));
  return router;
}

export default createReportRouter();

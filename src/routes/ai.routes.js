import { Router } from 'express';

import * as aiController from '../controllers/ia.controller.js';

const router = Router();

router.options('/create-ai/alpha', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/alpha2', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/trier', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/trier2', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/vtex', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/vannon', (req, res) => {
  res.sendStatus(204);
});
router.options('/create-ai/vannon2', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai/vetor', (req, res) => {
  res.sendStatus(204);
});

router.options('/create-ai', (req, res) => {
  res.sendStatus(204);
});

router.post('/create-ai/alpha', aiController.createAiAlphaController);
router.post('/create-ai/alpha2', aiController.createAiAlpha2Controller);
router.post('/create-ai/trier', aiController.createAiTrierController);
router.post('/create-ai/trier2', aiController.createAiTrier2Controller);
router.post('/create-ai/vtex', aiController.createAiVtexController);
router.post('/create-ai/vannon', aiController.createAiVannonController);
router.post('/create-ai/vannon2', aiController.createAiVannon2Controller);
router.post('/create-ai/vetor', aiController.createAiVetorController);

router.post('/create-ai', aiController.createAiController);
router.get('/versions', aiController.listAiVersionsController);
router.get('/installations', aiController.listAiInstallationsController);
router.post('/installations/update-all', aiController.updateAllAiInstallationsController);
router.post('/installations/:id/update', aiController.updateAiInstallationController);
router.post('/installations/:id/reconfigure', aiController.reconfigureAiInstallationController);
router.post('/installations/:id/patch-ura-qtd', aiController.patchAiInstallationUraQuantityController);
router.post('/installations/audit-ura-snapshots', aiController.auditAiInstallationUraSnapshotsController);
router.get('/templates', aiController.listAiTemplatesController);
router.post('/templates', aiController.saveAiTemplateBaseController);
router.get('/templates/providers', aiController.listAiProviderTemplatesController);
router.post('/templates/providers/:provider', aiController.saveAiProviderTemplateController);
router.post('/templates/sync-current', aiController.syncAiTemplatesController);
router.get('/templates/workspaces', aiController.listAiTemplateWorkspacesController);
router.get('/templates/workspaces/:provider', aiController.getAiTemplateWorkspaceController);
router.put('/templates/workspaces/:provider', aiController.saveAiTemplateWorkspaceDraftController);
router.delete('/templates/workspaces/:provider', aiController.discardAiTemplateWorkspaceDraftController);
router.post('/templates/workspaces/:provider/release', aiController.releaseAiTemplateWorkspaceDraftController);
router.post('/templates/workspaces/:provider/rollback', aiController.rollbackAiTemplateWorkspaceController);

export default router;

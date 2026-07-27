import { Router } from 'express';
import {
  cancelBancoUnicoImportJobController,
  createBancoUnicoImportJobController,
  deleteBancoUnicoImportJobController,
  getBancoUnicoImportItemFacetsController,
  getBancoUnicoImportJobController,
  listBancoUnicoImportEventsController,
  listBancoUnicoImportItemsController,
  listBancoUnicoImportJobsController,
  pauseBancoUnicoImportJobController,
  resumeBancoUnicoImportJobController,
  retryBancoUnicoImportJobController,
  streamBancoUnicoImportController,
} from '../controllers/bancoUnicoImports.controller.js';

const router = Router();

router.get('/', listBancoUnicoImportJobsController);
router.post('/', createBancoUnicoImportJobController);
router.get('/:id', getBancoUnicoImportJobController);
router.get('/:id/stream', streamBancoUnicoImportController);
router.get('/:id/items', listBancoUnicoImportItemsController);
router.get('/:id/items/facets', getBancoUnicoImportItemFacetsController);
router.get('/:id/events', listBancoUnicoImportEventsController);
router.post('/:id/pause', pauseBancoUnicoImportJobController);
router.post('/:id/resume', resumeBancoUnicoImportJobController);
router.post('/:id/retry', retryBancoUnicoImportJobController);
router.post('/:id/cancel', cancelBancoUnicoImportJobController);
router.delete('/:id', deleteBancoUnicoImportJobController);

export default router;

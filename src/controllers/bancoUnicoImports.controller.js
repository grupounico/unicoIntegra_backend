import {
  cancelBancoUnicoImportJob,
  createBancoUnicoImportJob,
  deleteBancoUnicoImportJob,
  getBancoUnicoImportItemFacets,
  getBancoUnicoImportJob,
  listBancoUnicoImportEvents,
  listBancoUnicoImportItems,
  listBancoUnicoImportJobs,
  pauseBancoUnicoImportJob,
  resumeBancoUnicoImportJob,
  retryBancoUnicoImportJob,
  subscribeBancoUnicoImportStream,
} from '../services/bancoUnicoImports.service.js';

function resolveStatusCode(error, fallback = 500) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('nao encontrada')) return 404;
  if (
    message.includes('informe') ||
    message.includes('origem') ||
    message.includes('autorizacao')
  ) {
    return 400;
  }
  if (message.includes('cancele a importacao')) {
    return 409;
  }

  return fallback;
}

export async function createBancoUnicoImportJobController(req, res) {
  try {
    const job = await createBancoUnicoImportJob(req.body || {});
    return res.status(201).json(job);
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 500)).json({
      error: error.message || 'Erro ao criar importacao.',
    });
  }
}

export async function listBancoUnicoImportJobsController(req, res) {
  try {
    const result = await listBancoUnicoImportJobs(req.query || {});
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Erro ao listar importacoes.',
    });
  }
}

export async function getBancoUnicoImportJobController(req, res) {
  try {
    const result = await getBancoUnicoImportJob(req.params.id);
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 500)).json({
      error: error.message || 'Erro ao carregar importacao.',
    });
  }
}

export async function listBancoUnicoImportItemsController(req, res) {
  try {
    const result = await listBancoUnicoImportItems(req.params.id, req.query || {});
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 500)).json({
      error: error.message || 'Erro ao listar itens da importacao.',
    });
  }
}

export async function getBancoUnicoImportItemFacetsController(req, res) {
  try {
    const values = await getBancoUnicoImportItemFacets(req.params.id, req.query.field, req.query || {});
    return res.json({ values });
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 400)).json({
      error: error.message || 'Erro ao carregar valores do filtro.',
    });
  }
}

export async function listBancoUnicoImportEventsController(req, res) {
  try {
    const result = await listBancoUnicoImportEvents(req.params.id, req.query || {});
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 500)).json({
      error: error.message || 'Erro ao listar eventos da importacao.',
    });
  }
}

export async function streamBancoUnicoImportController(req, res) {
  try {
    await subscribeBancoUnicoImportStream(req.params.id, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return res.status(resolveStatusCode(error, 500)).json({
        error: error.message || 'Erro ao abrir stream da importacao.',
      });
    }
  }
}

export async function cancelBancoUnicoImportJobController(req, res) {
  try {
    const username = String(req.body?.username || 'Sistema');
    await cancelBancoUnicoImportJob(req.params.id, username);
    return res.status(202).json({ message: 'Cancelamento solicitado.' });
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 409)).json({
      error: error.message || 'Erro ao cancelar importacao.',
    });
  }
}

export async function pauseBancoUnicoImportJobController(req, res) {
  try {
    const username = String(req.body?.username || 'Sistema');
    await pauseBancoUnicoImportJob(req.params.id, username);
    return res.status(202).json({ message: 'Pausa solicitada.' });
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 409)).json({
      error: error.message || 'Erro ao pausar importacao.',
    });
  }
}

export async function resumeBancoUnicoImportJobController(req, res) {
  try {
    const username = String(req.body?.username || 'Sistema');
    await resumeBancoUnicoImportJob(req.params.id, username);
    return res.status(202).json({ message: 'Importacao retomada.' });
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 409)).json({
      error: error.message || 'Erro ao retomar importacao.',
    });
  }
}

export async function retryBancoUnicoImportJobController(req, res) {
  try {
    const username = String(req.body?.username || 'Sistema');
    const job = await retryBancoUnicoImportJob(req.params.id, username);
    return res.status(202).json(job);
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 409)).json({
      error: error.message || 'Erro ao repetir importacao.',
    });
  }
}

export async function deleteBancoUnicoImportJobController(req, res) {
  try {
    const username = String(req.body?.username || 'Sistema');
    await deleteBancoUnicoImportJob(req.params.id, username);
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(resolveStatusCode(error, 500)).json({
      error: error.message || 'Erro ao excluir importacao.',
    });
  }
}

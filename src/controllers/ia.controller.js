import {
  createAiAlpha,
  createAiAlpha2,
  createAiTrier,
  createAiTrier2,
  createAiVtex,
  createAiVannon,
  createAiVannon2,
  createAiVetor,
  createDefaultAi,
  listManagedAiInstallations,
  patchManagedAiUraQuantity,
  reconfigureManagedAiInstallation,
  updateAllManagedAiInstallations,
  updateManagedAiInstallation,
} from '../services/ai.services.js';
import {
  listAiTemplateBases,
  saveAiTemplateBase,
} from '../services/aiTemplateBase.services.js';
import {
  listAiProviderTemplatePackages,
  saveAiProviderTemplatePackage,
} from '../services/aiProviderTemplate.services.js';
import {
  discardAiTemplateWorkspaceDraft,
  getAiTemplateWorkspace,
  listAiTemplateWorkspaces,
  releaseAiTemplateWorkspaceDraft,
  rollbackAiTemplateWorkspace,
  saveAiTemplateWorkspaceDraft,
} from '../services/aiTemplateWorkspace.services.js';
import { auditIntegratedAiUraSnapshots } from '../services/aiUraSnapshotAudit.services.js';
import { listAiVersions } from '../services/aiVersion.services.js';
import { normalizeVtexBaseUrl } from '../services/aiProviderCatalog.js';
import { isAutomatedInstanceAuthEnabled } from '../services/instanceExecutionAuth.services.js';
import { createLogService } from '../services/logs.services.js';

function toReadableError(error) {
  const responseData = error?.response?.data;

  if (typeof responseData === 'string' && responseData.trim()) {
    return responseData;
  }

  if (responseData && typeof responseData === 'object') {
    if (
      typeof responseData.message === 'string' &&
      responseData.message.trim()
    ) {
      return responseData.message;
    }

    if (typeof responseData.error === 'string' && responseData.error.trim()) {
      return responseData.error;
    }

    try {
      return JSON.stringify(responseData);
    } catch {
      return 'Erro de Integração ao criar IA.';
    }
  }

  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }

  return 'Erro interno ao criar IA.';
}

function requireManualInstanceAuthIfNeeded(res, { username, password, code }) {
  if (isAutomatedInstanceAuthEnabled()) {
    return false;
  }

  if (!username) {
    res.status(400).json({ message: 'O campo "username" é obrigatório' });
    return true;
  }

  if (!password) {
    res.status(400).json({ message: 'O campo "password" é obrigatório' });
    return true;
  }

  if (!code) {
    res.status(400).json({ message: 'O campo "code" é obrigatório' });
    return true;
  }

  return false;
}

export async function createAiAlphaController(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      nome_cliente,
      nomeCliente,
      clientName,
      porta_cliente,
      clientPort,
      unidade_negocio,
      unidadeNegocio,
      quantidade_de_produtos,
      quantidadeDeProdutos,
      apiKey,
      code,
      requestedBy,
    } = req.body;

    const alphaPayload = {
      instance,
      username,
      password,
      code2fa: code,
      name,
      nome_cliente: nome_cliente || nomeCliente || clientName,
      porta_cliente: clientPort || porta_cliente,
      unidade_negocio: unidade_negocio || unidadeNegocio,
      quantidade_de_produtos:
        quantidade_de_produtos ?? quantidadeDeProdutos ?? 3,
      apiKey,
    };
    const quantidadeDeProdutosValue = Number(
      alphaPayload.quantidade_de_produtos,
    );

    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!alphaPayload.nome_cliente) {
      return res
        .status(400)
        .json({ message: 'O campo "nome_cliente" é obrigatório' });
    }
    if (!alphaPayload.porta_cliente) {
      return res
        .status(400)
        .json({ message: 'O campo "porta_cliente" é obrigatório' });
    }
    if (!alphaPayload.unidade_negocio) {
      return res
        .status(400)
        .json({ message: 'O campo "unidade_negocio" é obrigatório' });
    }
    if (!apiKey) {
      return res
        .status(400)
        .json({ message: 'O campo "apiKey" é obrigatório' });
    }
    if (
      !Number.isFinite(quantidadeDeProdutosValue) ||
      quantidadeDeProdutosValue < 1
    ) {
      return res.status(400).json({
        message: 'O campo "quantidade_de_produtos" deve ser maior que zero.',
      });
    }
    if (quantidadeDeProdutosValue > 7) {
      return res.status(400).json({
        message: 'O campo "quantidade_de_produtos" deve ter no maximo 7 itens.',
      });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const aiResponse = await createAiAlpha(alphaPayload);
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA do alpha 7 - ${name}`,
      instance,
    );

    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function createAiTrierController(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      nome_cliente,
      nomeCliente,
      porta_cliente,
      clientPort,
      clientName,
      apiKey,
      code,
      requestedBy,
    } = req.body;

    const trierPayload = {
      instance,
      username,
      password,
      code2fa: code,
      name,
      nome_cliente: nome_cliente || nomeCliente || clientName,
      porta_cliente: clientPort || porta_cliente,
      apiKey,
    };

    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!trierPayload.nome_cliente) {
      return res
        .status(400)
        .json({ message: 'O campo "nome_cliente" é obrigatório' });
    }
    if (!trierPayload.porta_cliente) {
      return res
        .status(400)
        .json({ message: 'O campo "porta_cliente" é obrigatório' });
    }
    if (!apiKey) {
      return res
        .status(400)
        .json({ message: 'O campo "apiKey" é obrigatório' });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const aiResponse = await createAiTrier(trierPayload);
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA da Trier - ${name}`,
      instance,
    );

    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function createAiVannonController(req, res) {
  try {
    // 1. Obter todos os dados do body
    const {
      instance,
      username,
      password,
      name,
      clientEndpoint,
      apiKey,
      code,
      cepLoja,
      clientName,
      requestedBy,
    } = req.body;

    // 2. Validar campos obrigatÃ³rios
    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!clientName) {
      return res
        .status(400)
        .json({ message: 'O campo "clientName" é obrigatório' });
    }
    if (!clientEndpoint) {
      return res
        .status(400)
        .json({ message: 'O campo "clientEndpoint" é obrigatório' });
    }
    if (!cepLoja) {
      return res
        .status(400)
        .json({ message: 'O campo "cepLoja" é obrigatório' });
    }
    if (!apiKey) {
      return res
        .status(400)
        .json({ message: 'O campo "apiKey" é obrigatório' });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    // 3. Chamar a função correta (createAiAlpha) com todos os parâmetros
    const aiResponse = await createAiVannon(
      instance,
      username,
      password,
      code,
      name,
      clientEndpoint,
      clientName,
      apiKey,
      cepLoja,
    );
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA da Vannon - ${name}`,
      instance,
    );

    // 4. Retornar a resposta de sucesso
    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function createAiVtexController(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      nome_cliente,
      nomeCliente,
      clientName,
      apiKey,
      url_vtex_variable,
      url_vtex_var,
      urlVtex,
      vtex_app_key_variable,
      vtex_app_key,
      vtexAppKey,
      vtex_app_token_variable,
      vtex_app_token,
      vtexAppToken,
      quantidade_de_produtos,
      quantidadeDeProdutos,
      code,
      requestedBy,
    } = req.body;

    const vtexPayload = {
      instance,
      username,
      password,
      code2fa: code,
      name,
      nome_cliente: nome_cliente || nomeCliente || clientName,
      apiKey,
      url_vtex_variable: normalizeVtexBaseUrl(
        url_vtex_variable ||
          url_vtex_var ||
          urlVtex ||
          vtex_endpoint ||
          vtexAccountEndpoint,
      ),
      vtex_app_key_variable:
        vtex_app_key_variable || vtex_app_key || vtexAppKey,
      vtex_app_token_variable:
        vtex_app_token_variable || vtex_app_token || vtexAppToken,
      quantidade_de_produtos:
        quantidade_de_produtos ?? quantidadeDeProdutos ?? 3,
    };
    const quantidadeDeProdutosValue = Number(
      vtexPayload.quantidade_de_produtos,
    );

    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!vtexPayload.nome_cliente) {
      return res
        .status(400)
        .json({ message: 'O campo "nome_cliente" é obrigatório' });
    }
    if (!apiKey) {
      return res
        .status(400)
        .json({ message: 'O campo "apiKey" é obrigatório' });
    }
    if (!vtexPayload.url_vtex_variable) {
      return res.status(400).json({
        message:
          'O campo "url_vtex_variable" (endpoint do e-commerce VTEX) � obrigat�rio',
      });
    }
    if (!vtexPayload.vtex_app_key_variable) {
      return res
        .status(400)
        .json({ message: 'O campo "vtex_app_key_variable" é obrigatório' });
    }
    if (!vtexPayload.vtex_app_token_variable) {
      return res
        .status(400)
        .json({ message: 'O campo "vtex_app_token_variable" é obrigatório' });
    }
    if (
      !Number.isFinite(quantidadeDeProdutosValue) ||
      quantidadeDeProdutosValue < 1
    ) {
      return res.status(400).json({
        message: 'O campo "quantidade_de_produtos" deve ser maior que zero.',
      });
    }
    if (quantidadeDeProdutosValue > 7) {
      return res.status(400).json({
        message: 'O campo "quantidade_de_produtos" deve ter no maximo 7 itens.',
      });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const aiResponse = await createAiVtex(vtexPayload);
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA da VTEX - ${name}`,
      instance,
    );

    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function createAiVetorController(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      vetorToken,
      unidade_negocio_vetor,
      unidadeNegocioVetor,
      apiKey,
      code,
      clientName,
      requestedBy,
    } = req.body;

    const vetorBusinessUnit = unidade_negocio_vetor || unidadeNegocioVetor;

    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!clientName) {
      return res
        .status(400)
        .json({ message: 'O campo "clientName" é obrigatório' });
    }
    if (!vetorToken) {
      return res
        .status(400)
        .json({ message: 'O campo "vetorToken" é obrigatório' });
    }
    if (!vetorBusinessUnit) {
      return res.status(400).json({
        message: 'O campo "unidade_negocio_vetor" é obrigatório',
      });
    }
    if (!apiKey) {
      return res
        .status(400)
        .json({ message: 'O campo "apiKey" é obrigatório' });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const aiResponse = await createAiVetor(
      instance,
      username,
      password,
      code,
      name,
      vetorToken,
      vetorBusinessUnit,
      clientName,
      apiKey,
    );
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA da Vetor - ${name}`,
      instance,
    );

    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function createAiController(req, res) {
  try {
    // 1. Obter todos os dados do body
    const { instance, username, password, code, name, context, requestedBy } =
      req.body;

    // 2. Validar campos obrigatÃ³rios
    if (!instance) {
      return res
        .status(400)
        .json({ message: 'O campo "instance" é obrigatório' });
    }
    if (!name) {
      return res
        .status(400)
        .json({ message: 'O campo "name" (signaturename) é obrigatório' });
    }
    if (!context) {
      return res
        .status(400)
        .json({ message: 'O campo "context" é obrigatório' });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    // 3. Chamar a função correta (createAiAlpha) com todos os parâmetros
    const aiResponse = await createDefaultAi(
      instance,
      username,
      password,
      code,
      name,
      context,
    );
    const currentUser = requestedBy || username || 'Sistema';
    await createLogService(
      currentUser,
      `Criou a IA de atendimento - ${name}`,
      instance,
    );

    // 4. Retornar a resposta de sucesso
    res.status(200).json(aiResponse);
  } catch (error) {
    console.error('Erro ao criar IA:', error);
    const details = toReadableError(error);
    res.status(500).json({
      message: `Ocorreu um erro ao criar a IA. ${details}`,
      error: details,
    });
  }
}

export async function listAiVersionsController(req, res) {
  try {
    const { limit, latestOnly, instance } = req.query;
    const data = await listAiVersions({ limit, latestOnly, instance });
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao listar IAs versionadas:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao listar as IAs.',
      error: error.message,
    });
  }
}

export async function listAiInstallationsController(req, res) {
  try {
    const { instance, provider, limit } = req.query;
    const data = await listManagedAiInstallations({
      instance,
      provider,
      limit,
    });
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao listar instalacoes de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao listar as instalacoes de IA.',
      error: error.message,
    });
  }
}

export async function updateAiInstallationController(req, res) {
  try {
    const { id } = req.params;
    const {
      username,
      password,
      code,
      force,
      componentKey,
      component,
      requestedBy,
    } = req.body;

    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const data = await updateManagedAiInstallation({
      installationId: Number(id),
      username,
      password,
      code2fa: code,
      force: Boolean(force),
      componentKey: componentKey || component,
    });

    await createLogService(
      requestedBy || username || 'Sistema',
      `Atualizou a instalacao da IA ${id}`,
      data?.installation?.instance || null,
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro ao atualizar instalacao de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao atualizar a instalacao da IA.',
      error: error.message,
    });
  }
}

export async function updateAllAiInstallationsController(req, res) {
  try {
    const {
      username,
      password,
      code,
      instance,
      provider,
      force,
      componentKey,
      component,
      requestedBy,
    } = req.body;

    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const data = await updateAllManagedAiInstallations({
      username,
      password,
      code2fa: code,
      instance,
      provider,
      force: Boolean(force),
      componentKey: componentKey || component,
    });

    await createLogService(
      requestedBy || username || 'Sistema',
      `Atualizou instalacoes de IA em lote (${data.updated}/${data.total})`,
      instance || provider || 'todas',
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro ao atualizar instalacoes de IA em lote:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao atualizar as instalacoes de IA.',
      error: error.message,
    });
  }
}

export async function patchAiInstallationUraQuantityController(req, res) {
  try {
    const { id } = req.params;
    const {
      username,
      password,
      code,
      requestedBy,
      quantidade_de_produtos,
      quantidadeDeProdutos,
    } = req.body;

    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const data = await patchManagedAiUraQuantity({
      installationId: Number(id),
      username,
      password,
      code2fa: code,
      quantidadeDeProdutos: quantidade_de_produtos ?? quantidadeDeProdutos ?? 3,
    });

    await createLogService(
      requestedBy || username || 'Sistema',
      `Aplicou patch seguro de quantidade de produtos na URA (${data.quantidade_de_produtos})`,
      data.installation?.instance || String(id),
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro ao aplicar patch seguro na URA da IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao aplicar o patch seguro na URA da IA.',
      error: error.message,
    });
  }
}

export async function reconfigureAiInstallationController(req, res) {
  try {
    const { id } = req.params;
    const {
      username,
      password,
      code,
      requestedBy,
      assistantId,
      assistantName,
      preProcessId,
      buscaProdutosId,
      downloadImagemId,
      gerarCheckoutId,
      transferirHumanoId,
      uraIaId,
      uraAbId,
      configSnapshot,
      applyToClient,
      applyUraPatch,
    } = req.body || {};

    if (
      applyToClient &&
      requireManualInstanceAuthIfNeeded(res, { username, password, code })
    ) {
      return;
    }

    const data = await reconfigureManagedAiInstallation({
      installationId: Number(id),
      username,
      password,
      code2fa: code,
      assistantId,
      assistantName,
      preProcessId,
      buscaProdutosId,
      downloadImagemId,
      gerarCheckoutId,
      transferirHumanoId,
      uraIaId,
      uraAbId,
      configSnapshot,
      applyToClient: Boolean(applyToClient),
      applyUraPatch: applyUraPatch !== false,
    });

    await createLogService(
      requestedBy || username || 'Sistema',
      `Reconfigurou a instalacao da IA ${id}${applyToClient ? ' e reaplicou no cliente' : ''}`,
      data?.installation?.instance || String(id),
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro ao reconfigurar instalacao de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao reconfigurar a instalacao da IA.',
      error: error.message,
    });
  }
}

export async function auditAiInstallationUraSnapshotsController(req, res) {
  try {
    const { installationId, requestedBy } = req.body || {};

    const data = await auditIntegratedAiUraSnapshots({
      installationId,
      requestedBy: requestedBy || 'Sistema',
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erro ao auditar snapshots de URA das IAs:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao auditar as URAs das IAs.',
      error: error.message,
    });
  }
}

export async function listAiTemplatesController(req, res) {
  try {
    const { limit, currentOnly } = req.query;
    const data = await listAiTemplateBases({ limit, currentOnly });
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao listar templates base de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao listar os templates base de IA.',
      error: error.message,
    });
  }
}

export async function saveAiTemplateBaseController(req, res) {
  try {
    const data = await saveAiTemplateBase(req.body || {});
    return res.status(200).json({
      message: data.changed
        ? 'Template base versionado com sucesso.'
        : 'Nenhuma alteracao detectada no template base.',
      data,
    });
  } catch (error) {
    console.error('Erro ao salvar template base de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao salvar o template base de IA.',
      error: error.message,
    });
  }
}

export async function listAiProviderTemplatesController(req, res) {
  try {
    const { provider, currentOnly, limit } = req.query;
    const data = await listAiProviderTemplatePackages({
      provider,
      currentOnly,
      limit,
    });
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao listar templates por provider:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao listar os templates por provider.',
      error: error.message,
    });
  }
}

export async function saveAiProviderTemplateController(req, res) {
  try {
    const { provider } = req.params;
    const data = await saveAiProviderTemplatePackage(provider, req.body || {});
    return res.status(200).json({
      message: data.changed
        ? 'Pacote de templates do provider versionado com sucesso.'
        : 'Nenhuma alteracao detectada no pacote do provider.',
      data,
    });
  } catch (error) {
    console.error('Erro ao salvar template por provider:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao salvar o template por provider.',
      error: error.message,
    });
  }
}

export async function syncAiTemplatesController(req, res) {
  return res.status(410).json({
    message:
      'A sincronizacao por arquivos locais foi desativada. O banco e a unica fonte de verdade para templates.',
  });
}

export async function createAiVannon2Controller(req, res) {
  try {
    const { instance, username, password, name, clientEndpoint, apiKey, code, cepLoja, clientName, requestedBy } = req.body;
    const missing = !instance ? 'instance' : !name ? 'name' : !clientName ? 'clientName' : !clientEndpoint ? 'clientEndpoint' : !cepLoja ? 'cepLoja' : !apiKey ? 'apiKey' : '';
    if (missing) return res.status(400).json({ message: `O campo "${missing}" é obrigatório` });

    const result = await createAiVannon2({ instance, username, password, code2fa: code, name, clientEndpoint, clientName, apiKey, cepLoja });
    await createLogService(requestedBy || username || 'Sistema', `Criou a IA Vannon 2.0 - ${name}`, instance);
    return res.status(200).json(result);
  } catch (error) {
    const details = toReadableError(error);
    return res.status(500).json({ message: `Ocorreu um erro ao criar a IA Vannon 2.0. ${details}`, error: details });
  }
}

export async function createAiTrier2Controller(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      nome_cliente,
      nomeCliente,
      clientName,
      apiKey,
      trierToken,
      trier_token,
      quantidade_de_produtos,
      quantidadeDeProdutos,
      code,
      requestedBy,
    } = req.body;
    const payload = {
      instance,
      username,
      password,
      code2fa: code,
      name,
      nome_cliente: nome_cliente || nomeCliente || clientName,
      apiKey,
      trierToken: trierToken || trier_token,
      quantidade_de_produtos:
        quantidade_de_produtos ?? quantidadeDeProdutos ?? 3,
    };
    for (const [field, value] of Object.entries({
      instance: payload.instance,
      name: payload.name,
      nome_cliente: payload.nome_cliente,
      apiKey: payload.apiKey,
      trierToken: payload.trierToken,
    })) {
      if (!value)
        return res
          .status(400)
          .json({ message: `O campo "${field}" e obrigatorio` });
    }
    const quantidade = Number(payload.quantidade_de_produtos);
    if (!Number.isFinite(quantidade) || quantidade < 1 || quantidade > 7) {
      return res
        .status(400)
        .json({
          message: 'O campo "quantidade_de_produtos" deve estar entre 1 e 7.',
        });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code }))
      return;
    const response = await createAiTrier2(payload);
    await createLogService(
      requestedBy || username || 'Sistema',
      `Criou a IA Trier 2.0 - ${name}`,
      instance,
    );
    return res.status(200).json(response);
  } catch (error) {
    const details = toReadableError(error);
    return res
      .status(500)
      .json({
        message: `Ocorreu um erro ao criar a IA Trier 2.0. ${details}`,
        error: details,
      });
  }
}

export async function createAiAlpha2Controller(req, res) {
  try {
    const {
      instance,
      username,
      password,
      name,
      nome_cliente,
      nomeCliente,
      clientName,
      unidade_negocio,
      unidadeNegocio,
      apiKey,
      alphaToken,
      alpha_token,
      quantidade_de_produtos,
      quantidadeDeProdutos,
      code,
      requestedBy,
    } = req.body;

    const payload = {
      instance,
      username,
      password,
      code2fa: code,
      name,
      nome_cliente: nome_cliente || nomeCliente || clientName,
      unidade_negocio: unidade_negocio || unidadeNegocio,
      apiKey,
      alphaToken: alphaToken || alpha_token,
      quantidade_de_produtos:
        quantidade_de_produtos ?? quantidadeDeProdutos ?? 3,
    };
    const quantidade = Number(payload.quantidade_de_produtos);

    for (const [field, value] of Object.entries({
      instance: payload.instance,
      name: payload.name,
      nome_cliente: payload.nome_cliente,
      unidade_negocio: payload.unidade_negocio,
      apiKey: payload.apiKey,
      alphaToken: payload.alphaToken,
    })) {
      if (!value) {
        return res
          .status(400)
          .json({ message: `O campo "${field}" e obrigatorio` });
      }
    }
    if (!Number.isFinite(quantidade) || quantidade < 1 || quantidade > 7) {
      return res.status(400).json({
        message: 'O campo "quantidade_de_produtos" deve estar entre 1 e 7.',
      });
    }
    if (requireManualInstanceAuthIfNeeded(res, { username, password, code })) {
      return;
    }

    const aiResponse = await createAiAlpha2(payload);
    await createLogService(
      requestedBy || username || 'Sistema',
      `Criou a IA Alpha 2.0 - ${name}`,
      instance,
    );
    return res.status(200).json(aiResponse);
  } catch (error) {
    const details = toReadableError(error);
    return res.status(500).json({
      message: `Ocorreu um erro ao criar a IA Alpha 2.0. ${details}`,
      error: details,
    });
  }
}

export async function listAiTemplateWorkspacesController(req, res) {
  try {
    const data = await listAiTemplateWorkspaces();
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao listar workspaces de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao listar os workspaces de templates de IA.',
      error: error.message,
    });
  }
}

export async function getAiTemplateWorkspaceController(req, res) {
  try {
    const { provider } = req.params;
    const data = await getAiTemplateWorkspace(provider);
    return res.status(200).json({ data });
  } catch (error) {
    console.error('Erro ao carregar workspace de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao carregar o workspace de templates de IA.',
      error: error.message,
    });
  }
}

export async function saveAiTemplateWorkspaceDraftController(req, res) {
  try {
    const { provider } = req.params;
    const response = await saveAiTemplateWorkspaceDraft(
      provider,
      req.body || {},
    );
    return res.status(200).json(response);
  } catch (error) {
    console.error('Erro ao salvar rascunho de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao salvar o rascunho dos templates de IA.',
      error: error.message,
    });
  }
}

export async function discardAiTemplateWorkspaceDraftController(req, res) {
  try {
    const { provider } = req.params;
    const response = await discardAiTemplateWorkspaceDraft(provider);
    return res.status(200).json(response);
  } catch (error) {
    console.error('Erro ao descartar rascunho de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao descartar o rascunho dos templates de IA.',
      error: error.message,
    });
  }
}

export async function releaseAiTemplateWorkspaceDraftController(req, res) {
  try {
    const { provider } = req.params;
    const response = await releaseAiTemplateWorkspaceDraft(
      provider,
      req.body || {},
    );
    return res.status(200).json(response);
  } catch (error) {
    console.error('Erro ao publicar rascunho de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao publicar os templates de IA em producao.',
      error: error.message,
    });
  }
}

export async function rollbackAiTemplateWorkspaceController(req, res) {
  try {
    const { provider } = req.params;
    const response = await rollbackAiTemplateWorkspace(
      provider,
      req.body || {},
    );
    return res.status(200).json(response);
  } catch (error) {
    console.error('Erro ao realizar rollback de templates de IA:', error);
    return res.status(500).json({
      message: 'Ocorreu um erro ao realizar rollback dos templates de IA.',
      error: error.message,
    });
  }
}

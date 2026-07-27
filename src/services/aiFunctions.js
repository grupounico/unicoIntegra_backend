import { postIvr } from './instanceApi.services.js';
import {
  buildManagedAiTemplateVariables,
  getManagedAiInstallOrder,
  getManagedAiProviderDefinition,
} from './aiProviderCatalog.js';
import { loadAiProviderTemplateComponent } from './aiProviderTemplate.services.js';

const COMPONENT_ID_FIELD_MAP = {
  downloadImagem: 'downloadImagemId',
  buscaProdutos: 'buscaProdutosId',
  gerarCheckout: 'gerarCheckoutId',
  transferirHumano: 'transferirHumanoId',
  ura: 'uraIaId',
  uraAb: 'uraAbId',
  preProcess: 'preProcessId',
};

const COMPONENT_LOG_LABEL_MAP = {
  downloadImagem: 'Download Image',
  buscaProdutos: 'Busca de produtos',
  gerarCheckout: 'Gerar checkout',
  transferirHumano: 'Transferir para humano',
  ura: 'URA IA',
  uraAb: 'URA IA - AB',
  preProcess: 'Pre processamento',
};

async function installProviderComponent({
  provider,
  componentKey,
  instance,
  token,
  assistantId,
  configSnapshot,
  installedIds,
}) {
  const variables = buildManagedAiTemplateVariables(provider, {
    instance,
    assistantId,
    config: configSnapshot,
    ids: installedIds,
  });

  const payload = await loadAiProviderTemplateComponent(
    provider,
    componentKey,
    variables,
    { requireDatabase: true },
  );

  const response = await postIvr(instance, payload, token);
  if (!response?.id) {
    throw new Error(`Falha ao criar ${componentKey} para o provider ${provider}.`);
  }

  return response.id;
}

async function installManagedProviderTemplates({
  provider,
  instance,
  token,
  assistantId,
  configSnapshot,
}) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  const installedIds = {
    downloadImagemId: null,
    buscaProdutosId: null,
    gerarCheckoutId: null,
    transferirHumanoId: null,
    uraIaId: null,
    uraAbId: null,
    preProcessId: null,
  };

  const installOrder = getManagedAiInstallOrder(provider);

  for (const [index, componentKey] of installOrder.entries()) {
    const logLabel = COMPONENT_LOG_LABEL_MAP[componentKey] || componentKey;
    console.log(`--- Passo ${index + 1}: ${logLabel} ---`);

    const componentId = await installProviderComponent({
      provider,
      componentKey,
      instance,
      token,
      assistantId,
      configSnapshot,
      installedIds,
    });

    installedIds[COMPONENT_ID_FIELD_MAP[componentKey]] = componentId;
    console.log(`${logLabel} criado. ID: ${componentId}`);
  }

  return installedIds;
}

export async function alpha7Functions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  try {
    return await installManagedProviderTemplates({
      provider: 'alpha7',
      instance,
      token,
      assistantId: iaId,
      configSnapshot,
    });
  } catch (error) {
    console.error(
      'Erro critico em alpha7Functions:',
      error.response?.data || error.message,
    );
    throw error;
  }
}

export async function alpha2Functions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  return installManagedProviderTemplates({
    provider: 'alpha2',
    instance,
    token,
    assistantId: iaId,
    configSnapshot,
  });
}

export async function trierFunctions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  try {
    return await installManagedProviderTemplates({
      provider: 'trier',
      instance,
      token,
      assistantId: iaId,
      configSnapshot,
    });
  } catch (error) {
    console.error(
      'Erro critico em trierFunctions:',
      error.response?.data || error.message,
    );
    throw error;
  }
}

export async function trier2Functions({ instance, token, iaId, configSnapshot }) {
  return installManagedProviderTemplates({ provider: 'trier2', instance, token, assistantId: iaId, configSnapshot });
}

export async function vannon2Functions({ instance, token, iaId, configSnapshot }) {
  return installManagedProviderTemplates({ provider: 'vannon2', instance, token, assistantId: iaId, configSnapshot });
}

export async function vtexFunctions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  try {
    return await installManagedProviderTemplates({
      provider: 'vtex',
      instance,
      token,
      assistantId: iaId,
      configSnapshot,
    });
  } catch (error) {
    console.error(
      'Erro critico em vtexFunctions:',
      error.response?.data || error.message,
    );
    throw error;
  }
}

export async function vannonFunctions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  try {
    return await installManagedProviderTemplates({
      provider: 'vannon',
      instance,
      token,
      assistantId: iaId,
      configSnapshot,
    });
  } catch (error) {
    console.error(
      'Erro critico em vannonFunctions:',
      error.response?.data || error.message,
    );
    throw error;
  }
}

export async function vectorFunctions({
  instance,
  token,
  iaId,
  configSnapshot,
}) {
  try {
    return await installManagedProviderTemplates({
      provider: 'vetor',
      instance,
      token,
      assistantId: iaId,
      configSnapshot,
    });
  } catch (error) {
    console.error(
      'Erro critico em vectorFunctions:',
      error.response?.data || error.message,
    );
    throw error;
  }
}

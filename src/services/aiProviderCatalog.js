export const MANAGED_AI_COMPONENT_KEYS = [
  'assistant',
  'downloadImagem',
  'buscaProdutos',
  'gerarCheckout',
  'transferirHumano',
  'ura',
  'uraAb',
  'preProcess',
];

export const MANAGED_AI_MANUAL_UPDATE_COMPONENT_KEYS = ['ura', 'uraAb'];

const MANAGED_AI_PROVIDER_DEFINITIONS = {
  alpha7: {
    provider: 'alpha7',
    displayName: 'IA - Alpha 7',
    templateName: 'IA - Alpha 7 Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/alpha7/alpha_ia_config.json',
      downloadImagem: 'ia/alpha7/alpha_download_imagem.json',
      buscaProdutos: 'ia/alpha7/alpha_busca_produtos.json',
      ura: 'ia/alpha7/alpha_ura.json',
      uraAb: 'ia/alpha7/alpha_ab.json',
      preProcess: 'ia/alpha7/alpha_pre_processamento.json',
    },
    installOrder: ['downloadImagem', 'buscaProdutos', 'ura', 'uraAb', 'preProcess'],
    updateOrder: ['downloadImagem', 'buscaProdutos', 'preProcess'],
    createConfigSnapshot(input = {}) {
      const quantidadeDeProdutos = Number(
        input.quantidade_de_produtos ?? input.quantidadeDeProdutos ?? 3,
      );

      return {
        assistantDisplayName: input.name ?? '',
        nome_cliente: input.nome_cliente ?? input.nomeCliente ?? input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        porta_cliente: input.porta_cliente ?? input.clientPort ?? '',
        unidade_negocio: input.unidade_negocio ?? input.unidadeNegocio ?? '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      const quantidadeDeProdutos = Number(config.quantidade_de_produtos);

      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.nome_cliente || '',
        nome_cliente_var: config.nome_cliente || '',
        api_key: config.apiKey || '',
        url_cliente: instance,
        porta_cliente: config.porta_cliente || '',
        unidade_negocio: config.unidade_negocio || '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
        preProcessId: ids.preProcessId || '',
        BuscaItensId: ids.buscaProdutosId || '',
        download_img_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.nome_cliente &&
          record.configSnapshot?.apiKey &&
          record.configSnapshot?.porta_cliente &&
          record.configSnapshot?.unidade_negocio,
      );
    },
  },
  alpha2: {
    provider: 'alpha2',
    displayName: 'IA - Alpha 2.0',
    templateName: 'IA - Alpha 2.0 Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/alpha2/alpha2_ia_config.json',
      preProcess: 'ia/alpha2/alpha2_pre_processamento.json',
      buscaProdutos: 'ia/alpha2/alpha2_consulta_produtos.json',
      downloadImagem: 'ia/alpha2/alpha2_envia_produto.json',
      ura: 'ia/alpha2/alpha2_ura.json',
      uraAb: 'ia/alpha2/alpha2_ura_ab.json',
    },
    installOrder: ['preProcess', 'buscaProdutos', 'downloadImagem', 'ura', 'uraAb'],
    updateOrder: ['preProcess', 'buscaProdutos', 'downloadImagem'],
    createConfigSnapshot(input = {}) {
      const quantidadeDeProdutos = Number(
        input.quantidade_de_produtos ?? input.quantidadeDeProdutos ?? 3,
      );

      return {
        assistantDisplayName: input.name ?? '',
        nome_cliente: input.nome_cliente ?? input.nomeCliente ?? input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        alphaToken: input.alphaToken ?? input.alpha_token ?? '',
        porta_cliente: input.porta_cliente ?? input.clientPort ?? 0,
        unidade_negocio: input.unidade_negocio ?? input.unidadeNegocio ?? '',
        ip_cliente: input.ip_cliente ?? input.ipCliente ?? '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      const quantidadeDeProdutos = Number(config.quantidade_de_produtos);

      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.nome_cliente || '',
        nome_cliente_var: config.nome_cliente || '',
        api_key: config.apiKey || '',
        api_key_var: config.apiKey || '',
        alpha_token: config.alphaToken || '',
        url_cliente: instance,
        url_cliente_var: instance,
        porta_cliente: config.porta_cliente ?? 0,
        unidade_negocio: config.unidade_negocio || '',
        ip_cliente: config.ip_cliente || '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
        preAutomationId: ids.preProcessId || '',
        preProcessId: ids.preProcessId || '',
        consulta_produtos_automation_id: ids.buscaProdutosId || '',
        envia_produtos_automation_id: ids.downloadImagemId || '',
        BuscaItensId: ids.buscaProdutosId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.nome_cliente &&
          record.configSnapshot?.apiKey &&
          record.configSnapshot?.alphaToken &&
          record.configSnapshot?.unidade_negocio,
      );
    },
  },
  trier: {
    provider: 'trier',
    displayName: 'IA - Trier',
    templateName: 'IA - Trier Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/trier/trier_ia_config.json',
      downloadImagem: 'ia/trier/trier_download_imagem.json',
      buscaProdutos: 'ia/trier/trier_busca_produtos.json',
      ura: 'ia/trier/trier_ura.json',
      uraAb: 'ia/trier/trier_ab.json',
      preProcess: 'ia/trier/trier_pre_processamento.json',
    },
    installOrder: ['downloadImagem', 'buscaProdutos', 'ura', 'uraAb', 'preProcess'],
    updateOrder: ['downloadImagem', 'buscaProdutos', 'preProcess'],
    createConfigSnapshot(input = {}) {
      return {
        assistantDisplayName: input.name ?? '',
        nome_cliente: input.nome_cliente ?? input.nomeCliente ?? input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        porta_cliente: input.porta_cliente ?? input.clientPort ?? '',
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.nome_cliente || '',
        nome_cliente_var: config.nome_cliente || '',
        api_key: config.apiKey || '',
        url_cliente: instance,
        porta_cliente: config.porta_cliente || '',
        preProcessId: ids.preProcessId || '',
        BuscaItensId: ids.buscaProdutosId || '',
        download_img_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.nome_cliente &&
          record.configSnapshot?.apiKey &&
          record.configSnapshot?.porta_cliente,
      );
    },
  },
  trier2: {
    provider: 'trier2',
    displayName: 'IA - Trier 2.0',
    templateName: 'IA - Trier 2.0 Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/trier2/trier2_ia_config.json',
      preProcess: 'ia/trier2/trier2_pre_processamento.json',
      buscaProdutos: 'ia/trier2/trier2_busca_produtos.json',
      downloadImagem: 'ia/trier2/trier2_envia_produto.json',
      ura: 'ia/trier2/trier2_ura.json',
      uraAb: 'ia/trier2/trier2_ura_ab.json',
    },
    installOrder: ['preProcess', 'buscaProdutos', 'downloadImagem', 'ura', 'uraAb'],
    updateOrder: ['preProcess', 'buscaProdutos', 'downloadImagem'],
    createConfigSnapshot(input = {}) {
      const quantidadeDeProdutos = Number(input.quantidade_de_produtos ?? input.quantidadeDeProdutos ?? 3);
      return {
        assistantDisplayName: input.name ?? '',
        nome_cliente: input.nome_cliente ?? input.nomeCliente ?? input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        trierToken: input.trierToken ?? input.trier_token ?? '',
        quantidade_de_produtos: Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0 ? Math.min(7, quantidadeDeProdutos) : 3,
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.nome_cliente || '',
        api_key: config.apiKey || '',
        api_key_var: config.apiKey || '',
        trier_token: config.trierToken || '',
        url_cliente: instance,
        url_cliente_var: instance,
        quantidade_de_produtos: config.quantidade_de_produtos || 3,
        preAutomationId: ids.preProcessId || '',
        consulta_produtos_automation_id: ids.buscaProdutosId || '',
        envia_produtos_automation_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(record.assistantId && record.preProcessId && record.buscaProdutosId && record.downloadImagemId && record.uraIaId && record.uraAbId && record.configSnapshot?.nome_cliente && record.configSnapshot?.apiKey && record.configSnapshot?.trierToken);
    },
  },
  vtex: {
    provider: 'vtex',
    displayName: 'IA - VTEX',
    templateName: 'IA - VTEX Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/vtex/vtex_ia_config.json',
      downloadImagem: 'ia/vtex/vtex_download_imagem.json',
      buscaProdutos: 'ia/vtex/vtex_busca_produtos.json',
      gerarCheckout: 'ia/vtex/vtex_gerar_checkout.json',
      transferirHumano: 'ia/vtex/vtex_transferir_para_humano.json',
      ura: 'ia/vtex/vtex_ura.json',
      uraAb: 'ia/vtex/vtex_ab.json',
      preProcess: 'ia/vtex/vtex_pre_processamento.json',
    },
    installOrder: [
      'downloadImagem',
      'buscaProdutos',
      'gerarCheckout',
      'transferirHumano',
      'ura',
      'uraAb',
      'preProcess',
    ],
    updateOrder: [
      'downloadImagem',
      'buscaProdutos',
      'gerarCheckout',
      'transferirHumano',
      'preProcess',
    ],
    createConfigSnapshot(input = {}) {
      const quantidadeDeProdutos = Number(
        input.quantidade_de_produtos ?? input.quantidadeDeProdutos ?? 3,
      );

      return {
        assistantDisplayName: input.name ?? '',
        nome_cliente: input.nome_cliente ?? input.nomeCliente ?? input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        url_vtex_variable: normalizeVtexBaseUrl(
          input.url_vtex_variable ??
            input.url_vtex_var ??
            input.urlVtex ??
            input.vtexAccountEndpoint ??
            input.vtex_endpoint ??
            '',
        ),
        vtex_app_key_variable:
          input.vtex_app_key_variable ?? input.vtex_app_key ?? input.vtexAppKey ?? '',
        vtex_app_token_variable:
          input.vtex_app_token_variable ??
          input.vtex_app_token ??
          input.vtexAppToken ??
          '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      const quantidadeDeProdutos = Number(config.quantidade_de_produtos);

      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.nome_cliente || '',
        nome_cliente_var: config.nome_cliente || '',
        api_key: config.apiKey || '',
        url_cliente: instance,
        url_vtex_variable: normalizeVtexBaseUrl(
          config.url_vtex_variable || config.url_vtex_var || '',
        ),
        vtex_app_key_variable:
          config.vtex_app_key_variable || config.vtex_app_key || '',
        vtex_app_token_variable:
          config.vtex_app_token_variable || config.vtex_app_token || '',
        quantidade_de_produtos:
          Number.isFinite(quantidadeDeProdutos) && quantidadeDeProdutos > 0
            ? Math.min(7, quantidadeDeProdutos)
            : 3,
        preProcessId: ids.preProcessId || '',
        BuscaItensId: ids.buscaProdutosId || '',
        download_img_id: ids.downloadImagemId || '',
        gerar_checkout_id: ids.gerarCheckoutId || '',
        transferir_para_humano_id: ids.transferirHumanoId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.gerarCheckoutId &&
          record.transferirHumanoId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.nome_cliente &&
          record.configSnapshot?.apiKey &&
          (record.configSnapshot?.url_vtex_variable ||
            record.configSnapshot?.url_vtex_var) &&
          (record.configSnapshot?.vtex_app_key_variable ||
            record.configSnapshot?.vtex_app_key) &&
          (record.configSnapshot?.vtex_app_token_variable ||
            record.configSnapshot?.vtex_app_token),
      );
    },
  },
  vannon: {
    provider: 'vannon',
    displayName: 'IA - Vannon',
    templateName: 'IA - Vannon Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/vannon/Vannon_ai_config.json',
      downloadImagem: 'ia/vannon/download_de_imagens_IA_Vannon.json',
      buscaProdutos: 'ia/vannon/busca_produtos.json',
      ura: 'ia/vannon/ura_vannon.json',
      uraAb: 'ia/vannon/vannon_ab.json',
      preProcess: 'ia/vannon/pre_processamento.json',
    },
    installOrder: ['downloadImagem', 'buscaProdutos', 'preProcess', 'ura', 'uraAb'],
    updateOrder: ['downloadImagem', 'buscaProdutos', 'preProcess'],
    createConfigSnapshot(input = {}) {
      return {
        assistantDisplayName: input.name ?? '',
        clientName: input.clientName ?? '',
        clientEndpoint: input.clientEndpoint ?? '',
        apiKey: input.apiKey ?? '',
        cepLoja: input.cepLoja ?? '',
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.clientName || '',
        cliente_var: config.clientName || '',
        endpoint_var: normalizeBaseUrl(instance),
        api_var: config.apiKey || '',
        client_endpoint_var: getDominio(config.clientEndpoint || ''),
        cep_var: config.cepLoja || '',
        preProcessId: ids.preProcessId || '',
        busca_produtos_id: ids.buscaProdutosId || '',
        download_image_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.clientName &&
          record.configSnapshot?.clientEndpoint &&
          record.configSnapshot?.apiKey &&
          record.configSnapshot?.cepLoja,
      );
    },
  },
  vannon2: {
    provider: 'vannon2',
    displayName: 'IA - Vannon 2.0',
    templateName: 'IA - Vannon 2.0 Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/vannon2/vannon2_ia_config.json',
      // Os fluxos de produto consolidados da Vannon continuam compatíveis e
      // são reutilizados até que a nova automação de imagem seja fornecida.
      preProcess: 'ia/vannon/pre_processamento.json',
      buscaProdutos: 'ia/vannon/busca_produtos.json',
      downloadImagem: 'ia/vannon/download_de_imagens_IA_Vannon.json',
      transferirHumano: 'ia/vannon2/vannon2_transferir_humano.json',
      ura: 'ia/vannon2/vannon2_ura.json',
      uraAb: 'ia/alpha2/alpha2_ura_ab.json',
    },
    installOrder: ['preProcess', 'downloadImagem', 'buscaProdutos', 'transferirHumano', 'ura', 'uraAb'],
    updateOrder: ['preProcess', 'downloadImagem', 'buscaProdutos', 'transferirHumano'],
    createConfigSnapshot(input = {}) {
      return {
        assistantDisplayName: input.name ?? '',
        clientName: input.clientName ?? '',
        clientEndpoint: input.clientEndpoint ?? '',
        apiKey: input.apiKey ?? '',
        cepLoja: input.cepLoja ?? '',
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'Vannon',
        nome_cliente: config.clientName || '',
        cliente_var: config.clientName || '',
        endpoint_var: normalizeBaseUrl(instance),
        api_var: config.apiKey || '',
        client_endpoint_var: getDominio(config.clientEndpoint || ''),
        cep_var: config.cepLoja || '',
        preAutomationId: ids.preProcessId || '',
        busca_produtos_id: ids.buscaProdutosId || '',
        transfere_atendimento_id: ids.transferirHumanoId || '',
        download_image_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(record.assistantId && record.preProcessId && record.buscaProdutosId && record.downloadImagemId && record.transferirHumanoId && record.uraIaId && record.uraAbId && record.configSnapshot?.clientName && record.configSnapshot?.clientEndpoint && record.configSnapshot?.apiKey && record.configSnapshot?.cepLoja);
    },
  },
  vetor: {
    provider: 'vetor',
    displayName: 'IA - Vetor',
    templateName: 'IA - Vetor Integrada',
    fallbackVersion: 1,
    templatePaths: {
      assistant: 'ia/vetor/vetor_ai_config.json',
      downloadImagem: 'ia/vetor/download_de_imagens_IA_Vannon.json',
      buscaProdutos: 'ia/vetor/busca_produtos.json',
      ura: 'ia/vetor/ura_vetor.json',
      uraAb: 'ia/vetor/vannon_ab.json',
      preProcess: 'ia/vetor/pre_processamento.json',
    },
    installOrder: ['downloadImagem', 'buscaProdutos', 'preProcess', 'ura', 'uraAb'],
    updateOrder: ['downloadImagem', 'buscaProdutos', 'preProcess'],
    createConfigSnapshot(input = {}) {
      return {
        assistantDisplayName: input.name ?? '',
        clientName: input.clientName ?? '',
        apiKey: input.apiKey ?? '',
        vetorToken: input.vetorToken ?? '',
        unidade_negocio_vetor:
          input.unidade_negocio_vetor ?? input.unidadeNegocioVetor ?? '',
      };
    },
    buildTemplateVariables({ instance, assistantId, config = {}, ids = {} }) {
      return {
        id: assistantId,
        ia_id: assistantId,
        signaturename: config.assistantDisplayName || 'LeIA',
        nome_cliente: config.clientName || '',
        cliente_var: config.clientName || '',
        endpoint_var: normalizeBaseUrl(instance),
        api_var: config.apiKey || '',
        var_vetorKey: config.vetorToken || '',
        unidade_negocio_vetor: config.unidade_negocio_vetor || '',
        preProcessId: ids.preProcessId || '',
        busca_produtos_id: ids.buscaProdutosId || '',
        download_image_id: ids.downloadImagemId || '',
        ura_ia_id: ids.uraIaId || '',
      };
    },
    canUpdateInstallation(record = {}) {
      return Boolean(
        record.assistantId &&
          record.preProcessId &&
          record.buscaProdutosId &&
          record.downloadImagemId &&
          record.uraIaId &&
          record.uraAbId &&
          record.configSnapshot?.clientName &&
          record.configSnapshot?.apiKey &&
          record.configSnapshot?.vetorToken &&
          record.configSnapshot?.unidade_negocio_vetor,
      );
    },
  },
};

export const MANAGED_AI_PROVIDERS = Object.keys(MANAGED_AI_PROVIDER_DEFINITIONS);
export const NON_UPDATABLE_AI_PROVIDERS = ['atendimento'];

export function getManagedAiProviderDefinition(provider) {
  return MANAGED_AI_PROVIDER_DEFINITIONS[provider] || null;
}

export function isManagedAiProvider(provider) {
  return Boolean(getManagedAiProviderDefinition(provider));
}

export function createManagedAiConfigSnapshot(provider, input) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  return definition.createConfigSnapshot(input);
}

export function buildManagedAiTemplateVariables(provider, payload) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  return definition.buildTemplateVariables(payload);
}

export function getManagedAiInstallOrder(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  return [...definition.installOrder];
}

export function getManagedAiUpdateOrder(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  return [...(definition.updateOrder || definition.installOrder)];
}

export function isManagedAiComponentKey(componentKey) {
  return MANAGED_AI_COMPONENT_KEYS.includes(String(componentKey || '').trim());
}

export function isManagedAiManualUpdateOnlyComponentKey(componentKey) {
  return MANAGED_AI_MANUAL_UPDATE_COMPONENT_KEYS.includes(
    String(componentKey || '').trim(),
  );
}

export function getManagedAiTemplatePaths(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${provider}`);
  }

  return { ...definition.templatePaths };
}

export function canManagedAiInstallationBeUpdated(record) {
  if (isAiProviderUpdateBlocked(record?.provider)) {
    return false;
  }

  const definition = getManagedAiProviderDefinition(record?.provider);
  if (!definition) {
    return false;
  }

  return definition.canUpdateInstallation(record);
}

export function isAiProviderUpdateBlocked(provider) {
  return NON_UPDATABLE_AI_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

export function inferManagedAiProviderFromPayload(payload = {}) {
  const name = String(payload?.name || '').toLowerCase();
  const description = String(payload?.description || '').toLowerCase();

  if (name.includes('alpha7') || name.includes('alpha 7')) {
    return 'alpha7';
  }

  if (name.includes('alpha2') || name.includes('alpha 2.0')) {
    return 'alpha2';
  }

  if (name.includes('trier')) {
    if (name.includes('2.0') || name.includes('trier2')) return 'trier2';
    return 'trier';
  }

  if (name.includes('vtex')) {
    return 'vtex';
  }

  if (name.includes('vannon')) {
    return 'vannon';
  }

  if (name.includes('vetor')) {
    return 'vetor';
  }

  if (description.includes('vetor')) {
    return 'vetor';
  }

  if (description.includes('vannon')) {
    return 'vannon';
  }

  if (description.includes('vtex')) {
    return 'vtex';
  }

  return null;
}

export function getManagedAiProviderFallbackVersion(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  return Number(definition?.fallbackVersion || 1);
}

export function normalizeVtexBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let candidate = raw;

  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    try {
      const { hostname } = new URL(candidate);
      candidate = hostname;
    } catch {
      candidate = candidate
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .trim();
    }
  } else {
    candidate = candidate.replace(/\/.*$/, '').trim();
  }

  candidate = candidate.replace(/\.+$/, '').toLowerCase();

  if (!candidate) return '';

  if (candidate.includes('vtexcommercestable.com.br')) {
    return `https://${candidate}`.replace(/\/+$/, '');
  }

  if (!candidate.includes('.')) {
    candidate = `${candidate}.vtexcommercestable.com.br`;
    return `https://${candidate}`.replace(/\/+$/, '');
  }

  const normalizedHost = candidate.replace(/^www\./, '');
  const endpoint = normalizedHost.split('.')[0];

  if (!endpoint) return '';

  return `https://${endpoint}.vtexcommercestable.com.br`;
}

function getDominio(url) {
  if (!url) return '';

  const normalized = url.startsWith('http') ? url : `https://${url}`;
  const { hostname } = new URL(normalized);
  return hostname.split('.')[0];
}

function normalizeBaseUrl(url) {
  const normalized = url.startsWith('http') ? url : `https://${url}`;
  return normalized.replace(/\/+$/, '');
}

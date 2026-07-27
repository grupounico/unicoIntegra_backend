import { normalizeEan } from '../utils/ean.js';
import { pickFirstString } from '../utils/text.js';

const DEFAULT_BASE_URL = 'https://api.deliverypharmacy.com.br/v2/produto';
const DEFAULT_TIMEOUT_MS = Number(process.env.DELIVERY_PHARMACY_PRODUCTS_TIMEOUT_MS || 600_000);

function catalogItems(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.produtos || payload?.products || payload?.data || payload?.items || [];
}

function firstValue(item, ...keys) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item[key] !== null) return item[key];
  }
  return null;
}

export function mapDeliveryPharmacyProduct(item, index) {
  const nome = pickFirstString(
    firstValue(item, 'nome', 'name', 'descricao', 'description', 'titulo', 'title'),
  );
  const sourceId = firstValue(item, 'id', 'idProduto', 'codigo', 'codigoProduto', 'product_id', 'sku');

  return {
    id_produto: String(sourceId ?? index),
    nome,
    nomeOriginal: nome,
    codigoBarras: normalizeEan(
      firstValue(item, 'ean', 'codigoBarras', 'codigo_barras', 'codigobarras', 'barcode'),
    ),
    nomeLaboratorio: pickFirstString(
      firstValue(item, 'laboratorio', 'fabricante', 'marca', 'brand'),
    ),
    nomePrincipioAtivo: null,
    produtoOrigem: item,
  };
}

export class DeliveryPharmacyProductsClient {
  constructor({
    baseUrl = process.env.DELIVERY_PHARMACY_PRODUCTS_API_URL || DEFAULT_BASE_URL,
    token = '',
    companyId = '',
    erpId = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.baseUrl = String(baseUrl || '').trim();
    this.token = String(token || '').trim();
    this.companyId = String(companyId || '').trim();
    this.erpId = String(erpId || '').trim();
    this.timeoutMs = Math.max(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  validateConfiguration() {
    if (!this.baseUrl || !this.token || !this.companyId || !this.erpId) {
      throw new Error('Configuracao da Delivery Pharmacy incompleta. Informe token, Empresa ID e ERP ID.');
    }
  }

  describeSource() {
    return `deliverypharmacy://empresa-${this.companyId}/erp-${this.erpId}`;
  }

  async fetchAllProducts() {
    this.validateConfiguration();

    const response = await fetch(this.baseUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: /^Bearer\s+/i.test(this.token) ? this.token : `Bearer ${this.token}`,
        'x-id-empresa': this.companyId,
        'x-id-erp': this.erpId,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const bodyText = await response.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Preserve the status-specific error below when the upstream body is not JSON.
    }

    if (!response.ok) {
      const detail = pickFirstString(payload?.message, payload?.error, bodyText.slice(0, 300));
      throw new Error(`Falha na API Delivery Pharmacy: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
    }

    const products = catalogItems(payload);
    if (!Array.isArray(products)) {
      throw new Error('Resposta invalida da API Delivery Pharmacy: catalogo de produtos ausente.');
    }

    return products.map(mapDeliveryPharmacyProduct);
  }
}

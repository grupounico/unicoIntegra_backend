import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import prismaClientPackage from '@prisma/client';
import { prisma } from '../../prisma/PrismaClient.js';
import { createLogService } from './logs.services.js';
import { getClientWithCredential } from './clients.service.js';
import { BancoUnicoClient } from '../modules/banco-unico-import/runtime/services/banco-unico.client.js';
import { Alpha7ProductsClient } from '../modules/banco-unico-import/runtime/services/alpha7-products.client.js';
import { AutomatizaProductsClient } from '../modules/banco-unico-import/runtime/services/automatiza-products.client.js';
import { MercadologicalClassifierService } from '../modules/banco-unico-import/runtime/services/mercadological-classifier.service.js';
import { MercadologicalTreeService } from '../modules/banco-unico-import/runtime/services/mercadological-tree.service.js';
import { TrierProductsClient } from '../modules/banco-unico-import/runtime/services/trier-products.client.js';
import { VetorProductsClient } from '../modules/banco-unico-import/runtime/services/vetor-products.client.js';
import { DeliveryPharmacyProductsClient } from '../modules/banco-unico-import/runtime/services/delivery-pharmacy-products.client.js';
import {
  isValidEan,
  normalizeEan,
} from '../modules/banco-unico-import/runtime/utils/ean.js';
import {
  normalizarNomeComIA,
  normalizarNomeLocal,
} from '../modules/banco-unico-import/runtime/utils/openaiNormalizer.js';
import {
  chunk,
  pickFirstString,
} from '../modules/banco-unico-import/runtime/utils/text.js';

const { Prisma } = prismaClientPackage;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TAXONOMY_PATH = path.resolve(
  __dirname,
  '../modules/banco-unico-import/runtime/data/levantamento_arvore_mercadologica.csv',
);
const DEFAULT_BANCO_UNICO_BASE_URL = 'https://unicocontato.tech/banco-unico';
const DEFAULT_SOURCE_API_URL =
  'https://api-sgf-gateway.triersistemas.com.br/sgfpod1/rest/integracao/produto/obter-todos-v1';
const ACTIVE_JOBS = new Map();
const STREAM_SUBSCRIBERS = new Map();
const RECOVERABLE_JOB_STATUSES = ['pending', 'claimed', 'processing', 'running', 'cancelling'];
const ACTIVE_OR_PAUSED_JOB_STATUSES = [...RECOVERABLE_JOB_STATUSES, 'paused'];
const WORKER_POLL_INTERVAL_MS = 15000;
const WORKER_LEASE_MS = 60_000;
const WORKER_ID = `${os.hostname()}:${process.pid}`;
let workerInitialized = false;

class ImportCancelledError extends Error {
  constructor() {
    super('Importacao cancelada pelo usuario.');
    this.name = 'ImportCancelledError';
  }
}

function toNumber(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (min !== null && parsed < min) {
    return fallback;
  }

  if (max !== null && parsed > max) {
    return fallback;
  }

  return parsed;
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return fallback;
}

function percentage(part, total) {
  if (!total) {
    return 0;
  }

  return Number(((part / total) * 100).toFixed(2));
}

function normalizeLoadedProducts(products) {
  if (Array.isArray(products)) {
    return products;
  }

  if (Array.isArray(products?.products)) {
    return products.products;
  }

  if (Array.isArray(products?.produtos)) {
    return products.produtos;
  }

  return [];
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content.replace(/^\uFEFF/, ''));
}

function ensureActiveJob(jobId) {
  const activeJob = ACTIVE_JOBS.get(jobId);
  if (!activeJob) {
    throw new Error('Importacao nao esta em execucao.');
  }

  return activeJob;
}

function hasAnotherActiveJobForClient({ jobId, clientId, clientName }) {
  for (const [activeJobId, activeJob] of ACTIVE_JOBS.entries()) {
    if (activeJobId === jobId) {
      continue;
    }

    if (clientId && activeJob.clientId && activeJob.clientId === clientId) {
      return true;
    }

    if (
      !clientId &&
      clientName &&
      activeJob.clientName &&
      activeJob.clientName === clientName
    ) {
      return true;
    }
  }

  return false;
}

function assertNotCancelled(jobId) {
  const activeJob = ACTIVE_JOBS.get(jobId);
  if (activeJob?.cancelRequested) {
    throw new ImportCancelledError();
  }
}

async function waitIfPaused(jobId) {
  let activeJob = ACTIVE_JOBS.get(jobId);
  if (!activeJob?.pauseRequested) {
    return;
  }

  if (!activeJob.pauseAnnounced) {
    activeJob.pauseAnnounced = true;
    activeJob.resumeStage = activeJob.resumeStage || 'running';
    activeJob.resumeMessage = activeJob.resumeMessage || 'Importacao retomada.';
    await updateJob(jobId, {
      status: 'paused',
      currentStage: 'paused',
      currentMessage: 'Importacao pausada pelo usuario. O lote atual foi concluido com seguranca.',
    });
    await emitEvent(jobId, 'Importacao pausada. Aguardando retomada.', 'warning');
  }

  while (activeJob?.pauseRequested) {
    await activeJob.pausePromise;
    assertNotCancelled(jobId);
    activeJob = ACTIVE_JOBS.get(jobId);
  }
}

async function assertJobCanContinue(jobId) {
  assertNotCancelled(jobId);
  await waitIfPaused(jobId);
  assertNotCancelled(jobId);
}

async function emitEvent(jobId, message, level = 'info', data = null) {
  const createdEvent = await prisma.bancoUnicoImportEvent.create({
    data: {
      jobId,
      level,
      message,
      data,
    },
  });
  publishStreamEvent(jobId, 'event', createdEvent);
}

async function updateJob(jobId, data) {
  const activeJob = ACTIVE_JOBS.get(Number(jobId));
  const nextData =
    activeJob?.workerId === WORKER_ID
      ? { ...data, workerHeartbeatAt: new Date() }
      : data;
  const updatedJob = await prisma.bancoUnicoImportJob.update({
    where: { id: jobId },
    data: nextData,
    select: jobSelect(),
  });
  publishStreamEvent(jobId, 'job', formatJob(updatedJob));
}

function buildSummary(metrics) {
  return {
    totalCatalogoValido: metrics.totalCatalogValid,
    totalEansInvalidos: metrics.totalInvalidEans,
    totalAmostraSolicitada: metrics.totalSampled,
    totalSelecionados: metrics.totalSelected,
    totalExistentesNoBanco: metrics.totalExisting,
    percentualExistentesNoBanco: percentage(
      metrics.totalExisting,
      metrics.totalSampled,
    ),
    totalPreparados: metrics.totalPrepared,
    totalPulados: metrics.totalSkipped,
    totalErros: metrics.totalErrors,
    percentualErros: percentage(metrics.totalErrors, metrics.totalSampled),
    totalSubidos: metrics.totalPublished,
    percentualSubidos: percentage(metrics.totalPublished, metrics.totalSampled),
  };
}

function jobSelect() {
  return {
    id: true,
    clientId: true,
    clientName: true,
    sourceType: true,
    sourceLabel: true,
    status: true,
    mode: true,
    requestedBy: true,
    currentStage: true,
    currentMessage: true,
    progressCurrent: true,
    progressTotal: true,
    progressPercent: true,
    totalCatalogValid: true,
    totalInvalidEans: true,
    totalSampled: true,
    totalSelected: true,
    totalExisting: true,
    totalPrepared: true,
    totalSkipped: true,
    totalErrors: true,
    totalPublished: true,
    options: true,
    summary: true,
    startedAt: true,
    finishedAt: true,
    createdAt: true,
    updatedAt: true,
    _count: {
      select: {
        items: true,
        events: true,
      },
    },
  };
}

function formatJob(job) {
  return {
    ...job,
    itemCount: job._count?.items ?? 0,
    eventCount: job._count?.events ?? 0,
  };
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getStreamSubscribers(jobId) {
  if (!STREAM_SUBSCRIBERS.has(jobId)) {
    STREAM_SUBSCRIBERS.set(jobId, new Set());
  }

  return STREAM_SUBSCRIBERS.get(jobId);
}

function publishStreamEvent(jobId, eventName, payload) {
  const subscribers = STREAM_SUBSCRIBERS.get(Number(jobId));
  if (!subscribers?.size) {
    return;
  }

  for (const res of subscribers) {
    try {
      writeSseEvent(res, eventName, payload);
    } catch (error) {
      try {
        res.end();
      } catch {}
      subscribers.delete(res);
    }
  }

  if (!subscribers.size) {
    STREAM_SUBSCRIBERS.delete(Number(jobId));
  }
}

function publishItemsChanged(jobId, payload = {}) {
  publishStreamEvent(Number(jobId), 'items_changed', {
    jobId: Number(jobId),
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function buildItemRecord(jobId, itemOutput, status, overrides = {}) {
  return {
    jobId,
    externalKey: `${jobId}:${itemOutput.id_produto ?? 'no-id'}:${itemOutput.ean ?? 'no-ean'}`,
    sourceProductId: Number.isInteger(itemOutput.id_produto)
      ? itemOutput.id_produto
      : null,
    ean: itemOutput.ean || null,
    nameOriginal: itemOutput.nomeOriginal || null,
    nameNormalized: itemOutput.nomeNormalizadoFinal || null,
    manufacturer: itemOutput.fabricante || null,
    activeIngredient: itemOutput.principioAtivo || null,
    status,
    skippedReason: itemOutput.skippedReason || null,
    errorStage: itemOutput.errorStage || null,
    errorMessage: itemOutput.errorMessage || null,
    confidence: itemOutput.confiancaNormalizacao || null,
    needsReview: Boolean(itemOutput.precisaRevisaoNormalizacao || itemOutput.needsReview),
    taxonomy: itemOutput.taxonomy || null,
    metadata: itemOutput.metadata || null,
    payload: itemOutput.payload || null,
    sourcePayload: itemOutput.produtoOrigem || itemOutput.sourcePayload || null,
    ...overrides,
  };
}

function mapProductRef(product) {
  return {
    id_produto: Number.isInteger(product?.id_produto) ? product.id_produto : null,
    ean: normalizeEan(product?.codigoBarras || product?.ean),
    nomeOriginal: pickFirstString(product?.nomeOriginal, product?.nome),
    nomeNormalizadoFinal: pickFirstString(
      product?.nomeNormalizadoFinal,
      product?.nomeOriginal,
      product?.nome,
    ),
    principioAtivo: pickFirstString(product?.nomePrincipioAtivo),
    fabricante: pickFirstString(product?.nomeLaboratorio),
    produtoOrigem: product?.produtoOrigem || product || null,
  };
}

function isCompleteTaxonomy(taxonomy) {
  return Boolean(
    taxonomy &&
      taxonomy.departamento &&
      taxonomy.categoria &&
      taxonomy.subcategoria &&
      taxonomy.segmento &&
      taxonomy.subsegmento,
  );
}

function buildPayload(product, classification) {
  return {
    descricaoProduto: product.nomeNormalizadoFinal,
    ean: normalizeEan(product.codigoBarras || product.ean),
    ...(pickFirstString(product.nomePrincipioAtivo)
      ? { principioAtivo: pickFirstString(product.nomePrincipioAtivo) }
      : {}),
    ...(pickFirstString(product.nomeLaboratorio)
      ? { fabricante: pickFirstString(product.nomeLaboratorio) }
      : {}),
    ...classification,
  };
}

function buildDetalhes(product, options = {}) {
  const provider = options.sourceProviderLabel || 'Origem desconhecida';
  const iaNaClarificacao =
    !options.disableNormalizeAi && options.useAiNormalization;
  const origemClarificacao = iaNaClarificacao
    ? 'clarificado por ia'
    : 'clarificado localmente';
  const detalhesBase = `${origemClarificacao} - ${provider}`;
  const nomeOriginal = pickFirstString(product.nomeOriginal, product.nome);
  const nomeFinal = pickFirstString(product.nomeNormalizadoFinal);

  if (nomeOriginal && nomeFinal && nomeOriginal.trim() !== nomeFinal.trim()) {
    return `${detalhesBase} | original: ${nomeOriginal}`;
  }

  return detalhesBase;
}

function buildPayloadWithOptions(product, classification, options = {}) {
  return {
    descricaoProduto: product.nomeNormalizadoFinal,
    ean: normalizeEan(product.codigoBarras || product.ean),
    detalhes: buildDetalhes(product, options),
    ...(pickFirstString(product.nomePrincipioAtivo)
      ? { principioAtivo: pickFirstString(product.nomePrincipioAtivo) }
      : {}),
    ...(pickFirstString(product.nomeLaboratorio)
      ? { fabricante: pickFirstString(product.nomeLaboratorio) }
      : {}),
    ...classification,
  };
}

async function normalizeProduct(product, options) {
  const existingNormalizedName = String(product?.nomeNormalizadoFinal || '').trim();
  const shouldRenormalizeExistingName =
    /\b(?:DEP|ENX\s+B|S\/PERF|FRES\s+MIN|U\s+SHEER|ST\s+M|ESFOL|SENSIT|BRANQ|FRD|CHICLE|FORTIF\/|AMONIA|LOCAO|ATAD|LENCO\s+UMD|UMD\s+FRESHQ|PAP\s+FRESHQ|GELEGELE|NATURELIF|LEITE\s+COND|UNIDADES\s+C[ÁA]PS|CX\s+C\/)\b/i.test(
      existingNormalizedName,
    );

  if (existingNormalizedName && !shouldRenormalizeExistingName) {
    return {
      ...product,
      nomeOriginal: pickFirstString(product.nomeOriginal, product.nome),
      nomeNormalizadoFinal: existingNormalizedName,
    };
  }

  const shouldUseAiNormalization =
    !options.disableNormalizeAi && options.useAiNormalization;
  const normalized = shouldUseAiNormalization
    ? await normalizarNomeComIA(product)
    : normalizarNomeLocal(product);

  return {
    ...product,
    ...normalized,
  };
}

async function mapWithConcurrency(items, concurrency, iteratee, jobId) {
  const results = new Array(items.length);
  let nextIndex = 0;
  // ponytail: Promise.all rejects as soon as one worker throws, but sibling
  // workers keep pulling from the shared queue unless told to stop — that's
  // what let processing/publishing continue after a job was already marked
  // "failed". This flag makes every worker bail before claiming new work.
  let stopped = false;

  async function worker() {
    while (!stopped) {
      await assertJobCanContinue(jobId);
      if (stopped) return;
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      try {
        results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

async function lookupExistingEans(products, client, options, jobId, onProgress) {
  const eans = [
    ...new Set(
      products
        .map((product) => normalizeEan(product.codigoBarras || product.ean))
        .filter(Boolean),
    ),
  ];

  const batches = chunk(eans, options.existingCheckBatchSize);
  let completedBatches = 0;
  let checkedEans = 0;
  const foundEans = new Set();
  let progressWrite = Promise.resolve();
  const foundBatches = await mapWithConcurrency(
    batches,
    options.existingCheckConcurrency,
    async (batch, index) => {
      await emitEvent(
        jobId,
        `Consultando EANs existentes ${index + 1}/${batches.length} (${batch.length} EANs).`,
      );
      const results = await client.searchProductsByEans(batch);
      completedBatches += 1;
      checkedEans += batch.length;
      for (const item of results || []) {
        const ean = String(item?.ean || '').trim();
        if (ean) foundEans.add(ean);
      }

      if (onProgress && (completedBatches % 5 === 0 || completedBatches === batches.length)) {
        const snapshot = {
          completedBatches,
          totalBatches: batches.length,
          checkedEans,
          foundEans: foundEans.size,
        };
        // Serialize database notifications so an earlier async write cannot
        // overwrite a newer progress snapshot.
        progressWrite = progressWrite.then(() => onProgress(snapshot));
      }

      return results;
    },
    jobId,
  );
  await progressWrite;

  const existingEans = new Set();
  for (const batchResults of foundBatches) {
    for (const item of batchResults || []) {
      const ean = String(item?.ean || '').trim();
      if (ean) {
        existingEans.add(ean);
      }
    }
  }

  return existingEans;
}

// Mantém a mesma seleção incremental do normalizador V25: quando o operador
// pede N novos, consulta janelas sucessivas até encontrá-los, sem normalizar
// nem publicar os EANs que já existem no Banco Único.
async function selectProductsForProcessing(
  validProducts,
  bancoUnicoClient,
  options,
  jobId,
  onExistingCheckProgress,
) {
  const slice = (products) => products.slice(
    options.offset,
    options.limit ? options.offset + options.limit : undefined,
  );

  if (options.ignoreExistingCheck) {
    const sampledProducts = slice(validProducts);
    return {
      sampledProducts,
      selectedProducts: options.limitNew
        ? sampledProducts.slice(0, options.limitNew)
        : sampledProducts,
      existingEans: new Set(),
    };
  }

  if (options.limitNew === null) {
    const sampledProducts = slice(validProducts);
    const existingEans = await lookupExistingEans(
      sampledProducts,
      bancoUnicoClient,
      options,
      jobId,
      onExistingCheckProgress,
    );
    return {
      sampledProducts,
      selectedProducts: sampledProducts.filter(
        (product) => !existingEans.has(normalizeEan(product.codigoBarras || product.ean)),
      ),
      existingEans,
    };
  }

  const targetNew = options.limitNew;
  const sampledProducts = [];
  const selectedProducts = [];
  const existingEans = new Set();
  const scanWindowSize = Math.max(
    options.existingCheckBatchSize * Math.max(options.existingCheckConcurrency, 1) * 5,
    targetNew,
    200,
  );
  let cursor = options.offset;
  const maxCursor = options.limit
    ? Math.min(validProducts.length, options.offset + options.limit)
    : validProducts.length;

  while (cursor < maxCursor && selectedProducts.length < targetNew) {
    const windowProducts = validProducts.slice(
      cursor,
      Math.min(cursor + scanWindowSize, maxCursor),
    );
    if (!windowProducts.length) break;

    sampledProducts.push(...windowProducts);
    const windowExisting = await lookupExistingEans(
      windowProducts,
      bancoUnicoClient,
      options,
      jobId,
      onExistingCheckProgress,
    );
    for (const ean of windowExisting) existingEans.add(ean);

    for (const product of windowProducts) {
      const ean = normalizeEan(product.codigoBarras || product.ean);
      if (!existingEans.has(ean) && selectedProducts.length < targetNew) {
        selectedProducts.push(product);
      }
    }
    cursor += windowProducts.length;
  }

  return { sampledProducts, selectedProducts, existingEans };
}

async function normalizeOptions(payload, requestedBy) {
  const client = payload.clientId
    ? await getClientWithCredential(payload.clientId)
    : null;

  const clientName = client ? client.name : String(payload.clientName || '').trim();
  if (!clientName) {
    throw new Error('Informe o cliente.');
  }

  const sourceType = client
    ? client.provider === 'api'
      ? 'trier'
      : client.provider
    : payload.sourceType === 'file'
      ? 'file'
      : payload.sourceType === 'alpha7'
        ? 'alpha7'
        : payload.sourceType === 'trier'
          ? 'trier'
          : String(payload.sourceType || '').trim();

  const sourceFilePath =
    client && client.provider === 'file'
      ? client.instance
      : String(payload.sourceFilePath || '').trim();
  if (sourceType === 'file' && !sourceFilePath) {
    throw new Error('Informe o caminho do arquivo quando a origem for arquivo.');
  }

  const sourceApiUrl =
    sourceType === 'trier' && client && client.provider === 'api'
      ? DEFAULT_SOURCE_API_URL
      : String(payload.sourceApiUrl || DEFAULT_SOURCE_API_URL).trim();
  const sourceToken =
    sourceType === 'trier' && client && client.provider === 'api'
      ? String(client.credential || '').trim()
      : String(payload.sourceToken || '').trim();
  if (sourceType === 'trier' && !sourceToken) {
    throw new Error('Informe o token da API Trier de origem.');
  }

  const alpha7Host =
    client && client.provider === 'alpha7' ? client.instance : String(payload.alpha7Host || '').trim();
  const alpha7Database =
    client && client.provider === 'alpha7'
      ? client.alpha7Database || ''
      : String(payload.alpha7Database || '').trim();
  const alpha7User =
    client && client.provider === 'alpha7'
      ? client.alpha7User || ''
      : String(payload.alpha7User || '').trim();
  const alpha7Password =
    client && client.provider === 'alpha7'
      ? String(client.credential || '').trim()
      : String(payload.alpha7Password || '').trim();
  const alpha7Schema =
    client && client.provider === 'alpha7'
      ? client.alpha7Schema || 'public'
      : String(payload.alpha7Schema || 'public').trim() || 'public';
  if (
    sourceType === 'alpha7' &&
    (!alpha7Host || !alpha7Database || !alpha7User || !alpha7Password)
  ) {
    throw new Error(
      'Informe host, database, usuario e senha quando a origem for Alpha 7.',
    );
  }

  const automatizaHost =
    client && client.provider === 'automatiza'
      ? client.instance
      : String(payload.automatizaHost || '').trim();
  const automatizaPort =
    client && client.provider === 'automatiza'
      ? client.alpha7Port || 3306
      : toNumber(payload.automatizaPort, 3306, { min: 1 });
  const automatizaDatabase =
    client && client.provider === 'automatiza'
      ? client.alpha7Database || ''
      : String(payload.automatizaDatabase || '').trim();
  const automatizaUser =
    client && client.provider === 'automatiza'
      ? client.alpha7User || ''
      : String(payload.automatizaUser || '').trim();
  const automatizaPassword =
    client && client.provider === 'automatiza'
      ? String(client.credential || '').trim()
      : String(payload.automatizaPassword || '').trim();
  const automatizaShopId =
    client && client.provider === 'automatiza'
      ? Number(client.automatizaShopId || 0)
      : toNumber(payload.automatizaShopId, 0, { min: 1 });
  if (
    sourceType === 'automatiza' &&
    (!automatizaHost || !automatizaDatabase || !automatizaUser || !automatizaPassword || !automatizaShopId)
  ) {
    throw new Error(
      'Informe host, database, usuario, senha e shop ID quando a origem for Automatiza.',
    );
  }

  const vetorToken =
    client && client.provider === 'vetor'
      ? String(client.credential || '').trim()
      : String(payload.vetorToken || '').trim();
  const vetorUnidade =
    client && client.provider === 'vetor'
      ? String(client.instance || '').trim()
      : String(payload.vetorUnidade || '').trim();
  if (sourceType === 'vetor' && !vetorToken) {
    throw new Error('Informe o token da API Vetor.');
  }

  const deliveryPharmacyToken =
    client && client.provider === 'deliverypharmacy'
      ? String(client.credential || '').trim()
      : String(payload.deliveryPharmacyToken || '').trim();
  const deliveryPharmacyCompanyId =
    client && client.provider === 'deliverypharmacy'
      ? String(client.deliveryCompanyId || '').trim()
      : String(payload.deliveryPharmacyCompanyId || '').trim();
  const deliveryPharmacyErpId =
    client && client.provider === 'deliverypharmacy'
      ? String(client.deliveryErpId || '').trim()
      : String(payload.deliveryPharmacyErpId || '').trim();
  if (sourceType === 'deliverypharmacy' && (!deliveryPharmacyToken || !deliveryPharmacyCompanyId || !deliveryPharmacyErpId)) {
    throw new Error('Informe token, Empresa ID e ERP ID da Delivery Pharmacy.');
  }

  const authorization = String(payload.bancoUnicoAuthorization || '').trim();

  return {
    clientId: client ? client.id : null,
    clientName,
    requestedBy,
    sourceType,
    sourceLabel:
      sourceType === 'trier'
        ? sourceApiUrl
        : sourceType === 'alpha7'
          ? `alpha7-postgres://${alpha7Host}/${alpha7Database}`
          : sourceType === 'vetor'
            ? `vetor://unidade-${vetorUnidade || '?'}`
            : sourceType === 'automatiza'
              ? `automatiza-mysql://${automatizaHost}:${automatizaPort}/${automatizaDatabase}#shop-${automatizaShopId}`
              : sourceType === 'deliverypharmacy'
                ? `deliverypharmacy://empresa-${deliveryPharmacyCompanyId}/erp-${deliveryPharmacyErpId}`
                : sourceFilePath,
    sourceFilePath,
    sourceApiUrl,
    sourceToken,
    sourcePageSize: toNumber(payload.sourcePageSize, 999, { min: 1 }),
    sourceAtivo: toBoolean(payload.sourceAtivo, true),
    sourceIntegracaoEcommerce: toBoolean(
      payload.sourceIntegracaoEcommerce,
      true,
    ),
    sourceProcessaCustoMedio: toBoolean(
      payload.sourceProcessaCustoMedio,
      false,
    ),
    alpha7Host,
    alpha7Port:
      client && client.provider === 'alpha7'
        ? client.alpha7Port || 5432
        : toNumber(payload.alpha7Port, 5432, { min: 1 }),
    alpha7Database,
    alpha7User,
    alpha7Password,
    alpha7Schema,
    automatizaHost,
    automatizaPort,
    automatizaDatabase,
    automatizaUser,
    automatizaPassword,
    automatizaShopId,
    vetorToken,
    vetorUnidade,
    deliveryPharmacyToken,
    deliveryPharmacyCompanyId,
    deliveryPharmacyErpId,
    batchSize: toNumber(payload.batchSize, 50, { min: 1 }),
    classifyConcurrency: toNumber(payload.classifyConcurrency, 5, { min: 1 }),
    publishConcurrency: toNumber(payload.publishConcurrency, 1, { min: 1 }),
    existingCheckBatchSize: toNumber(payload.existingCheckBatchSize, 100, {
      min: 1,
    }),
    existingCheckConcurrency: toNumber(payload.existingCheckConcurrency, 2, {
      min: 1,
    }),
    mode: payload.mode === 'classify-only' ? 'classify-only' : 'publish',
    disableNormalizeAi: toBoolean(payload.disableNormalizeAi, false),
    disableAi: toBoolean(payload.disableAi, false),
    // A full Automatiza catalog may contain thousands of products. Prefer the
    // deterministic taxonomy match and only call IA for ambiguous products.
    forceTaxonomyAi:
      sourceType === 'automatiza'
        ? false
        : toBoolean(payload.forceTaxonomyAi, false),
    ignoreExistingCheck: toBoolean(payload.ignoreExistingCheck, false),
    useAiNormalization: toBoolean(payload.useAiNormalization, false),
    bancoUnicoBaseUrl: String(
      payload.bancoUnicoBaseUrl || DEFAULT_BANCO_UNICO_BASE_URL,
    ).trim(),
    bancoUnicoAuthorization: authorization,
    taxonomyPath: process.env.MERCADOLOGICAL_TREE_CSV_PATH || DEFAULT_TAXONOMY_PATH,
    limit: payload.limit ? toNumber(payload.limit, null, { min: 1 }) : null,
    limitNew: payload.limitNew
      ? toNumber(payload.limitNew, null, { min: 1 })
      : null,
    offset: toNumber(payload.offset, 0, { min: 0 }),
  };
}

async function loadSourceProducts(options, jobId = null) {
  if (options.sourceType === 'file') {
    const loaded = await readJson(path.resolve(options.sourceFilePath));
    return {
      products: normalizeLoadedProducts(loaded),
      sourceLabel: options.sourceFilePath,
      sourceProviderLabel: 'Arquivo local',
    };
  }

  if (options.sourceType === 'alpha7') {
    const client = new Alpha7ProductsClient({
      host: options.alpha7Host,
      port: options.alpha7Port,
      database: options.alpha7Database,
      user: options.alpha7User,
      password: options.alpha7Password,
      schema: options.alpha7Schema,
      pageSize: options.sourcePageSize,
    });

    return {
      products: await client.fetchAllProducts(),
      sourceLabel: client.describeSource(),
      sourceProviderLabel: 'Alpha 7',
    };
  }

  if (options.sourceType === 'vetor') {
    const client = new VetorProductsClient({
      token: options.vetorToken,
      unidade: options.vetorUnidade,
      pageSize: options.sourcePageSize,
    });

    return {
      products: await client.fetchAllProducts(),
      sourceLabel: client.describeSource(),
      sourceProviderLabel: 'Vetor',
    };
  }

  if (options.sourceType === 'automatiza') {
    const client = new AutomatizaProductsClient({
      host: options.automatizaHost,
      port: options.automatizaPort,
      database: options.automatizaDatabase,
      user: options.automatizaUser,
      password: options.automatizaPassword,
      shopId: options.automatizaShopId,
      pageSize: options.sourcePageSize,
    });

    return {
      products: await client.fetchAllProducts(),
      sourceLabel: client.describeSource(),
      sourceProviderLabel: 'Automatiza',
    };
  }

  if (options.sourceType === 'deliverypharmacy') {
    const client = new DeliveryPharmacyProductsClient({
      token: options.deliveryPharmacyToken,
      companyId: options.deliveryPharmacyCompanyId,
      erpId: options.deliveryPharmacyErpId,
    });

    return {
      products: await client.fetchAllProducts(),
      sourceLabel: client.describeSource(),
      sourceProviderLabel: 'Delivery Pharmacy',
    };
  }

  if (options.sourceType !== 'trier') {
    throw new Error(`Origem de importacao nao suportada: ${options.sourceType}.`);
  }

  const client = new TrierProductsClient({
    baseUrl: options.sourceApiUrl,
    token: options.sourceToken,
    pageSize: options.sourcePageSize,
    ativo: options.sourceAtivo,
    integracaoEcommerce: options.sourceIntegracaoEcommerce,
    processaCustoMedio: options.sourceProcessaCustoMedio,
  });

  // ponytail: writing each page's ~999 provisional rows to Postgres was
  // AWAITED before fetching the next page, so the loading phase paid Trier's
  // latency AND the DB write latency, back to back, page after page (this is
  // why the raw script — which just appends to a local JSON file — felt
  // instant by comparison). The provisional rows only exist for early UI
  // feedback; nothing downstream depends on them landing before the next
  // page starts. Fire the write and keep paging; join outstanding writes
  // once all pages are in.
  const products = await client.fetchAllProducts({
    shouldContinue: () => {
      if (jobId !== null) {
        assertNotCancelled(jobId);
      }
    },
    onPage: async ({ page, count, loaded, products: pageProducts }) => {
      if (jobId === null) {
        return;
      }

      await assertJobCanContinue(jobId);

      await updateJob(jobId, {
        currentStage: 'loading_source',
        currentMessage: `Carregando produtos de origem. Pagina ${page} (${loaded} acumulados).`,
      });
      await emitEvent(
        jobId,
        `Origem Trier: pagina ${page} carregada com ${count} produto(s) (${loaded} acumulados).`,
      );

    },
    onRetry: async ({ attempt, delayMs, error, page }) => {
      if (jobId === null) {
        return;
      }

      await updateJob(jobId, {
        currentStage: 'loading_source',
        currentMessage: `Origem Trier instavel. Nova tentativa ${attempt} para a pagina ${page} em ${Math.ceil(delayMs / 1000)}s.`,
      });
      await emitEvent(
        jobId,
        `Origem Trier instavel na pagina ${page}. Tentativa ${attempt} em ${Math.ceil(delayMs / 1000)}s. Motivo: ${error.message}`,
        'warning',
      );
    },
  });

  return {
    products,
    sourceLabel: client.baseUrl,
    sourceProviderLabel: 'Trier',
  };
}

// Source payloads can be large JSON documents. Small, sequential inserts keep
// the control database responsive while product classification is running.
const PERSIST_BULK_CHUNK = 10;
const PERSIST_BULK_MAX_ATTEMPTS = 3;

function isTransientPersistenceError(error) {
  return /operation has timed out|timeout|connection.*closed|connection.*reset/i.test(
    String(error?.message || ''),
  );
}

async function persistItemChunk(recordsChunk) {
  for (let attempt = 1; attempt <= PERSIST_BULK_MAX_ATTEMPTS; attempt += 1) {
    try {
      await prisma.bancoUnicoImportItem.createMany({
        data: recordsChunk,
        skipDuplicates: true,
      });
      return;
    } catch (error) {
      if (!isTransientPersistenceError(error) || attempt === PERSIST_BULK_MAX_ATTEMPTS) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

async function persistItemBatch(records) {
  if (!records.length) {
    return;
  }

  // Import records are immutable per attempt. A retry clears them first; on a
  // resumed worker, duplicate external keys already represent the same item.
  // Keep writes serial because each record may include the full source JSON.
  for (const recordsChunk of chunk(records, PERSIST_BULK_CHUNK)) {
    await persistItemChunk(recordsChunk);
  }

  publishItemsChanged(records[0].jobId, {
    count: records.length,
    statuses: [...new Set(records.map((record) => record.status))],
  });
}

async function setProgress(jobId, metrics, stage, message) {
  const summary = buildSummary(metrics);
  await updateJob(jobId, {
    status: 'processing',
    currentStage: stage,
    currentMessage: message,
    progressCurrent: metrics.progressCurrent,
    progressTotal: metrics.progressTotal,
    progressPercent: metrics.progressPercent,
    totalCatalogValid: metrics.totalCatalogValid,
    totalInvalidEans: metrics.totalInvalidEans,
    totalSampled: metrics.totalSampled,
    totalSelected: metrics.totalSelected,
    totalExisting: metrics.totalExisting,
    totalPrepared: metrics.totalPrepared,
    totalSkipped: metrics.totalSkipped,
    totalErrors: metrics.totalErrors,
    totalPublished: metrics.totalPublished,
    summary,
  });
}

async function runImportJob(jobId, options) {
  const existingActiveState = ACTIVE_JOBS.get(jobId);
  ACTIVE_JOBS.set(jobId, {
    cancelRequested: existingActiveState?.cancelRequested ?? false,
    pauseRequested: existingActiveState?.pauseRequested ?? false,
    pausePromise: existingActiveState?.pausePromise ?? null,
    resume: existingActiveState?.resume ?? null,
    pauseAnnounced: existingActiveState?.pauseAnnounced ?? false,
    resumeStage: existingActiveState?.resumeStage ?? null,
    resumeMessage: existingActiveState?.resumeMessage ?? null,
    workerId: existingActiveState?.workerId ?? WORKER_ID,
    clientId: options.clientId ?? null,
    clientName: options.clientName ?? null,
  });

  const metrics = {
    progressCurrent: 0,
    progressTotal: 0,
    progressPercent: 0,
    totalCatalogValid: 0,
    totalInvalidEans: 0,
    totalSampled: 0,
    totalSelected: 0,
    totalExisting: 0,
    totalPrepared: 0,
    totalSkipped: 0,
    totalErrors: 0,
    totalPublished: 0,
  };

  try {
    await createLogService(
      options.requestedBy,
      `Iniciou subida Banco Unico #${jobId} para ${options.clientName}`,
      options.clientName,
    );

    const treeService = new MercadologicalTreeService({
      csvPath: options.taxonomyPath,
    });
    if (!treeService.isConfigured()) {
      throw new Error(
        `Arvore mercadologica nao encontrada em ${options.taxonomyPath}.`,
      );
    }

    const classifier = new MercadologicalClassifierService({ treeService });
    const bancoUnicoClient = new BancoUnicoClient({
      baseUrl: options.bancoUnicoBaseUrl,
      authorization: options.bancoUnicoAuthorization,
    });

    await updateJob(jobId, {
      status: 'processing',
      startedAt: new Date(),
      currentStage: 'loading_source',
      currentMessage: 'Carregando produtos de origem.',
    });
    await emitEvent(jobId, 'Importacao iniciada.');
    await assertJobCanContinue(jobId);

    const {
      products: allProducts,
      sourceLabel,
      sourceProviderLabel,
    } = await loadSourceProducts(options, jobId);
    await updateJob(jobId, { sourceLabel });
    await emitEvent(
      jobId,
      `${allProducts.length} produto(s) carregado(s) da origem.`,
    );

    const invalidEanRecords = [];
    const validProducts = [];

    for (const product of allProducts) {
      const ean = normalizeEan(product.codigoBarras || product.ean);
      const name = pickFirstString(
        product.nomeNormalizadoFinal,
        product.nomeOriginal,
        product.nome,
      );

      if (!name) {
        continue;
      }

      if (!isValidEan(ean)) {
        invalidEanRecords.push(
          buildItemRecord(
            jobId,
            {
              ...mapProductRef(product),
              ean,
              skippedReason: 'invalid_ean',
              payload: null,
            },
            'invalid_ean',
          ),
        );
        continue;
      }

      validProducts.push({
        ...product,
        codigoBarras: ean,
      });
    }

    await persistItemBatch(invalidEanRecords);

    metrics.totalCatalogValid = validProducts.length;
    metrics.totalInvalidEans = invalidEanRecords.length;

    await setProgress(
      jobId,
      metrics,
      'checking_existing',
      'Consultando itens existentes no Banco Unico.',
    );

    const {
      sampledProducts,
      selectedProducts,
      existingEans,
    } = await selectProductsForProcessing(
      validProducts,
      bancoUnicoClient,
      options,
      jobId,
      async ({ completedBatches, totalBatches, checkedEans, foundEans }) => {
        metrics.progressCurrent = completedBatches;
        metrics.progressTotal = totalBatches;
        metrics.progressPercent = percentage(completedBatches, totalBatches);
        metrics.totalSampled = checkedEans;
        metrics.totalExisting = foundEans;

        await setProgress(
          jobId,
          metrics,
          'checking_existing',
          `Consultando itens existentes no Banco Unico: ${checkedEans.toLocaleString('pt-BR')} EANs analisados em ${completedBatches}/${totalBatches} lotes.`,
        );
      },
    );
    metrics.totalSampled = sampledProducts.length;

    const skippedExistingRecords = sampledProducts
      .filter((product) =>
        existingEans.has(normalizeEan(product.codigoBarras || product.ean)),
      )
      .map((product) =>
        buildItemRecord(
          jobId,
          {
            ...mapProductRef(product),
            skippedReason: 'already_exists_in_banco_unico',
            payload: null,
          },
          'already_exists',
        ),
      );

    await persistItemBatch(skippedExistingRecords);

    metrics.totalExisting = skippedExistingRecords.length;
    metrics.totalSelected = selectedProducts.length;
    metrics.progressTotal = selectedProducts.length;

    await emitEvent(
      jobId,
      `${selectedProducts.length} produto(s) selecionado(s) para processamento.`,
    );

    const pendingPublishProducts = [];
    const flushPendingPublications = async ({ force = false } = {}) => {
      if (options.mode !== 'publish') {
        return;
      }

      const publishableCount = force
        ? pendingPublishProducts.length
        : pendingPublishProducts.length -
          (pendingPublishProducts.length % options.batchSize);

      if (publishableCount <= 0) {
        return;
      }

      const itemsToPublish = pendingPublishProducts.splice(0, publishableCount);
      const batches = chunk(itemsToPublish, options.batchSize);

      await mapWithConcurrency(
        batches,
        options.publishConcurrency,
        async (batch, index) => {
          await assertJobCanContinue(jobId);
          await emitEvent(
            jobId,
            `Publicando lote ${index + 1}/${batches.length} com ${batch.length} produto(s).`,
          );

          try {
            await bancoUnicoClient.publishProducts(batch.map((item) => item.payload));
            const keys = batch.map((item) => item.externalKey);
            await prisma.bancoUnicoImportItem.updateMany({
              where: {
                jobId,
                externalKey: { in: keys },
              },
              data: {
                status: 'published',
                publishedAt: new Date(),
              },
            });
            publishItemsChanged(jobId, {
              count: batch.length,
              statuses: ['published'],
            });
            metrics.totalPublished += batch.length;
          } catch (error) {
            metrics.totalErrors += batch.length;
            for (const item of batch) {
              await prisma.bancoUnicoImportItem.update({
                where: { externalKey: item.externalKey },
                data: {
                  status: 'publish_error',
                  errorStage: 'publish',
                  errorMessage: error.message,
                },
              });
            }
            publishItemsChanged(jobId, {
              count: batch.length,
              statuses: ['publish_error'],
            });
            await emitEvent(jobId, error.message, 'error');
          }
        },
        jobId,
      );
    };

    const selectedChunks = chunk(
      selectedProducts,
      Math.max(options.classifyConcurrency * 5, 25),
    );
    let processedCount = 0;

    for (const productChunk of selectedChunks) {
      await assertJobCanContinue(jobId);
      await updateJob(jobId, {
        currentStage: 'classifying',
        currentMessage: `Processando ${processedCount}/${selectedProducts.length} produto(s).`,
      });

      const chunkResults = await mapWithConcurrency(
        productChunk,
        options.classifyConcurrency,
        async (product, chunkIndex) => {
          const globalIndex = processedCount + chunkIndex;

          try {
            const normalizedProduct = await normalizeProduct(product, options);
            const classificationResult = await classifier.classifyProduct(
              normalizedProduct,
              {
                disableAi: options.disableAi,
                forceAi: options.forceTaxonomyAi,
              },
            );

            const taxonomy = classificationResult?.taxonomy || null;
            const completeTaxonomy = isCompleteTaxonomy(taxonomy);
            const itemOutput = {
              ...mapProductRef(normalizedProduct),
              ean: normalizeEan(
                normalizedProduct.codigoBarras || normalizedProduct.ean,
              ),
              confiancaNormalizacao: normalizedProduct.confianca || null,
              precisaRevisaoNormalizacao: Boolean(
                normalizedProduct.precisaRevisao,
              ),
              taxonomy,
              metadata: classificationResult?.metadata || null,
              payload: completeTaxonomy
                ? buildPayloadWithOptions(normalizedProduct, taxonomy, {
                    ...options,
                    sourceProviderLabel,
                  })
                : null,
            };

            // ponytail: no per-product emitEvent here anymore (was 1 DB insert
            // per product, the other big throughput killer). One summary
            // event per chunk is emitted after the loop below instead.
            return {
              status: completeTaxonomy ? 'prepared' : 'skipped',
              itemOutput,
              logLine: `[${globalIndex + 1}/${selectedProducts.length}] ${completeTaxonomy ? 'OK' : 'SKIP'} ${itemOutput.ean || '-'} ${itemOutput.nomeNormalizadoFinal || '-'}`,
            };
          } catch (error) {
            const itemOutput = {
              ...mapProductRef(product),
              errorStage: 'classification',
              errorMessage: error.message,
              payload: null,
            };
            return {
              status: 'error',
              itemOutput,
              logLine: `[${globalIndex + 1}/${selectedProducts.length}] ERROR ${itemOutput.ean || '-'} ${itemOutput.nomeNormalizadoFinal || '-'}`,
            };
          }
        },
        jobId,
      );

      const preparedRecords = [];
      const skippedRecords = [];
      const errorRecords = [];

      for (const result of chunkResults) {
        if (result.status === 'prepared') {
          const record = buildItemRecord(
            jobId,
            result.itemOutput,
            options.mode === 'publish' ? 'prepared' : 'classified',
          );
          preparedRecords.push(record);
          pendingPublishProducts.push({
            externalKey: record.externalKey,
            payload: result.itemOutput.payload,
          });
        } else if (result.status === 'skipped') {
          skippedRecords.push(
            buildItemRecord(jobId, result.itemOutput, 'skipped_taxonomy'),
          );
        } else {
          errorRecords.push(
            buildItemRecord(jobId, result.itemOutput, 'classification_error'),
          );
        }
      }

      await persistItemBatch([
        ...preparedRecords,
        ...skippedRecords,
        ...errorRecords,
      ]);

      const chunkLog = chunkResults.map((result) => result.logLine).join('\n');
      if (chunkLog) {
        await emitEvent(jobId, chunkLog);
      }

      metrics.totalPrepared += preparedRecords.length;
      metrics.totalSkipped += skippedRecords.length;
      metrics.totalErrors += errorRecords.length;
      processedCount += productChunk.length;
      metrics.progressCurrent = processedCount;
      metrics.progressPercent = percentage(processedCount, metrics.progressTotal);

      await flushPendingPublications();
      await setProgress(
        jobId,
        metrics,
        'classifying',
        `${processedCount}/${selectedProducts.length} produto(s) processado(s).`,
      );
    }

    await updateJob(jobId, {
      currentStage: 'publishing',
      currentMessage:
        options.mode === 'publish'
          ? 'Finalizando publicacao.'
          : 'Finalizando classificacao.',
    });

    await flushPendingPublications({ force: true });
    metrics.progressCurrent = metrics.progressTotal;
    metrics.progressPercent = 100;

    const finalSummary = buildSummary(metrics);
    await updateJob(jobId, {
      status: 'completed',
      currentStage: 'completed',
      currentMessage: 'Importacao concluida com sucesso.',
      progressCurrent: metrics.progressCurrent,
      progressTotal: metrics.progressTotal,
      progressPercent: metrics.progressPercent,
      totalCatalogValid: metrics.totalCatalogValid,
      totalInvalidEans: metrics.totalInvalidEans,
      totalSampled: metrics.totalSampled,
      totalSelected: metrics.totalSelected,
      totalExisting: metrics.totalExisting,
      totalPrepared: metrics.totalPrepared,
      totalSkipped: metrics.totalSkipped,
      totalErrors: metrics.totalErrors,
      totalPublished: metrics.totalPublished,
      summary: finalSummary,
      finishedAt: new Date(),
    });

    // ponytail: job is already durably marked "completed" above. A transient
    // failure in these two side-effect calls (SSE event log, audit log) must
    // not fall into the catch below and flip a successful import back to
    // "failed" — that produced false-failure statuses on real, finished jobs.
    try {
      await emitEvent(jobId, 'Importacao concluida.');
      await createLogService(
        options.requestedBy,
        `Concluiu subida Banco Unico #${jobId} para ${options.clientName} com ${metrics.totalPublished} item(ns) subido(s)`,
        options.clientName,
      );
    } catch (postCompletionError) {
      console.error(
        `[bancoUnicoImports] Falha ao registrar evento/log de conclusao do job #${jobId} (job ja concluido com sucesso):`,
        postCompletionError,
      );
    }
  } catch (error) {
    const status = error instanceof ImportCancelledError ? 'cancelled' : 'failed';
    await updateJob(jobId, {
      status,
      currentStage: status,
      currentMessage: error.message,
      finishedAt: new Date(),
      summary: buildSummary(metrics),
      totalCatalogValid: metrics.totalCatalogValid,
      totalInvalidEans: metrics.totalInvalidEans,
      totalSampled: metrics.totalSampled,
      totalSelected: metrics.totalSelected,
      totalExisting: metrics.totalExisting,
      totalPrepared: metrics.totalPrepared,
      totalSkipped: metrics.totalSkipped,
      totalErrors: metrics.totalErrors,
      totalPublished: metrics.totalPublished,
    });
    await emitEvent(
      jobId,
      error.message,
      error instanceof ImportCancelledError ? 'warning' : 'error',
    );
    await createLogService(
      options.requestedBy,
      error instanceof ImportCancelledError
        ? `Subida Banco Unico #${jobId} cancelada para ${options.clientName}`
        : `Subida Banco Unico #${jobId} falhou para ${options.clientName}: ${error.message}`,
      options.clientName,
    );
    if (!(error instanceof ImportCancelledError)) {
      throw error;
    }
  } finally {
    ACTIVE_JOBS.delete(jobId);
    await prisma.bancoUnicoImportJob.updateMany({
      where: { id: jobId, workerId: WORKER_ID },
      data: { workerId: null, workerHeartbeatAt: null },
    });
  }
}

async function claimImportJob(jobId) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - WORKER_LEASE_MS);
  const result = await prisma.bancoUnicoImportJob.updateMany({
    where: {
      id: jobId,
      status: { in: RECOVERABLE_JOB_STATUSES },
      OR: [
        { workerId: null },
        { workerId: WORKER_ID },
        { workerHeartbeatAt: { lt: staleBefore } },
      ],
    },
    data: {
      // Older workers only recover pending/running/cancelling. Keeping a
      // claimed job in this new state prevents them from starting a second,
      // incompatible Trier execution against the same import.
      status: 'claimed',
      workerId: WORKER_ID,
      workerHeartbeatAt: now,
      currentStage: 'claimed',
      currentMessage: 'Subida reservada por um worker.',
    },
  });
  return result.count === 1;
}

async function startManagedJob(jobId, optionsOverride = null) {
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId) || ACTIVE_JOBS.has(normalizedJobId)) {
    return;
  }

  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: normalizedJobId },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      status: true,
      options: true,
    },
  });

  if (!job || !RECOVERABLE_JOB_STATUSES.includes(job.status)) {
    return;
  }

  if (!(await claimImportJob(normalizedJobId))) {
    return;
  }

  if (
    hasAnotherActiveJobForClient({
      jobId: normalizedJobId,
      clientId: job.clientId ?? null,
      clientName: job.clientName ?? null,
    })
  ) {
    return;
  }

  ACTIVE_JOBS.set(normalizedJobId, {
    cancelRequested: job.status === 'cancelling',
    pauseRequested: job.status === 'paused',
    pausePromise: null,
    resume: null,
    pauseAnnounced: false,
    resumeStage: null,
    resumeMessage: null,
    workerId: WORKER_ID,
    clientId: job.clientId ?? null,
    clientName: job.clientName ?? null,
  });

  void runImportJob(normalizedJobId, optionsOverride ?? job.options ?? {}).catch(
    async (error) => {
      console.error('Falha na importacao Banco Unico:', error);
    },
  );
}

async function scanAndStartRecoverableJobs() {
  const recoverableJobs = await prisma.bancoUnicoImportJob.findMany({
    where: {
      status: {
        in: RECOVERABLE_JOB_STATUSES,
      },
    },
    select: {
      id: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  for (const job of recoverableJobs) {
    await startManagedJob(job.id);
  }
}

export function initializeBancoUnicoImportWorker() {
  if (workerInitialized) {
    return;
  }

  workerInitialized = true;
  void scanAndStartRecoverableJobs().catch((error) => {
    console.error('Falha ao recuperar jobs Banco Unico:', error);
  });

  setInterval(() => {
    void scanAndStartRecoverableJobs().catch((error) => {
      console.error('Falha ao verificar fila Banco Unico:', error);
    });
  }, WORKER_POLL_INTERVAL_MS);
}

export async function createBancoUnicoImportJob(payload) {
  const requestedBy = String(payload.username || 'Sistema').trim() || 'Sistema';
  const options = await normalizeOptions(payload, requestedBy);

  const activeJobForClient = await prisma.bancoUnicoImportJob.findFirst({
    where: {
      OR: [
        ...(options.clientId
          ? [{ clientId: options.clientId }]
          : [{ clientName: options.clientName }]),
      ],
      status: {
        in: ACTIVE_OR_PAUSED_JOB_STATUSES,
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (activeJobForClient) {
    throw new Error(
      `Ja existe uma subida ativa para este cliente (importacao #${activeJobForClient.id} em status ${activeJobForClient.status}).`,
    );
  }

  const job = await prisma.bancoUnicoImportJob.create({
    data: {
      clientId: options.clientId,
      clientName: options.clientName,
      sourceType: options.sourceType,
      sourceLabel: options.sourceLabel,
      status: 'claimed',
      currentStage: 'claimed',
      currentMessage: 'Subida aguardando inicializacao do worker.',
      mode: options.mode,
      requestedBy,
      options,
    },
    select: jobSelect(),
  });

  await createLogService(
    requestedBy,
    `Solicitou subida Banco Unico #${job.id} para ${options.clientName} (${options.sourceType})`,
    options.clientName,
  );

  await startManagedJob(job.id, options);

  return formatJob(job);
}

export async function retryBancoUnicoImportJob(jobId, requestedBy = 'Sistema') {
  const id = Number(jobId);
  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      status: true,
      totalErrors: true,
      options: true,
    },
  });

  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }

  const completedWithErrors = job.status === 'completed' && Number(job.totalErrors) > 0;
  if (job.status !== 'failed' && !completedWithErrors) {
    throw new Error('Apenas importacoes com falha ou concluidas com erros podem ser executadas novamente.');
  }

  if (hasAnotherActiveJobForClient({ jobId: id, clientId: job.clientId, clientName: job.clientName })) {
    throw new Error('Ja existe uma subida ativa para este cliente.');
  }

  // Rebuild from the registered client so retries also repair jobs created
  // before a provider gained its own source configuration.
  const options = await normalizeOptions(
    {
      ...(job.options && typeof job.options === 'object' ? job.options : {}),
      clientId: job.clientId,
    },
    requestedBy,
  );

  await prisma.$transaction([
    prisma.bancoUnicoImportItem.deleteMany({ where: { jobId: id } }),
    prisma.bancoUnicoImportJob.update({
      where: { id },
      data: {
        status: 'claimed',
        currentStage: 'claimed',
        currentMessage: 'Nova tentativa aguardando inicializacao do worker.',
        progressCurrent: 0,
        progressTotal: 0,
        progressPercent: 0,
        totalCatalogValid: 0,
        totalInvalidEans: 0,
        totalSampled: 0,
        totalSelected: 0,
        totalExisting: 0,
        totalPrepared: 0,
        totalSkipped: 0,
        totalErrors: 0,
        totalPublished: 0,
        summary: null,
        startedAt: null,
        finishedAt: null,
        requestedBy: String(requestedBy || 'Sistema').trim() || 'Sistema',
        workerId: null,
        workerHeartbeatAt: null,
        sourceType: options.sourceType,
        sourceLabel: options.sourceLabel,
        options,
      },
    }),
  ]);

  await emitEvent(id, 'Nova tentativa de subida solicitada.');
  await startManagedJob(id, options);
  return getBancoUnicoImportJob(id);
}

export async function listBancoUnicoImportJobs({
  page = 1,
  limit = 10,
  search = '',
  status,
  clientId,
}) {
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.max(1, Math.min(50, Number(limit) || 10));
  const skip = (pageNumber - 1) * limitNumber;

  const where = {
    ...(clientId ? { clientId: Number(clientId) } : {}),
    ...(search
      ? {
          OR: [
            { clientName: { contains: search, mode: 'insensitive' } },
            { requestedBy: { contains: search, mode: 'insensitive' } },
            { sourceLabel: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(status ? { status } : {}),
  };

  const [data, totalItems] = await Promise.all([
    prisma.bancoUnicoImportJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNumber,
      select: jobSelect(),
    }),
    prisma.bancoUnicoImportJob.count({ where }),
  ]);

  return {
    data: data.map(formatJob),
    meta: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limitNumber)),
    },
  };
}

export async function getBancoUnicoImportJob(jobId) {
  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: Number(jobId) },
    select: jobSelect(),
  });

  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }

  const recentEvents = await prisma.bancoUnicoImportEvent.findMany({
    where: { jobId: job.id },
    orderBy: { id: 'desc' },
    take: 30,
  });

  return {
    ...formatJob(job),
    recentEvents: recentEvents.reverse(),
    isActive: ACTIVE_JOBS.has(job.id),
  };
}

export async function subscribeBancoUnicoImportStream(jobId, res) {
  const detail = await getBancoUnicoImportJob(jobId);
  const normalizedJobId = Number(jobId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const subscribers = getStreamSubscribers(normalizedJobId);
  subscribers.add(res);

  writeSseEvent(res, 'job', detail);
  for (const event of detail.recentEvents) {
    writeSseEvent(res, 'event', event);
  }
  writeSseEvent(res, 'ready', {
    jobId: normalizedJobId,
    timestamp: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    writeSseEvent(res, 'heartbeat', {
      jobId: normalizedJobId,
      timestamp: new Date().toISOString(),
    });
  }, 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    const currentSubscribers = STREAM_SUBSCRIBERS.get(normalizedJobId);
    currentSubscribers?.delete(res);
    if (currentSubscribers && currentSubscribers.size === 0) {
      STREAM_SUBSCRIBERS.delete(normalizedJobId);
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);
}

function toValueArray(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

export async function listBancoUnicoImportItems(jobId, query = {}) {
  const pageNumber = Math.max(1, Number(query.page) || 1);
  const limitNumber = Math.max(1, Math.min(100, Number(query.limit) || 20));
  const skip = (pageNumber - 1) * limitNumber;
  const normalizedJobId = Number(jobId);

  const statusValues = toValueArray(query.status);
  const eanValues = toValueArray(query.ean);
  const nameValues = toValueArray(query.name);
  const manufacturerValues = toValueArray(query.manufacturer);
  const activeIngredientValues = toValueArray(query.activeIngredient);
  const hasErrorValues = toValueArray(query.hasError);
  const wantsErrors = hasErrorValues.includes('yes');
  const wantsNoErrors = hasErrorValues.includes('no');

  const where = {
    jobId: normalizedJobId,
    ...(statusValues.length ? { status: { in: statusValues } } : {}),
    ...(query.search
      ? {
          OR: [
            { ean: { contains: String(query.search), mode: 'insensitive' } },
            {
              nameOriginal: {
                contains: String(query.search),
                mode: 'insensitive',
              },
            },
            {
              nameNormalized: {
                contains: String(query.search),
                mode: 'insensitive',
              },
            },
            {
              manufacturer: {
                contains: String(query.search),
                mode: 'insensitive',
              },
            },
          ],
        }
      : {}),
    ...(eanValues.length ? { ean: { in: eanValues } } : {}),
    ...(nameValues.length
      ? {
          OR: [
            { nameNormalized: { in: nameValues } },
            { nameOriginal: { in: nameValues } },
          ],
        }
      : {}),
    ...(manufacturerValues.length ? { manufacturer: { in: manufacturerValues } } : {}),
    ...(activeIngredientValues.length ? { activeIngredient: { in: activeIngredientValues } } : {}),
    // both selected (or neither) means no filter on error state
    ...(wantsErrors && !wantsNoErrors ? { errorMessage: { not: null } } : {}),
    ...(wantsNoErrors && !wantsErrors ? { errorMessage: null } : {}),
  };

  const [data, totalItems] = await Promise.all([
    prisma.bancoUnicoImportItem.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limitNumber,
    }),
    prisma.bancoUnicoImportItem.count({ where }),
  ]);

  return {
    data,
    meta: {
      page: pageNumber,
      limit: limitNumber,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / limitNumber)),
    },
  };
}

const ITEM_FACET_EXPR = {
  ean: Prisma.raw('"ean"'),
  name: Prisma.raw('COALESCE("nameNormalized", "nameOriginal")'),
  manufacturer: Prisma.raw('"manufacturer"'),
  activeIngredient: Prisma.raw('"activeIngredient"'),
};

export async function getBancoUnicoImportItemFacets(jobId, field, query = {}) {
  const expr = ITEM_FACET_EXPR[field];
  if (!expr) {
    throw new Error('Campo de filtro invalido.');
  }

  const normalizedJobId = Number(jobId);
  const search = String(query.search || '').trim();
  const limitNumber = Math.max(1, Math.min(50, Number(query.limit) || 5));

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ${expr} AS value
    FROM "sistema"."banco_unico_import_items"
    WHERE "jobId" = ${normalizedJobId}
      AND ${expr} IS NOT NULL
      AND ${expr} <> ''
      ${search ? Prisma.sql`AND ${expr} ILIKE ${`%${search}%`}` : Prisma.empty}
    ORDER BY ${expr} ASC
    LIMIT ${limitNumber}
  `;

  return rows.map((row) => row.value);
}

export async function listBancoUnicoImportEvents(jobId, query = {}) {
  const normalizedJobId = Number(jobId);
  const afterId = Math.max(0, Number(query.afterId) || 0);
  const limitNumber = Math.max(1, Math.min(200, Number(query.limit) || 100));

  const data = await prisma.bancoUnicoImportEvent.findMany({
    where: {
      jobId: normalizedJobId,
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take: limitNumber,
  });

  return {
    data,
    meta: {
      afterId,
      lastId: data.length ? data[data.length - 1].id : afterId,
    },
  };
}

export async function cancelBancoUnicoImportJob(jobId, username = 'Sistema') {
  const normalizedJobId = Number(jobId);
  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: normalizedJobId },
    select: { id: true, clientName: true },
  });
  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }

  const activeJob = ACTIVE_JOBS.get(normalizedJobId);
  if (activeJob) {
    activeJob.cancelRequested = true;
    activeJob.pauseRequested = false;
    activeJob.resume?.();
  }

  await updateJob(normalizedJobId, {
    status: 'cancelling',
    currentStage: 'cancelling',
    currentMessage: 'Cancelamento solicitado pelo usuario.',
  });
  await emitEvent(
    normalizedJobId,
    `Cancelamento solicitado por ${username}.`,
    'warning',
  );
  await createLogService(
    String(username || 'Sistema').trim() || 'Sistema',
    `Solicitou cancelamento da subida Banco Unico #${job.id} para ${job.clientName}`,
    job.clientName,
  );
}

export async function pauseBancoUnicoImportJob(jobId, username = 'Sistema') {
  const normalizedJobId = Number(jobId);
  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: normalizedJobId },
    select: {
      id: true,
      clientName: true,
      status: true,
      currentStage: true,
      currentMessage: true,
    },
  });

  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }
  if (!['pending', 'claimed', 'processing', 'running'].includes(job.status)) {
    throw new Error('Apenas importacoes pendentes ou em execucao podem ser pausadas.');
  }

  const activeJob = ACTIVE_JOBS.get(normalizedJobId);
  if (activeJob) {
    activeJob.pauseRequested = true;
    activeJob.resumeStage = job.currentStage || 'running';
    activeJob.resumeMessage = job.currentMessage || 'Importacao retomada.';
    if (!activeJob.pausePromise) {
      activeJob.pausePromise = new Promise((resolve) => {
        activeJob.resume = resolve;
      });
    }
    await updateJob(normalizedJobId, {
      currentMessage: 'Pausa solicitada. Finalizando o lote atual com seguranca.',
    });
  } else {
    await updateJob(normalizedJobId, {
      status: 'paused',
      currentStage: 'paused',
      currentMessage: 'Importacao pausada antes de iniciar.',
    });
    await emitEvent(normalizedJobId, 'Importacao pausada antes de iniciar.', 'warning');
  }

  await createLogService(
    String(username || 'Sistema').trim() || 'Sistema',
    `Solicitou pausa da subida Banco Unico #${job.id} para ${job.clientName}`,
    job.clientName,
  );
}

export async function resumeBancoUnicoImportJob(jobId, username = 'Sistema') {
  const normalizedJobId = Number(jobId);
  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: normalizedJobId },
    select: { id: true, clientName: true, status: true, options: true },
  });

  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }
  if (job.status !== 'paused') {
    throw new Error('Apenas importacoes pausadas podem ser retomadas.');
  }

  const activeJob = ACTIVE_JOBS.get(normalizedJobId);
  if (activeJob) {
    activeJob.pauseRequested = false;
    activeJob.pauseAnnounced = false;
    activeJob.resume?.();
    activeJob.resume = null;
    activeJob.pausePromise = null;
    await updateJob(normalizedJobId, {
      status: 'processing',
      currentStage: activeJob.resumeStage || 'running',
      currentMessage: activeJob.resumeMessage || 'Importacao retomada pelo usuario.',
    });
  } else {
    await updateJob(normalizedJobId, {
      status: 'pending',
      currentStage: 'pending',
      currentMessage: 'Importacao retomada. Aguardando worker.',
      finishedAt: null,
    });
    await startManagedJob(normalizedJobId, job.options ?? {});
  }

  await emitEvent(normalizedJobId, `Importacao retomada por ${username}.`);
  await createLogService(
    String(username || 'Sistema').trim() || 'Sistema',
    `Retomou a subida Banco Unico #${job.id} para ${job.clientName}`,
    job.clientName,
  );
}

export async function deleteBancoUnicoImportJob(jobId, username = 'Sistema') {
  const normalizedJobId = Number(jobId);
  if (!Number.isFinite(normalizedJobId)) {
    throw new Error('Importacao nao encontrada.');
  }

  if (ACTIVE_JOBS.has(normalizedJobId)) {
    throw new Error(
      'Cancele a importacao antes de excluir. Ela ainda esta em execucao.',
    );
  }

  const job = await prisma.bancoUnicoImportJob.findUnique({
    where: { id: normalizedJobId },
    select: { id: true, status: true, clientName: true },
  });
  if (!job) {
    throw new Error('Importacao nao encontrada.');
  }

  if (ACTIVE_OR_PAUSED_JOB_STATUSES.includes(job.status)) {
    throw new Error(
      'Cancele a importacao antes de excluir. Ela ainda esta em execucao.',
    );
  }

  await prisma.bancoUnicoImportJob.delete({ where: { id: normalizedJobId } });
  await createLogService(
    String(username || 'Sistema').trim() || 'Sistema',
    `Excluiu subida Banco Unico #${job.id} de ${job.clientName}`,
    job.clientName,
  );
}

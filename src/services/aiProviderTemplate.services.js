import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { adminPool } from '../database/adminPool.js';
import { parseTemplateContent } from './TemplateService.js';
import {
  MANAGED_AI_PROVIDERS,
  MANAGED_AI_COMPONENT_KEYS,
  getManagedAiProviderFallbackVersion,
  getManagedAiProviderDefinition,
  getManagedAiTemplatePaths,
} from './aiProviderCatalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

const TEMPLATE_COMPONENT_COLUMN_MAP = {
  assistant: 'assistantTemplate',
  preProcess: 'preProcessTemplate',
  buscaProdutos: 'buscaProdutosTemplate',
  downloadImagem: 'downloadImagemTemplate',
  gerarCheckout: 'gerarCheckoutTemplate',
  transferirHumano: 'transferirHumanoTemplate',
  ura: 'uraTemplate',
  uraAb: 'uraAbTemplate',
};

let aiProviderTemplatesTableReady = false;
let aiProviderTemplatesInitPromise = null;
let aiProviderTemplatesSeedPromise = null;
let aiProviderTemplatesSeeded = false;
let aiProviderTemplatesAvailable = true;
let aiProviderTemplatesWriteAvailable = true;

async function hasAnyAiProviderTemplateRows() {
  const result = await adminPool.query(`
    SELECT EXISTS(
      SELECT 1
      FROM sistema.ai_provider_templates
      LIMIT 1
    ) AS "hasRows";
  `);

  return Boolean(result.rows?.[0]?.hasRows);
}

function parseBooleanFlag(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return defaultValue;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function buildTemplateRowPayload(provider, rawTemplates) {
  const definition = getManagedAiProviderDefinition(provider);

  return {
    provider,
    templateName: definition.templateName,
    assistantTemplate: rawTemplates.assistant,
    preProcessTemplate: rawTemplates.preProcess,
    buscaProdutosTemplate: rawTemplates.buscaProdutos,
    downloadImagemTemplate: rawTemplates.downloadImagem,
    gerarCheckoutTemplate: rawTemplates.gerarCheckout ?? null,
    transferirHumanoTemplate: rawTemplates.transferirHumano ?? null,
    uraTemplate: rawTemplates.ura,
    uraAbTemplate: rawTemplates.uraAb,
  };
}

function parseRowJson(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPermissionDeniedError(error) {
  return error?.code === '42501';
}

function buildInitialComponentVersions() {
  return Object.fromEntries(MANAGED_AI_COMPONENT_KEYS.map((key) => [key, 1]));
}

async function readTemplateFileRaw(sourcePath) {
  const fullPath = path.join(TEMPLATES_DIR, sourcePath);
  return fs.readFile(fullPath, 'utf-8');
}

async function loadProviderRawTemplates(provider) {
  const templatePaths = getManagedAiTemplatePaths(provider);
  const entries = Object.entries(templatePaths);
  const rawTemplates = {};

  for (const [componentKey, sourcePath] of entries) {
    rawTemplates[componentKey] = await readTemplateFileRaw(sourcePath);
  }

  return rawTemplates;
}

function providerTemplatesChanged(currentRow, nextRow) {
  if (!currentRow) return true;

  return Object.values(TEMPLATE_COMPONENT_COLUMN_MAP).some(
    (column) => currentRow[column] !== nextRow[column],
  );
}

function resolveNextComponentVersions(currentRow, nextRow) {
  if (!currentRow) {
    return buildInitialComponentVersions();
  }

  const currentComponentVersions =
    parseRowJson(currentRow.componentVersions) || buildInitialComponentVersions();
  const nextComponentVersions = { ...currentComponentVersions };

  for (const [componentKey, column] of Object.entries(TEMPLATE_COMPONENT_COLUMN_MAP)) {
    const currentContent = currentRow[column] ?? null;
    const nextContent = nextRow[column] ?? null;

    if (currentContent !== nextContent) {
      nextComponentVersions[componentKey] =
        Number(currentComponentVersions[componentKey] || 0) + 1;
    } else if (!Number.isFinite(Number(nextComponentVersions[componentKey]))) {
      nextComponentVersions[componentKey] = 1;
    }
  }

  return nextComponentVersions;
}

async function createNextProviderTemplateVersion(provider, nextRow) {
  const currentQuery = await adminPool.query(
    `
      SELECT *
      FROM sistema.ai_provider_templates
      WHERE provider = $1::varchar(50)
        AND "isCurrent" = true
      ORDER BY version DESC, id DESC
      LIMIT 1;
    `,
    [provider],
  );

  const current = currentQuery.rows?.[0] ?? null;
  if (!providerTemplatesChanged(current, nextRow)) {
    return {
      changed: false,
      row: current,
    };
  }

  const aggregate = await adminPool.query(
    `
      SELECT COALESCE(MAX(version), 0) AS "maxVersion"
      FROM sistema.ai_provider_templates
      WHERE provider = $1::varchar(50);
    `,
    [provider],
  );

  const nextVersion = Number(aggregate.rows?.[0]?.maxVersion || 0) + 1;
  const nextComponentVersions = resolveNextComponentVersions(current, nextRow);

  await adminPool.query(
    `
      UPDATE sistema.ai_provider_templates
      SET "isCurrent" = false
      WHERE provider = $1::varchar(50)
        AND "isCurrent" = true;
    `,
    [provider],
  );

  const insertResult = await adminPool.query(
    `
      INSERT INTO sistema.ai_provider_templates (
        provider,
        "templateName",
        version,
        "assistantTemplate",
        "preProcessTemplate",
        "buscaProdutosTemplate",
        "downloadImagemTemplate",
        "gerarCheckoutTemplate",
        "transferirHumanoTemplate",
        "uraTemplate",
        "uraAbTemplate",
        "componentVersions",
        "isCurrent",
        "isActive",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        $1::varchar(50),
        $2::varchar(255),
        $3::int,
        $4::text,
        $5::text,
        $6::text,
        $7::text,
        $8::text,
        $9::text,
        $10::text,
        $11::text,
        $12::jsonb,
        true,
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      RETURNING *;
    `,
    [
      nextRow.provider,
      nextRow.templateName,
      nextVersion,
      nextRow.assistantTemplate,
      nextRow.preProcessTemplate,
      nextRow.buscaProdutosTemplate,
      nextRow.downloadImagemTemplate,
      nextRow.gerarCheckoutTemplate,
      nextRow.transferirHumanoTemplate,
      nextRow.uraTemplate,
      nextRow.uraAbTemplate,
      JSON.stringify(nextComponentVersions),
    ],
  );

  return {
    changed: true,
    row: insertResult.rows?.[0] ?? null,
  };
}

async function createManualProviderTemplateVersion(provider, input = {}) {
  await ensureAiProviderTemplatesTableExists();
  if (!aiProviderTemplatesAvailable) {
    throw new Error('Banco indisponivel para templates por provider.');
  }

  const normalizedProvider = normalizeOptionalString(provider);
  if (!normalizedProvider) {
    throw new Error('provider e obrigatorio.');
  }

  const definition = getManagedAiProviderDefinition(normalizedProvider);
  if (!definition) {
    throw new Error(`Provider de IA nao suportado: ${normalizedProvider}`);
  }

  const templateName = normalizeOptionalString(input.templateName) || definition.templateName;
  const nextRow = {
    provider: normalizedProvider,
    templateName,
    assistantTemplate: input.assistantTemplate,
    preProcessTemplate: input.preProcessTemplate,
    buscaProdutosTemplate: input.buscaProdutosTemplate,
    downloadImagemTemplate: input.downloadImagemTemplate,
    gerarCheckoutTemplate: input.gerarCheckoutTemplate ?? null,
    transferirHumanoTemplate: input.transferirHumanoTemplate ?? null,
    uraTemplate: input.uraTemplate,
    uraAbTemplate: input.uraAbTemplate,
  };

  const requiredComponentKeys = new Set(
    Object.keys(getManagedAiTemplatePaths(normalizedProvider)),
  );

  for (const [field, value] of Object.entries(nextRow)) {
    if (field === 'provider' || field === 'templateName') continue;

    const componentKey = Object.entries(TEMPLATE_COMPONENT_COLUMN_MAP).find(
      ([, column]) => column === field,
    )?.[0];

    if (!componentKey || !requiredComponentKeys.has(componentKey)) {
      continue;
    }

    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${field} e obrigatorio.`);
    }
  }

  const result = await createNextProviderTemplateVersion(normalizedProvider, nextRow);

  if (
    result.changed &&
    parseBooleanFlag(input.isActive, true) === false &&
    result.row?.id
  ) {
    await adminPool.query(
      `
        UPDATE sistema.ai_provider_templates
        SET
          "isActive" = false,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = $1::int
        RETURNING *;
      `,
      [Number(result.row.id)],
    );
    result.row.isActive = false;
  }

  return {
    changed: result.changed,
    row: normalizeTemplateRow(result.row),
  };
}

function normalizeTemplateRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    provider: row.provider,
    templateName: row.templateName,
    version: row.version,
    assistantTemplate: row.assistantTemplate,
    preProcessTemplate: row.preProcessTemplate,
    buscaProdutosTemplate: row.buscaProdutosTemplate,
    downloadImagemTemplate: row.downloadImagemTemplate,
    gerarCheckoutTemplate: row.gerarCheckoutTemplate ?? null,
    transferirHumanoTemplate: row.transferirHumanoTemplate ?? null,
    uraTemplate: row.uraTemplate,
    uraAbTemplate: row.uraAbTemplate,
    componentVersions: parseRowJson(row.componentVersions) || buildInitialComponentVersions(),
    isCurrent: row.isCurrent,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function ensureAiProviderTemplatesTableExists() {
  if (!aiProviderTemplatesAvailable) return;
  if (aiProviderTemplatesTableReady) return;
  if (aiProviderTemplatesInitPromise) {
    await aiProviderTemplatesInitPromise;
    return;
  }

  aiProviderTemplatesInitPromise = (async () => {
    try {
      await adminPool.query(`CREATE SCHEMA IF NOT EXISTS sistema;`);

      await adminPool.query(`
        CREATE TABLE IF NOT EXISTS sistema.ai_provider_templates (
          id SERIAL PRIMARY KEY,
          provider VARCHAR(50) NOT NULL,
          "templateName" VARCHAR(255) NOT NULL,
          version INTEGER NOT NULL,
          "assistantTemplate" TEXT NOT NULL,
          "preProcessTemplate" TEXT NOT NULL,
          "buscaProdutosTemplate" TEXT NOT NULL,
          "downloadImagemTemplate" TEXT NOT NULL,
          "gerarCheckoutTemplate" TEXT,
          "transferirHumanoTemplate" TEXT,
          "uraTemplate" TEXT NOT NULL,
          "uraAbTemplate" TEXT NOT NULL,
          "componentVersions" JSONB NOT NULL DEFAULT '{}'::jsonb,
          "isCurrent" BOOLEAN NOT NULL DEFAULT true,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await adminPool.query(`
        ALTER TABLE sistema.ai_provider_templates
        ADD COLUMN IF NOT EXISTS "componentVersions" JSONB NOT NULL DEFAULT '{}'::jsonb;
      `);

      await adminPool.query(`
        ALTER TABLE sistema.ai_provider_templates
        ADD COLUMN IF NOT EXISTS "gerarCheckoutTemplate" TEXT;
      `);

      await adminPool.query(`
        ALTER TABLE sistema.ai_provider_templates
        ADD COLUMN IF NOT EXISTS "transferirHumanoTemplate" TEXT;
      `);

      await adminPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_templates_provider_version_key
        ON sistema.ai_provider_templates (provider, version);
      `);

      await adminPool.query(`
        CREATE INDEX IF NOT EXISTS ai_provider_templates_provider_current_idx
        ON sistema.ai_provider_templates (provider, "isCurrent");
      `);

      aiProviderTemplatesTableReady = true;
    } catch (error) {
      if (error?.code === '42501') {
        const check = await adminPool.query(`
          SELECT to_regclass('sistema.ai_provider_templates') AS table_name;
        `);

        if (check.rows?.[0]?.table_name) {
          console.warn(
            'AI_PROVIDER_TEMPLATE WARN: Sem permissao de ownership. Usando tabela existente.',
          );
          aiProviderTemplatesTableReady = true;
          return;
        }
      }

      throw error;
    }
  })();

  try {
    await aiProviderTemplatesInitPromise;
  } catch (error) {
    aiProviderTemplatesAvailable = false;
    console.warn(
      'AI_PROVIDER_TEMPLATE WARN: Banco indisponivel para templates por provider. Usando arquivos locais.',
      error?.message || error,
    );
    return;
  } finally {
    aiProviderTemplatesInitPromise = null;
  }
}

export async function syncCurrentAiProviderTemplatesToDb() {
  throw new Error(
    'Sincronizacao por arquivos locais foi desativada. O banco e a unica fonte de verdade para templates por provider.',
  );
}

async function publishInitialProviderTemplateFromFiles(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) return null;

  const rawTemplates = await loadProviderRawTemplates(provider);
  const result = await createNextProviderTemplateVersion(
    provider,
    buildTemplateRowPayload(provider, rawTemplates),
  );

  return normalizeTemplateRow(result.row);
}

export async function ensureCurrentAiProviderTemplatesSeeded() {
  if (!aiProviderTemplatesAvailable) {
    return;
  }

  if (aiProviderTemplatesSeeded) {
    return;
  }

  if (aiProviderTemplatesSeedPromise) {
    await aiProviderTemplatesSeedPromise;
    return;
  }

  aiProviderTemplatesSeedPromise = (async () => {
    await ensureAiProviderTemplatesTableExists();
    if (!aiProviderTemplatesAvailable) return;
    await hasAnyAiProviderTemplateRows();
  })();

  try {
    await aiProviderTemplatesSeedPromise;
    aiProviderTemplatesSeeded = true;
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      aiProviderTemplatesWriteAvailable = false;
      console.warn(
        'AI_PROVIDER_TEMPLATE WARN: Sem permissao para versionar templates por provider. Usando modo somente leitura com fallback em arquivo.',
      );
      return;
    }

    throw error;
  } finally {
    aiProviderTemplatesSeedPromise = null;
  }
}

export async function getCurrentAiProviderTemplatePackage(provider) {
  return getCurrentAiProviderTemplatePackageWithOptions(provider);
}

export async function getCurrentAiProviderTemplatePackageWithOptions(
  provider,
  { requireDatabase = false } = {},
) {
  await ensureCurrentAiProviderTemplatesSeeded();
  if (!aiProviderTemplatesAvailable || !aiProviderTemplatesWriteAvailable) {
    if (requireDatabase) {
      throw new Error(
        `Pacote publicado do provider ${provider} indisponivel no banco. O fluxo operacional nao usa fallback em arquivo local.`,
      );
    }
    return buildFallbackTemplateRow(provider);
  }

  const result = await adminPool.query(
    `
      SELECT *
      FROM sistema.ai_provider_templates
      WHERE provider = $1::varchar(50)
        AND "isCurrent" = true
        AND "isActive" = true
      ORDER BY version DESC, id DESC
      LIMIT 1;
    `,
    [provider],
  );

  const normalizedRow = normalizeTemplateRow(result.rows?.[0] ?? null);

  if (normalizedRow) {
    return normalizedRow;
  }

  // O primeiro pacote de um provider novo precisa existir no banco antes que
  // qualquer instalacao seja executada. Fazemos somente esse bootstrap; as
  // versoes seguintes continuam sendo controladas pelo workspace publicado.
  try {
    const initialPackage = await publishInitialProviderTemplateFromFiles(provider);
    if (initialPackage) {
      return initialPackage;
    }
  } catch (error) {
    if (requireDatabase) {
      throw new Error(
        `Nao foi possivel publicar o pacote inicial do provider ${provider}: ${error.message}`,
      );
    }
  }

  if (requireDatabase) {
    throw new Error(
      `Pacote publicado do provider ${provider} nao encontrado no banco. O fluxo operacional nao usa fallback em arquivo local.`,
    );
  }

  return buildFallbackTemplateRow(provider);
}

export async function listCurrentAiProviderTemplatePackages() {
  await ensureCurrentAiProviderTemplatesSeeded();
  if (!aiProviderTemplatesAvailable || !aiProviderTemplatesWriteAvailable) {
    return MANAGED_AI_PROVIDERS.map((provider) => buildFallbackTemplateRow(provider));
  }

  const result = await adminPool.query(`
    SELECT *
    FROM sistema.ai_provider_templates
    WHERE "isCurrent" = true
      AND "isActive" = true
    ORDER BY provider ASC, version DESC, id DESC;
  `);

  return (result.rows ?? []).map(normalizeTemplateRow);
}

export async function listAiProviderTemplatePackages({
  provider,
  currentOnly = true,
  limit = 100,
} = {}) {
  await ensureCurrentAiProviderTemplatesSeeded();
  if (!aiProviderTemplatesAvailable || !aiProviderTemplatesWriteAvailable) {
    const fallback = provider
      ? [buildFallbackTemplateRow(provider)].filter(Boolean)
      : MANAGED_AI_PROVIDERS.map((item) => buildFallbackTemplateRow(item));
    return fallback;
  }

  const params = [];
  const clauses = [];

  const normalizedProvider = normalizeOptionalString(provider);
  if (normalizedProvider) {
    params.push(normalizedProvider);
    clauses.push(`provider = $${params.length}::varchar(50)`);
  }

  if (parseBooleanFlag(currentOnly, true)) {
    clauses.push(`"isCurrent" = true`);
  }

  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));

  const result = await adminPool.query(
    `
      SELECT *
      FROM sistema.ai_provider_templates
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY provider ASC, version DESC, id DESC
      LIMIT $${params.length}::int;
    `,
    params,
  );

  return (result.rows ?? []).map(normalizeTemplateRow);
}

export async function saveAiProviderTemplatePackage(provider, input = {}) {
  await ensureCurrentAiProviderTemplatesSeeded();
  if (!aiProviderTemplatesWriteAvailable) {
    throw new Error(
      'Banco sem permissao de escrita para versionar templates por provider.',
    );
  }
  return createManualProviderTemplateVersion(provider, input);
}

export async function loadAiProviderTemplateComponent(
  provider,
  componentKey,
  variables = {},
  { requireDatabase = false } = {},
) {
  const column = TEMPLATE_COMPONENT_COLUMN_MAP[componentKey];
  if (!column) {
    throw new Error(`Componente de template invalido: ${componentKey}`);
  }

  if (requireDatabase) {
    const row = await getCurrentAiProviderTemplatePackageWithOptions(provider, {
      requireDatabase: true,
    });

    if (!row?.[column]) {
      throw new Error(
        `Componente publicado '${provider}/${componentKey}' nao encontrado no banco. O fluxo operacional nao usa fallback em arquivo local.`,
      );
    }

    return parseTemplateContent(row[column], variables, '.json');
  }

  try {
    const row = await getCurrentAiProviderTemplatePackageWithOptions(provider);
    if (row?.[column]) {
      return parseTemplateContent(row[column], variables, '.json');
    }
  } catch (error) {
    console.error(
      `AI_PROVIDER_TEMPLATE WARN: Falha ao carregar '${provider}/${componentKey}' do banco. Usando arquivo local.`,
      error.message || error,
    );
  }

  const templatePaths = getManagedAiTemplatePaths(provider);
  const sourcePath = templatePaths[componentKey];
  const rawTemplate = await readTemplateFileRaw(sourcePath);
  return parseTemplateContent(rawTemplate, variables, '.json');
}

function buildFallbackTemplateRow(provider) {
  const definition = getManagedAiProviderDefinition(provider);
  if (!definition) return null;

  return {
    id: null,
    provider,
    templateName: definition.templateName,
    version: getManagedAiProviderFallbackVersion(provider),
    assistantTemplate: null,
    preProcessTemplate: null,
    buscaProdutosTemplate: null,
    downloadImagemTemplate: null,
    gerarCheckoutTemplate: null,
    transferirHumanoTemplate: null,
    uraTemplate: null,
    uraAbTemplate: null,
    componentVersions: buildInitialComponentVersions(),
    isCurrent: true,
    isActive: true,
    createdAt: null,
    updatedAt: null,
  };
}

import { Client } from 'pg';

import { adminPool } from '../database/adminPool.js';
import { testMysqlDatabaseConnection } from './mysqlConnectionTest.services.js';

const EXTENSION_STATUS_SCHEMA = 'public';
const EXTENSION_STATUS_TABLE = 'out_embalagem';

function sanitizeDbName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '') 
    .slice(0, 50);
}

function createDatabaseError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeOptionalCnpj(value) {
  const digits = String(value || '')
    .replace(/\D/g, '');

  if (!digits) {
    return '';
  }

  if (digits.length !== 14) {
    throw createDatabaseError(
      'Informe um CNPJ com 14 dígitos para consultar a unidade de negócio.',
      400,
    );
  }

  return digits;
}

function normalizeConnectionConfig(config) {
  const driver = config.driver === undefined ? 'postgres' : config.driver;
  if (!['postgres', 'mysql'].includes(driver)) {
    throw createDatabaseError('Informe um driver de banco válido: postgres ou mysql.', 400);
  }
  const host = config.host?.trim();
  const database = config.database?.trim();
  const user = config.user?.trim();
  const password = typeof config.password === 'string' ? config.password : '';
  const port = Number(config.port);
  const ssl = Boolean(config.ssl);
  const cnpj = normalizeOptionalCnpj(config.cnpj);

  if (!host) {
    throw createDatabaseError('Informe o host do banco.', 400);
  }

  if (!database) {
    throw createDatabaseError('Informe o nome do banco.', 400);
  }

  if (!user) {
    throw createDatabaseError('Informe o usuário do banco.', 400);
  }

  if (!password) {
    throw createDatabaseError('Informe a senha do banco.', 400);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createDatabaseError('Informe uma porta válida entre 1 e 65535.', 400);
  }

  return {
    driver,
    host,
    database,
    user,
    password,
    port,
    ssl,
    cnpj,
    sourceUnitId: config.sourceUnitId,
  };
}

function normalizeManagedDatabaseName(databaseName) {
  const normalizedName = databaseName?.trim();

  if (!normalizedName) {
    throw createDatabaseError('Informe o banco que deseja verificar.', 400);
  }

  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(normalizedName)) {
    throw createDatabaseError('Nome do banco informado e invalido.', 400);
  }

  return normalizedName;
}

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw createDatabaseError('Identificador invalido para consulta.', 400);
  }

  return `"${identifier}"`;
}

async function findBusinessUnitByCnpj(client, cnpj) {
  const normalizedCnpj = normalizeOptionalCnpj(cnpj);

  if (!normalizedCnpj) {
    return null;
  }

  try {
    const { rows } = await client.query(
      `
        SELECT
          id,
          status,
          codigo,
          nome,
          cnpj,
          nomefantasia,
          razaosocial
        FROM public.unidadenegocio
        WHERE regexp_replace(COALESCE(cnpj, ''), '[^0-9]', '', 'g') = $1
        ORDER BY CASE WHEN status = 'A' THEN 0 ELSE 1 END, id ASC
        LIMIT 1
      `,
      [normalizedCnpj],
    );

    const unit = rows[0];

    if (!unit) {
      return {
        requestedCnpj: normalizedCnpj,
        found: false,
        message:
          'Nenhuma unidade de negócio foi encontrada para o CNPJ informado.',
        unit: null,
      };
    }

    return {
      requestedCnpj: normalizedCnpj,
      found: true,
      message: 'Unidade de negócio localizada com sucesso.',
      unit: {
        id: Number(unit.id),
        status: unit.status || null,
        codigo: unit.codigo || null,
        nome: unit.nome || null,
        cnpj: unit.cnpj || null,
        nomeFantasia: unit.nomefantasia || null,
        razaoSocial: unit.razaosocial || null,
      },
    };
  } catch (error) {
    const lookupMessageByCode = {
      '42P01': 'A tabela unidadenegocio não foi encontrada neste banco.',
      '42501':
        'O usuário informado não tem permissão para consultar a tabela unidadenegocio.',
    };

    return {
      requestedCnpj: normalizedCnpj,
      found: false,
      message:
        lookupMessageByCode[error.code] ||
        'A conexão foi validada, mas não foi possível consultar a unidade de negócio para o CNPJ informado.',
      unit: null,
    };
  }
}

function mapConnectionError(error) {
  const knownErrors = {
    ENOTFOUND: 'Host não encontrado. Verifique o endereço informado.',
    ECONNREFUSED: 'Conexão recusada. Verifique host, porta e firewall.',
    ETIMEDOUT: 'Tempo esgotado ao tentar conectar ao banco.',
    '28P01': 'Usuário ou senha inválidos.',
    '3D000': 'Banco de dados não encontrado.',
    '23505': 'Conexão recusada pelo servidor.',
    '57P03': 'Servidor indisponível no momento.',
  };

  const message =
    knownErrors[error.code] ||
    'Não foi possível conectar ao banco informado.';

  return createDatabaseError(message, error.statusCode || 400);
}

function mapManagedDatabaseError(error, databaseName) {
  if (error.code === '42501') {
    return createDatabaseError(
      `O usuário configurado não tem permissão para consultar o banco ${databaseName}.`,
      403,
    );
  }

  return mapConnectionError(error);
}

function createManagedDatabaseClient(databaseName) {
  return new Client({
    host: process.env.DBHOST,
    user: process.env.DBUSER,
    password: process.env.DBPASSWORD,
    database: databaseName,
    port: Number(process.env.DBPORT) || 5432,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 8000,
  });
}

async function resolveManagedTableStatus(client) {
  const relationName = `${EXTENSION_STATUS_SCHEMA}.${EXTENSION_STATUS_TABLE}`;

  const { rows: metadataRows } = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
      ) AS exists
    `,
    [EXTENSION_STATUS_SCHEMA, EXTENSION_STATUS_TABLE],
  );

  const tableExists = metadataRows[0]?.exists === true;

  if (!tableExists) {
    return {
      tableExists: false,
      hasProducts: false,
      productCount: 0,
      productCountSource: 'exact',
      hasReadAccess: false,
    };
  }

  const { rows: privilegeRows } = await client.query(
    `SELECT has_table_privilege(current_user, $1, 'SELECT') AS can_select`,
    [relationName],
  );
  const hasReadAccess = privilegeRows[0]?.can_select === true;

  if (hasReadAccess) {
    const qualifiedTableName = `${quoteIdentifier(
      EXTENSION_STATUS_SCHEMA,
    )}.${quoteIdentifier(EXTENSION_STATUS_TABLE)}`;
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::bigint AS total FROM ${qualifiedTableName}`,
    );
    const productCount = Number(countRows[0]?.total || 0);

    return {
      tableExists: true,
      hasProducts: productCount > 0,
      productCount,
      productCountSource: 'exact',
      hasReadAccess: true,
    };
  }

  const { rows: statsRows } = await client.query(
    `
      SELECT COALESCE(
        stats.n_live_tup::bigint,
        class.reltuples::bigint,
        0::bigint
      ) AS total
      FROM pg_catalog.pg_class class
      JOIN pg_catalog.pg_namespace namespace
        ON namespace.oid = class.relnamespace
      LEFT JOIN pg_catalog.pg_stat_user_tables stats
        ON stats.schemaname = namespace.nspname
       AND stats.relname = class.relname
      WHERE namespace.nspname = $1
        AND class.relname = $2
        AND class.relkind IN ('r', 'p')
      LIMIT 1
    `,
    [EXTENSION_STATUS_SCHEMA, EXTENSION_STATUS_TABLE],
  );
  const productCount = Number(statsRows[0]?.total || 0);

  return {
    tableExists: true,
    hasProducts: productCount > 0,
    productCount,
    productCountSource: 'estimated',
    hasReadAccess: false,
  };
}

export async function listDatabases(page = 1, limit = 9, search = '') {
  try {
    const offset = (page - 1) * limit;

    let queryBase = `
      FROM pg_database
      WHERE datistemplate = false
      AND datname NOT IN ('postgres')
      `;

    const params = [];

    if (search) {
      params.push(`%${search}%`);
      queryBase += `AND datname ILIKE $${params.length}`;
    }

    //Buscar os dados paginados
    const dataParams = [...params];

    dataParams.push(limit);
    const limitIndex = dataParams.length;

    dataParams.push(offset);
    const offsetIndex = dataParams.length;

    const dataQuery = `
            SELECT datname, pg_size_pretty(pg_database_size(datname)) as size ${queryBase}
            ORDER BY datname ASC
            LIMIT $${limitIndex} OFFSET $${offsetIndex}
            `;
    const { rows: dataRows } = await adminPool.query(dataQuery, dataParams);

    //Contar o total de páginas
    const countQuery = `SELECT COUNT(*) as total ${queryBase}`;
    const { rows: countRows } = await adminPool.query(countQuery, params);

    const totalItems = parseInt(countRows[0].total);
    const totalPages = Math.ceil(totalItems / limit);

    return {
      data: dataRows.map((row) => ({
        name: row.datname,
        size: row.size,
      })),
      meta: {
        page: Number(page),
        limit: Number(limit),
        totalItems,
        totalPages,
      },
    };
  } catch (error) {
    console.error('Falha ao listar os databases:', error.message);
    throw error;
  }
}

export async function createDatabase(name) {
  const dbName = sanitizeDbName(name);
  
  if (!dbName || dbName.length < 3) {
      throw new Error("Nome do banco inválido ou muito curto.");
  }

  try {
    // Executa a query
    await adminPool.query(`
      CREATE DATABASE ${dbName}
      WITH ENCODING 'UTF8'
    `);

    

    // Retorna apenas o objeto de sucesso
    return { database: dbName, message: 'Criado com sucesso' };

  } catch (error) {
    // Lança o erro para o controller tratar
    if (error.code === '42P04') {
      throw new Error('Banco de dados já existe');
    }
    // Repassa o erro original se for outro tipo
    throw error; 
  }
}

export async function testDatabaseConnection(config) {
  const normalizedConfig = normalizeConnectionConfig(config);
  if (normalizedConfig.driver === 'mysql') return testMysqlDatabaseConnection(normalizedConfig);
  const client = new Client({
    host: normalizedConfig.host,
    database: normalizedConfig.database,
    user: normalizedConfig.user,
    password: normalizedConfig.password,
    port: normalizedConfig.port,
    ssl: normalizedConfig.ssl,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  const startedAt = Date.now();

  try {
    await client.connect();

    const { rows } = await client.query(
      'SELECT current_database() AS database, current_user AS user_name',
    );
    const businessUnitLookup = await findBusinessUnitByCnpj(
      client,
      normalizedConfig.cnpj,
    );

    return {
      success: true,
      message: 'Conexão realizada com sucesso.',
      latencyMs: Date.now() - startedAt,
      details: {
        driver: 'postgres',
        host: normalizedConfig.host,
        port: normalizedConfig.port,
        database: rows[0]?.database || normalizedConfig.database,
        user: rows[0]?.user_name || normalizedConfig.user,
        ssl: normalizedConfig.ssl,
      },
      businessUnitLookup,
    };
  } catch (error) {
    throw mapConnectionError(error);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function checkExtensionDatabaseStatus(databaseName) {
  const normalizedDatabaseName = normalizeManagedDatabaseName(databaseName);
  const client = createManagedDatabaseClient(normalizedDatabaseName);
  const startedAt = Date.now();

  try {
    await client.connect();
    const requirementStatus = await resolveManagedTableStatus(client);

    if (!requirementStatus.tableExists) {
      return {
        success: true,
        message:
          'A tabela out_embalagem nao foi encontrada neste banco. A integracao ainda nao pode prosseguir.',
        latencyMs: Date.now() - startedAt,
        database: normalizedDatabaseName,
        requirements: {
          schema: EXTENSION_STATUS_SCHEMA,
          table: EXTENSION_STATUS_TABLE,
          tableExists: false,
          hasProducts: false,
          productCount: 0,
          productCountSource: 'exact',
          hasReadAccess: false,
        },
        readyForIntegration: false,
      };
    }
    const countLabel =
      requirementStatus.productCountSource === 'estimated'
        ? `A estimativa atual indica ${requirementStatus.productCount} produto(s) cadastrado(s).`
        : `${requirementStatus.productCount} produto(s) cadastrado(s).`;

    return {
      success: true,
      message: requirementStatus.hasProducts
        ? `A tabela out_embalagem foi encontrada. ${countLabel}`
        : requirementStatus.productCountSource === 'estimated'
          ? 'A tabela out_embalagem existe. A estimativa atual indica que ela ainda nao possui produtos cadastrados.'
          : 'A tabela out_embalagem existe, mas ainda nao possui produtos cadastrados.',
      latencyMs: Date.now() - startedAt,
      database: normalizedDatabaseName,
      requirements: {
        schema: EXTENSION_STATUS_SCHEMA,
        table: EXTENSION_STATUS_TABLE,
        tableExists: true,
        hasProducts: requirementStatus.hasProducts,
        productCount: requirementStatus.productCount,
        productCountSource: requirementStatus.productCountSource,
        hasReadAccess: requirementStatus.hasReadAccess,
      },
      readyForIntegration: requirementStatus.hasProducts,
    };
  } catch (error) {
    throw mapManagedDatabaseError(error, normalizedDatabaseName);
  } finally {
    await client.end().catch(() => {});
  }
}

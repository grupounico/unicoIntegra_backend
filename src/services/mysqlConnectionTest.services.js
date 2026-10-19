import mysql from 'mysql2';

class MysqlConnectionTestError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function publicMysqlError(error) {
  if (error instanceof MysqlConnectionTestError) return error;
  const messages = {
    ENOTFOUND: 'Host não encontrado. Verifique o endereço informado.',
    ECONNREFUSED: 'Conexão recusada. Verifique host, porta e firewall.',
    ECONNRESET: 'A conexão com o banco foi interrompida.',
    ETIMEDOUT: 'Tempo esgotado ao validar a conexão MySQL.',
    PROTOCOL_SEQUENCE_TIMEOUT: 'Tempo esgotado ao validar a conexão MySQL.',
    ER_ACCESS_DENIED_ERROR: 'Usuário ou senha MySQL inválidos.',
    ER_DBACCESS_DENIED_ERROR: 'O usuário não tem acesso ao banco MySQL informado.',
    ER_BAD_DB_ERROR: 'Banco de dados MySQL não encontrado.',
    ER_NO_SUCH_TABLE: 'A view view_unicocontato_filial não foi encontrada neste banco.',
    ER_TABLEACCESS_DENIED_ERROR: 'O usuário não tem permissão para consultar view_unicocontato_filial.',
    CERT_HAS_EXPIRED: 'O certificado TLS do banco MySQL expirou.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'O certificado TLS do banco MySQL não é confiável.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Não foi possível verificar o certificado TLS do banco MySQL.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'O certificado TLS não corresponde ao host MySQL informado.',
  };
  return new MysqlConnectionTestError(messages[error?.code] || 'Não foi possível validar a conexão MySQL informada.');
}

// The factory and deadline are injectable so failures can be tested without a live ERP.
export async function testMysqlDatabaseConnection(config, { connectionFactory = mysql.createConnection, timeoutMs = 5000 } = {}) {
  const sourceUnitId = Number(config.sourceUnitId);
  if (!Number.isSafeInteger(sourceUnitId) || sourceUnitId <= 0) {
    throw new MysqlConnectionTestError('Informe o código da loja (shop_id) para validar a conexão MySQL.');
  }
  if (!/^\d{14}$/.test(config.cnpj || '')) {
    throw new MysqlConnectionTestError('Informe o CNPJ da unidade para validar a conexão MySQL.');
  }

  const startedAt = Date.now();
  let connection;
  let timer;
  try {
    connection = connectionFactory({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectTimeout: timeoutMs,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true, ...(process.env.AUTOMATIZA_MYSQL_TLS_CA ? { ca: process.env.AUTOMATIZA_MYSQL_TLS_CA } : {}) } } : {}),
    });
    // Driver errors are handled by the connect/query promises, never logged raw.
    connection.on('error', () => {});
    const client = connection.promise();
    const work = async () => {
      await client.connect();
      const [details] = await client.query({ sql: 'SELECT DATABASE() AS database_name, CURRENT_USER() AS user_name', timeout: timeoutMs });
      const [stores] = await client.query({ sql: 'SELECT codigo, cnpj FROM view_unicocontato_filial WHERE codigo = ? LIMIT 2', timeout: timeoutMs }, [sourceUnitId]);
      if (!Array.isArray(stores) || stores.length !== 1 || String(stores[0].codigo) !== String(sourceUnitId)) {
        throw new MysqlConnectionTestError('O código da loja não identifica uma única filial em view_unicocontato_filial.');
      }
      const store = stores[0];
      if (typeof store.cnpj !== 'string' || store.cnpj.replace(/\D/g, '') !== config.cnpj) {
        throw new MysqlConnectionTestError('O CNPJ da filial MySQL não corresponde ao CNPJ da unidade informada.');
      }
      return {
        success: true,
        message: 'Conexão MySQL e identidade da filial validadas com sucesso.',
        latencyMs: Date.now() - startedAt,
        details: { driver: 'mysql', host: config.host, port: config.port, database: details[0]?.database_name || config.database, user: details[0]?.user_name || config.user, ssl: config.ssl },
        businessUnitLookup: {
          requestedCnpj: config.cnpj,
          found: true,
          message: 'Filial Automatiza localizada e CNPJ conferido.',
          unit: { id: sourceUnitId, status: null, codigo: String(store.codigo), nome: null, cnpj: store.cnpj, nomeFantasia: null, razaoSocial: null },
        },
      };
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        connection.destroy();
        reject(new MysqlConnectionTestError('Tempo esgotado ao validar a conexão MySQL.'));
      }, timeoutMs);
    });
    return await Promise.race([work(), deadline]);
  } catch (error) {
    throw publicMysqlError(error);
  } finally {
    clearTimeout(timer);
    connection?.destroy();
  }
}

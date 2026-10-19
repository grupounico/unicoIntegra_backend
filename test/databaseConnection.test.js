import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import mysql from 'mysql2';
import { testDatabaseConnection } from '../src/services/database.services.js';
import { testMysqlDatabaseConnection } from '../src/services/mysqlConnectionTest.services.js';

const config = { host: 'erp.invalid', port: 3306, database: 'automatiza', user: 'reader', password: 'private-password', ssl: false, cnpj: '12345678000195', sourceUnitId: 7 };

function fakeMysql({ stores = [{ codigo: 7, cnpj: '12.345.678/0001-95' }], connectError, queryError, hang = false } = {}) {
  const state = { closed: 0, queries: [] };
  state.factory = (options) => {
    state.options = options;
    return {
      on() {},
      destroy() { state.closed += 1; },
      promise() {
        return {
          async connect() {
            if (connectError) throw connectError;
            if (hang) return new Promise(() => {});
          },
          async query(query, values) {
            state.queries.push({ ...query, values });
            if (queryError) throw queryError;
            return query.sql.startsWith('SELECT DATABASE()') ? [[{ database_name: 'automatiza', user_name: 'reader@erp' }]] : [stores];
          },
        };
      },
    };
  };
  return state;
}

test('MySQL validates shop_id and CNPJ and binds the lookup parameter', async () => {
  const state = fakeMysql();
  const result = await testMysqlDatabaseConnection(config, { connectionFactory: state.factory });
  assert.equal(result.success, true);
  assert.equal(result.details.driver, 'mysql');
  assert.equal(result.businessUnitLookup.found, true);
  assert.equal(result.businessUnitLookup.unit.id, 7);
  assert.equal(state.options.multipleStatements, false);
  assert.equal(state.options.connectTimeout, 5000);
  assert.equal(state.queries[1].sql, 'SELECT codigo, cnpj FROM view_unicocontato_filial WHERE codigo = ? LIMIT 2');
  assert.deepEqual(state.queries[1].values, [7]);
  assert.ok(state.closed > 0);
  assert.ok(!JSON.stringify(result).includes(config.password));
});

for (const [name, stores] of [
  ['missing store', []],
  ['ambiguous store', [{ codigo: 7, cnpj: config.cnpj }, { codigo: 7, cnpj: config.cnpj }]],
  ['wrong store', [{ codigo: 8, cnpj: config.cnpj }]],
  ['different CNPJ', [{ codigo: 7, cnpj: '99999999000199' }]],
]) {
  test(`MySQL blocks ${name}`, async () => {
    const state = fakeMysql({ stores });
    await assert.rejects(testMysqlDatabaseConnection(config, { connectionFactory: state.factory }), (error) => error.statusCode === 400);
    assert.ok(state.closed > 0);
  });
}

test('MySQL rejects absent identity before opening a connection', async () => {
  let opened = false;
  const connectionFactory = () => { opened = true; };
  await assert.rejects(testMysqlDatabaseConnection({ ...config, sourceUnitId: undefined }, { connectionFactory }), /shop_id/);
  await assert.rejects(testMysqlDatabaseConnection({ ...config, cnpj: '' }, { connectionFactory }), /CNPJ/);
  assert.equal(opened, false);
});

test('MySQL authentication failure is sanitized', async () => {
  const state = fakeMysql({ connectError: Object.assign(new Error(`secret ${config.password}`), { code: 'ER_ACCESS_DENIED_ERROR' }) });
  await assert.rejects(testMysqlDatabaseConnection(config, { connectionFactory: state.factory }), (error) => error.message === 'Usuário ou senha MySQL inválidos.');
  assert.ok(state.closed > 0);
});

test('unknown driver error cannot expose a URL, password or SQL', async () => {
  const state = fakeMysql({ queryError: new Error(`mysql://reader:${config.password}@erp.invalid/private`) });
  await assert.rejects(testMysqlDatabaseConnection(config, { connectionFactory: state.factory }), (error) => !error.message.includes(config.password) && !error.message.includes('mysql://'));
});

test('MySQL deadline destroys a connection stalled during handshake', async () => {
  const state = fakeMysql({ hang: true });
  await assert.rejects(testMysqlDatabaseConnection(config, { connectionFactory: state.factory, timeoutMs: 10 }), /Tempo esgotado/);
  assert.ok(state.closed > 0);
});

test('MySQL enables verified TLS with the configured CA', async (t) => {
  const originalCa = process.env.AUTOMATIZA_MYSQL_TLS_CA;
  t.after(() => { if (originalCa === undefined) delete process.env.AUTOMATIZA_MYSQL_TLS_CA; else process.env.AUTOMATIZA_MYSQL_TLS_CA = originalCa; });
  process.env.AUTOMATIZA_MYSQL_TLS_CA = 'test-ca';
  const state = fakeMysql();
  await testMysqlDatabaseConnection({ ...config, ssl: true }, { connectionFactory: state.factory });
  assert.deepEqual(state.options.ssl, { rejectUnauthorized: true, ca: 'test-ca' });
});

test('the database test endpoint dispatches MySQL with a formatted CNPJ', async (t) => {
  const state = fakeMysql();
  const original = mysql.createConnection;
  t.after(() => { mysql.createConnection = original; });
  mysql.createConnection = state.factory;
  const result = await testDatabaseConnection({ ...config, driver: 'mysql', cnpj: '12.345.678/0001-95' });
  assert.equal(result.details.driver, 'mysql');
  assert.equal(result.businessUnitLookup.requestedCnpj, config.cnpj);
});

test('omitting the driver preserves the PostgreSQL endpoint contract', async (t) => {
  const original = { connect: Client.prototype.connect, query: Client.prototype.query, end: Client.prototype.end };
  t.after(() => Object.assign(Client.prototype, original));
  Client.prototype.connect = async function () {};
  Client.prototype.query = async function () { return { rows: [{ database: 'alpha', user_name: 'reader' }] }; };
  Client.prototype.end = async function () {};
  const result = await testDatabaseConnection({ ...config, port: 5432, cnpj: '' });
  assert.equal(result.details.driver, 'postgres');
  assert.equal(result.details.database, 'alpha');
  assert.equal(result.businessUnitLookup, null);
});

test('unsupported driver is rejected without a database connection', async () => {
  await assert.rejects(testDatabaseConnection({ ...config, driver: 'sqlite' }), /driver/);
});

test('CNPJ with extra digits is rejected rather than truncated', async () => {
  await assert.rejects(testDatabaseConnection({ ...config, driver: 'mysql', cnpj: `${config.cnpj}99` }), /14 dígitos/);
});

test('unknown PostgreSQL errors are sanitized as well', async (t) => {
  const original = { connect: Client.prototype.connect, end: Client.prototype.end };
  t.after(() => Object.assign(Client.prototype, original));
  Client.prototype.connect = async function () { throw new Error(`postgresql://reader:${config.password}@erp.invalid/private`); };
  Client.prototype.end = async function () {};
  await assert.rejects(testDatabaseConnection({ ...config, port: 5432 }), (error) => !error.message.includes(config.password) && !error.message.includes('postgresql://'));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { buildLocalCatalogStagingEnvironment } from './lib/catalog-local-staging-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.catalog-staging.local');
let temporary;
try {
  if (!fs.existsSync(envPath) || (fs.statSync(envPath).mode & 0o077) !== 0) throw new Error('LOCAL_STAGING_PRIVATE_ENV_REQUIRED');
  const { environment, summary } = buildLocalCatalogStagingEnvironment({ ...process.env, ...dotenv.parse(fs.readFileSync(envPath)), CATALOG_LOCAL_STAGING_SERVER: 'true' });
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'unico-catalog-local-migrate-'));
  fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(temporary, 'schema.prisma'));
  const migrations = path.join(temporary, 'migrations'); fs.mkdirSync(migrations);
  fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(migrations, 'migration_lock.toml'));
  let count = 0;
  for (const entry of fs.readdirSync(path.join(root, 'prisma/migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(root, 'prisma/migrations', entry.name, 'migration.sql');
    if (!fs.existsSync(source)) continue;
    const destination = path.join(migrations, entry.name); fs.mkdirSync(destination); fs.copyFileSync(source, path.join(destination, 'migration.sql')); count += 1;
  }
  const configPath = path.join(temporary, 'prisma.config.mjs');
  fs.writeFileSync(configPath, `export default {schema:${JSON.stringify(path.join(temporary, 'schema.prisma'))},migrations:{path:${JSON.stringify(migrations)}},datasource:{url:process.env.DATABASE_URL}};\n`);
  const childEnvironment = { ...environment, DOTENV_CONFIG_PATH: envPath, DOTENV_CONFIG_QUIET: 'true' };
  delete childEnvironment.DOTENV_CONFIG_OVERRIDE;
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--config', configPath], {
    cwd: root, env: childEnvironment, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    const codes = [...new Set(`${result.stdout}${result.stderr}`.match(/P[0-9]{4}/g) || [])];
    console.error(JSON.stringify({ event: 'local_catalog_migration_failed', database: summary.database, codes })); process.exitCode = 1;
  } else console.log(JSON.stringify({ event: 'local_catalog_migration_completed', database: summary.database, migrations: count }));
} catch (error) {
  console.error(JSON.stringify({ event: 'local_catalog_migration_failed', code: /^LOCAL_STAGING_/.test(error.message) ? error.message : 'LOCAL_STAGING_MIGRATION_UNAVAILABLE' })); process.exitCode = 1;
} finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }

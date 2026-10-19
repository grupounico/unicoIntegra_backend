import dotenv from 'dotenv';
import { checkCatalogProductionEnvironment } from './lib/catalog-production-preflight.mjs';

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--env-file');
if (fileFlag >= 0 && !args[fileFlag + 1]) {
  console.error(JSON.stringify({ event: 'catalog_production_preflight_failed', code: 'CATALOG_PRODUCTION_ENV_FILE_REQUIRED' }));
  process.exitCode = 1;
} else {
  dotenv.config({ path: fileFlag >= 0 ? args[fileFlag + 1] : '.env', override: false, quiet: true });
  try {
    console.log(JSON.stringify({ event: 'catalog_production_preflight_passed', ...checkCatalogProductionEnvironment(process.env) }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'catalog_production_preflight_failed', code: /^CATALOG_PRODUCTION_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CATALOG_PRODUCTION_INVALID_CONFIGURATION' }));
    process.exitCode = 1;
  }
}

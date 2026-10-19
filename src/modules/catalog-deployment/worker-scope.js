import { env } from '../../config/env.js';
import { DeploymentError } from './errors.js';

export function catalogWorkerDeploymentFilter(value = env.CATALOG_WORKER_ENVIRONMENT) {
  if (!value) return {};
  if (!['staging', 'production'].includes(value)) throw new DeploymentError('CATALOG_WORKER_ENVIRONMENT_INVALID', 'O filtro de ambiente do worker é inválido.', { statusCode: 503, stage: 'configuration' });
  return { environment: value };
}

export function catalogWorkerUnitFilter() {
  const deployment = catalogWorkerDeploymentFilter();
  return deployment.environment ? { deployment } : {};
}

export function catalogWorkerCanProcess(deployment) {
  const { environment } = catalogWorkerDeploymentFilter();
  return !environment || deployment?.environment === environment;
}

import { prisma } from '../../../prisma/PrismaClient.js';
import { createAiVenda } from '../../services/ai.services.js';
import { testDatabaseConnection } from '../../services/database.services.js';
import * as deployments from '../catalog-deployment/service.js';
import { saveAtenderBemConfiguration, createAtenderBemGroup } from '../catalog-deployment/atenderbem-service.js';
import { startAtenderBemImport, checkAtenderBemImport } from '../catalog-deployment/atenderbem-import.js';
import { aiStep } from '../catalog-deployment/ai-step.js';
import { createCatalogMcpRouter } from './http.js';

const ai = aiStep({ database: prisma, installers: { venda: createAiVenda } });

export const catalogMcpServices = {
  listDeployments: deployments.listDeployments,
  getDeployment: deployments.getDeployment,
  createDeployment: deployments.createDeployment,
  startDeployment: deployments.startDeployment,
  refreshDeploymentRuns: deployments.refreshDeploymentRuns,
  retryDeployment: deployments.retryDeployment,
  retryUnit: deployments.retryUnit,
  testDatabaseConnection,
  saveAtenderBemConfiguration,
  createAtenderBemGroup,
  startAtenderBemImport,
  checkAtenderBemImport,
  createAi: ai.createAi,
};

export default createCatalogMcpRouter({ services: catalogMcpServices });

import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import archiver from 'archiver';
import { rimraf } from 'rimraf';
import helmet from 'helmet';
import { env } from './config/env.js';
import installingRoutes from './routes/installing.routes.js';
import createAiRoutes from './routes/ai.routes.js';
import databaseRoutes from './routes/database.routes.js';
import newsRoutes from './routes/news.routes.js';
import logsRoutes from './routes/logs.routes.js';
import chatRoutes from './routes/chat.routes.js';
import extensionRoutes from './routes/extensions.routes.js';
import bancoUnicoImportsRoutes from './routes/bancoUnicoImports.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import catalogDeploymentRoutes from './modules/catalog-deployment/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const downloadsPath = path.join(projectRoot, 'downloads');

const allowedOrigins = env.CORS_ALLOWED_ORIGINS;

function normalizeOrigin(origin = '') {
  return String(origin).trim().replace(/\/+$/g, '').toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOriginAllowed(origin) {
  const normalizedOrigin = normalizeOrigin(origin);

  return allowedOrigins.some((allowedOrigin) => {
    const normalizedAllowedOrigin = normalizeOrigin(allowedOrigin);

    if (!normalizedAllowedOrigin) {
      return false;
    }

    if (normalizedAllowedOrigin === '*') {
      return true;
    }

    if (normalizedAllowedOrigin.includes('*')) {
      const wildcardPattern = `^${escapeRegExp(normalizedAllowedOrigin).replace(/\\\*/g, '.*')}$`;
      return new RegExp(wildcardPattern, 'i').test(normalizedOrigin);
    }

    return normalizedAllowedOrigin === normalizedOrigin;
  });
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  exposedHeaders: ['Content-Disposition'],
  credentials: true,
  optionsSuccessStatus: 204,
};

export const app = express();

// ponytail: Express 5's default 'simple' query parser doesn't understand
// bracket notation (status[]=a&status[]=b), so multi-value filters (Produtos
// tab checkboxes) silently arrived as undefined server-side. 'extended'
// restores qs-style parsing.
app.set('query parser', 'extended');

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);

app.use(express.json({ limit: '1mb' }));
app.use('/downloads', express.static(downloadsPath));

app.post('/api/generate', async (req, res) => {
  const clientData = req.body;
  const buildId = Date.now();
  const buildPath = path.join(projectRoot, 'builds-temporarios', `${buildId}`);
  const sourceAppPath = path.join(projectRoot, 'app-Alpha7');
  const outputZipPath = path.join(
    projectRoot,
    'builds-temporarios',
    `app-cliente-${buildId}.zip`,
  );

  try {
    await fs.copy(sourceAppPath, buildPath);

    const dbConfigPath = path.join(buildPath, 'data', 'db-config.json');
    const dbConfig = await fs.readJson(dbConfigPath);
    dbConfig.db.user = clientData.db_user;
    dbConfig.db.host = clientData.db_host;
    dbConfig.db.database = clientData.db_database;
    dbConfig.db.password = clientData.db_password;
    await fs.writeJson(dbConfigPath, dbConfig, { spaces: 4 });

    const accessKeyPath = path.join(buildPath, 'data', 'access_key.json');
    await fs.writeJson(
      accessKeyPath,
      { key: clientData.access_key },
      { spaces: 4 },
    );

    const pkgCommand = [
      `cd ${buildPath}`,
      'npm install',
      'npx pkg . --targets node18-win-x64,node18-linux-x64,node18-macos-x64 --output app-cliente',
    ].join(' && ');

    await new Promise((resolve, reject) => {
      exec(pkgCommand, { timeout: 300000 }, (error, stdout, stderr) => {
        if (stdout) {
          console.log(stdout);
        }

        if (stderr) {
          console.error(stderr);
        }

        if (error) {
          return reject(
            new Error(
              `Falha ao executar o pkg. Mensagem: ${error.message}.`,
            ),
          );
        }

        return resolve(stdout);
      });
    });

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputZipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(buildPath, 'app-Alpha7-configurado');
      archive.finalize();
    });

    res.download(
      outputZipPath,
      `app-cliente-${clientData.nome_cliente || buildId}.zip`,
      async (error) => {
        if (error) {
          console.error('Erro ao enviar o arquivo para o cliente:', error);
        }

        await Promise.allSettled([
          rimraf(buildPath),
          fs.remove(outputZipPath),
        ]);
      },
    );
  } catch (error) {
    if (await fs.pathExists(buildPath)) {
      await rimraf(buildPath);
    }

    if (await fs.pathExists(outputZipPath)) {
      await fs.remove(outputZipPath);
    }

    if (!res.headersSent) {
      res.status(500).json({
        message: 'Falha na geracao',
        error: error.message,
      });
    }
  }
});

app.use('/api/databases', databaseRoutes);
app.use('/install', installingRoutes);
app.use('/api/ia', createAiRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/extensions', extensionRoutes);
app.use('/api/banco-unico-imports', bancoUnicoImportsRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/v1/deployments', catalogDeploymentRoutes);
app.use('/api', logsRoutes);
app.use('/chat', chatRoutes);

export default app;

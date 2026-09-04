# Deploy com Docker na VPS

Este procedimento troca apenas o processo Node gerenciado pelo PM2. O PostgreSQL
continua externo e nenhum volume de banco é criado pelo Compose.

## Antes de começar

1. Rotacione todas as credenciais que tenham sido compartilhadas fora do cofre:
   banco, OpenAI, API administrativa, multi-provider, usuário de instância e TOTP.
2. Confirme que o usuário da VPS possui acesso ao repositório da organização.
3. Faça backup do banco antes de executar migrations.
4. Mantenha uma única réplica do backend: a API inicia workers no mesmo processo.

Nunca adicione o arquivo .env ao Git. O .dockerignore também o exclui da imagem.
Em CI ou homologação, outro arquivo pode ser usado com APP_ENV_FILE=/caminho/env.

## Variáveis

Copie o .env usado pelo PM2 para a raiz do checkout na VPS. Mantenha
DATABASE_URL, DBHOST, DBPORT, DBUSER, DBPASSWORD e DB_DATABASE apontando para o
PostgreSQL existente.

Como o multi-provider roda na própria VPS, 127.0.0.1 não funciona de dentro do
container. O Compose usa, por padrão:

~~~env
MULTIPROVIDER_DOCKER_BASE_URL=http://host.docker.internal:51240
~~~

Adicione também as variáveis do módulo Catálogo:

~~~env
HUBUNICO_BASE_URL=
HUBUNICO_ADMIN_API_KEY=
UNICOMMERCE_BACK_BASE_URL=
UNICOMMERCE_BACK_INTERNAL_API_KEY=
DEPLOYMENT_ENCRYPTION_KEY=
BANCO_UNICO_BASE_URL=
BANCO_UNICO_AUTHORIZATION=
~~~

Gere a chave de criptografia uma única vez, guarde-a no cofre e não a troque sem
um processo de rotação:

~~~bash
openssl rand -base64 32
~~~

## Backup

Use as credenciais administrativas apropriadas para o PostgreSQL existente:

~~~bash
mkdir -p backups
PGPASSWORD='<senha>' pg_dump \
  --host='<host>' \
  --port='5432' \
  --username='<usuario>' \
  --format=custom \
  --file="backups/unico_integra_$(date +%Y%m%d_%H%M%S).dump" \
  unico_integra
~~~

Confirme que o arquivo foi criado e não está vazio antes de continuar.

## Build e teste paralelo

O backend atual usa a porta 4000 no PM2. Suba primeiro o container na porta local
14000, sem interromper o processo existente:

~~~bash
docker compose build app
APP_BIND_PORT=14000 WORKERS_ENABLED=false SCHEDULERS_ENABLED=false docker compose up -d app
docker compose ps
curl --fail http://127.0.0.1:14000/health/live
curl --fail http://127.0.0.1:14000/health/ready
docker compose logs --tail=200 app
~~~

O endpoint live confirma o processo HTTP. O endpoint ready também executa
SELECT 1 no banco existente.

Não execute cargas, instalações ou outros comandos mutáveis durante esse teste
paralelo. O comando acima desativa workers e schedulers no container de teste;
o PM2 continua sendo o único processador do banco nesse momento.

## Migrations

Inspecione primeiro o estado:

~~~bash
docker compose --profile tools run --rm migrate npx prisma migrate status
~~~

A cadeia histórica do projeto precisa estar saudável no banco da VPS. Se
migrate status indicar migration falha, divergência ou migration não aplicada
fora da nova entrega, interrompa o deploy e corrija o histórico antes de seguir.

Depois do backup e da inspeção:

~~~bash
docker compose --profile tools run --rm migrate
~~~

Migrations não são executadas automaticamente ao iniciar a aplicação.

## Cutover do PM2

Depois dos health checks na porta 14000:

~~~bash
APP_BIND_PORT=14000 docker compose down
pm2 stop <nome-do-processo>
docker compose up -d app
curl --fail http://127.0.0.1:4000/health/ready
docker compose logs --tail=200 app
~~~

Quando o proxy reverso estiver respondendo normalmente:

~~~bash
pm2 delete <nome-do-processo>
pm2 save
~~~

Não remova o PM2 antes de validar o container na porta definitiva.

## Operação

~~~bash
docker compose ps
docker compose logs -f --tail=200 app
docker compose restart app
docker compose build app
docker compose up -d app
~~~

O serviço usa restart unless-stopped, health check e encerramento gracioso de
até 30 segundos.

## Rollback da aplicação

As migrations desta entrega apenas adicionam tabelas e colunas. A versão anterior
do backend pode continuar operando com elas presentes.

~~~bash
docker compose down
pm2 start <arquivo-ou-comando-anterior>
pm2 save
curl --fail http://127.0.0.1:4000/
~~~

Se o proxy usar outro health check, valide também a URL pública.

Não restaure o banco automaticamente durante rollback da aplicação. Só restaure
o backup se uma análise confirmar corrupção ou alteração incompatível de dados.

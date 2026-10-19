# Release do Catálogo: quatro ERPs e criação da IA

A release reúne a criação da IA de venda da PR 21, as correções AtenderBem já
integradas em `main` e o cadastro por ERP: Alpha7 (PostgreSQL), Linx (CNPJ),
Automatiza (MySQL + `shop_id`) e Vetor (API key + `cdFilial`).

A API pública do Integra recebe a API key Vetor em `vetorApiKey`, grava-a
criptografada e envia `credentialRef` ao contrato atual do Hub. Não é necessário
publicar outra versão do Hub. Linx não envia `credentialRef` nem `sourceUnitId`.
O tenant Unicommerce continua usando `erpProvider=alpha7` como transporte do Hub
para os quatro ERPs; isso não representa o ERP original da loja.

## Configuração e preflight

Use um checkout de release isolado. Preserve o `.env` e a chave de criptografia
existentes. Não copie o `.env.catalog-staging.local` para produção.

Antes de iniciar a release, execute no ambiente de produção:

```sh
NODE_ENV=production npm run catalog:production:check -- --env-file /caminho/privado/.env
```

O preflight é somente leitura e não acessa rede ou banco. Ele exige:

- `CATALOG_DEPLOYMENT_ENVIRONMENT=production` e `CATALOG_WORKER_ENVIRONMENT=production`.
- Nenhuma configuração `CATALOG_LOCAL_*` ativa.
- URLs HTTPS de produção para Hub, Banco Único e Unicommerce, sem marcadores
  staging, sandbox ou local; as respectivas credenciais devem estar presentes.
- `DATABASE_URL` e `DEPLOYMENT_ENCRYPTION_KEY` válidas/presentes; a chave AES
  existente precisa ser preservada para ler segredos já gravados.
- `STOREFRONT_PROVISIONING_ENABLED=true`, token, time e projeto Vercel.
- `CATALOG_ATENDERBEM_FEED_BASE_URL` HTTPS e o host incluído em
  `CATALOG_FEED_ALLOWED_HOSTS` (o padrão é `unicocontato.tech`).

Os nomes específicos `HUBUNICO_PRODUCTION_*`, `BANCO_UNICO_PRODUCTION_*`,
`UNICOMMERCE_BACK_PRODUCTION_*` e `VERCEL_PRODUCTION_*` têm prioridade. Os aliases
legados globais (`HUBUNICO_BASE_URL`/`HUBUNICO_ADMIN_API_KEY`,
`BANCO_UNICO_BASE_URL`/`BANCO_UNICO_AUTHORIZATION`,
`UNICOMMERCE_BACK_BASE_URL`/`UNICOMMERCE_BACK_INTERNAL_API_KEY`,
`VERCEL_API_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID`) continuam aceitos se os
específicos estiverem vazios. O preflight informa somente quais nomes foram
selecionados e os destinos sem credenciais.

A conta de serviço usada para criar IA permanece configurada por
`INSTANCE_SERVICE_USERNAME`, `INSTANCE_SERVICE_PASSWORD` e, quando aplicável,
`INSTANCE_SERVICE_TOTP_SECRET`, `INSTANCE_SERVICE_TOTP_DIGITS` e
`INSTANCE_SERVICE_TOTP_PERIOD_SECONDS`. As credenciais MCP/feed do AtenderBem
continuam sendo informadas e criptografadas por unidade.

Para Automatiza com CA privada, `AUTOMATIZA_MYSQL_TLS_CA` pode conter o PEM da CA.
A conexão mantém a validação do certificado. Use a mesma CA configurada no Hub.

## Migrations

Faça backup e inspecione `prisma migrate status` antes de `prisma migrate deploy`.
Não execute `db push`, não resete o banco e não altere migrations já aplicadas.
A ordem final da cadeia é:

1. `20261007180000_add_atenderbem_configuration`: cria os campos JSON e segredo
   criptografado do AtenderBem; já está em `main`, mas precisa estar aplicada.
2. `20261008120000_add_linx_catalog_erp`: permite `sourceUnitId` nulo para Linx.
3. `20261019120000_scope_catalog_source_identity`: troca a unicidade global de
   origem por índice comum e unicidade parcial somente Alpha7, em uma transação.

Automatiza/Vetor podem repetir `shop_id`/`cdFilial` entre origens diferentes.
Alpha7 mantém a regra anterior de unicidade por implantação/provider/sourceId.
A criação do índice toma locks na tabela: aplique com o processamento pausado e
ative uma única réplica do worker após conferir a migration.

Os checkouts de desenvolvimento podem conter um diretório vazio antigo
`20260909100000_add_catalog_environment` que não faz parte do Git. Não o copie
para a release: Prisma rejeita um diretório de migration sem `migration.sql`.

A release foi validada aplicando as 27 migrations, do zero, em PostgreSQL 16
isolado, incluindo as constraints reais. O histórico do banco de produção ainda
precisa corresponder à cadeia antes da aplicação.

## Publicação e rollback

O repositório oferece `Dockerfile`/`compose.yml`; consulte `DEPLOY_DOCKER_VPS.md`.
A VPS também pode continuar com PM2 e um diretório de release separado. Preserve
correções operacionais existentes, especialmente CORS, sem resetar o checkout
ativo. A aplicação não executa migrations automaticamente.

Para verificar uma versão paralela, desative `DEPLOYMENT_WORKER_ENABLED`,
`BANCO_UNICO_IMPORT_WORKER_ENABLED` e `AI_URA_AUDIT_ENABLED`. Valide `/health/live`
e `/health/ready`, depois faça o cutover mantendo somente um worker ativo.

Um rollback da aplicação preserva as novas colunas. Não recrie automaticamente o
índice único global: após cadastros Automatiza/Vetor com IDs repetidos, sua
recriação pode falhar. A versão anterior também não oferece o cadastro dos novos
ERPs; revise os jobs criados pela release antes de voltar o worker antigo.

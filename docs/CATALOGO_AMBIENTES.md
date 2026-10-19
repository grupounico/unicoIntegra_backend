# Ambientes do módulo Catálogo

`CATALOG_DEPLOYMENT_ENVIRONMENT` define o destino de novas implantações:

```env
CATALOG_DEPLOYMENT_ENVIRONMENT=staging
```

Valores aceitos: `staging` e `production`. O ambiente escolhido é persistido em
`client_deployments.environment`. Alterar a flag não move implantações já
criadas e não faz um retry mudar de ambiente.

```env
HUBUNICO_PRODUCTION_BASE_URL=https://unicocontato.tech/hubunico
HUBUNICO_PRODUCTION_ADMIN_API_KEY=
HUBUNICO_STAGING_BASE_URL=https://api.unicocontato.ia.br/hubunico-staging
HUBUNICO_STAGING_ADMIN_API_KEY=

UNICOMMERCE_BACK_PRODUCTION_BASE_URL=https://unicocontato.tech/unicommerceBack
UNICOMMERCE_BACK_PRODUCTION_INTERNAL_API_KEY=
UNICOMMERCE_BACK_STAGING_BASE_URL=https://unicocontato.tech/unicommerceBack
UNICOMMERCE_BACK_STAGING_INTERNAL_API_KEY=

BANCO_UNICO_PRODUCTION_BASE_URL=https://unicocontato.tech/banco-unico
BANCO_UNICO_PRODUCTION_AUTHORIZATION=
BANCO_UNICO_STAGING_BASE_URL=https://unicocontato.tech/banco-unico
BANCO_UNICO_STAGING_AUTHORIZATION=
```

UnicommerceBack e Banco Único podem apontar para o mesmo destino nos dois
ambientes. As variáveis legadas sem `PRODUCTION` continuam aceitas como fallback
somente em produção. Staging é fail-closed: todas as variáveis de staging devem
estar preenchidas para impedir fallback acidental para produção.

Depois de mudar a flag, reinicie o processo com `--update-env`. Confira o campo
`environment` na resposta de criação antes de iniciar a implantação.

## Storefront compartilhado na Vercel

### Endereço do catálogo por tenant

O instalador envia os dois campos em cada criação/atualização do tenant:

```json
{
  "storefrontDomain": "whatsapp-unidade-franca.vercel.app",
  "ecommerceBaseUrl": "https://whatsapp-unidade-franca.vercel.app"
}
```

`storefrontDomain` é somente o hostname. `ecommerceBaseUrl` é derivado desse
hostname e deve usar HTTPS, sem caminho, credenciais, query ou fragmento. Não há
fallback para a URL global da Complexo Pharma ou de outra unidade.

Por compatibilidade com a API de criação que ainda ignora `storefrontDomain`,
o instalador também envia ambos no PATCH de configuração e confirma com GET.
A instalação não avança/conclui se o tenant não retornar os valores esperados;
o erro `ECOMMERCE_BASE_URL_NOT_PERSISTED` indica URL ausente ou divergente.
A conclusão faz uma leitura final, incluindo unidades já prontas de uma tentativa
anterior. A retomada corrige a URL reutilizando tenant, produtos e domínio.
Essa validação não é executada pela reconciliação periódica de aliases.

Para uma instalação existente, confirme primeiro a identidade e o domínio do
tenant. A correção pontual usa `PATCH /api/tenants/{TENANT_ID}` no UnicommerceBack
do ambiente correto, com `X-Internal-API-Key`, enviando `ecommerceBaseUrl` HTTPS
do próprio tenant. Confirme ambos os campos por GET após o PATCH. Não faça edição
direta no banco nem reimporte produtos para corrigir o endereço.

### Publicação

Cada ambiente usa seu projeto Vercel compartilhado. Nenhum projeto ou build é
criado por cliente. O orquestrador aceita somente um deployment `READY` ligado
a `grupounico/unicommerce:main` cujo `githubCommitSha` seja igual ao SHA atual
do GitHub. O alias é reservado, o domínio é configurado no tenant ainda inativo
e só então o tenant é ativado. Identidade, branding responsivo e catálogo
público são validados antes de concluir.

```env
STOREFRONT_PROVISIONING_ENABLED=true
STOREFRONT_DOMAIN_PREFIX=whatsapp
STOREFRONT_DOMAIN_SUFFIX=vercel.app
STOREFRONT_HEALTH_TIMEOUT_MS=60000
VERCEL_API_TOKEN=
VERCEL_TEAM_ID=
VERCEL_PROJECT_ID=
STOREFRONT_GITHUB_OWNER=grupounico
STOREFRONT_GITHUB_REPO=unicommerce
STOREFRONT_GITHUB_BRANCH=main
STOREFRONT_GITHUB_TOKEN=
```

A unidade inicial usa `whatsapp-<username>.vercel.app`. Filiais usam também o
código da unidade, por exemplo `whatsapp-<username>-loja-02.vercel.app`.
`VERCEL_API_TOKEN` é secreto server-side. `VERCEL_TEAM_ID` e
`VERCEL_PROJECT_ID` podem ser compartilhados entre staging e production; para
separá-los, use as variantes `VERCEL_STAGING_*` e `VERCEL_PRODUCTION_*`.

Se a release ainda não estiver alinhada, a implantação aguarda em
`waiting_storefront_release`, sem ativar tenants novos. Tenants previamente
ativados pela mesma implantação permanecem ativos. O reconciliador verifica
domínio, proteção e alias mesmo quando o SHA não mudou; ele não cria deploys,
commits, merges ou pushes.

### Publicação automática e permissões

O fluxo valida equipe/projeto e vínculo Git antes de qualquer escrita na Vercel:

1. Confirma a release `READY` correspondente ao SHA atual da `main`.
2. Consulta e, se necessário, cadastra o domínio em **Project Domains**.
   Remove associação de preview/redirecionamento nesse domínio, confirma
   Production e reconsulta a verificação. Um alias legado não substitui esse cadastro.
3. Apenas em produção, configura **Standard Protection** via
   `ssoProtection.deploymentType = prod_deployment_urls_and_all_previews` e
   confirma por leitura. **Todos os domínios de Production desse projeto ficam
   públicos; previews e URLs individuais de deployments continuam protegidos.**
4. Associa o alias à release validada, configura o domínio no tenant e ativa-o
   somente se ainda estiver inativo e apto para ativação.
5. Acessa `/api/storefront/identity` e `/api/catalog/products` sem cookies,
   autenticação ou bypass. Exige HTTP 200, tenant e domínio esperados, status
   ativo, três banners desktop/mobile distintos e ao menos 20 produtos com
   preço e estoque positivos antes de concluir.

O token Vercel precisa acessar a equipe selecionada e ter permissão para ler
projeto/deployments/aliases, cadastrar/atualizar/verificar Project Domains,
associar aliases e atualizar a configuração de autenticação do projeto.
Um token somente de leitura não basta. O token GitHub precisa ler a revisão
atual do repositório (inclusive acesso ao repositório quando privado).
Nenhum desses tokens deve ser enviado pelo frontend ou gravado em eventos.

Em staging, a automação **não altera a autenticação**. Use projeto/equipe de
staging separados se precisar preservar uma política diferente: compartilhar
um projeto com produção também compartilha suas políticas. Firewall,
restrições de IP, senhas e demais proteções não são desativados automaticamente.
Domínios de outro projeto geram conflito; não há transferência automática.
Em respostas ambíguas ou concorrência, o cadastro remoto é reconsultado antes
de repetir a escrita.

Contratos: [Project Domains](https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project)
e [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

### Retomar após a última etapa confirmada

No acompanhamento, use **Retomar implantação** no cabeçalho/alerta ou
**Retomar unidade** no cartão da unidade. Os botões aparecem em falha,
falha parcial, timeout ou reconciliação necessária, inclusive quando
`retryable=false`: esse campo controla a repetição automática, não impede
uma retomada manual depois da correção da causa.

Os endpoints permanecem `POST /api/v1/deployments/:deploymentId/retry` e
`POST /api/v1/deployments/:deploymentId/units/:unitId/retry`.
Não é necessário criar outra implantação nem editar o banco.

A retomada consulta o estado real do tenant e confere identidade, implantação,
unidade/vendedor do Hub, configuração e domínio. Um tenant ativo só é
reaproveitado com registro de ativação concluída pela própria implantação.
Nesse caso, retoma a publicação da loja, sem recriar tenant, reimportar produtos
ou ativá-lo novamente. Para tenants novos continua valendo a preparação
inativa. Cada unidade retoma sua pendência; unidades já prontas são preservadas.

Falhas transitórias da publicação ficam em `waiting_storefront`. O worker
agenda até **cinco novas tentativas**, com intervalo mínimo de **30 segundos**
(a primeira execução não conta como nova tentativa). O orçamento usa etapas
persistidas desde `startedAt` da tentativa atual, sobrevivendo ao reinício do
worker. Ao esgotar, preserva recursos e erro para retomada manual. Um clique
de retomada inicia um novo orçamento; não apaga o histórico.

Diagnóstico no alerta e na timeline:

| Código | Ação de suporte |
| --- | --- |
| `VERCEL_DOMAIN_CONFLICT` | Conferir o proprietário/projeto; não transferir automaticamente. |
| `VERCEL_PERMISSION_DENIED` / `VERCEL_AUTH_FAILED` | Corrigir acesso/permissões do token da equipe e tentar novamente. |
| `VERCEL_DOMAIN_UNVERIFIED` | Conferir propriedade, verificação e DNS. |
| `STOREFRONT_AUTHENTICATION_REQUIRED` | Conferir cadastro em Production e política de autenticação. |
| `STOREFRONT_ACCESS_BLOCKED` | Conferir firewall, IP e outras proteções; não há bypass. |
| `RECONCILIATION_REQUIRED` | Conferir vínculos e evidência de ativação; não desativar/recriar o tenant. |

Os metadados seguros preservam etapa e HTTP quando disponíveis, sem corpo
da resposta remota nem credenciais. O painel usa o erro da unidade quando o
erro geral está vazio. O novo status é textual e não exige migration.

### Validação local isolada

`npm test` cobre domínios, aliases, permissões, proteção e identidade pública.
Com PostgreSQL descartável em `127.0.0.1:55432/unico_integra_test`, execute
`node test/catalogDeployment.e2e.mjs` e
`CATALOG_E2E_PUBLICATION_RECOVERY=1 node test/catalogDeployment.e2e.mjs`.
O segundo cenário reproduz a falha de Franca, preservação de IDs/produtos,
unidades em estados diferentes, worker reiniciado e limite de tentativas.
**O teste E2E limpa suas tabelas: nunca aponte `CATALOG_E2E_DATABASE_URL` para
produção ou um banco compartilhado.**

`POST /api/v1/deployments/:deploymentId/promote` promove staging para production
de forma idempotente. A rota fica bloqueada até
`CATALOG_PRODUCTION_PROMOTION_ENABLED=true`, exige que o SHA validado em staging
continue sendo a `main` atual e retém a credencial ERP cifrada por no máximo
`CATALOG_CREDENTIAL_RETENTION_DAYS` (padrão: 7).

## Webhook de pedidos por unidade

Novas implantações devem informar `orderWebhookUrl` em cada unidade. O valor
deve ser uma URL HTTPS e é incorporado em `erpConfig.orderWebhookUrl` antes da
validação e ativação do tenant:

```json
{
  "units": [
    {
      "codigo": "MATRIZ",
      "orderWebhookUrl": "https://cliente.example/webhook/capture/identificador"
    }
  ]
}
```

O orquestrador sempre busca o tenant e mescla o `erpConfig` atual antes do
`PATCH`, preservando campos adicionais. O webhook é cifrado no banco do Único
Integra e nunca aparece nas respostas públicas, snapshots de entrada, etapas
ou eventos. A API expõe apenas `hasOrderWebhookUrl` para indicar que a unidade
está configurada.

## Monitoramento exato do run no Hub

O agendamento `POST /api/v1/integration/catalog-sync/:integrationId/runs` deve
retornar `runId`. O Único Integra persiste esse valor antes de iniciar o
monitoramento. A consulta usa
`GET /api/v1/integration/catalog-sync/:integrationId/runs/:runId` e só aceita o
run exato persistido. Uma execução anterior nunca é usada para liberar o gate.

## Cadastro por ERP

Cada unidade informa `erpId`; os IDs canônicos são 1 Alpha7, 2 Linx,
3 Automatiza e 4 Vetor. `provider` pode acompanhar o ID, mas deve corresponder
ao ERP escolhido. O cadastro legado sem ERP continua sendo Alpha7.

| ERP | Configuração por unidade | Publicação inicial |
| --- | --- | --- |
| Alpha7 | `sourceUnitId` da unidade de negócio e `credentialRef` com URL PostgreSQL completa | `automatic` |
| Linx | CNPJ cadastrado na unidade; omitir `sourceUnitId`, `credentialRef` e `vetorApiKey` | `shadow` |
| Automatiza | `sourceUnitId` igual ao `shop_id` e `credentialRef` com URL `mysql://` completa | `shadow` |
| Vetor | `sourceUnitId` igual ao `cdFilial` e `vetorApiKey` | `shadow` |

As rotas continuam `POST /api/v1/deployments` e
`PATCH /api/v1/deployments/:deploymentId/units/:unitId`. O ERP não muda na edição;
IDs de origem ficam bloqueados depois de criada a integração no Hub. Para
editar credenciais Vetor, enviar somente `vetorApiKey`; omitir a chave para
preservar o segredo existente. URLs e API keys são cifradas no campo existente
e omitidas das respostas, etapas e eventos. `hasCredential` indica a presença
de qualquer uma dessas credenciais. O adapter Hub traduz `vetorApiKey` do
formulário para `credentialRef` no POST/PATCH `catalog-sync`, conforme o
contrato publicado no Hub (`develop` 1e41a9e). A chave continua cifrada no
backend intermediário e não aparece em seus snapshots ou respostas. O Hub
mantém seu armazenamento atual; este teste não instala a proposta de arquivo
privado ou altera o Hub.

`POST /api/databases/testConnection` recebe `driver` opcional (`postgres` padrão
ou `mysql`) e `sourceUnitId` opcional. No MySQL, o teste exige `sourceUnitId` e
CNPJ, consulta `view_unicocontato_filial` por `codigo` e confirma exatamente uma
filial com CNPJ correspondente. Conexão e consultas têm limite total de 5s.
`?ssl=true` na URL MySQL habilita TLS com certificado verificado; `ssl=false`
ou ausência do parâmetro usa a conexão sem TLS. Quando houver CA particular,
configure `AUTOMATIZA_MYSQL_TLS_CA` com o conteúdo PEM tanto neste backend
quanto no worker Hub, para que o teste use a mesma confiança de certificados.

Linx mantém `pageSize=500` e `validEanDropThresholdBps=1000` na criação.
Os outros ERPs aceitam os limites operacionais existentes (página 1..500 e
threshold 0..10000), com os mesmos defaults. A migration
`20261019120000_scope_catalog_source_identity` substitui a unicidade global
dos IDs de origem por unicidade parcial Alpha7: `shop_id` e `cdFilial` podem
se repetir em origens de lojas diferentes. Código por implantação continua
único. Aplicar a migration antes de usar esses cadastros multiloja.

Snapshots Linx, Automatiza e Vetor são ativados pelo mesmo fluxo após validar
itens. Cada run recebe até três tentativas persistidas de ativação, sem criar
outra carga e sem bloquear a resposta HTTP aguardando a publicação. A consulta
ao run confirma o resultado. Requisições interrompidas podem ser reenviadas
após o timeout de 35s; o polling respeita seu intervalo configurado. Ao esgotar,
`HUB_SHADOW_ACTIVATION_FAILED` solicita retomada manual, que inicia novo orçamento
para o mesmo run e preserva o histórico. Uma nova carga continua disponível
quando o snapshot precisa ser corrigido.

Promoção de staging exige a credencial não expirada para Alpha7, Automatiza e
Vetor, e recria os ERPs não Alpha7 em `shadow`. O tenant Unicommerce continua
usando `erpProvider=alpha7` como adapter legado de acesso ao catálogo Hub,
com `hubUnicoApiKey` e o ID central da unidade; o ERP real pertence à integração
de origem no Hub.

## Servidor local com Hub staging real

O comando `npm run catalog:local:staging` usa o launcher específico
`scripts/start-catalog-staging.mjs`, sem iniciar o servidor genérico, auditoria
IA ou worker de importação legado. Ele lê `.env.catalog-staging.local` privado
(`chmod 600`), baseado em `.env.catalog-staging.local.example`, e atende apenas
em `127.0.0.1:4199`. Expõe catálogo, teste de conexão e health. O banco deve ser
exatamente `unico_catalog_staging_local` em loopback; o Hub deve ter `staging`
no caminho da URL. Configurações e promoção de produção são bloqueadas.

`npm run catalog:local:check` verifica essa configuração sem abrir HTTP ou
iniciar workers. `GET /health/catalog-local` identifica o launcher real para
o preflight do frontend, sem devolver credenciais. O worker recebe
`CATALOG_WORKER_ENVIRONMENT=staging`, inclusive para jobs em segundo plano,
expiração de credenciais e reconciliação de domínios. Essa opção é adicional:
o servidor normal mantém o comportamento anterior quando ela está vazia.

O PostgreSQL dedicado usa `compose.catalog-staging.local.yml`, porta local
15439 e volume próprio. `.env.catalog-postgres.local` deve conter somente
`POSTGRES_USER` e `POSTGRES_PASSWORD` locais, com permissão 0600. Após preparar
esses arquivos privados, execute:

```sh
docker compose --project-name unico-catalog-staging-local -f compose.catalog-staging.local.yml up -d
npm run catalog:local:migrate
npm run catalog:local:check
npm run catalog:local:staging
```

A migração local valida o DSN antes de escrever e usa cópia temporária dos
arquivos SQL válidos, preservando pastas vazias preexistentes do checkout.
Nunca aplica migrations em destinos remotos. Para Full, habilite
`CATALOG_LOCAL_FULL_FLOW_ENABLED=true` e configure Banco/Unicommerce
explicitamente em staging ou loopback. Uma loja local em
`CATALOG_LOCAL_STOREFRONT_BASE_URL` exige loopback e
`CATALOG_LOCAL_STAGING_SERVER=true`; nesse caso, o launcher usa domínios
`qa-*.test.localhost` e dispensa credenciais Vercel. Sem loja local, a publicação
Vercel exige suas credenciais específicas de staging.

Com Banco ou Unicommerce ausente, o preflight não declara o fluxo Full pronto.
Um catálogo carregado no Hub, isoladamente, não equivale à implantação completa.

O feed AtenderBem HTTP é permitido apenas no launcher local, fora de production,
com configuração e implantação em staging, na origem exata do Banco local:4196
e caminho `/api/products/catalog/feed.csv`. O mesmo controle é aplicado ao
cadastro, à URL com `unidadeId` e ao download autenticado. MCP continua exigindo
HTTPS; feeds HTTP externos, outras portas e caminhos permanecem bloqueados.
As regras anteriores para feeds HTTPS externos são preservadas.

O launcher remove `DOTENV_CONFIG_OVERRIDE` antes dos imports. A opção textual
`false` é interpretada como verdadeira pelo carregador `dotenv/config` e poderia
desfazer os valores protegidos ao reler o arquivo privado. Um teste em processo
filho cobre essa releitura, incluindo a publicação local habilitada e a promoção
de produção bloqueada.

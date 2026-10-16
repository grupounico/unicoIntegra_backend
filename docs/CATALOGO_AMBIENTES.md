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
HUBUNICO_STAGING_BASE_URL=https://unicocontato.tech/hubunico-staging
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

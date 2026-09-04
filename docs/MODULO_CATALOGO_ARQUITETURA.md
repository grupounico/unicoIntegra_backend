# Módulo Catálogo — arquitetura e plano de implementação

## Objetivo

O módulo Catálogo permitirá que o time de suporte provisione uma operação de e-commerce farmacêutico pelo Único Integra. O Integra será o orquestrador; não será a fonte de verdade de produtos, preço ou estoque.

O formulário inicial receberá, no mínimo:

- identificação da farmácia e do grupo (nome, CNPJ da unidade e CNPJ do grupo);
- conexão com o ERP/banco de origem;
- domínio desejado;
- três banners;
- logo para desktop e logo para mobile;
- usuário responsável pela solicitação.

Os campos de conexão continuam variando por provedor, seguindo o cadastro de `Client` já existente.

## Fronteiras que devem ser preservadas

1. **Banco Único / multi-provider** é a fonte do catálogo normalizado e da sincronização com o ERP. Não copiar produtos, embeddings, imagens, preço ou estoque para tabelas do Integra.
2. **Hub Único** é a fonte de seller, grupo, unidades e da consulta operacional de preço e estoque. Persistir seus IDs apenas como referências externas.
3. **Unicommerce Back** é dono do tenant, da configuração da loja e da jornada de compra. O Integra apenas cria e atualiza essa configuração por API administrativa.
4. **Unicommerce Front** resolve a loja por domínio e consome branding público. Domínio, logos e banners são dados do tenant, nunca constantes de build.
5. Credenciais e chaves administrativas ficam somente no backend. Nunca retorná-las em leitura, eventos, logs ou SSE.
6. Uma loja só pode ser publicada depois de validação explícita. A carga inicial começa em modo de conferência.

## Diagnóstico do backend atual

### O que pode ser reaproveitado

- Separação entre `routes`, `controllers` e `services`.
- Prisma/PostgreSQL no schema `sistema` para estado administrativo.
- `Client` como registro da origem e dos campos específicos de cada ERP.
- `BancoUnicoImportJob` como referência para jobs duráveis, eventos, lease do worker, pausa, retomada, retry e SSE.
- `multiProviderClients.service.js` como adaptador existente para provisionar a origem.
- `SystemLog` para trilha funcional, desde que nunca receba segredos.
- CORS centralizado e Helmet no Express.

### Pontos críticos antes de expor o Catálogo

1. **Autenticação administrativa ausente.** O middleware de API key existe, mas não está aplicado em `app.js` ou nas rotas. Hoje o código permite chamar criação/exclusão de cliente, revelar/regenerar chave multi-provider, criar banco e iniciar importação sem esse controle.
2. **Segredos em texto puro.** `Client.credential` e `Client.multiProviderApiKey` são persistidos sem cifra. O novo módulo deve usar envelope encryption/KMS e guardar apenas ciphertext e metadados da chave.
3. **Provisionamento parcial.** A criação atual chama o multi-provider antes do `prisma.client.create`. Uma falha local deixa tenant externo órfão. O Catálogo precisa de saga persistida e reconciliação.
4. **Exclusão com efeito externo.** Excluir um `Client` também pode excluir o tenant multi-provider. Loja publicada deve usar desativação/arquivamento e um fluxo separado e confirmado para teardown.
5. **SSRF e rede interna.** O teste de conexão aceita host e porta do usuário. Precisa de autenticação e política de egress/allowlist antes de entrar no wizard.
6. **Uploads inexistentes.** O limite JSON é 1 MB e não há storage de mídia. Não enviar imagens como base64 nem gravá-las no filesystem efêmero.
7. **Processos longos junto da API.** Schedulers e worker iniciam no servidor HTTP. Em múltiplas réplicas, o novo worker precisa de lease no banco.
8. **Validação e erros não padronizados.** Controllers inferem status HTTP pelo texto da mensagem. Usar erros tipados e schema validation na fronteira HTTP.
9. **Observabilidade limitada.** Falta `requestId`, métricas e tracing comum entre Integra, Hub, Unicommerce e storage.
10. **Geração de builds legada.** `/api/generate` executa shell e `npm install` numa requisição. O Catálogo não deve se acoplar a esse fluxo.
11. **Testes e dependências.** `npm test` está configurado para falhar; os testes reais usam `node --test`. A instalação local está incompleta e o audit do lockfile reporta vulnerabilidades altas, inclusive em dependências diretas.

## Arquitetura proposta

```text
Único Integra Front
        |
        | API administrativa autenticada
        v
Único Integra Backend
  CatalogProvisioning (saga + worker + eventos)
        |--------> storage de mídia
        |--------> Hub Único (grupo, seller, unidades)
        |--------> Banco Único / multi-provider (origem e carga)
        |--------> Unicommerce Back (tenant e branding)
        `--------> DNS/deploy (domínio e verificação)
```

Cada sistema externo terá adaptador próprio. O orquestrador não conhecerá URLs nem importará o cliente HTTP diretamente:

```text
src/modules/catalog-provisioning/
  catalog-provisioning.routes.js
  catalog-provisioning.controller.js
  catalog-provisioning.service.js
  catalog-provisioning.worker.js
  catalog-provisioning.validation.js
  adapters/
    hub.client.js
    unicommerce.client.js
    media-storage.client.js
    domain.client.js
    banco-unico.client.js
```

## Modelo de dados proposto

### `CatalogProvisioning`

- `id`: UUID;
- `idempotencyKey`: chave única fornecida pelo frontend;
- `clientId`: relação opcional com `Client`;
- `status`: `draft`, `queued`, `running`, `awaiting_review`, `publishing`, `completed`, `failed`, `cancelled`;
- `currentStep`, `requestedBy` e timestamps;
- `groupCnpj`, `pharmacyCnpj`, `storeName`, `domain` normalizados;
- `inputSnapshot`: entrada não sensível;
- `secretRef`: referência ao cofre/ciphertext;
- `externalRefs`: IDs de grupo, seller, unidades, tenant, projeto e domínio;
- `lastErrorCode`, `lastErrorMessage`, `retryCount`;
- `workerId`, `workerHeartbeatAt` para lease;
- `version`: controle otimista de concorrência.

Restrições: unique em `idempotencyKey`; domínio único em operações ativas; índice em `status, workerHeartbeatAt`; CNPJs com 14 dígitos; sem cascade de `Client` para operação publicada.

### `CatalogProvisioningAsset`

- tipo: `banner_1`, `banner_2`, `banner_3`, `logo_desktop`, `logo_mobile`;
- object key, URL pública final, MIME, tamanho e checksum;
- status de upload e validação;
- unique em `provisioningId, type`.

### `CatalogProvisioningStep`

Registro durável de cada tentativa: etapa, status, tentativa, idempotency key externa, request/response sanitizados, IDs externos, timestamps e erro tipado.

### `CatalogProvisioningEvent`

Eventos sanitizados para timeline/SSE. Nenhum payload pode conter senha, token, API key, connection string ou URL assinada.

## Máquina de estados e ordem segura

1. `validate_input`: valida CNPJs, domínio, provedor e metadados de imagem.
2. `reserve_domain`: verifica conflito local e disponibilidade.
3. `upload_assets`: frontend envia ao storage por URLs assinadas; backend valida checksum, tipo e dimensões.
4. `create_source_client`: cria/reutiliza `Client` e integração multi-provider.
5. `create_hub_group`: cria/reutiliza grupo pelo CNPJ.
6. `create_hub_units`: cria/reutiliza seller e unidades pelo CNPJ.
7. `create_unicommerce_tenant`: cria tenant desativado e associa IDs externos.
8. `configure_branding`: associa banners, logos e configuração pública.
9. `configure_domain`: cria binding e aguarda DNS/TLS.
10. `start_initial_sync`: agenda carga inicial em modo de conferência.
11. `awaiting_review`: mostra health checks, amostra do catálogo e pendências.
12. `publish`: ativa tenant/domínio após confirmação do suporte.

Cada etapa aceita repetição. Antes de criar, consultar pela chave natural; depois de timeout, reconciliar antes de tentar novamente. Compensações só removem recursos criados pela própria saga e ainda não publicados.

## API administrativa proposta

```text
POST   /api/catalog-provisionings
GET    /api/catalog-provisionings
GET    /api/catalog-provisionings/:id
POST   /api/catalog-provisionings/:id/assets/presign
POST   /api/catalog-provisionings/:id/assets/confirm
POST   /api/catalog-provisionings/:id/start
POST   /api/catalog-provisionings/:id/retry
POST   /api/catalog-provisionings/:id/cancel
POST   /api/catalog-provisionings/:id/publish
GET    /api/catalog-provisionings/:id/events
GET    /api/catalog-provisionings/:id/stream
```

Regras:

- todas as rotas exigem identidade administrativa e autorização por papel;
- `Idempotency-Key` é obrigatória em criação, start, retry e publish;
- upload direto ao storage é preferível;
- leitura retorna `hasCredential`, nunca credencial;
- `publish` exige `awaiting_review` e confirmação explícita;
- cancelamento não faz teardown de loja publicada;
- auditoria usa a identidade autenticada, nunca `username` livre no body.

## Contrato inicial do formulário

```json
{
  "store": {
    "name": "Farmácia Exemplo",
    "groupCnpj": "00000000000000",
    "pharmacyCnpj": "00000000000000",
    "domain": "loja.exemplo.com.br"
  },
  "source": {
    "provider": "trier",
    "connection": {}
  },
  "assets": {
    "banner1UploadId": "uuid",
    "banner2UploadId": "uuid",
    "banner3UploadId": "uuid",
    "desktopLogoUploadId": "uuid",
    "mobileLogoUploadId": "uuid"
  }
}
```

`source.connection` é uma união discriminada por ERP. O backend mapeia os nomes da interface para os providers existentes (por exemplo, Trier para `api`) em um único lugar.

## Validações obrigatórias

- dígitos verificadores dos CNPJs, não apenas comprimento;
- domínio lowercase, sem protocolo/path/query, com allowlist de zonas;
- cinco assets presentes, MIME detectado pelo conteúdo e limite de bytes;
- dimensões/aspect ratios definidos com produto;
- bloquear SVG sem sanitização;
- host/porta de banco conforme política de egress;
- teste de conexão somente leitura antes de persistir credencial;
- unicidade/reconciliação de CNPJ, domínio, tenant e seller;
- timeout, retry com backoff e circuit breaker nos upstreams;
- redação de segredos em erros e logs.

## Contratos externos necessários antes dos adaptadores

### Hub Único

- base URL e autenticação;
- endpoints/payloads para consultar/criar grupo, seller e unidades;
- chaves naturais, conflitos e idempotência;
- health/reconciliação e desativação.

### Unicommerce Back

- OpenAPI real e versionado para tenant e branding;
- campos para ligar tenant a Hub/Banco Único;
- resolução por domínio, ativação/desativação e health check;
- formatos e dimensões dos assets.

O handbook HTML local é apenas referência e não substitui esse contrato.

### Storage e domínio

- object storage e política de URLs públicas;
- validação de imagem e lifecycle de uploads abandonados;
- provedor de DNS/deploy, zonas autorizadas e TLS;
- definir se domínio é criado ou apenas verificado.

### Banco Único

- chamada que inicia e acompanha a carga oficial;
- definição do modo de conferência;
- critério de prontidão e falhas toleradas;
- associação entre grupo, unidade, tenant e cliente multi-provider.

## Entregas recomendadas

1. **Hardening:** autenticação/autorização, cifra de segredos, validação comum, request ID e redação de logs.
2. **Fundação:** migrations, CRUD de rascunho, assets e interfaces dos adaptadores com doubles de teste.
3. **Orquestração:** worker com lease, saga, retry, reconciliação, eventos e SSE.
4. **Integrações:** Hub, Banco Único, Unicommerce, storage e domínio, uma por vez.
5. **Publicação:** review, health checks, ativação e runbook.

## Critérios de aceite

- repetir a mesma requisição não cria duplicatas;
- reiniciar o backend permite retomar do último passo concluído;
- timeout após criação externa é reconciliado;
- nenhum segredo aparece em texto puro, resposta, log ou evento;
- falha identifica etapa, código, tentativa e ação recomendada;
- operação incompleta não fica acessível no domínio público;
- publicação registra quem aprovou e o snapshot aprovado;
- teardown nunca é efeito colateral de cancelar/editar rascunho;
- testes cobrem sucesso, retry, timeout ambíguo, conflito e restart.


# Catálogo no AtenderBem

A etapa final funciona em implantações completas, Hub e Banco Único e registros antigos. O operador seleciona a unidade, informa MCP e credenciais, escolhe criar/reutilizar grupo e confirma a revisão. O CSV é validado antes de criar um grupo. A importação é enviada por multipart com margem de 1 MiB no ticket e executada em segundo plano pelo AtenderBem. O operador retorna aos detalhes da implantação; consultas a cada 15 segundos atualizam o andamento e solicitam reindexação ao concluir. A reindexação é assíncrona; concluído indica importação terminada e reindexação solicitada, não indexação finalizada.

## Implantação

1. Aplicar `prisma migrate deploy` (migration 20261007180000_add_atenderbem_configuration) e gerar o Prisma Client.
2. Configurar DEPLOYMENT_ENCRYPTION_KEY, CATALOG_ATENDERBEM_FEED_BASE_URL (URL HTTPS completa do feed, sem query) e as listas de hosts no .env.example. Acrescentar instâncias permitidas a CATALOG_MCP_ALLOWED_HOSTS e hosts do feed a CATALOG_FEED_ALLOWED_HOSTS. CATALOG_UPLOAD_ALLOWED_HOSTS só é necessário se o armazenamento não estiver na mesma origem do MCP.
3. Publicar o backend antes do frontend. Todas as rotas de configuração, grupo, importação e assistente exigem `X-API-Key` igual à `ADMIN_API_KEY` do Integra; esta não é a chave MCP. O operador informa a chave administrativa no formulário, mantida somente em memória. Após recarregar a página, informe-a novamente. Sem ela, não há consultas automáticas da importação.

O parâmetro unidadeId vem exclusivamente de hubSellerUnitId da unidade selecionada. A URL é montada no servidor a partir do ambiente. Credenciais MCP e feed são cifradas e não retornam nas consultas. Os campos vazios preservam credenciais salvas; mudar endereço/autenticação exige nova credencial.

## Endpoints

- GET /api/v1/deployments/atenderbem/settings
- PUT /api/v1/deployments/:deploymentId/units/:unitId/atenderbem
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/group
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/import
- POST /api/v1/deployments/:deploymentId/units/:unitId/atenderbem/import/status

Ferramentas MCP: product_groups_create, files_create_upload_url, products_import, products_import_status, products_reindex. Importação: format=csv, source=meta, missingAction=0, fileChangeAction=0. Produtos com o mesmo código atualizam registros existentes; produtos ausentes são preservados. Somente o grupo escolhido é reindexado.

## Retentativas e limites

Cancelamento/falha confirmados permitem novo job, preservando o resultado anterior. Resultado incerto após uma chamada externa bloqueia retentativa para não duplicar operações. Nesse caso, ou após reinício do backend durante envio/criação/reindexação, é necessária reconciliação operacional dos IDs/estados no AtenderBem e no registro local; não há recuperação automática desses estados nesta entrega. A conferência de status/reindexação ocorre enquanto os detalhes estiverem abertos ou numa consulta explícita.

Alterar a origem do feed preserva o grupo, mas invalida a conclusão anterior. O status geral da implantação existente não é alterado. O CSV é limitado a 50 MiB. O Prisma 7.2 exige Node ^20.19, ^22.12 ou >=24; a release deve usar um desses runtimes, não o Node 18 do processo legado.

As chamadas MCP do instalador têm prazo total de 90 segundos, inferior à reserva de etapa de 120 segundos. A ativação compara todos os campos da fila que poderá alterar. Não há novo worker, reconciliação contínua ou sondagem periódica do storefront.

Na validação desta release, o histórico de migrations falhou em banco vazio na migration antiga `20260226205934_add_ai_template`, por referência não qualificada a `ai_template_bases`. Isso não deve ser contornado em produção: confira que todas as migrations anteriores já constam aplicadas, sem falhas pendentes. A migration nova somente acrescenta duas colunas opcionais; mantenha-as no rollback do código para preservar os registros.

A atualização recorrente de 8 horas NÃO está implementada nesta entrega; a frequência é prevista e executionEnabled permanece false. Nenhuma credencial, fixture local ou registro de teste é incluído no PR.
# Assistente WhatsApp com catálogo externo (unicodev)

## Escopo e referência

Referência inspecionada por MCP em 15/10/2026: `https://unicodev.atenderbem.com/mcp`.
O fluxo solicitado é **WhatsApp → botão → catálogo Unicommerce**, não a jornada
Minas Mais (carrinho inteiramente dentro do WhatsApp). Assistente 1, função
`busca_produto`, automação 14 e URA 13 são as referências desta versão.

Inventário também encontrado: assistentes de voz 2 e WebChat 3; dez fluxos; três
filas; um funil com Início/Carrinho/Pedido; um formulário de endereço com sete
campos. Não havia conjuntos de gatilhos, gatilhos de palavras, agendas ou horários
cadastrados. Os fluxos de voz/WebChat e automações legadas não são instalados.

## Evidência da simulação

Chat virtual 349, assistente 1, sem contato real, baseQueueId 0. Pergunta de teste:
“Vocês têm sabonete Dove? Quero ver as opções para comprar.” A função acionou a
automação 14 e enviou um botão cuja URL estava vazia. O atendimento de teste foi
encerrado por transferência (`message_process_failed`). O simulador não forneceu
telefone nem oportunidade. Não houve envio a telefone real nem compra.

O contrato local de `POST /api/ecommerce/sessions/bootstrap` exige tenant, telefone
e consulta, e responde **201**. A automação de referência não verifica HTTP/URL e
seu POST não envia opportunityId, embora o elemento de informação exiba esse campo.
A ausência do telefone obrigatório invalida o teste ponta a ponta: não é evidência
de falha na sequência da URA do WhatsApp. A URA 13 e a busca 14 são preservadas;
apenas nomes, IDs e destino por ambiente são parametrizados.

## Fluxo implementado

Na implantação, abrir **Configurar AtenderBem → Configurar assistente WhatsApp +
catálogo**. Primeiro salvar conexão, grupo e importar produtos no fluxo existente.
O novo formulário solicita loja, fila WhatsApp oficial, modelo disponível e
políticas confirmadas. Tenant e origem do Unicommerce são resolvidos pelo backend
a partir da unidade e do ambiente da implantação; não vêm de texto livre do operador.

1. Consultar conexão, ferramentas, modelos, fila e grupo, sem gravar no AtenderBem.
2. Preparar o plano e registrar a configuração original da fila.
3. Instalar formulário, funil, três etapas, vínculos, busca, assistente e URA.
4. Revisar os recursos no AtenderBem.
5. Confirmar a equipe humana e, se necessário, a substituição da URA existente.
6. Vincular **somente** a fila selecionada e reconsultar para confirmar os campos.

A URA entra diretamente no assistente, preservando seu timeout de 900 segundos.
O bloco de oportunidade permanece fora do caminho inicial, como na referência;
não é introduzida criação obrigatória nem condição extra para a busca. O POST usa
o telefone do atendimento (`chat_client_number`), não um telefone artificial.
A busca mantém timeout do fluxo de 600 segundos e da requisição de 15 segundos,
os campos originais do POST e o botão alimentado por `catalogo_openUrl`.
A função mantém `endsturn=0` e as opções de transferência/encerramento da origem.
Também são mantidos conversão pelo cliente e comportamento de receita da fila
de referência; não se introduz uma nova regra operacional com base no chat virtual.
Não são ativados follow-ups ou campanhas. Como a referência não valida HTTP/URL,
esta versão tampouco promete corrigir esse comportamento; erros reais devem ser
avaliados com o contexto do WhatsApp.

## Retomada e carga

Cada POST `/next` executa **uma etapa**, salva seu ID e retorna. O navegador conduz
no máximo dez etapas sequenciais enquanto a página está aberta. Fechar ou pausar
interrompe a sequência após a etapa em andamento. Não existe worker novo, polling,
cron, health-check público do catálogo ou download de produtos nesse instalador.

O estado fica em `ClientDeploymentUnit.atenderBemConfig.assistant`. Escritas usam
compare-and-swap e transação com evento. Clique duplo não cria duas vezes. Uma
criação enviada sem resposta confirmada fica `uncertain`; nova tentativa consulta
o nome exclusivo daquela instalação. Só reutiliza correspondência única. Sem
correspondência, bloqueia em vez de recriar. Recursos existentes antes da tentativa
geram conflito. Atualizações de recursos próprios são repetíveis. Reinício durante
uma etapa permite conferência após dois minutos; nenhuma rotina automática retoma.

Erro `MCP_QUOTA_EXCEEDED` não é repetido: ampliar a cota exige ação administrativa.
Configuração de destino fica imutável quando há criação iniciada. Mudança externa
na fila desde a preparação bloqueia ativação; não se sobrescreve silenciosamente.

## Segurança e configuração

- Rotas novas exigem `X-API-Key` correspondente a `ADMIN_API_KEY` do Integra. Essa
  chave é digitada em campo password e fica apenas na memória da página; não é a
  chave MCP, não entra em localStorage e não é embutida no build.
- MCP usa a credencial cifrada existente (`DEPLOYMENT_ENCRYPTION_KEY`). A credencial
  da referência unicodev não está nos templates nem no repositório.
- Incluir **explicitamente** os hosts de destino em `CATALOG_MCP_ALLOWED_HOSTS`.
  URLs MCP exigem HTTPS, porta padrão, `/mcp`, sem usuário, senha, query ou fragmento.
- A conta MCP precisa ler capabilities, modelos, filas, grupos, forms, pipelines,
  stages, assistants e automations; criar forms/pipelines/stages/assistants/automations;
  atualizar o funil e assistente criados, validar DSL e atualizar a fila selecionada.
  Não precisa apagar recursos, enviar campanhas, ler conversas reais ou alterar usuários.
- A base de importação MCP foi incorporada do commit `11b5836` (branch
  `codex/catalogo-atenderbem`), ainda não presente na main do backend nesta análise.
  A migration aditiva `20261007180000_add_atenderbem_configuration` e geração Prisma
  são pré-requisitos se ainda não aplicados. Nenhuma migration foi executada na VPS.

Rotas sob `/api/v1/deployments/:deploymentId/units/:unitId/atenderbem/assistant`:
GET `/` consulta; POST `/prepare` salva plano; POST `/next` executa/retoma uma etapa;
POST `/activate` exige `confirm`, `confirmHumanTeam` e `replaceExisting` se houver URA.
Respostas não contêm chaves MCP. GET é pontual; não inicia trabalho em segundo plano.

## Limites de aceite — não confundir vinculação com homologação

Esta versão instala assistente, busca, URA, formulário e CRM; **não substitui os
webhooks do tenant** nem clona automaticamente as automações 10/11/17/18/21/22/23/24.
Em especial, a automação 22 da referência usa template WhatsApp ID 2, e o serviço
de templates estava indisponível na descoberta. Copiá-la literalmente para outra
instância pode enviar por template errado ou falhar. O retorno de pedido precisa
de homologação e configuração específica antes da liberação operacional.

Checklist em instância e tenant de teste: telefone de teste identificado, oportunidade
na etapa Carrinho, botão com URL válida do tenant correto, seleção de produtos no
catálogo, retorno cart.updated na oportunidade correta, checkout order.finalized,
confirmação de pedido sem duplicação e transferência humana. O chat virtual sem
telefone não substitui esse teste. Não declarar instalação integral concluída só
porque os recursos e a fila foram vinculados.

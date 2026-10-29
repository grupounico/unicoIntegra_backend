# MCP do catálogo (IA de catálogo de produtos)

Servidor MCP embutido no backend que permite a um agente (Claude Code, Claude Desktop ou outro cliente MCP)
executar o fluxo completo de instalação da IA de catálogo:

**Hub + Banco Único → AtenderBem → IA de venda**

As ferramentas chamam os mesmos serviços das telas do catálogo, com as mesmas validações e proteções
(idempotência, bloqueio de IA duplicada, credenciais criptografadas).

## Ativação

O endpoint fica **desligado** até a variável abaixo ser configurada no backend:

```bash
CATALOG_MCP_API_KEY=<chave aleatória com 32+ caracteres>
```

Para gerar uma chave:

```bash
node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
```

- Endpoint: `POST https://<backend>/mcp/catalogo` (Streamable HTTP, sem sessão)
- Autenticação: `Authorization: Bearer <CATALOG_MCP_API_KEY>` (ou `X-API-Key`)
- Sem a variável o endpoint responde `503`; com chave errada, `401`.

Trate a chave como senha de administrador: quem a possui pode criar implantações e IAs em produção.
Troque-a se vazar e use chaves diferentes por ambiente (staging e produção).

## Conectar um agente

Claude Code:

```bash
claude mcp add --transport http unico-catalogo https://<backend>/mcp/catalogo --header "Authorization: Bearer <CATALOG_MCP_API_KEY>"
```

Outros clientes MCP: configure um servidor HTTP com a URL acima e o header `Authorization`.

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `catalog_workflow_guide` | Explica o fluxo e a ordem das ferramentas |
| `catalog_list_deployments` | Lista implantações com a próxima ação de cada uma |
| `catalog_get_deployment` | Situação da implantação, das unidades, do AtenderBem e da IA |
| `catalog_test_database_connection` | Testa a conexão do ERP (Alpha7/PostgreSQL, Automatiza/MySQL) |
| `catalog_create_deployment` | Cria a implantação Hub + Banco Único (campos de conexão separados) |
| `catalog_start_deployment` | Inicia a carga no Hub e no Banco Único |
| `catalog_refresh_runs` | Atualiza o andamento da carga no Hub |
| `catalog_retry_deployment` | Retoma uma implantação interrompida (ou uma unidade) |
| `atenderbem_configure_unit` | Salva URL/chave MCP da instância, credencial do CSV e grupo de produtos |
| `atenderbem_create_group` | Valida a conexão e vincula o grupo de produtos |
| `atenderbem_start_import` | Importa o CSV do catálogo no AtenderBem |
| `atenderbem_check_import` | Acompanha a importação |
| `catalog_create_ai` | Cria a IA de venda usando o grupo de produtos importado |

Prompt disponível: `instalar_ia_catalogo` (argumento `grupo`).

### Próxima ação

Toda resposta traz `nextAction`, com a ferramenta e os argumentos do passo seguinte. Quando
`nextAction.humanRequired` é `true`, o agente deve parar e pedir ajuda a um operador. Isso acontece, por exemplo,
quando o AtenderBem não confirmou uma importação (repetir poderia duplicar produtos) ou quando ela terminou com erros.

### Proteções

- Ações que alteram sistemas exigem `confirm: true` e `requestedBy` (operador responsável). O histórico registra
  `<operador> (via MCP)`.
- `catalog_create_deployment` aceita `idempotencyKey`: repetir com a mesma chave devolve a mesma implantação.
- A IA só é criada com a importação concluída, e nunca duas vezes na mesma unidade.
- Respostas nunca incluem chaves, senhas ou a conexão do ERP.
- Escopo: apenas o fluxo `hub_banco_only`. Implantações do fluxo completo (storefront) aparecem como
  `humanRequired`.

## Testes

```bash
node --test test/catalogMcp.test.js
```

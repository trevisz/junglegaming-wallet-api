# Distributed Wagering Processor

Servico financeiro distribuido para processamento de transacoes de apostas, integracao com provedores de jogos (iGaming), gerenciamento de carteiras de jogadores e livro-razao (ledger) auditavel de alta concorrencia.

---

## 1. Descricao do Projeto

O sistema atua como motor transacional para plataformas de cassino online, garantindo:

- Precisao monetaria exata utilizando o Value Object `Money` com `Decimal.js` (eliminando qualquer uso de ponto flutuante binario).
- Controle de concorrencia e prevencao de condicoes de corrida (race conditions) entre multiplas instancias por meio de pessimistic write lock (`SELECT ... FOR UPDATE`) no PostgreSQL.
- Idempotencia persistente baseada em chaves unicas e hash canonico deterministico (SHA-256) dos campos de negocio.
- Consistencia estrita entre saldo materializado e o historico imutavel de lancamentos contabeis no ledger.
- Suporte a transacoes financeiras do tipo `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, alem de transacao interna de abertura (`OPENING`).
- Integracao do padrao Transactional Outbox para publicacao confiavel de eventos de dominio sem publicacao prematura antes do commit SQL.
- Endpoint de reconciliacao contabil que audita o saldo armazenado contra o somatorio historico de debitos e creditos do ledger.
- Probes de observabilidade com health checks desacoplados (`/health/live` e `/health/ready`).

---

## 2. Tecnologias Utilizadas

- **Runtime e Test Runner**: Bun 1.x
- **Linguagem**: TypeScript 6.x (modo estrito)
- **Framework**: NestJS 12.x
- **ORM**: MikroORM 7.x (com PostgreSQL Driver e Migrations)
- **Banco de Dados**: PostgreSQL 15
- **Precisao Monetaria**: Decimal.js
- **Linter de Alta Performance**: Oxlint
- **Orquestracao Local**: Docker Compose (PostgreSQL e MiniStack com SQS)

---

## 3. Pre-requisitos

- [Bun](https://bun.sh/) (versao 1.2 ou superior)
- [Docker](https://www.docker.com/) e Docker Compose

---

## 4. Instalacao e Execucao

### 4.1. Clonar o repositorio e instalar dependencias

```bash
bun install
```

### 4.2. Subir os servicos de infraestrutura (PostgreSQL e MiniStack)

```bash
docker compose up -d
```

O container do PostgreSQL ficara acessivel na porta `5432` com as credenciais padrao:
- Usuario: `postgres`
- Senha: `postgres`
- Banco de dados: `jungle_wagering`

Para habilitar o consumidor e o publisher SQS local, configure estas variaveis no ambiente da aplicacao (por exemplo, em `.env`):

```env
SQS_ENABLED=true
SQS_ENDPOINT=http://localhost:4566
AWS_REGION=us-east-1
```

Use `.env.example` como base para a configuracao local. Em AWS, remova `SQS_ENDPOINT`, configure as URLs das tres filas e forneca credenciais por IAM role ou pela cadeia padrao do AWS SDK.

Crie o arquivo `.env` a partir do exemplo antes de iniciar a aplicacao:

```powershell
Copy-Item .env.example .env
```

Na primeira conexao, a aplicacao cria as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` no MiniStack. Mensagens invalidas vao para a DLQ; mensagens com falha transitoria sao tentadas novamente pela politica de redrive.

### 4.3. Executar as migrations do banco de dados

```bash
bun mikro-orm migration:up
```

Para reverter a ultima migration:

```bash
bun mikro-orm migration:down
```

### 4.4. Iniciar a aplicacao

Modo de desenvolvimento com recarga automatica:

```bash
bun run start:dev
```

Compilar e iniciar em modo producao:

```bash
bun run build
bun run start:prod
```

A API ficara disponivel por padrao em: `http://localhost:3000`

---

## 5. Endpoints da API HTTP

### 5.1. Carteiras (Wallets)

#### Criar Carteira
Cria uma nova carteira para o jogador. Se `initialBalance` for maior que zero, gera atomicamente a transacao interna `OPENING` e a entrada `CREDIT` no ledger.

- **Rota**: `POST /wallets`
- **Exemplo de Body**:
```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": {
    "amount": "1000.00",
    "currency": "BRL"
  }
}
```
- **Resposta (201 Created)**:
```json
{
  "id": "76495b6c-2f9c-4869-bc94-aa612f08a402",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": {
    "amount": "1000.00",
    "currency": "BRL"
  },
  "version": 1
}
```

#### Consultar Carteira
- **Rota**: `GET /wallets/:walletId`

#### Consultar Extrato do Ledger (Paginacao por Cursor)
Retorna os lancamentos imutaveis do ledger com paginacao estavel baseada em cursor.

- **Rota**: `GET /wallets/:walletId/ledger?limit=50&cursor=...`

#### Reconciliacao Contabil da Carteira
Audita a integridade entre o saldo materializado na tabela `wallets` e a reconstrucao somando todas as entradas do ledger.

- **Rota**: `POST /wallets/:walletId/reconciliation`
- **Resposta (200 OK)**:
```json
{
  "walletId": "76495b6c-2f9c-4869-bc94-aa612f08a402",
  "storedBalance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "calculatedBalance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "difference": {
    "amount": "0.00",
    "currency": "BRL"
  },
  "consistent": true,
  "checkedEntries": 42
}
```

---

### 5.2. Transacoes de Apostas (Wagering)

#### Submeter Transacao Unificada
Processa operacoes de jogo com chave de idempotencia persistente.

- **Rota**: `POST /wagering/transactions`
- **Header Obrigatorio**: `Idempotency-Key: provider-a:tx-1001`
- **Exemplo de Body (Aposta / BET)**:
```json
{
  "providerId": "provider-a",
  "externalTransactionId": "tx-1001",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "76495b6c-2f9c-4869-bc94-aa612f08a402",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```
- **Resposta (200 OK)**:
```json
{
  "transactionId": "b18ce4d5-8968-450f-90e6-9e9d6d8122d2",
  "status": "PROCESSED",
  "balance": {
    "amount": "975.00",
    "currency": "BRL"
  },
  "idempotentReplay": false
}
```

Tipos de operacao suportados no campo `kind`:
- `BET`: Debita o saldo da carteira e gera 1 lancamento `DEBIT` no ledger. Falha caso nao haja saldo suficiente.
- `WIN`: Credita o saldo da carteira e gera 1 lancamento `CREDIT` no ledger.
- `LOSS`: Registra o resultado da rodada sem alterar o saldo e sem gerar entrada no ledger.
- `REFUND`: Reverte uma operacao `BET` atraves de um credito equivalente, exigindo `referenceExternalTransactionId`.
- `ROLLBACK`: Reverte uma operacao anterior (`BET`, `WIN` ou `REFUND`) aplicando a direcao inversa.

Na rota unificada, `200` indica processamento/replay concluido, `202` indica referencia pendente, `409` indica conflito de idempotencia, `422` indica rejeicao de negocio e `400` indica entrada invalida. Falhas transitorias de infraestrutura permanecem como respostas `5xx` para permitir retry pelo cliente.

#### Consultar Transacao por ID Interno
- **Rota**: `GET /wagering/transactions/:transactionId`

#### Consultar Transacao por ID Externo do Provedor
- **Rota**: `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

---

### 5.3. Health Checks

- **Liveness probe**: `GET /health/live` (informa se a aplicacao esta ativa)
- **Readiness probe**: `GET /health/ready` (valida PostgreSQL e SQS; ambos devem estar acessiveis)

---

## 6. Testes e Qualidade de Codigo

### Executar a suite rapida
Executa os testes de dominio e os cenarios HTTP de concorrencia/idempotencia:

```bash
bun run test
```

### Executar testes de integracao com PostgreSQL e SQS reais
Suba PostgreSQL e MiniStack, aplique as migrations no banco isolado de integracao e habilite a suite:

```powershell
$env:DB_NAME = "jungle_wagering_integration"
$env:SQS_ENABLED = "true"
$env:SQS_ENDPOINT = "http://localhost:4566"
$env:AWS_REGION = "us-east-1"
$env:RUN_INFRA_INTEGRATION = "true"
bun run migration:up
bun run test:integration
```

A suite sobe tres processos da aplicacao e usa filas FIFO exclusivas. Ela verifica 50 entregas SQS duplicadas, 50 requisicoes HTTP idempotentes em paralelo, disputa de saldo, wallets paralelas, BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, rollback fora de ordem, Outbox, reinicio/redelivery, retries com falha transitoria, DLQ e constraints do schema. Fora do modo de integracao, esses testes ficam ignorados.

### Testes manuais via Postman
Importe `postman/JungleGaming-Wallet-API.postman_collection.json`, confirme `baseUrl` como `http://localhost:3000` e rode a colecao na ordem. A API deve estar iniciada com PostgreSQL e SQS habilitados; a colecao valida wallet, idempotencia, operacoes financeiras, rejeicoes, ledger e reconciliacao.

Para habilitar o envio das metricas de negocio ao NestJS Observe, execute `npx @nestjs/observe link` e mantenha as credenciais fora do repositorio.

### Analise Estatica e Linting
Executa a validacao estatica em alta velocidade com Oxlint:

```bash
bun run lint
```

### Compilacao (Build)
Valida a compilacao com tipagem estrita do NestJS:

```bash
bun run build
```

---

## 7. Estrutura de Diretorios

```text
src/
├── application/
│   ├── dtos/                # Objetos de transferencia de dados
│   ├── use-cases/           # Casos de uso de aplicacao
│   └── utils/               # Hashing canonico de payload
├── domain/
│   ├── entities/            # Entidades ricas (Wallet, WagerTransaction, Ledger)
│   ├── enums/               # Enums de tipo, status e direcao contabil
│   ├── events/              # Eventos de integracao e envelope de Outbox
│   ├── repositories/        # Contratos de persistencia de dominio
│   └── value-objects/       # Value Object Money com Decimal.js
├── infrastructure/
│   ├── database/
│   │   ├── entities/        # Mapeamentos e decoradores MikroORM
│   │   ├── migrations/      # Migrations SQL versionadas
│   │   └── repositories/    # Implementacoes de repositorio com locks
│   ├── messaging/           # Consumidor SQS, Inbox, DLQ e workers
│   └── outbox/              # Servico transacional de despacho de outbox
└── presentation/
    ├── controllers/         # Endpoints REST (Wallets, Wagering, Health)
    ├── filters/             # Tratamento global de excecoes de dominio
    └── guards/              # Seguranca e assinaturas de provedor
```

Para informacoes aprofundadas sobre concorrencia, locks e trade-offs, consulte o arquivo `ARCHITECTURE.md`.

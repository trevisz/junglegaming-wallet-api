# Arquitetura e Decisoes Tecnicas

Este documento descreve os padroes arquiteturais, modelos de concorrencia, garantias de consistencia e decisoes de design adotadas no Distributed Wagering Processor.

---

## 1. Visao Geral da Arquitetura

O sistema foi estruturado seguindo principios de Domain-Driven Design (DDD) e Clean Architecture, separando claramente:

- **Domain**: Entidades ricas (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`), Value Objects (`Money`), Enums e Interfaces de Repositorio. Contem todas as regras de negocio e invariantes, sem dependencia de frameworks ou ORMs.
- **Application**: Casos de uso especializados (`ProcessWageringTransactionUseCase`, `CreateWalletUseCase`, `ReconcileWalletUseCase`, `GetWalletLedgerUseCase`), DTOs e utilitarios de hashing canonico.
- **Infrastructure**: Implementacao com MikroORM, PostgreSQL, Outbox Pattern, entidades de banco e migrations versionadas.
- **Presentation**: Controllers HTTP REST (`WalletController`, `WageringController`, `HealthController`, `WagerController`), Exception Filters e Guards.

---

## 2. Escolha e Justificativa do ORM

Foi selecionado o **MikroORM** como ORM principal:

- **Unit of Work e Identity Map**: Mantem rastreamento exato das entidades carregadas durante a sessao e garante que mutacoes sejam sincronizadas de forma consistente.
- **Transacoes Atomicas Explictas**: O uso de `em.transactional(async () => { ... })` garante atomicidade estrita entre a atualizacao da carteira, a geracao da transacao financeira, o lancamento no ledger e o enfileiramento de eventos na tabela de outbox na mesma transacao SQL (PostgreSQL).
- **Controle de Concorrencia**: Suporte nativo a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`), fundamental para evitar lost updates em cenarios de hot wallet com multiplas instâncias da aplicacao em paralelo.

---

## 3. Modelagem Monetaria (Value Object Money)

Para prevenir imprecisoes e erros de arredondamento de ponto flutuante binario (`number`, `float`, `double`):

- Toda computacao monetaria e realizada atraves do Value Object `Money`, encapsulando a biblioteca `Decimal.js` com precisao configurada de 20 digitos e modo de arredondamento `ROUND_HALF_EVEN`.
- Nas fronteiras de entrada e saida (DTOs, contratos JSON e banco de dados), os valores sao tratados estritamente como strings decimais formatadas com escala fixa de 2 casas decimais (ex.: `"25.00"`).
- Entradas invalidas (como `NaN`, `Infinity`, notacao cientifica `1e2`, strings vazias, valores negativos na criacao ou mais de duas casas decimais) sao sumariamente rejeitadas em tempo de instanciacao.
- No PostgreSQL, os valores sao persistidos na coluna `NUMERIC(20, 2)`.

---

## 4. Estrategia de Concorrencia e Multiplas Instancias

A unidade fundamental de concorrencia e o registro da carteira (`walletId` / `playerId + currency`):

1. **Pessimistic Locking**: Durante operacoes que alteram saldo (`BET`, `WIN`, `REFUND`, `ROLLBACK`), a carteira e carregada com `LockMode.PESSIMISTIC_WRITE`. Isso serializa as requisicoes concorrentes para a mesma carteira a nivel de banco de dados, prevenindo qualquer race condition entre pods ou workers distintos.
2. **Restricoes no Schema (Defesa em Profundidade)**:
   - A constraint de tabela `chk_wallet_balance_positive` impede que o banco permita saldo negativo em qualquer hipotese.
   - A constraint `uq_wallet_player_currency` impede criacao duplicada de carteira para o mesmo jogador e moeda.
   - A constraint `uq_idempotency_key` garante unicidade de operacoes na tabela `wager_transactions`.
   - A constraint `uq_ledger_transaction` garante que cada transacao gere no maximo uma entrada correspondente no ledger por carteira.
3. **Controle de Versao**: A entidade `Wallet` mantem um campo `version` sequencial que incrementa a cada mutacao de saldo, permitindo auditoria e integracao com optimistic locking caso necessario.

---

## 5. Idempotencia Persistente e Hashing Canonico

A garantia de idempotencia nao depende de cache em memoria nem da camada de mensageria:

- Toda transacao submetida exige uma chave de idempotencia (`Idempotency-Key`), armazenada no PostgreSQL com indice unico.
- O payload de negocio passa por um algoritmo deterministico de hashing (`computePayloadHash`): todas as chaves do objeto JSON de negocio sao ordenadas alfabeticamente antes da serializacao, gerando um hash SHA-256 estavel independentemente da ordem em que os campos foram enviados pelo cliente HTTP.
- **Replay Idempotente**: Se uma requisicao for reenviada com a mesma chave e o mesmo `payloadHash`, a operacao retorna o resultado original registrado com a flag `idempotentReplay: true`.
- **Conflito**: Se uma requisicao utilizar uma chave ja existente mas com `payloadHash` divergente, a aplicacao rejeita a solicitacao com HTTP 409 Conflict.

---

## 6. Transactional Outbox Pattern

Para garantir que eventos de integracao nunca sejam perdidos nem publicados antes do commit da transacao financeira:

1. Os eventos de dominio sao instanciados no envelope padronizado `IntegrationEvent<T>` (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`).
2. O payload do evento e persistido na tabela `outbox_messages` dentro da mesma transacao SQL que debita/credita a carteira e grava o ledger.
3. Um servico de despacho (`OutboxService`) e responsavel por publicar os eventos pendentes e atualizar a data de publicacao (`published_at`), garantindo entrega at-least-once segura mesmo em caso de falha subita do processo.

---

## 7. Reconciliacao e Auditoria do Ledger

- O `WalletLedgerEntry` e estruturalmente imutavel: nao possui metodos de alteracao de estado nem campos mutaveis.
- A consistencia entre o saldo da carteira e o historico de lancamentos e auditavel via `POST /wallets/:walletId/reconciliation`, que recalcula o saldo historico somando todos os lancamentos de `CREDIT` e subtraindo os lancamentos de `DEBIT`.
- Qualquer divergencia detectada e registrada com severidade de erro e exposta na resposta detalhada.

---

## 8. Estrategia de Autenticacao (Decisao Arquitetural)

Conforme as diretrizes da Secao 2 do desafio:

- O sistema inclui suporte a verificacao de assinatura criptografica HMAC (`HmacSignatureGuard`) para canais de webhook de provedores externos.
- Para autenticacao de usuarios e operadores no ambiente de producao, a solucao foi desenhada para integracao com um Identity Provider externo padrao OIDC (como Keycloak ou Zitadel), mantendo o processador financeiro desacoplado de tabelas locais de credenciais de usuarios.
- Endpoints de health check (`/health/live` e `/health/ready`) operam sem exigencia de autenticacao para permitir probes de orquestradores (Kubernetes/Docker).

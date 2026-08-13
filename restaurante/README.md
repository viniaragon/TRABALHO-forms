# Módulo de Gestão de Pedidos — Restaurante

Sistema de comandas para operação de salão: o garçom lança, a cozinha produz,
o caixa recebe e fecha. Vive dentro deste projeto como módulo isolado — schema
`restaurante` no PostgreSQL, rotas sob `/api/restaurante`, tela em
`/restaurante` — sem tocar em nada do portal OCIS.

## Subir

```bash
npm install
node restaurante/seed.js          # cria schema, cardápio de exemplo, 12 mesas e os usuários
npm start                         # http://localhost:3000/restaurante
```

O seed imprime as senhas geradas **uma única vez**. Para definir a senha do
gerente na mão:

```bash
node restaurante/seed.js --senha "senha-forte-do-gerente"
node restaurante/seed.js --sem-exemplos --somente-usuarios   # só o gerente, sem cardápio de exemplo
```

O schema é criado sozinho no primeiro request (`garantirSchema()`), então subir
o servidor contra um banco vazio também funciona — o seed só popula os dados.

### Banco

Resolve nesta ordem: `RESTAURANTE_DB_*` → `OCI_DB_*` → `POSTGRES_*` → local
(`127.0.0.1:55432/ocis_local`). Reaproveita a mesma cadeia do resto do projeto,
então em produção não há nada novo a configurar.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `RESTAURANTE_TAXA_SERVICO` | `10` | Percentual da taxa de serviço |
| `RESTAURANTE_SESSION_HOURS` | `12` | Duração da sessão (um turno) |
| `RESTAURANTE_ADMIN_SENHA` | — | Senha do gerente no seed |

## Papéis

| Papel | Pode |
| --- | --- |
| `garcom` | Abrir comanda, lançar itens, entregar, cancelar item **na fila**, pedir a conta |
| `cozinha` | Iniciar/finalizar preparo, marcar produto esgotado |
| `caixa` | Receber pagamento, retirar taxa, estornar lançamento, fechar conta |
| `gerente` | Tudo acima + cardápio, mesas, equipe, desconto e cancelamento de item **já em preparo** |

## As decisões que sustentam o sistema

**Dinheiro em centavos (`integer`), nunca float.** `10.1 + 20.2` não dá `30.3`
em ponto flutuante, e no fim do turno isso vira divergência de caixa. A taxa é
arredondada uma única vez, em `calcularTotais()`, que é a única fonte de verdade
do dinheiro.

**Preço e nome congelados no item.** `itens.preco_unit_centavos` guarda o preço
do momento do lançamento. O gerente pode reajustar o cardápio às 20h que as
contas abertas não mudam. Vale também para o nome: renomear ou desativar um
produto não reescreve conta antiga.

**Status por item, não por pedido.** A cerveja sai em 30s e o risoto em 20min.
Cada item é roteado por setor (`cozinha`, `chapa`, `bar`, `sobremesa`) e anda na
própria máquina de estados:

```
pendente ──→ preparando ──→ pronto ──→ entregue
    │             │
    └─────────────┴──→ cancelado
```

`pendente → pronto` existe de propósito para o que não tem preparo (long neck,
lata). Transição fora da tabela devolve `409`, não um update silencioso.

**Idempotência no lançamento.** O garçom está no celular com Wi-Fi ruim e toca
duas vezes. O `POST` leva um header `Idempotency-Key`; a chave tem `UNIQUE` no
banco e o reenvio devolve a rodada original em vez de mandar outra picanha para
a chapa. Duas requisições simultâneas com a mesma chave: a perdedora bate no
índice único, o servidor reconhece o `23505` e devolve a rodada vencedora.

**Concorrência resolvida no banco.** `SELECT ... FOR UPDATE` na comanda serializa
lançamento e fechamento — não dá para entrar item enquanto o caixa fecha a conta.
Um índice único parcial (`WHERE status IN ('aberta','conta_pedida')`) impede duas
comandas vivas na mesma mesa mesmo com dois garçons abrindo ao mesmo tempo.

**Fechamento não esconde nada.** Conta com item ainda na produção não fecha: ou
entrega, ou cancela com motivo. Conta com saldo em aberto não fecha.

**Auditoria no que mexe em dinheiro.** Cancelamento, desconto, estorno,
fechamento, esgotamento de produto e login negado gravam quem, quando e por quê
em `restaurante.auditoria`. Desconto exige gerente **e** motivo; cancelar item já
em preparo exige gerente, porque aí já tem insumo gasto e virou perda.

**Tempo real por SSE, não WebSocket.** KDS e aviso de "pedido pronto" são fluxos
de mão única (servidor → tela). SSE resolve com o próprio `res` do Express, sem
dependência nova, e o navegador reconecta sozinho.

## Rotas

```
POST   /api/restaurante/login | /logout            GET /me
GET    /api/restaurante/cardapio                   POST /categorias  POST /produtos
PATCH  /api/restaurante/produtos/:id               PATCH /produtos/:id/disponibilidade
GET    /api/restaurante/mesas                      POST /mesas  PATCH /mesas/:id
GET    /api/restaurante/comandas                   POST /comandas  GET /comandas/:id
POST   /api/restaurante/comandas/:id/itens         (exige Idempotency-Key)
POST   /api/restaurante/comandas/:id/conta         POST /comandas/:id/reabrir
PATCH  /api/restaurante/comandas/:id               (taxa, pessoas, desconto)
POST   /api/restaurante/itens/:id/status           POST /itens/:id/cancelar
GET    /api/restaurante/producao                   (fila do KDS, filtro ?setor=)
POST   /api/restaurante/comandas/:id/pagamentos    DELETE .../pagamentos/:pagamentoId
POST   /api/restaurante/comandas/:id/fechar
GET    /api/restaurante/usuarios                   POST /usuarios  PATCH /usuarios/:id
GET    /api/restaurante/eventos                    (stream SSE)
```

## Arquivos

```
restaurante/schema.sql    DDL idempotente (as regras que o banco garante sozinho)
restaurante/db.js         pool próprio, transações, auditoria
restaurante/auth.js       pbkdf2, sessão em cookie HttpOnly, guarda de papel
restaurante/eventos.js    barramento SSE
restaurante/rotas.js      regras de negócio e máquina de estados
restaurante/seed.js       carga inicial
public/restaurante.*      tela única que troca de view conforme o papel
```

## Demo navegável (sem servidor)

```bash
npm run restaurante:demo        # gera restaurante/demo/comanda.html
```

Uma página única e autocontida, para abrir no celular ou mandar para alguém ver.
`backend-local.js` falsifica `fetch` e `EventSource` **antes** da tela carregar,
então `public/restaurante.js` roda byte a byte igual ao de produção — a demo
exercita a interface de verdade, não uma reimplementação parecida. As regras de
negócio são espelhadas do servidor: máquina de estados, papéis, centavos, preço
congelado, idempotência e as travas de fechamento.

O que a demo **não** reproduz: concorrência real (`FOR UPDATE`, índice único
parcial) e estado compartilhado entre aparelhos — cada navegador tem o próprio
banco em memória, que zera ao recarregar. Para o garçom e a cozinha verem a
mesma comanda, é preciso o servidor com PostgreSQL.

Rode de novo depois de mexer na aplicação, para a demo não descolar do sistema.

## Próximos incrementos

- Relatórios: faturamento por turno, ticket médio, mais vendidos, tempo médio
  por setor, cancelamentos por usuário — com exportação `.xlsx` (o ExcelJS já
  está no projeto).
- Fechamento de caixa do turno (abertura, sangria, suprimento, conferência).
- Transferir item entre comandas; juntar e dividir mesas.
- Divisão de conta por pessoa no ato do pagamento.
- Delivery e balcão (comanda sem mesa — o schema já permite `mesa_id` nulo).
- Impressão de comanda e cupom em impressora térmica.
- Estoque com ficha técnica e baixa automática de insumo.

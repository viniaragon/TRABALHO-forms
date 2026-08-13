-- Schema do modulo de gestao de pedidos do restaurante.
-- Isolado em `restaurante` para nao colidir com o schema `oci` do portal de saude.
--
-- Regras estruturais que o banco garante (e nao dependem do codigo acertar):
--   * dinheiro sempre em centavos (integer), nunca ponto flutuante;
--   * preco e nome do produto sao congelados no item no momento do lancamento;
--   * uma mesa so pode ter uma comanda viva por vez (indice unico parcial);
--   * status de item e comanda restritos por CHECK.

CREATE SCHEMA IF NOT EXISTS restaurante;

-- ---------------------------------------------------------------------------
-- Usuarios e sessoes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS restaurante.usuarios (
    id bigserial PRIMARY KEY,
    login text NOT NULL UNIQUE,
    senha_hash text NOT NULL,
    nome text NOT NULL,
    papel text NOT NULL CHECK (papel IN ('garcom', 'cozinha', 'caixa', 'gerente')),
    ativo boolean NOT NULL DEFAULT true,
    ultimo_acesso timestamptz NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurante.sessoes (
    id bigserial PRIMARY KEY,
    usuario_id bigint NOT NULL REFERENCES restaurante.usuarios(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expira_em timestamptz NOT NULL,
    criado_em timestamptz NOT NULL DEFAULT now(),
    ultimo_uso timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_sessoes_usuario
    ON restaurante.sessoes (usuario_id);
CREATE INDEX IF NOT EXISTS idx_restaurante_sessoes_expira
    ON restaurante.sessoes (expira_em);

-- ---------------------------------------------------------------------------
-- Cardapio
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS restaurante.categorias (
    id bigserial PRIMARY KEY,
    nome text NOT NULL UNIQUE,
    setor text NOT NULL DEFAULT 'cozinha'
        CHECK (setor IN ('cozinha', 'chapa', 'bar', 'sobremesa')),
    ordem integer NOT NULL DEFAULT 0,
    ativa boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS restaurante.produtos (
    id bigserial PRIMARY KEY,
    categoria_id bigint NOT NULL REFERENCES restaurante.categorias(id),
    nome text NOT NULL,
    descricao text NULL,
    preco_centavos integer NOT NULL CHECK (preco_centavos >= 0),
    -- setor proprio sobrescreve o da categoria (ex.: sobremesa quente sai da cozinha)
    setor text NULL CHECK (setor IN ('cozinha', 'chapa', 'bar', 'sobremesa')),
    tempo_preparo_minutos integer NOT NULL DEFAULT 0 CHECK (tempo_preparo_minutos >= 0),
    -- `disponivel` e o "esgotou hoje", alternado pela cozinha durante o servico
    disponivel boolean NOT NULL DEFAULT true,
    -- `ativo` e a exclusao logica; produto inativo some do cardapio mas
    -- continua referenciado por itens historicos
    ativo boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_produtos_categoria
    ON restaurante.produtos (categoria_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurante_produto_nome_categoria
    ON restaurante.produtos (categoria_id, lower(nome)) WHERE ativo;

-- ---------------------------------------------------------------------------
-- Salao
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS restaurante.mesas (
    id bigserial PRIMARY KEY,
    numero text NOT NULL UNIQUE,
    capacidade integer NOT NULL DEFAULT 4 CHECK (capacidade > 0),
    ativa boolean NOT NULL DEFAULT true,
    criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS restaurante.comanda_codigo_seq;

CREATE TABLE IF NOT EXISTS restaurante.comandas (
    id bigserial PRIMARY KEY,
    codigo text NOT NULL UNIQUE
        DEFAULT ('CMD-' || lpad(nextval('restaurante.comanda_codigo_seq')::text, 5, '0')),
    mesa_id bigint NULL REFERENCES restaurante.mesas(id),
    status text NOT NULL DEFAULT 'aberta'
        CHECK (status IN ('aberta', 'conta_pedida', 'fechada', 'cancelada')),
    pessoas integer NOT NULL DEFAULT 1 CHECK (pessoas > 0),
    taxa_servico boolean NOT NULL DEFAULT true,
    desconto_centavos integer NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
    desconto_motivo text NULL,
    desconto_por bigint NULL REFERENCES restaurante.usuarios(id),
    aberta_por bigint NOT NULL REFERENCES restaurante.usuarios(id),
    fechada_por bigint NULL REFERENCES restaurante.usuarios(id),
    aberta_em timestamptz NOT NULL DEFAULT now(),
    conta_pedida_em timestamptz NULL,
    fechada_em timestamptz NULL
);
-- Impede duas comandas vivas na mesma mesa mesmo com dois garcons simultaneos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_restaurante_comanda_viva_por_mesa
    ON restaurante.comandas (mesa_id)
    WHERE status IN ('aberta', 'conta_pedida');
CREATE INDEX IF NOT EXISTS idx_restaurante_comandas_status
    ON restaurante.comandas (status, aberta_em DESC);

-- ---------------------------------------------------------------------------
-- Pedidos e itens
-- ---------------------------------------------------------------------------

-- Um "pedido" e uma rodada de lancamento (o que o garcom envia de uma vez).
-- E a unidade de idempotencia: reenviar a mesma chave devolve a mesma rodada
-- em vez de duplicar os itens.
CREATE TABLE IF NOT EXISTS restaurante.pedidos (
    id bigserial PRIMARY KEY,
    comanda_id bigint NOT NULL REFERENCES restaurante.comandas(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL UNIQUE,
    usuario_id bigint NOT NULL REFERENCES restaurante.usuarios(id),
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_pedidos_comanda
    ON restaurante.pedidos (comanda_id);

CREATE TABLE IF NOT EXISTS restaurante.itens (
    id bigserial PRIMARY KEY,
    pedido_id bigint NOT NULL REFERENCES restaurante.pedidos(id) ON DELETE CASCADE,
    comanda_id bigint NOT NULL REFERENCES restaurante.comandas(id) ON DELETE CASCADE,
    produto_id bigint NOT NULL REFERENCES restaurante.produtos(id),
    -- nome e preco congelados: reajuste de cardapio nao altera conta ja aberta
    produto_nome text NOT NULL,
    preco_unit_centavos integer NOT NULL CHECK (preco_unit_centavos >= 0),
    quantidade integer NOT NULL CHECK (quantidade > 0),
    observacao text NULL,
    setor text NOT NULL CHECK (setor IN ('cozinha', 'chapa', 'bar', 'sobremesa')),
    status text NOT NULL DEFAULT 'pendente'
        CHECK (status IN ('pendente', 'preparando', 'pronto', 'entregue', 'cancelado')),
    criado_em timestamptz NOT NULL DEFAULT now(),
    iniciado_em timestamptz NULL,
    pronto_em timestamptz NULL,
    entregue_em timestamptz NULL,
    cancelado_em timestamptz NULL,
    cancelado_por bigint NULL REFERENCES restaurante.usuarios(id),
    motivo_cancelamento text NULL
);
CREATE INDEX IF NOT EXISTS idx_restaurante_itens_comanda
    ON restaurante.itens (comanda_id);
-- Indice da fila do KDS: so o que ainda esta em jogo.
CREATE INDEX IF NOT EXISTS idx_restaurante_itens_fila
    ON restaurante.itens (setor, status, criado_em)
    WHERE status IN ('pendente', 'preparando', 'pronto');

-- ---------------------------------------------------------------------------
-- Pagamentos e auditoria
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS restaurante.pagamentos (
    id bigserial PRIMARY KEY,
    comanda_id bigint NOT NULL REFERENCES restaurante.comandas(id) ON DELETE CASCADE,
    forma text NOT NULL CHECK (forma IN ('dinheiro', 'debito', 'credito', 'pix', 'voucher')),
    -- valor que abate a conta
    valor_centavos integer NOT NULL CHECK (valor_centavos > 0),
    -- o que o cliente entregou em especie (so dinheiro) e o troco devolvido
    recebido_centavos integer NULL CHECK (recebido_centavos >= 0),
    troco_centavos integer NOT NULL DEFAULT 0 CHECK (troco_centavos >= 0),
    usuario_id bigint NOT NULL REFERENCES restaurante.usuarios(id),
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_pagamentos_comanda
    ON restaurante.pagamentos (comanda_id);

-- Toda acao que mexe em dinheiro ou anula produto passa por aqui.
CREATE TABLE IF NOT EXISTS restaurante.auditoria (
    id bigserial PRIMARY KEY,
    usuario_id bigint NULL REFERENCES restaurante.usuarios(id) ON DELETE SET NULL,
    acao text NOT NULL,
    entidade text NOT NULL,
    entidade_id bigint NULL,
    detalhe jsonb NULL,
    criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_restaurante_auditoria_criado
    ON restaurante.auditoria (criado_em DESC);

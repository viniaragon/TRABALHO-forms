const express = require('express');
const crypto = require('crypto');

const { pool, garantirSchema, emTransacao, registrarAuditoria } = require('./db');
const auth = require('./auth');
const eventos = require('./eventos');

const router = express.Router();

const TAXA_SERVICO_PERCENTUAL = Number(process.env.RESTAURANTE_TAXA_SERVICO || 10);
const SETORES = ['cozinha', 'chapa', 'bar', 'sobremesa'];
const FORMAS_PAGAMENTO = ['dinheiro', 'debito', 'credito', 'pix', 'voucher'];

// Maquina de estados do item. Toda mudanca de status passa por aqui: uma
// transicao fora da lista devolve 409 em vez de gravar em silencio.
// `pendente -> pronto` existe de proposito para o que nao tem preparo
// (cerveja long neck, refrigerante em lata): o bar entrega direto.
const TRANSICOES_ITEM = {
    pendente: ['preparando', 'pronto', 'cancelado'],
    preparando: ['pronto', 'cancelado'],
    pronto: ['entregue'],
    entregue: [],
    cancelado: [],
};

// Quem tem autoridade para levar o item a cada estado (gerente sempre pode).
const PAPEIS_POR_STATUS = {
    preparando: ['cozinha'],
    pronto: ['cozinha'],
    entregue: ['garcom', 'caixa'],
};

class ErroRegra extends Error {
    constructor(status, mensagem) {
        super(mensagem);
        this.status = status;
    }
}

// Envolve handler async para que qualquer throw caia no tratador de erro do
// router em vez de virar promessa rejeitada sem dono.
function rota(handler) {
    return (req, res, proximo) => Promise.resolve(handler(req, res, proximo)).catch(proximo);
}

function dinheiro(centavos) {
    return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function idDaRota(req, parametro = 'id') {
    const valor = Number(req.params[parametro]);
    if (!Number.isInteger(valor) || valor <= 0) {
        throw new ErroRegra(400, 'Identificador invalido.');
    }
    return valor;
}

function textoObrigatorio(valor, campo, maximo = 200) {
    const texto = String(valor == null ? '' : valor).trim();
    if (!texto) throw new ErroRegra(400, `Campo "${campo}" e obrigatorio.`);
    if (texto.length > maximo) throw new ErroRegra(400, `Campo "${campo}" excede ${maximo} caracteres.`);
    return texto;
}

function textoOpcional(valor, maximo = 200) {
    const texto = String(valor == null ? '' : valor).trim();
    if (!texto) return null;
    return texto.slice(0, maximo);
}

function inteiro(valor, campo, { minimo = 0, maximo = 1000000 } = {}) {
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
        throw new ErroRegra(400, `Campo "${campo}" deve ser inteiro entre ${minimo} e ${maximo}.`);
    }
    return numero;
}

// Aceita "38,90", "38.90" e 3890 (ja em centavos, quando vem do proprio front).
function precoParaCentavos(valor, campo) {
    if (valor == null || valor === '') throw new ErroRegra(400, `Campo "${campo}" e obrigatorio.`);
    if (typeof valor === 'number' && Number.isInteger(valor)) return inteiro(valor, campo, { maximo: 100000000 });
    const normalizado = String(valor).replace(/\s|R\$/g, '').replace(/\./g, '').replace(',', '.');
    const numero = Number(normalizado);
    if (!Number.isFinite(numero) || numero < 0) throw new ErroRegra(400, `Campo "${campo}" invalido.`);
    return Math.round(numero * 100);
}

// ---------------------------------------------------------------------------
// Leitura de comanda + totais
// ---------------------------------------------------------------------------

async function buscarComanda(cliente, comandaId, { bloquear = false } = {}) {
    const { rows } = await cliente.query(
        `SELECT c.*, m.numero AS mesa_numero, u.nome AS garcom_nome
         FROM restaurante.comandas c
         LEFT JOIN restaurante.mesas m ON m.id = c.mesa_id
         LEFT JOIN restaurante.usuarios u ON u.id = c.aberta_por
         WHERE c.id = $1
         ${bloquear ? 'FOR UPDATE OF c' : ''}`,
        [comandaId],
    );
    if (!rows.length) throw new ErroRegra(404, 'Comanda nao encontrada.');
    return rows[0];
}

async function itensDaComanda(cliente, comandaId) {
    const { rows } = await cliente.query(
        `SELECT i.*, uc.nome AS cancelado_por_nome
         FROM restaurante.itens i
         LEFT JOIN restaurante.usuarios uc ON uc.id = i.cancelado_por
         WHERE i.comanda_id = $1
         ORDER BY i.criado_em, i.id`,
        [comandaId],
    );
    return rows;
}

async function pagamentosDaComanda(cliente, comandaId) {
    const { rows } = await cliente.query(
        `SELECT p.*, u.nome AS usuario_nome
         FROM restaurante.pagamentos p
         LEFT JOIN restaurante.usuarios u ON u.id = p.usuario_id
         WHERE p.comanda_id = $1
         ORDER BY p.criado_em, p.id`,
        [comandaId],
    );
    return rows;
}

// Fonte unica de verdade do dinheiro. Tudo em centavos inteiros: a taxa e
// arredondada uma unica vez, aqui, e nunca recalculada em outro lugar.
function calcularTotais(comanda, itens, pagamentos) {
    const cobraveis = itens.filter((item) => item.status !== 'cancelado');
    const subtotalCentavos = cobraveis.reduce(
        (soma, item) => soma + item.quantidade * item.preco_unit_centavos,
        0,
    );
    const taxaCentavos = comanda.taxa_servico
        ? Math.round((subtotalCentavos * TAXA_SERVICO_PERCENTUAL) / 100)
        : 0;
    const descontoCentavos = Math.min(comanda.desconto_centavos || 0, subtotalCentavos + taxaCentavos);
    const totalCentavos = subtotalCentavos + taxaCentavos - descontoCentavos;
    const pagoCentavos = pagamentos.reduce((soma, pagamento) => soma + pagamento.valor_centavos, 0);
    return {
        subtotalCentavos,
        taxaCentavos,
        percentualTaxa: TAXA_SERVICO_PERCENTUAL,
        descontoCentavos,
        totalCentavos,
        pagoCentavos,
        saldoCentavos: totalCentavos - pagoCentavos,
        porPessoaCentavos: comanda.pessoas > 0 ? Math.ceil(totalCentavos / comanda.pessoas) : totalCentavos,
    };
}

async function montarComanda(cliente, comandaId, opcoes) {
    const comanda = await buscarComanda(cliente, comandaId, opcoes);
    const [itens, pagamentos] = await Promise.all([
        itensDaComanda(cliente, comandaId),
        pagamentosDaComanda(cliente, comandaId),
    ]);
    return { comanda, itens, pagamentos, totais: calcularTotais(comanda, itens, pagamentos) };
}

// ---------------------------------------------------------------------------
// Bootstrap do schema
// ---------------------------------------------------------------------------

router.use(rota(async (req, res, proximo) => {
    await garantirSchema();
    proximo();
}));

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

router.post('/login', rota(async (req, res) => {
    const login = textoObrigatorio(req.body?.login, 'login', 80).toLowerCase();
    const senha = textoObrigatorio(req.body?.senha, 'senha', 200);

    const { rows } = await pool.query(
        'SELECT id, login, nome, papel, senha_hash, ativo FROM restaurante.usuarios WHERE login = $1',
        [login],
    );
    const usuario = rows[0];
    // Mensagem unica para login inexistente, senha errada e usuario inativo:
    // nao entrega quais logins existem.
    if (!usuario || !usuario.ativo || !auth.conferirSenha(senha, usuario.senha_hash)) {
        await registrarAuditoria(null, {
            usuarioId: usuario?.id || null,
            acao: 'login_negado',
            entidade: 'usuario',
            entidadeId: usuario?.id || null,
            detalhe: { login },
        });
        throw new ErroRegra(401, 'Login ou senha invalidos.');
    }

    const token = await auth.abrirSessao(usuario.id);
    auth.definirCookieSessao(res, token);
    await registrarAuditoria(null, {
        usuarioId: usuario.id,
        acao: 'login',
        entidade: 'usuario',
        entidadeId: usuario.id,
    });
    res.json({ id: usuario.id, login: usuario.login, nome: usuario.nome, papel: usuario.papel });
}));

router.post('/logout', rota(async (req, res) => {
    const token = auth.lerCookies(req)[auth.COOKIE];
    await auth.encerrarSessao(token);
    auth.limparCookieSessao(res);
    res.json({ ok: true });
}));

router.get('/me', rota(async (req, res) => {
    const usuario = await auth.usuarioDaRequisicao(req);
    if (!usuario) throw new ErroRegra(401, 'Sessao expirada.');
    res.json({
        id: usuario.id,
        login: usuario.login,
        nome: usuario.nome,
        papel: usuario.papel,
        percentualTaxa: TAXA_SERVICO_PERCENTUAL,
    });
}));

// ---------------------------------------------------------------------------
// Cardapio
// ---------------------------------------------------------------------------

router.get('/cardapio', auth.exigirPapel(), rota(async (req, res) => {
    const incluirIndisponiveis = req.query.incluirIndisponiveis === '1';
    const { rows } = await pool.query(
        `SELECT cat.id AS categoria_id, cat.nome AS categoria_nome, cat.setor AS categoria_setor, cat.ordem,
                p.id, p.nome, p.descricao, p.preco_centavos, p.tempo_preparo_minutos,
                p.disponivel, COALESCE(p.setor, cat.setor) AS setor
         FROM restaurante.categorias cat
         LEFT JOIN restaurante.produtos p ON p.categoria_id = cat.id AND p.ativo
              AND ($1::boolean OR p.disponivel)
         WHERE cat.ativa
         ORDER BY cat.ordem, cat.nome, p.nome`,
        [incluirIndisponiveis],
    );

    const categorias = [];
    const porId = new Map();
    for (const linha of rows) {
        if (!porId.has(linha.categoria_id)) {
            const categoria = {
                id: linha.categoria_id,
                nome: linha.categoria_nome,
                setor: linha.categoria_setor,
                produtos: [],
            };
            porId.set(linha.categoria_id, categoria);
            categorias.push(categoria);
        }
        if (linha.id) {
            porId.get(linha.categoria_id).produtos.push({
                id: linha.id,
                nome: linha.nome,
                descricao: linha.descricao,
                precoCentavos: linha.preco_centavos,
                tempoPreparoMinutos: linha.tempo_preparo_minutos,
                disponivel: linha.disponivel,
                setor: linha.setor,
            });
        }
    }
    res.json({ categorias });
}));

router.post('/categorias', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const nome = textoObrigatorio(req.body?.nome, 'nome', 80);
    const setor = textoObrigatorio(req.body?.setor || 'cozinha', 'setor', 20);
    if (!SETORES.includes(setor)) throw new ErroRegra(400, `Setor deve ser um de: ${SETORES.join(', ')}.`);
    const ordem = inteiro(req.body?.ordem ?? 0, 'ordem', { maximo: 999 });

    const { rows } = await pool.query(
        `INSERT INTO restaurante.categorias (nome, setor, ordem) VALUES ($1, $2, $3)
         ON CONFLICT (nome) DO UPDATE SET setor = EXCLUDED.setor, ordem = EXCLUDED.ordem, ativa = true
         RETURNING id, nome, setor, ordem`,
        [nome, setor, ordem],
    );
    res.status(201).json(rows[0]);
}));

router.post('/produtos', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const categoriaId = inteiro(req.body?.categoriaId, 'categoriaId', { minimo: 1 });
    const nome = textoObrigatorio(req.body?.nome, 'nome', 120);
    const precoCentavos = precoParaCentavos(req.body?.preco ?? req.body?.precoCentavos, 'preco');
    const descricao = textoOpcional(req.body?.descricao, 400);
    const tempoPreparo = inteiro(req.body?.tempoPreparoMinutos ?? 0, 'tempoPreparoMinutos', { maximo: 240 });
    const setor = req.body?.setor ? textoObrigatorio(req.body.setor, 'setor', 20) : null;
    if (setor && !SETORES.includes(setor)) throw new ErroRegra(400, `Setor deve ser um de: ${SETORES.join(', ')}.`);

    const { rows } = await pool.query(
        `INSERT INTO restaurante.produtos
             (categoria_id, nome, descricao, preco_centavos, setor, tempo_preparo_minutos)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, nome, preco_centavos`,
        [categoriaId, nome, descricao, precoCentavos, setor, tempoPreparo],
    );
    await registrarAuditoria(null, {
        usuarioId: req.usuario.id,
        acao: 'produto_criado',
        entidade: 'produto',
        entidadeId: rows[0].id,
        detalhe: { nome, precoCentavos },
    });
    eventos.publicar('cardapio.alterado', { produtoId: rows[0].id });
    res.status(201).json(rows[0]);
}));

router.patch('/produtos/:id', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const id = idDaRota(req);
    const campos = [];
    const valores = [];
    const definir = (coluna, valor) => {
        valores.push(valor);
        campos.push(`${coluna} = $${valores.length}`);
    };

    if (req.body?.nome !== undefined) definir('nome', textoObrigatorio(req.body.nome, 'nome', 120));
    if (req.body?.descricao !== undefined) definir('descricao', textoOpcional(req.body.descricao, 400));
    if (req.body?.preco !== undefined || req.body?.precoCentavos !== undefined) {
        definir('preco_centavos', precoParaCentavos(req.body.preco ?? req.body.precoCentavos, 'preco'));
    }
    if (req.body?.tempoPreparoMinutos !== undefined) {
        definir('tempo_preparo_minutos', inteiro(req.body.tempoPreparoMinutos, 'tempoPreparoMinutos', { maximo: 240 }));
    }
    if (req.body?.categoriaId !== undefined) definir('categoria_id', inteiro(req.body.categoriaId, 'categoriaId', { minimo: 1 }));
    if (req.body?.ativo !== undefined) definir('ativo', Boolean(req.body.ativo));
    if (req.body?.setor !== undefined) {
        const setor = req.body.setor ? String(req.body.setor).trim() : null;
        if (setor && !SETORES.includes(setor)) throw new ErroRegra(400, `Setor deve ser um de: ${SETORES.join(', ')}.`);
        definir('setor', setor);
    }
    if (!campos.length) throw new ErroRegra(400, 'Nada para atualizar.');

    valores.push(id);
    const { rows } = await pool.query(
        `UPDATE restaurante.produtos SET ${campos.join(', ')}, atualizado_em = now()
         WHERE id = $${valores.length} RETURNING id, nome, preco_centavos, ativo`,
        valores,
    );
    if (!rows.length) throw new ErroRegra(404, 'Produto nao encontrado.');
    await registrarAuditoria(null, {
        usuarioId: req.usuario.id,
        acao: 'produto_alterado',
        entidade: 'produto',
        entidadeId: id,
        detalhe: req.body,
    });
    // Preco novo nao mexe em conta aberta: o item ja gravou o preco praticado.
    eventos.publicar('cardapio.alterado', { produtoId: id });
    res.json(rows[0]);
}));

// "Esgotou" e operacao de servico, nao de cadastro: a cozinha resolve sozinha.
router.patch('/produtos/:id/disponibilidade', auth.exigirPapel('cozinha', 'caixa'), rota(async (req, res) => {
    const id = idDaRota(req);
    const disponivel = Boolean(req.body?.disponivel);
    const { rows } = await pool.query(
        `UPDATE restaurante.produtos SET disponivel = $1, atualizado_em = now()
         WHERE id = $2 AND ativo RETURNING id, nome, disponivel`,
        [disponivel, id],
    );
    if (!rows.length) throw new ErroRegra(404, 'Produto nao encontrado.');
    await registrarAuditoria(null, {
        usuarioId: req.usuario.id,
        acao: disponivel ? 'produto_reabastecido' : 'produto_esgotado',
        entidade: 'produto',
        entidadeId: id,
        detalhe: { nome: rows[0].nome },
    });
    eventos.publicar('produto.disponibilidade', rows[0]);
    res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Salao: mapa de mesas
// ---------------------------------------------------------------------------

router.get('/mesas', auth.exigirPapel(), rota(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT m.id, m.numero, m.capacidade,
                c.id AS comanda_id, c.codigo AS comanda_codigo, c.status AS comanda_status,
                c.pessoas, c.aberta_em, c.taxa_servico, c.desconto_centavos,
                u.nome AS garcom_nome,
                COALESCE(t.subtotal, 0)::int AS subtotal_centavos,
                COALESCE(t.em_producao, 0)::int AS itens_em_producao,
                COALESCE(t.prontos, 0)::int AS itens_prontos
         FROM restaurante.mesas m
         LEFT JOIN restaurante.comandas c
                ON c.mesa_id = m.id AND c.status IN ('aberta', 'conta_pedida')
         LEFT JOIN restaurante.usuarios u ON u.id = c.aberta_por
         LEFT JOIN LATERAL (
             SELECT SUM(i.quantidade * i.preco_unit_centavos) FILTER (WHERE i.status <> 'cancelado') AS subtotal,
                    COUNT(*) FILTER (WHERE i.status IN ('pendente', 'preparando')) AS em_producao,
                    COUNT(*) FILTER (WHERE i.status = 'pronto') AS prontos
             FROM restaurante.itens i WHERE i.comanda_id = c.id
         ) t ON true
         WHERE m.ativa
         ORDER BY length(m.numero), m.numero`,
    );

    const mesas = rows.map((linha) => {
        const subtotal = linha.subtotal_centavos;
        const taxa = linha.comanda_id && linha.taxa_servico
            ? Math.round((subtotal * TAXA_SERVICO_PERCENTUAL) / 100)
            : 0;
        return {
            id: linha.id,
            numero: linha.numero,
            capacidade: linha.capacidade,
            status: linha.comanda_id ? linha.comanda_status : 'livre',
            comanda: linha.comanda_id
                ? {
                    id: linha.comanda_id,
                    codigo: linha.comanda_codigo,
                    status: linha.comanda_status,
                    pessoas: linha.pessoas,
                    abertaEm: linha.aberta_em,
                    garcom: linha.garcom_nome,
                    subtotalCentavos: subtotal,
                    totalCentavos: subtotal + taxa - (linha.desconto_centavos || 0),
                    itensEmProducao: linha.itens_em_producao,
                    itensProntos: linha.itens_prontos,
                }
                : null,
        };
    });
    res.json({ mesas });
}));

router.post('/mesas', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const numero = textoObrigatorio(req.body?.numero, 'numero', 10);
    const capacidade = inteiro(req.body?.capacidade ?? 4, 'capacidade', { minimo: 1, maximo: 50 });
    const { rows } = await pool.query(
        `INSERT INTO restaurante.mesas (numero, capacidade) VALUES ($1, $2)
         ON CONFLICT (numero) DO UPDATE SET capacidade = EXCLUDED.capacidade, ativa = true
         RETURNING id, numero, capacidade`,
        [numero, capacidade],
    );
    res.status(201).json(rows[0]);
}));

router.patch('/mesas/:id', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const id = idDaRota(req);
    const ativa = Boolean(req.body?.ativa);
    if (!ativa) {
        const { rows } = await pool.query(
            `SELECT 1 FROM restaurante.comandas
             WHERE mesa_id = $1 AND status IN ('aberta', 'conta_pedida')`,
            [id],
        );
        if (rows.length) throw new ErroRegra(409, 'Nao da para desativar mesa com comanda aberta.');
    }
    const { rows } = await pool.query(
        'UPDATE restaurante.mesas SET ativa = $1 WHERE id = $2 RETURNING id, numero, ativa',
        [ativa, id],
    );
    if (!rows.length) throw new ErroRegra(404, 'Mesa nao encontrada.');
    res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Comandas
// ---------------------------------------------------------------------------

router.post('/comandas', auth.exigirPapel('garcom', 'caixa'), rota(async (req, res) => {
    const mesaId = inteiro(req.body?.mesaId, 'mesaId', { minimo: 1 });
    const pessoas = inteiro(req.body?.pessoas ?? 1, 'pessoas', { minimo: 1, maximo: 50 });

    const mesa = await pool.query('SELECT id, numero, ativa FROM restaurante.mesas WHERE id = $1', [mesaId]);
    if (!mesa.rows.length) throw new ErroRegra(404, 'Mesa nao encontrada.');
    if (!mesa.rows[0].ativa) throw new ErroRegra(409, 'Mesa desativada.');

    let comanda;
    try {
        const { rows } = await pool.query(
            `INSERT INTO restaurante.comandas (mesa_id, pessoas, aberta_por)
             VALUES ($1, $2, $3) RETURNING *`,
            [mesaId, pessoas, req.usuario.id],
        );
        comanda = rows[0];
    } catch (erro) {
        // O indice unico parcial e quem realmente impede duas comandas na mesma
        // mesa quando dois garcons abrem ao mesmo tempo.
        if (erro.code === '23505') {
            throw new ErroRegra(409, `Mesa ${mesa.rows[0].numero} ja tem comanda aberta.`);
        }
        throw erro;
    }

    await registrarAuditoria(null, {
        usuarioId: req.usuario.id,
        acao: 'comanda_aberta',
        entidade: 'comanda',
        entidadeId: comanda.id,
        detalhe: { mesa: mesa.rows[0].numero, pessoas },
    });
    eventos.publicar('comanda.aberta', {
        comandaId: comanda.id,
        codigo: comanda.codigo,
        mesa: mesa.rows[0].numero,
    });
    res.status(201).json({ ...comanda, mesa_numero: mesa.rows[0].numero });
}));

router.get('/comandas/:id', auth.exigirPapel(), rota(async (req, res) => {
    const id = idDaRota(req);
    const dados = await montarComanda(pool, id);
    res.json(dados);
}));

router.get('/comandas', auth.exigirPapel(), rota(async (req, res) => {
    const status = req.query.status ? String(req.query.status).split(',') : ['aberta', 'conta_pedida'];
    const { rows } = await pool.query(
        `SELECT c.id, c.codigo, c.status, c.pessoas, c.aberta_em, c.fechada_em,
                m.numero AS mesa_numero, u.nome AS garcom_nome
         FROM restaurante.comandas c
         LEFT JOIN restaurante.mesas m ON m.id = c.mesa_id
         LEFT JOIN restaurante.usuarios u ON u.id = c.aberta_por
         WHERE c.status = ANY($1::text[])
         ORDER BY c.aberta_em DESC
         LIMIT 200`,
        [status],
    );
    res.json({ comandas: rows });
}));

// Lancamento de rodada. O `Idempotency-Key` e o que impede o duplo toque do
// garcom em rede ruim de virar dois pratos na cozinha.
router.post('/comandas/:id/itens', auth.exigirPapel('garcom', 'caixa'), rota(async (req, res) => {
    const comandaId = idDaRota(req);
    const chave = textoObrigatorio(
        req.get('Idempotency-Key') || req.body?.idempotencyKey,
        'Idempotency-Key',
        100,
    );
    const linhas = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (!linhas.length) throw new ErroRegra(400, 'Informe ao menos um item.');
    if (linhas.length > 50) throw new ErroRegra(400, 'Maximo de 50 itens por lancamento.');

    const pedidos = linhas.map((linha) => ({
        produtoId: inteiro(linha?.produtoId, 'produtoId', { minimo: 1 }),
        quantidade: inteiro(linha?.quantidade ?? 1, 'quantidade', { minimo: 1, maximo: 99 }),
        observacao: textoOpcional(linha?.observacao, 200),
    }));

    const executar = () => emTransacao(async (cliente) => {
        const repetido = await cliente.query(
            'SELECT id, comanda_id FROM restaurante.pedidos WHERE idempotency_key = $1',
            [chave],
        );
        if (repetido.rows.length) {
            return { pedidoId: repetido.rows[0].id, repetido: true, itens: [] };
        }

        // O lock da comanda serializa lancamento e fechamento: nao da para
        // entrar item enquanto o caixa esta fechando a conta.
        const comanda = await buscarComanda(cliente, comandaId, { bloquear: true });
        if (comanda.status !== 'aberta') {
            throw new ErroRegra(409, `Comanda ${comanda.codigo} esta "${comanda.status}" e nao aceita novos itens.`);
        }

        const { rows: produtos } = await cliente.query(
            `SELECT p.id, p.nome, p.preco_centavos, p.disponivel, p.ativo,
                    COALESCE(p.setor, cat.setor) AS setor
             FROM restaurante.produtos p
             JOIN restaurante.categorias cat ON cat.id = p.categoria_id
             WHERE p.id = ANY($1::bigint[])`,
            [pedidos.map((item) => item.produtoId)],
        );
        const catalogo = new Map(produtos.map((produto) => [produto.id, produto]));

        for (const item of pedidos) {
            const produto = catalogo.get(item.produtoId);
            if (!produto || !produto.ativo) throw new ErroRegra(404, `Produto ${item.produtoId} nao existe no cardapio.`);
            if (!produto.disponivel) throw new ErroRegra(409, `"${produto.nome}" esta esgotado.`);
        }

        const { rows: criado } = await cliente.query(
            `INSERT INTO restaurante.pedidos (comanda_id, idempotency_key, usuario_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [comandaId, chave, req.usuario.id],
        );
        const pedidoId = criado[0].id;

        const inseridos = [];
        for (const item of pedidos) {
            const produto = catalogo.get(item.produtoId);
            const { rows } = await cliente.query(
                `INSERT INTO restaurante.itens
                     (pedido_id, comanda_id, produto_id, produto_nome, preco_unit_centavos,
                      quantidade, observacao, setor)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [
                    pedidoId,
                    comandaId,
                    produto.id,
                    produto.nome,          // congelado
                    produto.preco_centavos, // congelado
                    item.quantidade,
                    item.observacao,
                    produto.setor,
                ],
            );
            inseridos.push(rows[0]);
        }

        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'itens_lancados',
            entidade: 'comanda',
            entidadeId: comandaId,
            detalhe: { pedidoId, quantidadeItens: inseridos.length },
        });

        return { pedidoId, repetido: false, itens: inseridos, comanda };
    });

    let resultado;
    try {
        resultado = await executar();
    } catch (erro) {
        // Duas requisicoes com a mesma chave em paralelo: a perdedora bate no
        // indice unico. Isso e sucesso, nao falha — devolve a rodada vencedora.
        if (erro.code === '23505' && String(erro.constraint || '').includes('idempotency')) {
            const { rows } = await pool.query(
                'SELECT id FROM restaurante.pedidos WHERE idempotency_key = $1',
                [chave],
            );
            resultado = { pedidoId: rows[0]?.id, repetido: true, itens: [] };
        } else {
            throw erro;
        }
    }

    if (!resultado.repetido) {
        eventos.publicar('itens.lancados', {
            comandaId,
            codigo: resultado.comanda.codigo,
            mesa: resultado.comanda.mesa_numero,
            itens: resultado.itens.map((item) => ({
                id: item.id,
                nome: item.produto_nome,
                quantidade: item.quantidade,
                setor: item.setor,
            })),
        });
    }

    const dados = await montarComanda(pool, comandaId);
    res.status(resultado.repetido ? 200 : 201).json({ ...dados, repetido: resultado.repetido });
}));

router.post('/comandas/:id/conta', auth.exigirPapel('garcom', 'caixa'), rota(async (req, res) => {
    const id = idDaRota(req);
    const comanda = await emTransacao(async (cliente) => {
        const atual = await buscarComanda(cliente, id, { bloquear: true });
        if (atual.status !== 'aberta') {
            throw new ErroRegra(409, `Comanda ja esta "${atual.status}".`);
        }
        const { rows } = await cliente.query(
            `UPDATE restaurante.comandas SET status = 'conta_pedida', conta_pedida_em = now()
             WHERE id = $1 RETURNING *`,
            [id],
        );
        return rows[0];
    });
    eventos.publicar('comanda.conta_pedida', { comandaId: id, codigo: comanda.codigo });
    res.json(await montarComanda(pool, id));
}));

// Reabre a comanda para lancar item esquecido depois de pedir a conta.
router.post('/comandas/:id/reabrir', auth.exigirPapel('garcom', 'caixa'), rota(async (req, res) => {
    const id = idDaRota(req);
    await emTransacao(async (cliente) => {
        const atual = await buscarComanda(cliente, id, { bloquear: true });
        if (atual.status !== 'conta_pedida') {
            throw new ErroRegra(409, `So da para reabrir comanda com conta pedida (esta "${atual.status}").`);
        }
        await cliente.query(
            `UPDATE restaurante.comandas SET status = 'aberta', conta_pedida_em = NULL WHERE id = $1`,
            [id],
        );
        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'comanda_reaberta',
            entidade: 'comanda',
            entidadeId: id,
        });
    });
    eventos.publicar('comanda.reaberta', { comandaId: id });
    res.json(await montarComanda(pool, id));
}));

// Taxa de servico e desconto. Desconto sempre exige motivo e fica auditado —
// e por essa porta que dinheiro sai do caixa sem passar pelo cardapio.
router.patch('/comandas/:id', auth.exigirPapel('caixa'), rota(async (req, res) => {
    const id = idDaRota(req);
    await emTransacao(async (cliente) => {
        const comanda = await buscarComanda(cliente, id, { bloquear: true });
        if (comanda.status === 'fechada' || comanda.status === 'cancelada') {
            throw new ErroRegra(409, 'Comanda ja encerrada.');
        }

        if (req.body?.taxaServico !== undefined) {
            await cliente.query('UPDATE restaurante.comandas SET taxa_servico = $1 WHERE id = $2', [
                Boolean(req.body.taxaServico), id,
            ]);
            await registrarAuditoria(cliente, {
                usuarioId: req.usuario.id,
                acao: Boolean(req.body.taxaServico) ? 'taxa_aplicada' : 'taxa_removida',
                entidade: 'comanda',
                entidadeId: id,
            });
        }

        if (req.body?.pessoas !== undefined) {
            await cliente.query('UPDATE restaurante.comandas SET pessoas = $1 WHERE id = $2', [
                inteiro(req.body.pessoas, 'pessoas', { minimo: 1, maximo: 50 }), id,
            ]);
        }

        if (req.body?.descontoCentavos !== undefined) {
            const desconto = inteiro(req.body.descontoCentavos, 'descontoCentavos', { maximo: 100000000 });
            // Desconto e prerrogativa de gerente: o caixa nao se autoriza.
            if (desconto > 0 && req.usuario.papel !== 'gerente') {
                throw new ErroRegra(403, 'Desconto exige autorizacao do gerente.');
            }
            const motivo = desconto > 0 ? textoObrigatorio(req.body?.descontoMotivo, 'descontoMotivo', 200) : null;
            await cliente.query(
                `UPDATE restaurante.comandas
                 SET desconto_centavos = $1, desconto_motivo = $2, desconto_por = $3
                 WHERE id = $4`,
                [desconto, motivo, desconto > 0 ? req.usuario.id : null, id],
            );
            await registrarAuditoria(cliente, {
                usuarioId: req.usuario.id,
                acao: 'desconto_aplicado',
                entidade: 'comanda',
                entidadeId: id,
                detalhe: { descontoCentavos: desconto, motivo },
            });
        }
    });
    res.json(await montarComanda(pool, id));
}));

// ---------------------------------------------------------------------------
// Itens: status e cancelamento
// ---------------------------------------------------------------------------

router.post('/itens/:id/status', auth.exigirPapel(), rota(async (req, res) => {
    const id = idDaRota(req);
    const novoStatus = textoObrigatorio(req.body?.status, 'status', 20);
    if (novoStatus === 'cancelado') {
        throw new ErroRegra(400, 'Use a rota de cancelamento, que exige motivo.');
    }

    const item = await emTransacao(async (cliente) => {
        const { rows } = await cliente.query('SELECT * FROM restaurante.itens WHERE id = $1 FOR UPDATE', [id]);
        const atual = rows[0];
        if (!atual) throw new ErroRegra(404, 'Item nao encontrado.');

        const permitidas = TRANSICOES_ITEM[atual.status] || [];
        if (!permitidas.includes(novoStatus)) {
            throw new ErroRegra(409, `Item "${atual.produto_nome}" esta "${atual.status}" e nao pode ir para "${novoStatus}".`);
        }
        const papeis = PAPEIS_POR_STATUS[novoStatus] || [];
        if (req.usuario.papel !== 'gerente' && !papeis.includes(req.usuario.papel)) {
            throw new ErroRegra(403, `Marcar "${novoStatus}" e funcao de: ${papeis.join(', ')}.`);
        }

        const carimbo = {
            preparando: 'iniciado_em',
            pronto: 'pronto_em',
            entregue: 'entregue_em',
        }[novoStatus];
        const { rows: atualizado } = await cliente.query(
            `UPDATE restaurante.itens SET status = $1, ${carimbo} = now() WHERE id = $2 RETURNING *`,
            [novoStatus, id],
        );
        return atualizado[0];
    });

    eventos.publicar('item.status', {
        itemId: item.id,
        comandaId: item.comanda_id,
        nome: item.produto_nome,
        status: item.status,
        setor: item.setor,
    });
    res.json(item);
}));

router.post('/itens/:id/cancelar', auth.exigirPapel(), rota(async (req, res) => {
    const id = idDaRota(req);
    const motivo = textoObrigatorio(req.body?.motivo, 'motivo', 200);
    if (motivo.length < 3) throw new ErroRegra(400, 'Descreva o motivo do cancelamento.');

    const item = await emTransacao(async (cliente) => {
        const { rows } = await cliente.query('SELECT * FROM restaurante.itens WHERE id = $1 FOR UPDATE', [id]);
        const atual = rows[0];
        if (!atual) throw new ErroRegra(404, 'Item nao encontrado.');
        if (!TRANSICOES_ITEM[atual.status].includes('cancelado')) {
            throw new ErroRegra(409, `Item "${atual.produto_nome}" esta "${atual.status}" e nao pode mais ser cancelado.`);
        }
        // Depois que a producao encostou no item ha insumo gasto: vira perda,
        // e perda so o gerente assume.
        if (atual.status === 'preparando' && req.usuario.papel !== 'gerente') {
            throw new ErroRegra(403, 'Item ja em preparo. Cancelamento exige autorizacao do gerente.');
        }

        const comanda = await buscarComanda(cliente, atual.comanda_id, { bloquear: true });
        if (comanda.status === 'fechada' || comanda.status === 'cancelada') {
            throw new ErroRegra(409, 'Comanda ja encerrada.');
        }

        const { rows: atualizado } = await cliente.query(
            `UPDATE restaurante.itens
             SET status = 'cancelado', cancelado_em = now(), cancelado_por = $1, motivo_cancelamento = $2
             WHERE id = $3 RETURNING *`,
            [req.usuario.id, motivo, id],
        );
        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'item_cancelado',
            entidade: 'item',
            entidadeId: id,
            detalhe: {
                produto: atual.produto_nome,
                statusAnterior: atual.status,
                valorCentavos: atual.quantidade * atual.preco_unit_centavos,
                motivo,
            },
        });
        return atualizado[0];
    });

    eventos.publicar('item.status', {
        itemId: item.id,
        comandaId: item.comanda_id,
        nome: item.produto_nome,
        status: 'cancelado',
        setor: item.setor,
    });
    res.json(item);
}));

// ---------------------------------------------------------------------------
// Producao (KDS)
// ---------------------------------------------------------------------------

router.get('/producao', auth.exigirPapel(), rota(async (req, res) => {
    const setor = req.query.setor ? String(req.query.setor) : null;
    if (setor && !SETORES.includes(setor)) throw new ErroRegra(400, 'Setor invalido.');

    const { rows } = await pool.query(
        `SELECT i.id, i.produto_nome, i.quantidade, i.observacao, i.setor, i.status,
                i.criado_em, i.iniciado_em,
                EXTRACT(EPOCH FROM (now() - i.criado_em))::int AS espera_segundos,
                p.tempo_preparo_minutos,
                c.id AS comanda_id, c.codigo AS comanda_codigo,
                m.numero AS mesa_numero
         FROM restaurante.itens i
         JOIN restaurante.comandas c ON c.id = i.comanda_id
         JOIN restaurante.produtos p ON p.id = i.produto_id
         LEFT JOIN restaurante.mesas m ON m.id = c.mesa_id
         WHERE i.status IN ('pendente', 'preparando', 'pronto')
           AND ($1::text IS NULL OR i.setor = $1)
         ORDER BY i.criado_em, i.id`,
        [setor],
    );
    res.json({ itens: rows, setores: SETORES });
}));

// ---------------------------------------------------------------------------
// Pagamento e fechamento
// ---------------------------------------------------------------------------

router.post('/comandas/:id/pagamentos', auth.exigirPapel('caixa'), rota(async (req, res) => {
    const comandaId = idDaRota(req);
    const forma = textoObrigatorio(req.body?.forma, 'forma', 20);
    if (!FORMAS_PAGAMENTO.includes(forma)) {
        throw new ErroRegra(400, `Forma deve ser uma de: ${FORMAS_PAGAMENTO.join(', ')}.`);
    }

    const pagamento = await emTransacao(async (cliente) => {
        const { comanda, itens, pagamentos } = await montarComanda(cliente, comandaId, { bloquear: true });
        if (comanda.status === 'fechada' || comanda.status === 'cancelada') {
            throw new ErroRegra(409, 'Comanda ja encerrada.');
        }
        const totais = calcularTotais(comanda, itens, pagamentos);
        if (totais.saldoCentavos <= 0) throw new ErroRegra(409, 'Conta ja esta quitada.');

        // Sem valor informado, quita o saldo restante (caso mais comum).
        const valorCentavos = req.body?.valorCentavos !== undefined
            ? inteiro(req.body.valorCentavos, 'valorCentavos', { minimo: 1, maximo: 100000000 })
            : totais.saldoCentavos;
        if (valorCentavos > totais.saldoCentavos) {
            throw new ErroRegra(400, `Valor acima do saldo de ${dinheiro(totais.saldoCentavos)}.`);
        }

        let recebidoCentavos = null;
        let trocoCentavos = 0;
        if (forma === 'dinheiro' && req.body?.recebidoCentavos !== undefined) {
            recebidoCentavos = inteiro(req.body.recebidoCentavos, 'recebidoCentavos', { minimo: 1, maximo: 100000000 });
            if (recebidoCentavos < valorCentavos) {
                throw new ErroRegra(400, `Recebido ${dinheiro(recebidoCentavos)} e menor que ${dinheiro(valorCentavos)}.`);
            }
            trocoCentavos = recebidoCentavos - valorCentavos;
        }

        const { rows } = await cliente.query(
            `INSERT INTO restaurante.pagamentos
                 (comanda_id, forma, valor_centavos, recebido_centavos, troco_centavos, usuario_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [comandaId, forma, valorCentavos, recebidoCentavos, trocoCentavos, req.usuario.id],
        );
        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'pagamento_registrado',
            entidade: 'comanda',
            entidadeId: comandaId,
            detalhe: { forma, valorCentavos, trocoCentavos },
        });
        return rows[0];
    });

    const dados = await montarComanda(pool, comandaId);
    res.status(201).json({ pagamento, ...dados });
}));

// Estorno de lancamento errado no caixa (dedo trocado na forma de pagamento).
router.delete('/comandas/:id/pagamentos/:pagamentoId', auth.exigirPapel('caixa'), rota(async (req, res) => {
    const comandaId = idDaRota(req);
    const pagamentoId = idDaRota(req, 'pagamentoId');
    await emTransacao(async (cliente) => {
        const comanda = await buscarComanda(cliente, comandaId, { bloquear: true });
        if (comanda.status === 'fechada') {
            throw new ErroRegra(409, 'Comanda fechada. Estorno exige reabertura pelo gerente.');
        }
        const { rows } = await cliente.query(
            'DELETE FROM restaurante.pagamentos WHERE id = $1 AND comanda_id = $2 RETURNING *',
            [pagamentoId, comandaId],
        );
        if (!rows.length) throw new ErroRegra(404, 'Pagamento nao encontrado nesta comanda.');
        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'pagamento_estornado',
            entidade: 'comanda',
            entidadeId: comandaId,
            detalhe: { forma: rows[0].forma, valorCentavos: rows[0].valor_centavos },
        });
    });
    res.json(await montarComanda(pool, comandaId));
}));

router.post('/comandas/:id/fechar', auth.exigirPapel('caixa'), rota(async (req, res) => {
    const comandaId = idDaRota(req);

    const fechada = await emTransacao(async (cliente) => {
        const { comanda, itens, pagamentos } = await montarComanda(cliente, comandaId, { bloquear: true });
        if (comanda.status === 'fechada') throw new ErroRegra(409, 'Comanda ja fechada.');
        if (comanda.status === 'cancelada') throw new ErroRegra(409, 'Comanda cancelada.');

        // Fechar com item ainda na producao esconde prejuizo: ou entrega, ou
        // cancela com motivo. Nao existe terceira saida.
        const emAndamento = itens.filter((item) => ['pendente', 'preparando', 'pronto'].includes(item.status));
        if (emAndamento.length) {
            throw new ErroRegra(
                409,
                `Ha ${emAndamento.length} item(ns) sem entrega: ${emAndamento.map((i) => i.produto_nome).join(', ')}. Entregue ou cancele antes de fechar.`,
            );
        }

        const totais = calcularTotais(comanda, itens, pagamentos);
        if (totais.saldoCentavos > 0) {
            throw new ErroRegra(409, `Faltam ${dinheiro(totais.saldoCentavos)} para quitar a conta.`);
        }

        const { rows } = await cliente.query(
            `UPDATE restaurante.comandas
             SET status = 'fechada', fechada_em = now(), fechada_por = $1
             WHERE id = $2 RETURNING *`,
            [req.usuario.id, comandaId],
        );
        await registrarAuditoria(cliente, {
            usuarioId: req.usuario.id,
            acao: 'comanda_fechada',
            entidade: 'comanda',
            entidadeId: comandaId,
            detalhe: totais,
        });
        return { comanda: rows[0], totais };
    });

    eventos.publicar('comanda.fechada', {
        comandaId,
        codigo: fechada.comanda.codigo,
        totalCentavos: fechada.totais.totalCentavos,
    });
    res.json(await montarComanda(pool, comandaId));
}));

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

router.get('/usuarios', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const { rows } = await pool.query(
        `SELECT id, login, nome, papel, ativo, ultimo_acesso
         FROM restaurante.usuarios ORDER BY nome`,
    );
    res.json({ usuarios: rows });
}));

router.post('/usuarios', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const login = textoObrigatorio(req.body?.login, 'login', 80).toLowerCase();
    const nome = textoObrigatorio(req.body?.nome, 'nome', 120);
    const papel = textoObrigatorio(req.body?.papel, 'papel', 20);
    const senha = textoObrigatorio(req.body?.senha, 'senha', 200);
    if (!auth.PAPEIS.includes(papel)) throw new ErroRegra(400, `Papel deve ser um de: ${auth.PAPEIS.join(', ')}.`);
    if (senha.length < 6) throw new ErroRegra(400, 'Senha precisa de ao menos 6 caracteres.');

    try {
        const { rows } = await pool.query(
            `INSERT INTO restaurante.usuarios (login, senha_hash, nome, papel)
             VALUES ($1, $2, $3, $4) RETURNING id, login, nome, papel, ativo`,
            [login, auth.gerarHashSenha(senha), nome, papel],
        );
        await registrarAuditoria(null, {
            usuarioId: req.usuario.id,
            acao: 'usuario_criado',
            entidade: 'usuario',
            entidadeId: rows[0].id,
            detalhe: { login, papel },
        });
        res.status(201).json(rows[0]);
    } catch (erro) {
        if (erro.code === '23505') throw new ErroRegra(409, `Login "${login}" ja existe.`);
        throw erro;
    }
}));

router.patch('/usuarios/:id', auth.exigirPapel('gerente'), rota(async (req, res) => {
    const id = idDaRota(req);
    const campos = [];
    const valores = [];
    const definir = (coluna, valor) => {
        valores.push(valor);
        campos.push(`${coluna} = $${valores.length}`);
    };

    if (req.body?.nome !== undefined) definir('nome', textoObrigatorio(req.body.nome, 'nome', 120));
    if (req.body?.papel !== undefined) {
        const papel = textoObrigatorio(req.body.papel, 'papel', 20);
        if (!auth.PAPEIS.includes(papel)) throw new ErroRegra(400, `Papel deve ser um de: ${auth.PAPEIS.join(', ')}.`);
        definir('papel', papel);
    }
    if (req.body?.ativo !== undefined) definir('ativo', Boolean(req.body.ativo));
    if (req.body?.senha !== undefined) {
        const senha = textoObrigatorio(req.body.senha, 'senha', 200);
        if (senha.length < 6) throw new ErroRegra(400, 'Senha precisa de ao menos 6 caracteres.');
        definir('senha_hash', auth.gerarHashSenha(senha));
    }
    if (!campos.length) throw new ErroRegra(400, 'Nada para atualizar.');

    valores.push(id);
    const { rows } = await pool.query(
        `UPDATE restaurante.usuarios SET ${campos.join(', ')}, atualizado_em = now()
         WHERE id = $${valores.length} RETURNING id, login, nome, papel, ativo`,
        valores,
    );
    if (!rows.length) throw new ErroRegra(404, 'Usuario nao encontrado.');

    // Trocar senha, papel ou desativar tem que derrubar as sessoes vivas,
    // senao o cracha antigo continua valendo ate expirar.
    if (req.body?.senha !== undefined || req.body?.ativo === false || req.body?.papel !== undefined) {
        await pool.query('DELETE FROM restaurante.sessoes WHERE usuario_id = $1', [id]);
    }
    await registrarAuditoria(null, {
        usuarioId: req.usuario.id,
        acao: 'usuario_alterado',
        entidade: 'usuario',
        entidadeId: id,
        detalhe: { campos: Object.keys(req.body || {}).filter((chave) => chave !== 'senha') },
    });
    res.json(rows[0]);
}));

// ---------------------------------------------------------------------------
// Stream de eventos
// ---------------------------------------------------------------------------

router.get('/eventos', rota(async (req, res) => {
    const usuario = await auth.usuarioDaRequisicao(req);
    if (!usuario) throw new ErroRegra(401, 'Sessao expirada.');
    eventos.inscrever(req, res, usuario);
}));

// ---------------------------------------------------------------------------
// Tratador de erro do modulo
// ---------------------------------------------------------------------------

router.use((erro, req, res, proximo) => {
    if (res.headersSent) return proximo(erro);
    if (erro instanceof ErroRegra) {
        return res.status(erro.status).json({ erro: erro.message });
    }
    console.error('[restaurante] erro nao tratado:', erro);
    return res.status(500).json({ erro: 'Falha interna no modulo de pedidos.' });
});

module.exports = router;
module.exports.ErroRegra = ErroRegra;
module.exports.calcularTotais = calcularTotais;
module.exports.TRANSICOES_ITEM = TRANSICOES_ITEM;

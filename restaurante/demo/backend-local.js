/* Backend do restaurante rodando dentro do navegador, para a demo publicada.
 *
 * Falsifica `fetch` e `EventSource` na fronteira da rede. Assim o arquivo
 * `public/restaurante.js` roda BYTE A BYTE IGUAL ao da aplicacao real — a demo
 * exercita a tela de verdade, nao uma reimplementacao parecida.
 *
 * As regras aqui espelham `restaurante/rotas.js`: centavos inteiros, preco
 * congelado, maquina de estados, permissao por papel, idempotencia, uma comanda
 * viva por mesa e conta que nao fecha com item na producao ou saldo em aberto.
 * O que nao da para reproduzir em memoria e a concorrencia real do PostgreSQL
 * (`FOR UPDATE`, indice unico) — aqui ela vira checagem sequencial, que basta
 * porque o navegador roda em uma unica thread.
 */

(() => {
    'use strict';

    const TAXA_SERVICO_PERCENTUAL = 10;
    const SETORES = ['cozinha', 'chapa', 'bar', 'sobremesa'];
    const FORMAS_PAGAMENTO = ['dinheiro', 'debito', 'credito', 'pix', 'voucher'];

    const TRANSICOES_ITEM = {
        pendente: ['preparando', 'pronto', 'cancelado'],
        preparando: ['pronto', 'cancelado'],
        pronto: ['entregue'],
        entregue: [],
        cancelado: [],
    };
    const PAPEIS_POR_STATUS = {
        preparando: ['cozinha'],
        pronto: ['cozinha'],
        entregue: ['garcom', 'caixa'],
    };

    // ----------------------------------------------------------------- banco

    let bd;
    let sessao = null;

    const proximoId = (() => {
        const contadores = {};
        return (tabela) => {
            contadores[tabela] = (contadores[tabela] || 0) + 1;
            return contadores[tabela];
        };
    })();

    const agora = () => new Date().toISOString();
    const minutosAtras = (m) => new Date(Date.now() - m * 60000).toISOString();

    const CARDAPIO = [
        ['Entradas', 'cozinha', 1, [
            ['Bolinho de bacalhau (6un)', 3890, 15], ['Pastel de carne (6un)', 3200, 12],
            ['Bruschetta de tomate', 2800, 8],
        ]],
        ['Pratos principais', 'cozinha', 2, [
            ['Picanha na chapa (2 pessoas)', 12900, 35, 'chapa'], ['File a parmegiana', 7450, 30],
            ['Risoto de camarao', 8900, 25], ['Moqueca de peixe', 9800, 30],
            ['Feijoada individual', 6900, 20],
        ]],
        ['Guarnicoes', 'cozinha', 3, [
            ['Batata frita', 2900, 12], ['Arroz branco', 1400, 5], ['Farofa da casa', 1600, 5],
        ]],
        ['Bebidas', 'bar', 4, [
            ['Agua mineral 500ml', 700, 0], ['Refrigerante lata', 900, 0],
            ['Suco natural 400ml', 1600, 5], ['Cerveja long neck', 1400, 0], ['Caipirinha', 2400, 6],
        ]],
        ['Sobremesas', 'sobremesa', 5, [
            ['Pudim de leite', 1900, 3], ['Petit gateau', 2600, 12, 'cozinha'], ['Taca de sorvete', 1700, 3],
        ]],
    ];

    const USUARIOS = [
        ['garcom', 'Rita, salao', 'garcom'],
        ['cozinha', 'Praca da cozinha', 'cozinha'],
        ['caixa', 'Jorge, caixa', 'caixa'],
        ['gerente', 'Gerente do restaurante', 'gerente'],
    ];

    function semear() {
        bd = {
            usuarios: [], categorias: [], produtos: [], mesas: [],
            comandas: [], pedidos: [], itens: [], pagamentos: [], auditoria: [],
        };

        for (const [login, nome, papel] of USUARIOS) {
            bd.usuarios.push({ id: proximoId('usuarios'), login, nome, papel, senha: 'demo', ativo: true, ultimo_acesso: null });
        }
        for (const [nome, setor, ordem, produtos] of CARDAPIO) {
            const categoria = { id: proximoId('categorias'), nome, setor, ordem, ativa: true };
            bd.categorias.push(categoria);
            for (const [pnome, preco, tempo, psetor] of produtos) {
                bd.produtos.push({
                    id: proximoId('produtos'), categoria_id: categoria.id, nome: pnome, descricao: null,
                    preco_centavos: preco, tempo_preparo_minutos: tempo, setor: psetor || null,
                    disponivel: true, ativo: true,
                });
            }
        }
        for (let numero = 1; numero <= 12; numero += 1) {
            bd.mesas.push({ id: proximoId('mesas'), numero: String(numero), capacidade: numero > 8 ? 6 : 4, ativa: true });
        }
        semearMovimento();
    }

    // Um salao vazio nao mostra nada. A demo abre com servico em andamento:
    // mesa com item na chapa, item pronto esperando o garcom e uma conta pronta
    // para o caixa fechar.
    function semearMovimento() {
        const produto = (nome) => bd.produtos.find((p) => p.nome.startsWith(nome));
        const rita = bd.usuarios.find((u) => u.papel === 'garcom');

        const montar = (numeroMesa, pessoas, minutos, linhas, status = 'aberta') => {
            const mesa = bd.mesas.find((m) => m.numero === numeroMesa);
            const comanda = {
                id: proximoId('comandas'),
                codigo: `CMD-${String(proximoId('codigo')).padStart(5, '0')}`,
                mesa_id: mesa.id, status, pessoas, taxa_servico: true,
                desconto_centavos: 0, desconto_motivo: null, desconto_por: null,
                aberta_por: rita.id, fechada_por: null,
                aberta_em: minutosAtras(minutos), conta_pedida_em: status === 'conta_pedida' ? minutosAtras(2) : null,
                fechada_em: null,
            };
            bd.comandas.push(comanda);
            const pedido = { id: proximoId('pedidos'), comanda_id: comanda.id, idempotency_key: `semente-${comanda.id}`, usuario_id: rita.id, criado_em: minutosAtras(minutos) };
            bd.pedidos.push(pedido);

            for (const [nome, quantidade, estado, idade, observacao] of linhas) {
                const p = produto(nome);
                const categoria = bd.categorias.find((c) => c.id === p.categoria_id);
                bd.itens.push({
                    id: proximoId('itens'), pedido_id: pedido.id, comanda_id: comanda.id, produto_id: p.id,
                    produto_nome: p.nome, preco_unit_centavos: p.preco_centavos, quantidade,
                    observacao: observacao || null, setor: p.setor || categoria.setor, status: estado,
                    criado_em: minutosAtras(idade),
                    iniciado_em: ['preparando', 'pronto', 'entregue'].includes(estado) ? minutosAtras(idade - 1) : null,
                    pronto_em: ['pronto', 'entregue'].includes(estado) ? minutosAtras(1) : null,
                    entregue_em: estado === 'entregue' ? minutosAtras(1) : null,
                    cancelado_em: null, cancelado_por: null, motivo_cancelamento: null,
                });
            }
            return comanda;
        };

        // A batata entra atrasada de proposito: 19 min parada contra 12 de
        // preparo. E o caso que o destaque vermelho do KDS existe para pegar.
        montar('3', 4, 22, [
            ['Picanha', 1, 'preparando', 14, 'ao ponto, sem sal'],
            ['Batata', 2, 'pendente', 19],
            ['Cerveja', 4, 'entregue', 21],
            ['Caipirinha', 2, 'pronto', 5],
        ]);
        montar('7', 2, 48, [
            ['Moqueca', 1, 'entregue', 47],
            ['Arroz', 1, 'entregue', 47],
            ['Suco', 2, 'entregue', 46],
            ['Pudim', 2, 'entregue', 9],
        ], 'conta_pedida');
        montar('11', 6, 9, [
            ['Bolinho', 2, 'pendente', 4],
            ['Refrigerante', 3, 'pronto', 8],
        ]);
    }

    // ---------------------------------------------------------------- eventos

    const ouvintes = new Set();

    function publicar(evento, dados) {
        for (const ouvinte of Array.from(ouvintes)) ouvinte(evento, dados);
    }

    function auditar(acao, entidade, entidadeId, detalhe) {
        bd.auditoria.push({
            id: proximoId('auditoria'), usuario_id: sessao ? sessao.id : null,
            acao, entidade, entidade_id: entidadeId || null, detalhe: detalhe || null, criado_em: agora(),
        });
    }

    // --------------------------------------------------------------- helpers

    class ErroRegra extends Error {
        constructor(status, mensagem) {
            super(mensagem);
            this.status = status;
        }
    }

    function dinheiro(centavos) {
        return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function exigirSessao(...papeis) {
        if (!sessao) throw new ErroRegra(401, 'Sessao expirada. Entre novamente.');
        if (papeis.length && sessao.papel !== 'gerente' && !papeis.includes(sessao.papel)) {
            throw new ErroRegra(403, `Acao permitida para: ${papeis.join(', ')}.`);
        }
        return sessao;
    }

    function textoObrigatorio(valor, campo, maximo = 200) {
        const texto = String(valor == null ? '' : valor).trim();
        if (!texto) throw new ErroRegra(400, `Campo "${campo}" e obrigatorio.`);
        return texto.slice(0, maximo);
    }

    function textoOpcional(valor, maximo = 200) {
        const texto = String(valor == null ? '' : valor).trim();
        return texto ? texto.slice(0, maximo) : null;
    }

    function inteiro(valor, campo, { minimo = 0, maximo = 100000000 } = {}) {
        const numero = Number(valor);
        if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
            throw new ErroRegra(400, `Campo "${campo}" deve ser inteiro entre ${minimo} e ${maximo}.`);
        }
        return numero;
    }

    const setorDoProduto = (produto) =>
        produto.setor || bd.categorias.find((c) => c.id === produto.categoria_id).setor;

    const acharComanda = (id) => {
        const comanda = bd.comandas.find((c) => c.id === Number(id));
        if (!comanda) throw new ErroRegra(404, 'Comanda nao encontrada.');
        return comanda;
    };

    const itensDa = (comandaId) => bd.itens.filter((i) => i.comanda_id === comandaId);
    const pagamentosDa = (comandaId) => bd.pagamentos.filter((p) => p.comanda_id === comandaId);
    const nomeDe = (usuarioId) => (bd.usuarios.find((u) => u.id === usuarioId) || {}).nome || null;
    const numeroDaMesa = (mesaId) => (bd.mesas.find((m) => m.id === mesaId) || {}).numero || null;

    // Fonte unica de verdade do dinheiro, igual a `calcularTotais` do servidor.
    function calcularTotais(comanda, itens, pagamentos) {
        const cobraveis = itens.filter((item) => item.status !== 'cancelado');
        const subtotalCentavos = cobraveis.reduce((soma, i) => soma + i.quantidade * i.preco_unit_centavos, 0);
        const taxaCentavos = comanda.taxa_servico ? Math.round((subtotalCentavos * TAXA_SERVICO_PERCENTUAL) / 100) : 0;
        const descontoCentavos = Math.min(comanda.desconto_centavos || 0, subtotalCentavos + taxaCentavos);
        const totalCentavos = subtotalCentavos + taxaCentavos - descontoCentavos;
        const pagoCentavos = pagamentos.reduce((soma, p) => soma + p.valor_centavos, 0);
        return {
            subtotalCentavos, taxaCentavos, percentualTaxa: TAXA_SERVICO_PERCENTUAL, descontoCentavos,
            totalCentavos, pagoCentavos, saldoCentavos: totalCentavos - pagoCentavos,
            porPessoaCentavos: comanda.pessoas > 0 ? Math.ceil(totalCentavos / comanda.pessoas) : totalCentavos,
        };
    }

    function montarComanda(comandaId) {
        const comanda = acharComanda(comandaId);
        const itens = itensDa(comanda.id).slice().sort((a, b) => a.id - b.id);
        const pagamentos = pagamentosDa(comanda.id);
        return {
            comanda: { ...comanda, mesa_numero: numeroDaMesa(comanda.mesa_id), garcom_nome: nomeDe(comanda.aberta_por) },
            itens: itens.map((i) => ({ ...i, cancelado_por_nome: nomeDe(i.cancelado_por) })),
            pagamentos: pagamentos.map((p) => ({ ...p, usuario_nome: nomeDe(p.usuario_id) })),
            totais: calcularTotais(comanda, itens, pagamentos),
        };
    }

    // ----------------------------------------------------------------- rotas

    const rotas = [];
    const rota = (metodo, padrao, handler) => rotas.push({ metodo, padrao, handler });

    rota('POST', /^\/login$/, (_, corpo) => {
        const login = textoObrigatorio(corpo.login, 'login', 80).toLowerCase();
        const senha = textoObrigatorio(corpo.senha, 'senha', 200);
        const usuario = bd.usuarios.find((u) => u.login === login);
        if (!usuario || !usuario.ativo || usuario.senha !== senha) {
            auditar('login_negado', 'usuario', usuario ? usuario.id : null, { login });
            throw new ErroRegra(401, 'Login ou senha invalidos.');
        }
        usuario.ultimo_acesso = agora();
        sessao = usuario;
        auditar('login', 'usuario', usuario.id);
        return { id: usuario.id, login: usuario.login, nome: usuario.nome, papel: usuario.papel };
    });

    rota('POST', /^\/logout$/, () => {
        sessao = null;
        return { ok: true };
    });

    rota('GET', /^\/me$/, () => {
        const usuario = exigirSessao();
        return {
            id: usuario.id, login: usuario.login, nome: usuario.nome, papel: usuario.papel,
            percentualTaxa: TAXA_SERVICO_PERCENTUAL,
        };
    });

    rota('GET', /^\/cardapio/, (_, __, busca) => {
        exigirSessao();
        const incluirIndisponiveis = busca.get('incluirIndisponiveis') === '1';
        return {
            categorias: bd.categorias
                .filter((c) => c.ativa)
                .sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome))
                .map((categoria) => ({
                    id: categoria.id, nome: categoria.nome, setor: categoria.setor,
                    produtos: bd.produtos
                        .filter((p) => p.categoria_id === categoria.id && p.ativo && (incluirIndisponiveis || p.disponivel))
                        .sort((a, b) => a.nome.localeCompare(b.nome))
                        .map((p) => ({
                            id: p.id, nome: p.nome, descricao: p.descricao, precoCentavos: p.preco_centavos,
                            tempoPreparoMinutos: p.tempo_preparo_minutos, disponivel: p.disponivel,
                            setor: setorDoProduto(p),
                        })),
                })),
        };
    });

    rota('POST', /^\/produtos$/, (_, corpo) => {
        exigirSessao('gerente');
        const categoriaId = inteiro(corpo.categoriaId, 'categoriaId', { minimo: 1 });
        const nome = textoObrigatorio(corpo.nome, 'nome', 120);
        const precoCentavos = inteiro(corpo.precoCentavos, 'preco', { minimo: 0 });
        if (bd.produtos.some((p) => p.ativo && p.categoria_id === categoriaId && p.nome.toLowerCase() === nome.toLowerCase())) {
            throw new ErroRegra(409, `"${nome}" ja existe nessa categoria.`);
        }
        const produto = {
            id: proximoId('produtos'), categoria_id: categoriaId, nome, descricao: textoOpcional(corpo.descricao, 400),
            preco_centavos: precoCentavos, tempo_preparo_minutos: inteiro(corpo.tempoPreparoMinutos ?? 0, 'tempoPreparoMinutos', { maximo: 240 }),
            setor: null, disponivel: true, ativo: true,
        };
        bd.produtos.push(produto);
        auditar('produto_criado', 'produto', produto.id, { nome, precoCentavos });
        publicar('cardapio.alterado', { produtoId: produto.id });
        return { id: produto.id, nome: produto.nome, preco_centavos: produto.preco_centavos };
    });

    rota('PATCH', /^\/produtos\/(\d+)$/, (params, corpo) => {
        exigirSessao('gerente');
        const produto = bd.produtos.find((p) => p.id === Number(params[1]));
        if (!produto) throw new ErroRegra(404, 'Produto nao encontrado.');
        if (corpo.nome !== undefined) produto.nome = textoObrigatorio(corpo.nome, 'nome', 120);
        if (corpo.precoCentavos !== undefined) produto.preco_centavos = inteiro(corpo.precoCentavos, 'preco', { minimo: 0 });
        if (corpo.tempoPreparoMinutos !== undefined) produto.tempo_preparo_minutos = inteiro(corpo.tempoPreparoMinutos, 'tempoPreparoMinutos', { maximo: 240 });
        if (corpo.ativo !== undefined) produto.ativo = Boolean(corpo.ativo);
        auditar('produto_alterado', 'produto', produto.id, corpo);
        // O item ja lancado guarda o proprio preco: conta aberta nao se mexe.
        publicar('cardapio.alterado', { produtoId: produto.id });
        return { id: produto.id, nome: produto.nome, preco_centavos: produto.preco_centavos, ativo: produto.ativo };
    });

    rota('PATCH', /^\/produtos\/(\d+)\/disponibilidade$/, (params, corpo) => {
        exigirSessao('cozinha', 'caixa');
        const produto = bd.produtos.find((p) => p.id === Number(params[1]) && p.ativo);
        if (!produto) throw new ErroRegra(404, 'Produto nao encontrado.');
        produto.disponivel = Boolean(corpo.disponivel);
        auditar(produto.disponivel ? 'produto_reabastecido' : 'produto_esgotado', 'produto', produto.id, { nome: produto.nome });
        publicar('produto.disponibilidade', { id: produto.id, nome: produto.nome, disponivel: produto.disponivel });
        return { id: produto.id, nome: produto.nome, disponivel: produto.disponivel };
    });

    rota('GET', /^\/mesas$/, () => {
        exigirSessao();
        const mesas = bd.mesas
            .filter((m) => m.ativa)
            .sort((a, b) => a.numero.length - b.numero.length || a.numero.localeCompare(b.numero))
            .map((mesa) => {
                const comanda = bd.comandas.find((c) => c.mesa_id === mesa.id && ['aberta', 'conta_pedida'].includes(c.status));
                if (!comanda) {
                    return { id: mesa.id, numero: mesa.numero, capacidade: mesa.capacidade, status: 'livre', comanda: null };
                }
                const itens = itensDa(comanda.id);
                const subtotal = itens.filter((i) => i.status !== 'cancelado')
                    .reduce((soma, i) => soma + i.quantidade * i.preco_unit_centavos, 0);
                const taxa = comanda.taxa_servico ? Math.round((subtotal * TAXA_SERVICO_PERCENTUAL) / 100) : 0;
                return {
                    id: mesa.id, numero: mesa.numero, capacidade: mesa.capacidade, status: comanda.status,
                    comanda: {
                        id: comanda.id, codigo: comanda.codigo, status: comanda.status, pessoas: comanda.pessoas,
                        abertaEm: comanda.aberta_em, garcom: nomeDe(comanda.aberta_por),
                        subtotalCentavos: subtotal, totalCentavos: subtotal + taxa - (comanda.desconto_centavos || 0),
                        itensEmProducao: itens.filter((i) => ['pendente', 'preparando'].includes(i.status)).length,
                        itensProntos: itens.filter((i) => i.status === 'pronto').length,
                    },
                };
            });
        return { mesas };
    });

    rota('POST', /^\/mesas$/, (_, corpo) => {
        exigirSessao('gerente');
        const numero = textoObrigatorio(corpo.numero, 'numero', 10);
        const capacidade = inteiro(corpo.capacidade ?? 4, 'capacidade', { minimo: 1, maximo: 50 });
        const existente = bd.mesas.find((m) => m.numero === numero);
        if (existente) {
            existente.capacidade = capacidade;
            existente.ativa = true;
            return existente;
        }
        const mesa = { id: proximoId('mesas'), numero, capacidade, ativa: true };
        bd.mesas.push(mesa);
        return mesa;
    });

    rota('PATCH', /^\/mesas\/(\d+)$/, (params, corpo) => {
        exigirSessao('gerente');
        const mesa = bd.mesas.find((m) => m.id === Number(params[1]));
        if (!mesa) throw new ErroRegra(404, 'Mesa nao encontrada.');
        const ativa = Boolean(corpo.ativa);
        if (!ativa && bd.comandas.some((c) => c.mesa_id === mesa.id && ['aberta', 'conta_pedida'].includes(c.status))) {
            throw new ErroRegra(409, 'Nao da para desativar mesa com comanda aberta.');
        }
        mesa.ativa = ativa;
        return mesa;
    });

    rota('GET', /^\/comandas$/, (_, __, busca) => {
        exigirSessao();
        const status = busca.get('status') ? busca.get('status').split(',') : ['aberta', 'conta_pedida'];
        return {
            comandas: bd.comandas
                .filter((c) => status.includes(c.status))
                .sort((a, b) => new Date(b.aberta_em) - new Date(a.aberta_em))
                .map((c) => ({
                    id: c.id, codigo: c.codigo, status: c.status, pessoas: c.pessoas,
                    aberta_em: c.aberta_em, fechada_em: c.fechada_em,
                    mesa_numero: numeroDaMesa(c.mesa_id), garcom_nome: nomeDe(c.aberta_por),
                })),
        };
    });

    rota('POST', /^\/comandas$/, (_, corpo) => {
        const usuario = exigirSessao('garcom', 'caixa');
        const mesaId = inteiro(corpo.mesaId, 'mesaId', { minimo: 1 });
        const pessoas = inteiro(corpo.pessoas ?? 1, 'pessoas', { minimo: 1, maximo: 50 });
        const mesa = bd.mesas.find((m) => m.id === mesaId);
        if (!mesa) throw new ErroRegra(404, 'Mesa nao encontrada.');
        if (!mesa.ativa) throw new ErroRegra(409, 'Mesa desativada.');
        // No servidor quem garante isto e um indice unico parcial.
        if (bd.comandas.some((c) => c.mesa_id === mesaId && ['aberta', 'conta_pedida'].includes(c.status))) {
            throw new ErroRegra(409, `Mesa ${mesa.numero} ja tem comanda aberta.`);
        }
        const comanda = {
            id: proximoId('comandas'), codigo: `CMD-${String(proximoId('codigo')).padStart(5, '0')}`,
            mesa_id: mesaId, status: 'aberta', pessoas, taxa_servico: true,
            desconto_centavos: 0, desconto_motivo: null, desconto_por: null,
            aberta_por: usuario.id, fechada_por: null, aberta_em: agora(),
            conta_pedida_em: null, fechada_em: null,
        };
        bd.comandas.push(comanda);
        auditar('comanda_aberta', 'comanda', comanda.id, { mesa: mesa.numero, pessoas });
        publicar('comanda.aberta', { comandaId: comanda.id, codigo: comanda.codigo, mesa: mesa.numero });
        return { ...comanda, mesa_numero: mesa.numero };
    });

    rota('GET', /^\/comandas\/(\d+)$/, (params) => {
        exigirSessao();
        return montarComanda(Number(params[1]));
    });

    rota('POST', /^\/comandas\/(\d+)\/itens$/, (params, corpo, __, cabecalhos) => {
        const usuario = exigirSessao('garcom', 'caixa');
        const comandaId = Number(params[1]);
        const chave = textoObrigatorio(cabecalhos['idempotency-key'] || corpo.idempotencyKey, 'Idempotency-Key', 100);

        // Chave ja usada: devolve a rodada original em vez de duplicar.
        if (bd.pedidos.some((p) => p.idempotency_key === chave)) {
            return { ...montarComanda(comandaId), repetido: true };
        }

        const linhas = Array.isArray(corpo.itens) ? corpo.itens : [];
        if (!linhas.length) throw new ErroRegra(400, 'Informe ao menos um item.');

        const comanda = acharComanda(comandaId);
        if (comanda.status !== 'aberta') {
            throw new ErroRegra(409, `Comanda ${comanda.codigo} esta "${comanda.status}" e nao aceita novos itens.`);
        }

        const pedidos = linhas.map((linha) => ({
            produtoId: inteiro(linha.produtoId, 'produtoId', { minimo: 1 }),
            quantidade: inteiro(linha.quantidade ?? 1, 'quantidade', { minimo: 1, maximo: 99 }),
            observacao: textoOpcional(linha.observacao, 200),
        }));
        for (const linha of pedidos) {
            const produto = bd.produtos.find((p) => p.id === linha.produtoId && p.ativo);
            if (!produto) throw new ErroRegra(404, `Produto ${linha.produtoId} nao existe no cardapio.`);
            if (!produto.disponivel) throw new ErroRegra(409, `"${produto.nome}" esta esgotado.`);
        }

        const pedido = { id: proximoId('pedidos'), comanda_id: comandaId, idempotency_key: chave, usuario_id: usuario.id, criado_em: agora() };
        bd.pedidos.push(pedido);

        const inseridos = pedidos.map((linha) => {
            const produto = bd.produtos.find((p) => p.id === linha.produtoId);
            const item = {
                id: proximoId('itens'), pedido_id: pedido.id, comanda_id: comandaId, produto_id: produto.id,
                produto_nome: produto.nome,               // congelado
                preco_unit_centavos: produto.preco_centavos, // congelado
                quantidade: linha.quantidade, observacao: linha.observacao, setor: setorDoProduto(produto),
                status: 'pendente', criado_em: agora(), iniciado_em: null, pronto_em: null,
                entregue_em: null, cancelado_em: null, cancelado_por: null, motivo_cancelamento: null,
            };
            bd.itens.push(item);
            return item;
        });

        auditar('itens_lancados', 'comanda', comandaId, { pedidoId: pedido.id, quantidadeItens: inseridos.length });
        publicar('itens.lancados', {
            comandaId, codigo: comanda.codigo, mesa: numeroDaMesa(comanda.mesa_id),
            itens: inseridos.map((i) => ({ id: i.id, nome: i.produto_nome, quantidade: i.quantidade, setor: i.setor })),
        });
        return { ...montarComanda(comandaId), repetido: false };
    });

    rota('POST', /^\/comandas\/(\d+)\/conta$/, (params) => {
        exigirSessao('garcom', 'caixa');
        const comanda = acharComanda(Number(params[1]));
        if (comanda.status !== 'aberta') throw new ErroRegra(409, `Comanda ja esta "${comanda.status}".`);
        comanda.status = 'conta_pedida';
        comanda.conta_pedida_em = agora();
        publicar('comanda.conta_pedida', { comandaId: comanda.id, codigo: comanda.codigo });
        return montarComanda(comanda.id);
    });

    rota('POST', /^\/comandas\/(\d+)\/reabrir$/, (params) => {
        exigirSessao('garcom', 'caixa');
        const comanda = acharComanda(Number(params[1]));
        if (comanda.status !== 'conta_pedida') {
            throw new ErroRegra(409, `So da para reabrir comanda com conta pedida (esta "${comanda.status}").`);
        }
        comanda.status = 'aberta';
        comanda.conta_pedida_em = null;
        auditar('comanda_reaberta', 'comanda', comanda.id);
        publicar('comanda.reaberta', { comandaId: comanda.id });
        return montarComanda(comanda.id);
    });

    rota('PATCH', /^\/comandas\/(\d+)$/, (params, corpo) => {
        const usuario = exigirSessao('caixa');
        const comanda = acharComanda(Number(params[1]));
        if (['fechada', 'cancelada'].includes(comanda.status)) throw new ErroRegra(409, 'Comanda ja encerrada.');

        if (corpo.taxaServico !== undefined) {
            comanda.taxa_servico = Boolean(corpo.taxaServico);
            auditar(comanda.taxa_servico ? 'taxa_aplicada' : 'taxa_removida', 'comanda', comanda.id);
        }
        if (corpo.pessoas !== undefined) {
            comanda.pessoas = inteiro(corpo.pessoas, 'pessoas', { minimo: 1, maximo: 50 });
        }
        if (corpo.descontoCentavos !== undefined) {
            const desconto = inteiro(corpo.descontoCentavos, 'descontoCentavos');
            if (desconto > 0 && usuario.papel !== 'gerente') {
                throw new ErroRegra(403, 'Desconto exige autorizacao do gerente.');
            }
            const motivo = desconto > 0 ? textoObrigatorio(corpo.descontoMotivo, 'descontoMotivo', 200) : null;
            comanda.desconto_centavos = desconto;
            comanda.desconto_motivo = motivo;
            comanda.desconto_por = desconto > 0 ? usuario.id : null;
            auditar('desconto_aplicado', 'comanda', comanda.id, { descontoCentavos: desconto, motivo });
        }
        return montarComanda(comanda.id);
    });

    rota('POST', /^\/itens\/(\d+)\/status$/, (params, corpo) => {
        const usuario = exigirSessao();
        const novoStatus = textoObrigatorio(corpo.status, 'status', 20);
        if (novoStatus === 'cancelado') throw new ErroRegra(400, 'Use a rota de cancelamento, que exige motivo.');

        const item = bd.itens.find((i) => i.id === Number(params[1]));
        if (!item) throw new ErroRegra(404, 'Item nao encontrado.');
        if (!(TRANSICOES_ITEM[item.status] || []).includes(novoStatus)) {
            throw new ErroRegra(409, `Item "${item.produto_nome}" esta "${item.status}" e nao pode ir para "${novoStatus}".`);
        }
        const papeis = PAPEIS_POR_STATUS[novoStatus] || [];
        if (usuario.papel !== 'gerente' && !papeis.includes(usuario.papel)) {
            throw new ErroRegra(403, `Marcar "${novoStatus}" e funcao de: ${papeis.join(', ')}.`);
        }

        item.status = novoStatus;
        item[{ preparando: 'iniciado_em', pronto: 'pronto_em', entregue: 'entregue_em' }[novoStatus]] = agora();
        publicar('item.status', {
            itemId: item.id, comandaId: item.comanda_id, nome: item.produto_nome,
            status: item.status, setor: item.setor,
        });
        return item;
    });

    rota('POST', /^\/itens\/(\d+)\/cancelar$/, (params, corpo) => {
        const usuario = exigirSessao();
        const motivo = textoObrigatorio(corpo.motivo, 'motivo', 200);
        if (motivo.length < 3) throw new ErroRegra(400, 'Descreva o motivo do cancelamento.');

        const item = bd.itens.find((i) => i.id === Number(params[1]));
        if (!item) throw new ErroRegra(404, 'Item nao encontrado.');
        if (!TRANSICOES_ITEM[item.status].includes('cancelado')) {
            throw new ErroRegra(409, `Item "${item.produto_nome}" esta "${item.status}" e nao pode mais ser cancelado.`);
        }
        // Producao encostou no item: ha insumo gasto, virou perda de gerente.
        if (item.status === 'preparando' && usuario.papel !== 'gerente') {
            throw new ErroRegra(403, 'Item ja em preparo. Cancelamento exige autorizacao do gerente.');
        }
        const comanda = acharComanda(item.comanda_id);
        if (['fechada', 'cancelada'].includes(comanda.status)) throw new ErroRegra(409, 'Comanda ja encerrada.');

        const statusAnterior = item.status;
        item.status = 'cancelado';
        item.cancelado_em = agora();
        item.cancelado_por = usuario.id;
        item.motivo_cancelamento = motivo;
        auditar('item_cancelado', 'item', item.id, {
            produto: item.produto_nome, statusAnterior,
            valorCentavos: item.quantidade * item.preco_unit_centavos, motivo,
        });
        publicar('item.status', {
            itemId: item.id, comandaId: item.comanda_id, nome: item.produto_nome,
            status: 'cancelado', setor: item.setor,
        });
        return item;
    });

    rota('GET', /^\/producao/, (_, __, busca) => {
        exigirSessao();
        const setor = busca.get('setor') || null;
        if (setor && !SETORES.includes(setor)) throw new ErroRegra(400, 'Setor invalido.');
        const itens = bd.itens
            .filter((i) => ['pendente', 'preparando', 'pronto'].includes(i.status) && (!setor || i.setor === setor))
            .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em) || a.id - b.id)
            .map((item) => {
                const comanda = bd.comandas.find((c) => c.id === item.comanda_id);
                const produto = bd.produtos.find((p) => p.id === item.produto_id);
                return {
                    id: item.id, produto_nome: item.produto_nome, quantidade: item.quantidade,
                    observacao: item.observacao, setor: item.setor, status: item.status,
                    criado_em: item.criado_em, iniciado_em: item.iniciado_em,
                    espera_segundos: Math.floor((Date.now() - new Date(item.criado_em)) / 1000),
                    tempo_preparo_minutos: produto ? produto.tempo_preparo_minutos : 0,
                    comanda_id: comanda.id, comanda_codigo: comanda.codigo,
                    mesa_numero: numeroDaMesa(comanda.mesa_id),
                };
            });
        return { itens, setores: SETORES };
    });

    rota('POST', /^\/comandas\/(\d+)\/pagamentos$/, (params, corpo) => {
        const usuario = exigirSessao('caixa');
        const comandaId = Number(params[1]);
        const comanda = acharComanda(comandaId);
        if (['fechada', 'cancelada'].includes(comanda.status)) throw new ErroRegra(409, 'Comanda ja encerrada.');

        const forma = textoObrigatorio(corpo.forma, 'forma', 20);
        if (!FORMAS_PAGAMENTO.includes(forma)) {
            throw new ErroRegra(400, `Forma deve ser uma de: ${FORMAS_PAGAMENTO.join(', ')}.`);
        }
        const totais = calcularTotais(comanda, itensDa(comandaId), pagamentosDa(comandaId));
        if (totais.saldoCentavos <= 0) throw new ErroRegra(409, 'Conta ja esta quitada.');

        const valorCentavos = corpo.valorCentavos !== undefined
            ? inteiro(corpo.valorCentavos, 'valorCentavos', { minimo: 1 })
            : totais.saldoCentavos;
        if (valorCentavos > totais.saldoCentavos) {
            throw new ErroRegra(400, `Valor acima do saldo de ${dinheiro(totais.saldoCentavos)}.`);
        }

        let recebidoCentavos = null;
        let trocoCentavos = 0;
        if (forma === 'dinheiro' && corpo.recebidoCentavos !== undefined) {
            recebidoCentavos = inteiro(corpo.recebidoCentavos, 'recebidoCentavos', { minimo: 1 });
            if (recebidoCentavos < valorCentavos) {
                throw new ErroRegra(400, `Recebido ${dinheiro(recebidoCentavos)} e menor que ${dinheiro(valorCentavos)}.`);
            }
            trocoCentavos = recebidoCentavos - valorCentavos;
        }

        const pagamento = {
            id: proximoId('pagamentos'), comanda_id: comandaId, forma, valor_centavos: valorCentavos,
            recebido_centavos: recebidoCentavos, troco_centavos: trocoCentavos,
            usuario_id: usuario.id, criado_em: agora(),
        };
        bd.pagamentos.push(pagamento);
        auditar('pagamento_registrado', 'comanda', comandaId, { forma, valorCentavos, trocoCentavos });
        return { pagamento, ...montarComanda(comandaId) };
    });

    rota('DELETE', /^\/comandas\/(\d+)\/pagamentos\/(\d+)$/, (params) => {
        exigirSessao('caixa');
        const comandaId = Number(params[1]);
        const comanda = acharComanda(comandaId);
        if (comanda.status === 'fechada') {
            throw new ErroRegra(409, 'Comanda fechada. Estorno exige reabertura pelo gerente.');
        }
        const indice = bd.pagamentos.findIndex((p) => p.id === Number(params[2]) && p.comanda_id === comandaId);
        if (indice < 0) throw new ErroRegra(404, 'Pagamento nao encontrado nesta comanda.');
        const [removido] = bd.pagamentos.splice(indice, 1);
        auditar('pagamento_estornado', 'comanda', comandaId, { forma: removido.forma, valorCentavos: removido.valor_centavos });
        return montarComanda(comandaId);
    });

    rota('POST', /^\/comandas\/(\d+)\/fechar$/, (params) => {
        exigirSessao('caixa');
        const comandaId = Number(params[1]);
        const comanda = acharComanda(comandaId);
        if (comanda.status === 'fechada') throw new ErroRegra(409, 'Comanda ja fechada.');
        if (comanda.status === 'cancelada') throw new ErroRegra(409, 'Comanda cancelada.');

        const itens = itensDa(comandaId);
        const emAndamento = itens.filter((i) => ['pendente', 'preparando', 'pronto'].includes(i.status));
        if (emAndamento.length) {
            throw new ErroRegra(409, `Ha ${emAndamento.length} item(ns) sem entrega: ${emAndamento.map((i) => i.produto_nome).join(', ')}. Entregue ou cancele antes de fechar.`);
        }
        const totais = calcularTotais(comanda, itens, pagamentosDa(comandaId));
        if (totais.saldoCentavos > 0) {
            throw new ErroRegra(409, `Faltam ${dinheiro(totais.saldoCentavos)} para quitar a conta.`);
        }

        comanda.status = 'fechada';
        comanda.fechada_em = agora();
        comanda.fechada_por = sessao.id;
        auditar('comanda_fechada', 'comanda', comandaId, totais);
        publicar('comanda.fechada', { comandaId, codigo: comanda.codigo, totalCentavos: totais.totalCentavos });
        return montarComanda(comandaId);
    });

    rota('GET', /^\/usuarios$/, () => {
        exigirSessao('gerente');
        return {
            usuarios: bd.usuarios
                .slice()
                .sort((a, b) => a.nome.localeCompare(b.nome))
                .map((u) => ({ id: u.id, login: u.login, nome: u.nome, papel: u.papel, ativo: u.ativo, ultimo_acesso: u.ultimo_acesso })),
        };
    });

    rota('POST', /^\/usuarios$/, (_, corpo) => {
        exigirSessao('gerente');
        const login = textoObrigatorio(corpo.login, 'login', 80).toLowerCase();
        const nome = textoObrigatorio(corpo.nome, 'nome', 120);
        const papel = textoObrigatorio(corpo.papel, 'papel', 20);
        const senha = textoObrigatorio(corpo.senha, 'senha', 200);
        if (!['garcom', 'cozinha', 'caixa', 'gerente'].includes(papel)) throw new ErroRegra(400, 'Papel invalido.');
        if (senha.length < 6) throw new ErroRegra(400, 'Senha precisa de ao menos 6 caracteres.');
        if (bd.usuarios.some((u) => u.login === login)) throw new ErroRegra(409, `Login "${login}" ja existe.`);
        const usuario = { id: proximoId('usuarios'), login, nome, papel, senha, ativo: true, ultimo_acesso: null };
        bd.usuarios.push(usuario);
        auditar('usuario_criado', 'usuario', usuario.id, { login, papel });
        return { id: usuario.id, login, nome, papel, ativo: true };
    });

    rota('PATCH', /^\/usuarios\/(\d+)$/, (params, corpo) => {
        exigirSessao('gerente');
        const usuario = bd.usuarios.find((u) => u.id === Number(params[1]));
        if (!usuario) throw new ErroRegra(404, 'Usuario nao encontrado.');
        if (corpo.nome !== undefined) usuario.nome = textoObrigatorio(corpo.nome, 'nome', 120);
        if (corpo.ativo !== undefined) usuario.ativo = Boolean(corpo.ativo);
        if (corpo.senha !== undefined) {
            const senha = textoObrigatorio(corpo.senha, 'senha', 200);
            if (senha.length < 6) throw new ErroRegra(400, 'Senha precisa de ao menos 6 caracteres.');
            usuario.senha = senha;
            if (sessao && sessao.id === usuario.id) sessao = null; // derruba a sessao, como no servidor
        }
        auditar('usuario_alterado', 'usuario', usuario.id);
        return { id: usuario.id, login: usuario.login, nome: usuario.nome, papel: usuario.papel, ativo: usuario.ativo };
    });

    // ------------------------------------------------------- fronteira falsa

    function despachar(metodo, caminho, busca, corpo, cabecalhos) {
        for (const definicao of rotas) {
            if (definicao.metodo !== metodo) continue;
            const casou = definicao.padrao.exec(caminho);
            if (!casou) continue;
            return { status: metodo === 'POST' && /\/(comandas|produtos|usuarios|mesas|pagamentos)$/.test(caminho) ? 201 : 200,
                dados: definicao.handler(casou, corpo || {}, busca, cabecalhos) };
        }
        throw new ErroRegra(404, `Rota nao encontrada: ${metodo} ${caminho}`);
    }

    const fetchOriginal = window.fetch.bind(window);

    window.fetch = async (recurso, opcoes = {}) => {
        const url = String(recurso && recurso.url ? recurso.url : recurso);
        if (!url.includes('/api/restaurante')) return fetchOriginal(recurso, opcoes);

        // Base fixa de propósito: aberto por `file://` (dois cliques, sem
        // servidor) `window.location.origin` é a string "null" e `new URL`
        // lança. Só interessam `pathname` e `searchParams`, então qualquer
        // base válida serve — e uma URL absoluta ignora a base de qualquer jeito.
        const endereco = new URL(url, 'http://demo.local');
        const caminho = endereco.pathname.replace(/^.*\/api\/restaurante/, '');
        const cabecalhos = {};
        for (const [chave, valor] of Object.entries(opcoes.headers || {})) {
            cabecalhos[chave.toLowerCase()] = valor;
        }

        let resposta;
        try {
            const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
            resposta = despachar(opcoes.method || 'GET', caminho, endereco.searchParams, corpo, cabecalhos);
        } catch (erro) {
            resposta = {
                status: erro instanceof ErroRegra ? erro.status : 500,
                dados: { erro: erro.message },
            };
        }

        // Latencia curta: sem ela a tela pisca sem mostrar o estado de carga.
        await new Promise((r) => setTimeout(r, 60));
        return {
            ok: resposta.status < 400,
            status: resposta.status,
            json: async () => resposta.dados,
        };
    };

    // EventSource falso: mesma superficie que a tela usa (addEventListener /
    // close), alimentado pelo barramento local em vez de um stream HTTP.
    window.EventSource = class {
        constructor() {
            this.ouvintesPorEvento = new Map();
            this.ouvinte = (evento, dados) => this.despachar(evento, dados);
            ouvintes.add(this.ouvinte);
            setTimeout(() => {
                this.despachar('open', null);
                this.despachar('conectado', { demo: true });
            }, 0);
        }

        addEventListener(evento, handler) {
            if (!this.ouvintesPorEvento.has(evento)) this.ouvintesPorEvento.set(evento, []);
            this.ouvintesPorEvento.get(evento).push(handler);
        }

        despachar(evento, dados) {
            for (const handler of this.ouvintesPorEvento.get(evento) || []) {
                handler({ data: JSON.stringify(dados) });
            }
        }

        close() {
            ouvintes.delete(this.ouvinte);
        }
    };

    semear();
    window.__demoRestaurante = {
        reiniciar() {
            sessao = null;
            ouvintes.clear();
            semear();
            window.location.reload();
        },
    };
})();

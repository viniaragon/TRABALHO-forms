/* Front do modulo de pedidos. HTML/CSS/JS puro, no mesmo padrao das outras
   telas do projeto. Uma unica pagina que troca de view conforme o papel do
   usuario logado. Todo texto vindo do banco entra por textContent — nome de
   produto e observacao de garcom sao digitados por gente e nao podem virar
   HTML. */

(() => {
    'use strict';

    const estado = {
        usuario: null,
        view: 'salao',
        abaAtiva: 'salao',
        mesas: [],
        cardapio: [],
        comanda: null,
        producao: [],
        setorFiltro: '',
        carrinho: new Map(),
        chaveLancamento: null,
        comandasCaixa: [],
        contaSelecionada: null,
        abaAdmin: 'cardapio',
        usuarios: [],
        fonte: null,
    };

    const ABAS = [
        { id: 'salao', rotulo: 'Salão', papeis: ['garcom', 'caixa', 'gerente'] },
        { id: 'cozinha', rotulo: 'Produção', papeis: ['cozinha', 'gerente'] },
        { id: 'caixa', rotulo: 'Caixa', papeis: ['caixa', 'gerente'] },
        { id: 'admin', rotulo: 'Admin', papeis: ['gerente'] },
    ];

    // Cada posto abre direto no que ele usa: a cozinha nao quer o mapa de
    // mesas, o caixa nao quer a fila da producao.
    const ABA_INICIAL = { garcom: 'salao', cozinha: 'cozinha', caixa: 'caixa', gerente: 'salao' };

    const ROTULO_STATUS = {
        pendente: 'na fila',
        preparando: 'preparando',
        pronto: 'pronto',
        entregue: 'entregue',
        cancelado: 'cancelado',
    };

    // ----------------------------------------------------------- utilitarios

    const $ = (seletor) => document.querySelector(seletor);

    function el(tag, props = {}, filhos = []) {
        const no = document.createElement(tag);
        for (const [chave, valor] of Object.entries(props)) {
            if (valor === null || valor === undefined || valor === false) continue;
            if (chave === 'texto') no.textContent = valor;
            else if (chave === 'classe') no.className = valor;
            else if (chave === 'ao') {
                for (const [evento, fn] of Object.entries(valor)) no.addEventListener(evento, fn);
            } else no.setAttribute(chave, valor === true ? '' : String(valor));
        }
        for (const filho of [].concat(filhos)) if (filho) no.append(filho);
        return no;
    }

    function limpar(no) {
        while (no.firstChild) no.removeChild(no.firstChild);
        return no;
    }

    function dinheiro(centavos) {
        return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    // Aceita "38,90", "38.90" e "R$ 38,90".
    function paraCentavos(texto) {
        const limpo = String(texto ?? '').replace(/\s|R\$/g, '').replace(/\./g, '').replace(',', '.');
        const numero = Number(limpo);
        return Number.isFinite(numero) ? Math.round(numero * 100) : NaN;
    }

    function hora(iso) {
        return iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    }

    function cronometro(segundos) {
        const total = Math.max(0, Math.floor(segundos));
        const minutos = Math.floor(total / 60);
        return `${String(minutos).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    // `crypto.randomUUID` so existe em contexto seguro. Um restaurante roda o
    // sistema em rede local por http, onde ele e `undefined` — dai o fallback.
    function novaChave() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function aviso(texto, tipo = '') {
        const caixa = el('div', { classe: `aviso ${tipo}`.trim(), texto });
        $('#avisos').append(caixa);
        setTimeout(() => caixa.remove(), tipo === 'erro' ? 6000 : 3500);
    }

    async function api(caminho, { metodo = 'GET', corpo, cabecalhos } = {}) {
        const resposta = await fetch(`/api/restaurante${caminho}`, {
            method: metodo,
            credentials: 'same-origin',
            headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...cabecalhos },
            body: corpo ? JSON.stringify(corpo) : undefined,
        });
        const dados = await resposta.json().catch(() => ({}));
        if (resposta.status === 401 && estado.usuario) {
            mostrarLogin('Sessão expirada. Entre novamente.');
            throw new Error('Sessão expirada.');
        }
        if (!resposta.ok) throw new Error(dados.erro || `Falha na requisição (${resposta.status}).`);
        return dados;
    }

    // Envolve uma acao de botao: mostra o erro de regra de negocio como aviso
    // em vez de deixar a promessa morrer no console.
    function acao(fn) {
        return async (...args) => {
            try {
                await fn(...args);
            } catch (erro) {
                aviso(erro.message, 'erro');
            }
        };
    }

    // ------------------------------------------------------------- navegacao

    function podeVer(aba) {
        return aba.papeis.includes(estado.usuario.papel);
    }

    function renderAbas() {
        const nav = limpar($('#abas'));
        for (const aba of ABAS.filter(podeVer)) {
            const botao = el('button', {
                classe: 'aba',
                type: 'button',
                'aria-current': String(estado.abaAtiva === aba.id),
                ao: { click: () => irPara(aba.id) },
            }, [el('span', { texto: aba.rotulo })]);

            if (aba.id === 'cozinha' && estado.producao.length) {
                const emFila = estado.producao.filter((item) => item.status !== 'pronto').length;
                if (emFila) botao.append(el('span', { classe: 'selo', texto: String(emFila) }));
            }
            nav.append(botao);
        }
    }

    function mostrarView(nome) {
        estado.view = nome;
        for (const secao of document.querySelectorAll('.view')) secao.classList.remove('ativa');
        const alvo = document.getElementById(`view${nome.charAt(0).toUpperCase()}${nome.slice(1)}`);
        if (alvo) alvo.classList.add('ativa');
    }

    async function irPara(aba) {
        estado.abaAtiva = aba;
        mostrarView(aba);
        renderAbas();
        await atualizarViewAtual();
    }

    async function atualizarViewAtual() {
        try {
            if (estado.view === 'salao') await carregarMesas();
            else if (estado.view === 'comanda' && estado.comanda) await carregarComanda(estado.comanda.comanda.id);
            else if (estado.view === 'cozinha') await carregarProducao();
            else if (estado.view === 'caixa') await carregarCaixa();
            else if (estado.view === 'admin') await renderAdmin();
        } catch (erro) {
            aviso(erro.message, 'erro');
        }
    }

    let atualizacaoAgendada = null;
    // Uma rajada de eventos (rodada com 6 itens) vira uma unica releitura.
    function agendarAtualizacao() {
        clearTimeout(atualizacaoAgendada);
        atualizacaoAgendada = setTimeout(() => {
            atualizarViewAtual();
            if (estado.view !== 'cozinha') carregarProducao().catch(() => {});
        }, 180);
    }

    // ----------------------------------------------------------------- salao

    async function carregarMesas() {
        const dados = await api('/mesas');
        estado.mesas = dados.mesas;
        renderSalao();
    }

    function renderSalao() {
        const mapa = limpar($('#mapaMesas'));
        if (!estado.mesas.length) {
            mapa.append(el('p', { classe: 'vazio', texto: 'Nenhuma mesa cadastrada. Vá em Admin > Salão.' }));
            return;
        }

        for (const mesa of estado.mesas) {
            const comanda = mesa.comanda;
            const temPronto = comanda && comanda.itensProntos > 0;
            const classes = ['mesa'];
            if (comanda) classes.push(comanda.status === 'conta_pedida' ? 'conta_pedida' : 'ocupada');
            if (temPronto) classes.push('pronta');

            const cartao = el('button', {
                classe: classes.join(' '),
                type: 'button',
                ao: { click: acao(() => (comanda ? abrirComanda(comanda.id) : abrirMesa(mesa))) },
            }, [
                el('span', { classe: 'mesa-numero', texto: mesa.numero }),
                el('span', {
                    classe: 'mesa-info',
                    texto: comanda
                        ? `${comanda.pessoas} pessoa(s) · ${hora(comanda.abertaEm)} · ${comanda.garcom || '—'}`
                        : `${mesa.capacidade} lugares · livre`,
                }),
            ]);

            if (temPronto) {
                cartao.append(el('span', { classe: 'mesa-flag', texto: `${comanda.itensProntos} pronto(s)` }));
            } else if (comanda && comanda.itensEmProducao) {
                cartao.append(el('span', { classe: 'mesa-flag aguardando', texto: `${comanda.itensEmProducao} na produção` }));
            }
            if (comanda) {
                cartao.append(el('span', { classe: 'mesa-total', texto: dinheiro(comanda.totalCentavos) }));
            }
            mapa.append(cartao);
        }
    }

    async function abrirMesa(mesa) {
        const resposta = window.prompt(`Mesa ${mesa.numero} — quantas pessoas?`, String(mesa.capacidade));
        if (resposta === null) return;
        const pessoas = Number(resposta);
        if (!Number.isInteger(pessoas) || pessoas < 1) {
            aviso('Informe um número inteiro de pessoas.', 'erro');
            return;
        }
        const comanda = await api('/comandas', { metodo: 'POST', corpo: { mesaId: mesa.id, pessoas } });
        aviso(`Comanda ${comanda.codigo} aberta na mesa ${mesa.numero}.`, 'sucesso');
        await abrirComanda(comanda.id);
    }

    // --------------------------------------------------------------- comanda

    async function abrirComanda(comandaId) {
        await carregarComanda(comandaId);
        mostrarView('comanda');
    }

    async function carregarComanda(comandaId) {
        estado.comanda = await api(`/comandas/${comandaId}`);
        renderComanda();
    }

    function renderComanda() {
        const { comanda, itens, pagamentos, totais } = estado.comanda;
        const encerrada = comanda.status === 'fechada' || comanda.status === 'cancelada';

        $('#comandaTitulo').textContent = `Mesa ${comanda.mesa_numero || '—'} · ${comanda.codigo}`;
        $('#comandaSubtitulo').textContent =
            `${comanda.pessoas} pessoa(s) · aberta às ${hora(comanda.aberta_em)} por ${comanda.garcom_nome || '—'} · ${comanda.status.replace('_', ' ')}`;

        $('#abrirCardapio').disabled = comanda.status !== 'aberta';
        const botaoConta = $('#pedirConta');
        botaoConta.textContent = comanda.status === 'conta_pedida' ? 'Reabrir comanda' : 'Pedir a conta';
        botaoConta.disabled = encerrada;
        botaoConta.onclick = acao(async () => {
            const rota = comanda.status === 'conta_pedida' ? 'reabrir' : 'conta';
            estado.comanda = await api(`/comandas/${comanda.id}/${rota}`, { metodo: 'POST' });
            renderComanda();
        });

        // ---- itens agrupados por rodada de lancamento
        const painel = limpar($('#comandaItens'));
        if (!itens.length) {
            painel.append(el('p', { classe: 'vazio', texto: 'Nenhum item lançado ainda.' }));
        } else {
            const rodadas = new Map();
            for (const item of itens) {
                if (!rodadas.has(item.pedido_id)) rodadas.set(item.pedido_id, []);
                rodadas.get(item.pedido_id).push(item);
            }
            let numero = 0;
            for (const lista of rodadas.values()) {
                numero += 1;
                const bloco = el('div', { classe: 'rodada' }, [
                    el('p', { classe: 'rodada-titulo', texto: `${numero}ª rodada · ${hora(lista[0].criado_em)}` }),
                ]);
                for (const item of lista) bloco.append(linhaItem(item, encerrada));
                painel.append(bloco);
            }
        }

        // ---- resumo financeiro
        const resumo = limpar($('#comandaTotais'));
        const lista = el('dl');
        const linha = (rotulo, valor, classe) => {
            const dt = el('dt', { texto: rotulo });
            const dd = el('dd', { texto: valor });
            if (classe) { dt.classList.add(classe); dd.classList.add(classe); }
            lista.append(dt, dd);
        };
        linha('Subtotal', dinheiro(totais.subtotalCentavos));
        if (totais.taxaCentavos) linha(`Serviço ${totais.percentualTaxa}%`, dinheiro(totais.taxaCentavos));
        if (totais.descontoCentavos) linha('Desconto', `− ${dinheiro(totais.descontoCentavos)}`);
        lista.append(el('hr'));
        linha('Total', dinheiro(totais.totalCentavos), 'total');
        linha(`Por pessoa (${comanda.pessoas})`, dinheiro(totais.porPessoaCentavos));
        if (pagamentos.length) {
            linha('Pago', dinheiro(totais.pagoCentavos));
            if (totais.saldoCentavos > 0) linha('Falta', dinheiro(totais.saldoCentavos), 'saldo');
        }
        resumo.append(lista);

        if (comanda.desconto_motivo) {
            resumo.append(el('p', { classe: 'legenda', texto: `Desconto: ${comanda.desconto_motivo}` }));
        }
    }

    function linhaItem(item, encerrada) {
        const podeEntregar = item.status === 'pronto' && ['garcom', 'caixa', 'gerente'].includes(estado.usuario.papel);
        const podeCancelar = !encerrada && ['pendente', 'preparando'].includes(item.status);

        const corpo = el('div', {}, [
            el('div', { classe: 'item-nome', texto: item.produto_nome }),
        ]);
        if (item.observacao) corpo.append(el('div', { classe: 'item-obs', texto: `» ${item.observacao}` }));
        if (item.status === 'cancelado' && item.motivo_cancelamento) {
            corpo.append(el('div', { classe: 'legenda', texto: `Cancelado: ${item.motivo_cancelamento}` }));
        }

        const acoes = el('div', { classe: 'item-acoes' }, [
            el('span', { classe: `chip ${item.status}`, texto: ROTULO_STATUS[item.status] }),
        ]);
        if (podeEntregar) {
            acoes.append(el('button', {
                classe: 'btn pequeno sucesso', type: 'button', texto: 'Entregar',
                ao: { click: acao(() => mudarStatusItem(item.id, 'entregue')) },
            }));
        }
        if (podeCancelar) {
            acoes.append(el('button', {
                classe: 'btn pequeno perigo', type: 'button', texto: 'Cancelar',
                ao: { click: acao(() => cancelarItem(item)) },
            }));
        }

        return el('div', { classe: `item-linha ${item.status === 'cancelado' ? 'item-cancelado' : ''}` }, [
            el('span', { classe: 'item-qtd', texto: `${item.quantidade}×` }),
            corpo,
            el('span', {
                classe: 'item-valor',
                texto: item.status === 'cancelado' ? '—' : dinheiro(item.quantidade * item.preco_unit_centavos),
            }),
            acoes,
        ]);
    }

    async function mudarStatusItem(itemId, status) {
        await api(`/itens/${itemId}/status`, { metodo: 'POST', corpo: { status } });
        await atualizarViewAtual();
    }

    async function cancelarItem(item) {
        const motivo = window.prompt(`Cancelar "${item.produto_nome}". Motivo:`);
        if (motivo === null) return;
        await api(`/itens/${item.id}/cancelar`, { metodo: 'POST', corpo: { motivo } });
        aviso('Item cancelado e registrado na auditoria.', 'alerta');
        await atualizarViewAtual();
    }

    // ------------------------------------------------- gaveta do cardapio

    async function carregarCardapio(incluirIndisponiveis = false) {
        const dados = await api(`/cardapio${incluirIndisponiveis ? '?incluirIndisponiveis=1' : ''}`);
        estado.cardapio = dados.categorias;
        return estado.cardapio;
    }

    async function abrirGaveta() {
        await carregarCardapio(true);
        $('#buscaProduto').value = '';
        $('#gaveta').hidden = false;
        renderCardapio();
        renderCarrinho();
        $('#buscaProduto').focus();
    }

    function fecharGaveta() {
        $('#gaveta').hidden = true;
    }

    function renderCardapio() {
        const termo = $('#buscaProduto').value.trim().toLowerCase();
        const lista = limpar($('#listaCardapio'));

        for (const categoria of estado.cardapio) {
            const produtos = categoria.produtos.filter((p) => !termo || p.nome.toLowerCase().includes(termo));
            if (!produtos.length) continue;

            const grupo = el('div', { classe: 'grupo-cardapio' }, [
                el('p', { classe: 'grupo-titulo', texto: `${categoria.nome} · ${categoria.setor}` }),
            ]);
            for (const produto of produtos) {
                const detalhe = produto.disponivel
                    ? (produto.tempoPreparoMinutos ? `~${produto.tempoPreparoMinutos} min` : 'saída imediata')
                    : 'ESGOTADO';
                grupo.append(el('button', {
                    classe: 'produto', type: 'button', disabled: !produto.disponivel,
                    ao: { click: () => adicionarAoCarrinho(produto) },
                }, [
                    el('span', {}, [
                        el('div', { classe: 'produto-nome', texto: produto.nome }),
                        el('div', { classe: 'produto-meta', texto: detalhe }),
                    ]),
                    el('span', { classe: 'produto-preco', texto: dinheiro(produto.precoCentavos) }),
                ]));
            }
            lista.append(grupo);
        }
        if (!lista.childElementCount) {
            lista.append(el('p', { classe: 'vazio', texto: 'Nenhum produto encontrado.' }));
        }
    }

    function adicionarAoCarrinho(produto) {
        const atual = estado.carrinho.get(produto.id);
        if (atual) atual.quantidade += 1;
        else estado.carrinho.set(produto.id, { produto, quantidade: 1, observacao: '' });
        renderCarrinho();
    }

    function renderCarrinho() {
        const caixa = limpar($('#carrinho'));
        const linhas = [...estado.carrinho.values()];
        $('#enviarPedido').disabled = !linhas.length;

        if (!linhas.length) {
            caixa.append(el('p', { classe: 'legenda', texto: 'Toque nos produtos para montar a rodada.' }));
            return;
        }

        let total = 0;
        for (const linha of linhas) {
            total += linha.quantidade * linha.produto.precoCentavos;
            const bloco = el('div', { classe: 'carrinho-linha' }, [
                el('span', { texto: linha.produto.nome }),
                el('span', { classe: 'carrinho-controles' }, [
                    el('button', {
                        classe: 'btn', type: 'button', texto: '−', 'aria-label': 'Diminuir',
                        ao: { click: () => alterarQuantidade(linha.produto.id, -1) },
                    }),
                    el('strong', { texto: String(linha.quantidade) }),
                    el('button', {
                        classe: 'btn', type: 'button', texto: '+', 'aria-label': 'Aumentar',
                        ao: { click: () => alterarQuantidade(linha.produto.id, 1) },
                    }),
                ]),
                el('span', { texto: dinheiro(linha.quantidade * linha.produto.precoCentavos) }),
                el('span', { classe: 'carrinho-obs' }, [
                    el('input', {
                        type: 'text', placeholder: 'Observação (ex.: sem cebola, ao ponto)',
                        value: linha.observacao,
                        ao: { input: (evento) => { linha.observacao = evento.target.value; } },
                    }),
                ]),
            ]);
            caixa.append(bloco);
        }
        caixa.append(el('p', { classe: 'subtitulo', texto: `Total da rodada: ${dinheiro(total)}` }));
    }

    function alterarQuantidade(produtoId, delta) {
        const linha = estado.carrinho.get(produtoId);
        if (!linha) return;
        linha.quantidade += delta;
        if (linha.quantidade < 1) estado.carrinho.delete(produtoId);
        renderCarrinho();
    }

    async function enviarPedido() {
        if (!estado.comanda || !estado.carrinho.size) return;
        // A chave nasce uma vez por rodada e sobrevive a erro de rede: em nova
        // tentativa o servidor reconhece o reenvio e nao duplica o pedido.
        if (!estado.chaveLancamento) estado.chaveLancamento = novaChave();

        const itens = [...estado.carrinho.values()].map((linha) => ({
            produtoId: linha.produto.id,
            quantidade: linha.quantidade,
            observacao: linha.observacao || null,
        }));

        const botao = $('#enviarPedido');
        botao.disabled = true;
        try {
            const dados = await api(`/comandas/${estado.comanda.comanda.id}/itens`, {
                metodo: 'POST',
                corpo: { itens },
                cabecalhos: { 'Idempotency-Key': estado.chaveLancamento },
            });
            estado.comanda = dados;
            estado.carrinho.clear();
            estado.chaveLancamento = null;
            fecharGaveta();
            renderComanda();
            aviso(dados.repetido ? 'Rodada já registrada — nada foi duplicado.' : 'Pedido enviado para a produção.', 'sucesso');
        } finally {
            botao.disabled = false;
        }
    }

    // -------------------------------------------------------------- producao

    async function carregarProducao() {
        const dados = await api(`/producao${estado.setorFiltro ? `?setor=${estado.setorFiltro}` : ''}`);
        estado.producao = dados.itens;
        estado.setores = dados.setores;
        if (estado.view === 'cozinha') renderProducao();
        renderAbas();
    }

    function renderProducao() {
        const filtros = limpar($('#filtroSetores'));
        const opcoes = [{ id: '', rotulo: 'Todos' }, ...(estado.setores || []).map((s) => ({ id: s, rotulo: s }))];
        for (const opcao of opcoes) {
            filtros.append(el('button', {
                classe: 'aba', type: 'button', texto: opcao.rotulo,
                'aria-current': String(estado.setorFiltro === opcao.id),
                ao: {
                    click: acao(async () => {
                        estado.setorFiltro = opcao.id;
                        await carregarProducao();
                    }),
                },
            }));
        }

        const fila = limpar($('#filaProducao'));
        if (!estado.producao.length) {
            fila.append(el('p', { classe: 'vazio', texto: 'Nada na fila. Cozinha em dia.' }));
            return;
        }

        const agora = Date.now();
        for (const item of estado.producao) {
            // Normaliza pelo relogio do servidor: o cronometro nao depende de a
            // maquina da cozinha estar com a hora certa.
            const inicioMs = agora - item.espera_segundos * 1000;
            const limiteSegundos = Math.max(item.tempo_preparo_minutos, 1) * 60;
            const atrasado = item.status !== 'pronto' && item.espera_segundos > limiteSegundos;

            const ficha = el('article', { classe: `ficha ${item.status} ${atrasado ? 'atrasado' : ''}` }, [
                el('div', { classe: 'ficha-topo' }, [
                    el('span', { classe: 'ficha-mesa', texto: `Mesa ${item.mesa_numero || '—'}` }),
                    el('span', {
                        classe: 'ficha-cronometro',
                        'data-cronometro': String(inicioMs),
                        texto: cronometro(item.espera_segundos),
                    }),
                ]),
                el('div', { classe: 'ficha-produto', texto: `${item.quantidade}× ${item.produto_nome}` }),
            ]);

            if (item.observacao) ficha.append(el('div', { classe: 'ficha-obs', texto: item.observacao }));
            ficha.append(el('div', { classe: 'ficha-meta', texto: `${item.setor} · ${item.comanda_codigo} · ${ROTULO_STATUS[item.status]}` }));

            const rodape = el('div', { classe: 'ficha-rodape' });
            if (item.status === 'pendente') {
                rodape.append(el('button', {
                    classe: 'btn', type: 'button', texto: 'Iniciar',
                    ao: { click: acao(() => mudarStatusItem(item.id, 'preparando')) },
                }));
                rodape.append(el('button', {
                    classe: 'btn sucesso', type: 'button', texto: 'Pronto',
                    ao: { click: acao(() => mudarStatusItem(item.id, 'pronto')) },
                }));
            } else if (item.status === 'preparando') {
                rodape.append(el('button', {
                    classe: 'btn sucesso', type: 'button', texto: 'Pronto',
                    ao: { click: acao(() => mudarStatusItem(item.id, 'pronto')) },
                }));
            } else {
                rodape.append(el('span', { classe: 'legenda', texto: 'Aguardando o garçom retirar.' }));
            }
            ficha.append(rodape);
            fila.append(ficha);
        }
    }

    // Tick local de 1s: so reescreve o texto do cronometro, sem redesenhar a
    // fila (redesenho a cada segundo perderia o toque do cozinheiro).
    setInterval(() => {
        if (estado.view !== 'cozinha') return;
        const agora = Date.now();
        for (const no of document.querySelectorAll('[data-cronometro]')) {
            no.textContent = cronometro((agora - Number(no.dataset.cronometro)) / 1000);
        }
    }, 1000);

    // ----------------------------------------------------------------- caixa

    async function carregarCaixa() {
        const dados = await api('/comandas?status=aberta,conta_pedida');
        estado.comandasCaixa = dados.comandas;
        if (estado.contaSelecionada) {
            const aindaViva = estado.comandasCaixa.some((c) => c.id === estado.contaSelecionada);
            estado.conta = aindaViva ? await api(`/comandas/${estado.contaSelecionada}`) : null;
            if (!aindaViva) estado.contaSelecionada = null;
        }
        renderCaixa();
    }

    function renderCaixa() {
        const lista = limpar($('#caixaLista'));
        lista.append(el('p', { classe: 'subtitulo', texto: `Contas abertas (${estado.comandasCaixa.length})` }));
        if (!estado.comandasCaixa.length) {
            lista.append(el('p', { classe: 'vazio', texto: 'Nenhuma conta aberta.' }));
        }
        for (const comanda of estado.comandasCaixa) {
            lista.append(el('button', {
                classe: 'linha-comanda', type: 'button',
                'aria-current': String(estado.contaSelecionada === comanda.id),
                ao: {
                    click: acao(async () => {
                        estado.contaSelecionada = comanda.id;
                        estado.conta = await api(`/comandas/${comanda.id}`);
                        renderCaixa();
                    }),
                },
            }, [
                el('strong', { texto: `Mesa ${comanda.mesa_numero || '—'} · ${comanda.codigo}` }),
                el('span', {
                    texto: `${comanda.status === 'conta_pedida' ? 'CONTA PEDIDA' : 'aberta'} · ${comanda.pessoas} pessoa(s) · ${hora(comanda.aberta_em)}`,
                }),
            ]));
        }

        const painel = limpar($('#caixaConta'));
        if (!estado.conta) {
            painel.append(el('p', { classe: 'vazio', texto: 'Escolha uma conta à esquerda.' }));
            return;
        }
        renderConta(painel);
    }

    function renderConta(painel) {
        const { comanda, itens, pagamentos, totais } = estado.conta;
        const gerente = estado.usuario.papel === 'gerente';

        painel.append(el('h3', { texto: `Mesa ${comanda.mesa_numero || '—'} · ${comanda.codigo}` }));
        painel.append(el('p', { classe: 'legenda', texto: `${comanda.pessoas} pessoa(s) · aberta às ${hora(comanda.aberta_em)}` }));

        painel.append(el('p', { classe: 'subtitulo', texto: 'Consumo' }));
        for (const item of itens.filter((i) => i.status !== 'cancelado')) {
            painel.append(el('div', { classe: 'conta-item' }, [
                el('span', { texto: `${item.quantidade}× ${item.produto_nome}` }),
                el('strong', { texto: dinheiro(item.quantidade * item.preco_unit_centavos) }),
            ]));
        }

        painel.append(el('p', { classe: 'subtitulo', texto: 'Totais' }));
        const totaisBloco = el('div');
        const par = (rotulo, valor) => totaisBloco.append(el('div', { classe: 'conta-item' }, [
            el('span', { texto: rotulo }), el('strong', { texto: valor }),
        ]));
        par('Subtotal', dinheiro(totais.subtotalCentavos));
        par(`Serviço ${totais.percentualTaxa}%`, comanda.taxa_servico ? dinheiro(totais.taxaCentavos) : 'removido');
        if (totais.descontoCentavos) par('Desconto', `− ${dinheiro(totais.descontoCentavos)}`);
        par('TOTAL', dinheiro(totais.totalCentavos));
        par(`Por pessoa (${comanda.pessoas})`, dinheiro(totais.porPessoaCentavos));
        if (pagamentos.length) par('Recebido', dinheiro(totais.pagoCentavos));
        par('Saldo', dinheiro(totais.saldoCentavos));
        painel.append(totaisBloco);

        // ---- ajustes da conta
        const ajustes = el('div', { classe: 'form-pagamento' }, [
            el('button', {
                classe: 'btn', type: 'button',
                texto: comanda.taxa_servico ? 'Retirar serviço 10%' : 'Aplicar serviço 10%',
                ao: {
                    click: acao(async () => {
                        estado.conta = await api(`/comandas/${comanda.id}`, {
                            metodo: 'PATCH', corpo: { taxaServico: !comanda.taxa_servico },
                        });
                        renderCaixa();
                    }),
                },
            }),
        ]);
        if (gerente) {
            ajustes.append(el('button', {
                classe: 'btn', type: 'button', texto: 'Aplicar desconto',
                ao: { click: acao(() => aplicarDesconto(comanda)) },
            }));
        }
        painel.append(ajustes);

        // ---- pagamentos ja lancados
        if (pagamentos.length) {
            painel.append(el('p', { classe: 'subtitulo', texto: 'Pagamentos' }));
            for (const pagamento of pagamentos) {
                const linha = el('div', { classe: 'conta-item' }, [
                    el('span', {
                        texto: `${pagamento.forma} · ${hora(pagamento.criado_em)}${pagamento.troco_centavos ? ` · troco ${dinheiro(pagamento.troco_centavos)}` : ''}`,
                    }),
                    el('strong', { texto: dinheiro(pagamento.valor_centavos) }),
                ]);
                linha.append(el('button', {
                    classe: 'btn pequeno perigo', type: 'button', texto: 'Estornar',
                    ao: {
                        click: acao(async () => {
                            estado.conta = await api(`/comandas/${comanda.id}/pagamentos/${pagamento.id}`, { metodo: 'DELETE' });
                            aviso('Pagamento estornado.', 'alerta');
                            renderCaixa();
                        }),
                    },
                }));
                painel.append(linha);
            }
        }

        if (totais.saldoCentavos > 0) painel.append(formularioPagamento(comanda, totais));

        painel.append(el('button', {
            classe: 'btn sucesso bloco', type: 'button',
            texto: `Fechar conta · ${dinheiro(totais.totalCentavos)}`,
            style: 'margin-top:14px',
            ao: {
                click: acao(async () => {
                    await api(`/comandas/${comanda.id}/fechar`, { metodo: 'POST' });
                    aviso(`Conta ${comanda.codigo} fechada. Mesa liberada.`, 'sucesso');
                    estado.contaSelecionada = null;
                    estado.conta = null;
                    await carregarCaixa();
                }),
            },
        }));
    }

    function formularioPagamento(comanda, totais) {
        const forma = el('select', {}, ['dinheiro', 'debito', 'credito', 'pix', 'voucher'].map(
            (opcao) => el('option', { value: opcao, texto: opcao }),
        ));
        const valor = el('input', { type: 'text', inputmode: 'decimal', value: (totais.saldoCentavos / 100).toFixed(2).replace('.', ',') });
        const recebido = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'só dinheiro' });

        const formulario = el('div', { classe: 'form-pagamento' }, [
            el('div', { classe: 'campo' }, [el('label', { texto: 'Forma' }), forma]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Valor (R$)' }), valor]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Recebido (R$)' }), recebido]),
            el('button', {
                classe: 'btn primary', type: 'button', texto: 'Lançar pagamento',
                ao: {
                    click: acao(async () => {
                        const valorCentavos = paraCentavos(valor.value);
                        if (!Number.isFinite(valorCentavos) || valorCentavos <= 0) throw new Error('Valor inválido.');
                        const corpo = { forma: forma.value, valorCentavos };
                        if (forma.value === 'dinheiro' && recebido.value.trim()) {
                            const recebidoCentavos = paraCentavos(recebido.value);
                            if (!Number.isFinite(recebidoCentavos)) throw new Error('Valor recebido inválido.');
                            corpo.recebidoCentavos = recebidoCentavos;
                        }
                        const dados = await api(`/comandas/${comanda.id}/pagamentos`, { metodo: 'POST', corpo });
                        estado.conta = dados;
                        if (dados.pagamento.troco_centavos) {
                            aviso(`Troco: ${dinheiro(dados.pagamento.troco_centavos)}`, 'alerta');
                        }
                        renderCaixa();
                    }),
                },
            }),
        ]);

        const bloco = el('div');
        bloco.append(el('p', { classe: 'subtitulo', texto: 'Receber' }), formulario);
        return bloco;
    }

    async function aplicarDesconto(comanda) {
        const texto = window.prompt('Valor do desconto em R$ (0 remove):', '0');
        if (texto === null) return;
        const descontoCentavos = paraCentavos(texto);
        if (!Number.isFinite(descontoCentavos) || descontoCentavos < 0) throw new Error('Valor inválido.');
        const corpo = { descontoCentavos };
        if (descontoCentavos > 0) {
            const motivo = window.prompt('Motivo do desconto (fica na auditoria):');
            if (motivo === null) return;
            corpo.descontoMotivo = motivo;
        }
        estado.conta = await api(`/comandas/${comanda.id}`, { metodo: 'PATCH', corpo });
        renderCaixa();
    }

    // ----------------------------------------------------------------- admin

    const ABAS_ADMIN = [
        { id: 'cardapio', rotulo: 'Cardápio' },
        { id: 'mesas', rotulo: 'Salão' },
        { id: 'equipe', rotulo: 'Equipe' },
    ];

    async function renderAdmin() {
        const filtros = limpar($('#abasAdmin'));
        for (const aba of ABAS_ADMIN) {
            filtros.append(el('button', {
                classe: 'aba', type: 'button', texto: aba.rotulo,
                'aria-current': String(estado.abaAdmin === aba.id),
                ao: {
                    click: acao(async () => {
                        estado.abaAdmin = aba.id;
                        await renderAdmin();
                    }),
                },
            }));
        }

        const painel = limpar($('#adminConteudo'));
        if (estado.abaAdmin === 'cardapio') await renderAdminCardapio(painel);
        else if (estado.abaAdmin === 'mesas') await renderAdminMesas(painel);
        else await renderAdminEquipe(painel);
    }

    async function renderAdminCardapio(painel) {
        await carregarCardapio(true);

        const nome = el('input', { type: 'text', placeholder: 'Nome do produto' });
        const preco = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00' });
        const tempo = el('input', { type: 'number', min: '0', max: '240', value: '0' });
        const categoria = el('select', {}, estado.cardapio.map(
            (cat) => el('option', { value: cat.id, texto: cat.nome }),
        ));

        painel.append(el('p', { classe: 'subtitulo', texto: 'Novo produto' }));
        painel.append(el('div', { classe: 'form-pagamento' }, [
            el('div', { classe: 'campo' }, [el('label', { texto: 'Categoria' }), categoria]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Nome' }), nome]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Preço (R$)' }), preco]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Preparo (min)' }), tempo]),
            el('button', {
                classe: 'btn primary', type: 'button', texto: 'Cadastrar',
                ao: {
                    click: acao(async () => {
                        await api('/produtos', {
                            metodo: 'POST',
                            corpo: {
                                categoriaId: Number(categoria.value),
                                nome: nome.value,
                                precoCentavos: paraCentavos(preco.value),
                                tempoPreparoMinutos: Number(tempo.value),
                            },
                        });
                        aviso('Produto cadastrado.', 'sucesso');
                        await renderAdmin();
                    }),
                },
            }),
        ]));

        painel.append(el('p', { classe: 'subtitulo', texto: 'Cardápio' }));
        const corpo = el('tbody');
        for (const cat of estado.cardapio) {
            for (const produto of cat.produtos) {
                corpo.append(el('tr', {}, [
                    el('td', { texto: produto.nome }),
                    el('td', { texto: cat.nome }),
                    el('td', { texto: produto.setor }),
                    el('td', { texto: dinheiro(produto.precoCentavos) }),
                    el('td', {}, [
                        el('button', {
                            classe: `btn pequeno ${produto.disponivel ? '' : 'perigo'}`,
                            type: 'button',
                            texto: produto.disponivel ? 'Disponível' : 'Esgotado',
                            ao: {
                                click: acao(async () => {
                                    await api(`/produtos/${produto.id}/disponibilidade`, {
                                        metodo: 'PATCH', corpo: { disponivel: !produto.disponivel },
                                    });
                                    await renderAdmin();
                                }),
                            },
                        }),
                    ]),
                    el('td', {}, [
                        el('button', {
                            classe: 'btn pequeno', type: 'button', texto: 'Preço',
                            ao: {
                                click: acao(async () => {
                                    const novo = window.prompt(`Novo preço de "${produto.nome}" (R$):`,
                                        (produto.precoCentavos / 100).toFixed(2).replace('.', ','));
                                    if (novo === null) return;
                                    await api(`/produtos/${produto.id}`, {
                                        metodo: 'PATCH', corpo: { precoCentavos: paraCentavos(novo) },
                                    });
                                    aviso('Preço atualizado. Contas abertas mantêm o preço lançado.', 'sucesso');
                                    await renderAdmin();
                                }),
                            },
                        }),
                    ]),
                ]));
            }
        }
        painel.append(el('div', { classe: 'tabela-rolagem' }, [
            el('table', {}, [
                el('thead', {}, [el('tr', {}, ['Produto', 'Categoria', 'Setor', 'Preço', 'Situação', ''].map(
                    (titulo) => el('th', { texto: titulo }),
                ))]),
                corpo,
            ]),
        ]));
    }

    async function renderAdminMesas(painel) {
        await carregarMesas();
        const numero = el('input', { type: 'text', placeholder: 'Ex.: 13' });
        const capacidade = el('input', { type: 'number', min: '1', max: '50', value: '4' });

        painel.append(el('p', { classe: 'subtitulo', texto: 'Nova mesa' }));
        painel.append(el('div', { classe: 'form-pagamento' }, [
            el('div', { classe: 'campo' }, [el('label', { texto: 'Número' }), numero]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Lugares' }), capacidade]),
            el('button', {
                classe: 'btn primary', type: 'button', texto: 'Cadastrar',
                ao: {
                    click: acao(async () => {
                        await api('/mesas', {
                            metodo: 'POST',
                            corpo: { numero: numero.value, capacidade: Number(capacidade.value) },
                        });
                        aviso('Mesa cadastrada.', 'sucesso');
                        await renderAdmin();
                    }),
                },
            }),
        ]));

        painel.append(el('p', { classe: 'subtitulo', texto: `Mesas ativas (${estado.mesas.length})` }));
        const corpo = el('tbody');
        for (const mesa of estado.mesas) {
            corpo.append(el('tr', {}, [
                el('td', { texto: mesa.numero }),
                el('td', { texto: `${mesa.capacidade} lugares` }),
                el('td', { texto: mesa.comanda ? `ocupada · ${mesa.comanda.codigo}` : 'livre' }),
                el('td', {}, [
                    el('button', {
                        classe: 'btn pequeno perigo', type: 'button', texto: 'Desativar',
                        ao: {
                            click: acao(async () => {
                                await api(`/mesas/${mesa.id}`, { metodo: 'PATCH', corpo: { ativa: false } });
                                await renderAdmin();
                            }),
                        },
                    }),
                ]),
            ]));
        }
        painel.append(el('div', { classe: 'tabela-rolagem' }, [
            el('table', {}, [
                el('thead', {}, [el('tr', {}, ['Mesa', 'Lugares', 'Situação', ''].map((t) => el('th', { texto: t })))]),
                corpo,
            ]),
        ]));
    }

    async function renderAdminEquipe(painel) {
        const dados = await api('/usuarios');
        estado.usuarios = dados.usuarios;

        const login = el('input', { type: 'text', placeholder: 'login' });
        const nome = el('input', { type: 'text', placeholder: 'Nome completo' });
        const senha = el('input', { type: 'password', placeholder: 'mínimo 6 caracteres' });
        const papel = el('select', {}, ['garcom', 'cozinha', 'caixa', 'gerente'].map(
            (opcao) => el('option', { value: opcao, texto: opcao }),
        ));

        painel.append(el('p', { classe: 'subtitulo', texto: 'Novo usuário' }));
        painel.append(el('div', { classe: 'form-pagamento' }, [
            el('div', { classe: 'campo' }, [el('label', { texto: 'Login' }), login]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Nome' }), nome]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Papel' }), papel]),
            el('div', { classe: 'campo' }, [el('label', { texto: 'Senha' }), senha]),
            el('button', {
                classe: 'btn primary', type: 'button', texto: 'Criar',
                ao: {
                    click: acao(async () => {
                        await api('/usuarios', {
                            metodo: 'POST',
                            corpo: { login: login.value, nome: nome.value, papel: papel.value, senha: senha.value },
                        });
                        aviso('Usuário criado.', 'sucesso');
                        await renderAdmin();
                    }),
                },
            }),
        ]));

        painel.append(el('p', { classe: 'subtitulo', texto: 'Equipe' }));
        const corpo = el('tbody');
        for (const usuario of estado.usuarios) {
            corpo.append(el('tr', {}, [
                el('td', { texto: usuario.nome }),
                el('td', { texto: usuario.login }),
                el('td', { texto: usuario.papel }),
                el('td', { texto: usuario.ativo ? 'ativo' : 'inativo' }),
                el('td', { texto: usuario.ultimo_acesso ? new Date(usuario.ultimo_acesso).toLocaleString('pt-BR') : '—' }),
                el('td', {}, [
                    el('button', {
                        classe: 'btn pequeno', type: 'button', texto: 'Nova senha',
                        ao: {
                            click: acao(async () => {
                                const nova = window.prompt(`Nova senha para "${usuario.login}":`);
                                if (nova === null) return;
                                await api(`/usuarios/${usuario.id}`, { metodo: 'PATCH', corpo: { senha: nova } });
                                aviso('Senha trocada. As sessões desse usuário foram encerradas.', 'sucesso');
                            }),
                        },
                    }),
                    el('button', {
                        classe: `btn pequeno ${usuario.ativo ? 'perigo' : ''}`,
                        type: 'button',
                        texto: usuario.ativo ? 'Desativar' : 'Reativar',
                        ao: {
                            click: acao(async () => {
                                await api(`/usuarios/${usuario.id}`, { metodo: 'PATCH', corpo: { ativo: !usuario.ativo } });
                                await renderAdmin();
                            }),
                        },
                    }),
                ]),
            ]));
        }
        painel.append(el('div', { classe: 'tabela-rolagem' }, [
            el('table', {}, [
                el('thead', {}, [el('tr', {}, ['Nome', 'Login', 'Papel', 'Situação', 'Último acesso', ''].map(
                    (t) => el('th', { texto: t }),
                ))]),
                corpo,
            ]),
        ]));
    }

    // ------------------------------------------------------- tempo real

    function conectarEventos() {
        if (estado.fonte) estado.fonte.close();
        const fonte = new EventSource('/api/restaurante/eventos');
        estado.fonte = fonte;

        fonte.addEventListener('open', () => $('#conexao').classList.remove('caiu'));
        fonte.addEventListener('error', () => $('#conexao').classList.add('caiu'));

        fonte.addEventListener('itens.lancados', (evento) => {
            const dados = JSON.parse(evento.data);
            if (['cozinha', 'gerente'].includes(estado.usuario.papel)) {
                aviso(`Novo pedido · Mesa ${dados.mesa || '—'} (${dados.itens.length} item(ns))`, 'alerta');
            }
            agendarAtualizacao();
        });

        fonte.addEventListener('item.status', (evento) => {
            const dados = JSON.parse(evento.data);
            if (dados.status === 'pronto' && ['garcom', 'caixa', 'gerente'].includes(estado.usuario.papel)) {
                const mesa = estado.mesas.find((m) => m.comanda && m.comanda.id === dados.comandaId);
                aviso(`Pronto para servir · Mesa ${mesa ? mesa.numero : '—'} · ${dados.nome}`, 'sucesso');
            }
            agendarAtualizacao();
        });

        for (const nome of ['comanda.aberta', 'comanda.fechada', 'comanda.conta_pedida', 'comanda.reaberta', 'produto.disponibilidade', 'cardapio.alterado']) {
            fonte.addEventListener(nome, agendarAtualizacao);
        }
    }

    // ---------------------------------------------------------- sessao

    function mostrarLogin(mensagem) {
        estado.usuario = null;
        if (estado.fonte) { estado.fonte.close(); estado.fonte = null; }
        $('#appView').hidden = true;
        $('#loginView').hidden = false;
        const erro = $('#loginErro');
        erro.textContent = mensagem || '';
        erro.hidden = !mensagem;
    }

    async function entrar(usuario) {
        estado.usuario = usuario;
        $('#loginView').hidden = true;
        $('#appView').hidden = false;
        $('#usuarioNome').textContent = usuario.nome;
        $('#usuarioPapel').textContent = usuario.papel;

        const disponiveis = ABAS.filter(podeVer);
        const preferida = ABA_INICIAL[usuario.papel];
        estado.abaAtiva = disponiveis.some((aba) => aba.id === preferida)
            ? preferida
            : (disponiveis[0]?.id || 'salao');
        conectarEventos();
        await carregarProducao().catch(() => {});
        await irPara(estado.abaAtiva);
    }

    // ------------------------------------------------------------ ligacoes

    $('#loginForm').addEventListener('submit', async (evento) => {
        evento.preventDefault();
        const botao = $('#loginButton');
        botao.disabled = true;
        try {
            const usuario = await api('/login', {
                metodo: 'POST',
                corpo: { login: $('#loginInput').value, senha: $('#senhaInput').value },
            });
            $('#senhaInput').value = '';
            $('#loginErro').hidden = true;
            await entrar(usuario);
        } catch (erro) {
            const alvo = $('#loginErro');
            alvo.textContent = erro.message;
            alvo.hidden = false;
        } finally {
            botao.disabled = false;
        }
    });

    $('#sairButton').addEventListener('click', acao(async () => {
        await api('/logout', { metodo: 'POST' });
        mostrarLogin();
    }));

    $('#voltarSalao').addEventListener('click', acao(() => irPara('salao')));
    $('#abrirCardapio').addEventListener('click', acao(abrirGaveta));
    $('#enviarPedido').addEventListener('click', acao(enviarPedido));
    $('#buscaProduto').addEventListener('input', renderCardapio);
    for (const no of document.querySelectorAll('[data-fechar-gaveta]')) {
        no.addEventListener('click', fecharGaveta);
    }
    document.addEventListener('keydown', (evento) => {
        if (evento.key === 'Escape' && !$('#gaveta').hidden) fecharGaveta();
    });

    // Sessao viva sobrevive ao F5 — o cookie HttpOnly ja esta no navegador.
    api('/me')
        .then(entrar)
        .catch(() => mostrarLogin());
})();

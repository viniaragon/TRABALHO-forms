// Barramento de eventos em tempo real via Server-Sent Events.
//
// Escolha deliberada de SSE em vez de WebSocket: o KDS da cozinha e o aviso de
// "pedido pronto" para o garcom sao fluxos de mao unica (servidor -> tela).
// SSE resolve isso com o proprio `res` do Express, sem dependencia nova, e
// reconecta sozinho no navegador. Comandos do cliente continuam indo por POST.

const inscritos = new Set();
let proximoId = 1;

function escrever(inscrito, evento, dados) {
    try {
        inscrito.res.write(`event: ${evento}\n`);
        inscrito.res.write(`data: ${JSON.stringify(dados)}\n\n`);
    } catch (erro) {
        desconectar(inscrito);
    }
}

function desconectar(inscrito) {
    if (!inscritos.delete(inscrito)) return;
    try {
        inscrito.res.end();
    } catch (erro) {
        // conexao ja caiu; nada a fazer
    }
}

function inscrever(req, res, usuario) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // desliga o buffering do nginx, que senao segura o stream
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const inscrito = { id: proximoId++, res, usuario };
    inscritos.add(inscrito);

    // `retry` diz ao EventSource quanto esperar antes de reconectar.
    res.write('retry: 3000\n\n');
    escrever(inscrito, 'conectado', { usuario: usuario.nome, papel: usuario.papel });

    req.on('close', () => desconectar(inscrito));
    return inscrito;
}

// Publica para todas as telas conectadas. O filtro por setor/papel fica no
// cliente: o volume de um restaurante e baixo e a tela ja sabe o que exibir.
function publicar(evento, dados) {
    for (const inscrito of Array.from(inscritos)) {
        escrever(inscrito, evento, dados);
    }
}

// Comentario SSE periodico: mantem viva a conexao atras de proxies que
// derrubam socket ocioso. `unref` evita segurar o processo aberto.
const batimento = setInterval(() => {
    for (const inscrito of Array.from(inscritos)) {
        try {
            inscrito.res.write(': ping\n\n');
        } catch (erro) {
            desconectar(inscrito);
        }
    }
}, 25000);
batimento.unref?.();

module.exports = { inscrever, publicar, totalInscritos: () => inscritos.size };

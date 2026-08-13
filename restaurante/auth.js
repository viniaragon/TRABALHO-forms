const crypto = require('crypto');
const { pool } = require('./db');

const COOKIE = 'restaurante_session';
const HORAS_SESSAO = Number(process.env.RESTAURANTE_SESSION_HOURS || 12);
const ITERACOES_HASH = 310000;

const PAPEIS = ['garcom', 'cozinha', 'caixa', 'gerente'];

function gerarHashSenha(senha) {
    const sal = crypto.randomBytes(16).toString('base64url');
    const digest = crypto.pbkdf2Sync(String(senha), sal, ITERACOES_HASH, 32, 'sha256').toString('base64url');
    return `pbkdf2_sha256$${ITERACOES_HASH}$${sal}$${digest}`;
}

function compararTextoSeguro(a, b) {
    const esquerda = Buffer.from(String(a || ''), 'utf8');
    const direita = Buffer.from(String(b || ''), 'utf8');
    return esquerda.length === direita.length && crypto.timingSafeEqual(esquerda, direita);
}

function conferirSenha(senha, hashArmazenado) {
    const [esquema, iteracoesTexto, sal, digest] = String(hashArmazenado || '').split('$');
    const iteracoes = Number(iteracoesTexto);
    if (esquema !== 'pbkdf2_sha256' || !iteracoes || !sal || !digest) {
        return false;
    }
    const candidato = crypto.pbkdf2Sync(String(senha), sal, iteracoes, 32, 'sha256').toString('base64url');
    return compararTextoSeguro(candidato, digest);
}

function lerCookies(req) {
    const bruto = req.headers.cookie || '';
    return bruto.split(';').reduce((mapa, parte) => {
        const separador = parte.indexOf('=');
        if (separador > 0) {
            mapa[parte.slice(0, separador).trim()] = decodeURIComponent(parte.slice(separador + 1).trim());
        }
        return mapa;
    }, {});
}

function definirCookieSessao(res, token) {
    const partes = [
        `${COOKIE}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${HORAS_SESSAO * 60 * 60}`,
    ];
    if (process.env.NODE_ENV === 'production') {
        partes.push('Secure');
    }
    res.setHeader('Set-Cookie', partes.join('; '));
}

function limparCookieSessao(res) {
    const partes = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (process.env.NODE_ENV === 'production') {
        partes.push('Secure');
    }
    res.setHeader('Set-Cookie', partes.join('; '));
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function abrirSessao(usuarioId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiraEm = new Date(Date.now() + HORAS_SESSAO * 60 * 60 * 1000);
    await pool.query(
        `INSERT INTO restaurante.sessoes (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)`,
        [usuarioId, hashToken(token), expiraEm],
    );
    await pool.query('UPDATE restaurante.usuarios SET ultimo_acesso = now() WHERE id = $1', [usuarioId]);
    return token;
}

async function encerrarSessao(token) {
    if (!token) return;
    await pool.query('DELETE FROM restaurante.sessoes WHERE token_hash = $1', [hashToken(token)]);
}

async function usuarioDaRequisicao(req) {
    const token = lerCookies(req)[COOKIE];
    if (!token) return null;
    const { rows } = await pool.query(
        `SELECT s.id AS sessao_id, u.id, u.login, u.nome, u.papel, u.ativo
         FROM restaurante.sessoes s
         JOIN restaurante.usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = $1 AND s.expira_em > now()`,
        [hashToken(token)],
    );
    const usuario = rows[0];
    if (!usuario || !usuario.ativo) return null;
    await pool.query('UPDATE restaurante.sessoes SET ultimo_uso = now() WHERE id = $1', [usuario.sessao_id]);
    return usuario;
}

// Middleware. Sem papeis informados exige apenas sessao valida; com papeis,
// restringe a lista (gerente entra em tudo).
function exigirPapel(...papeis) {
    return async function guarda(req, res, proximo) {
        try {
            const usuario = await usuarioDaRequisicao(req);
            if (!usuario) {
                return res.status(401).json({ erro: 'Sessao expirada. Entre novamente.' });
            }
            if (papeis.length && usuario.papel !== 'gerente' && !papeis.includes(usuario.papel)) {
                return res.status(403).json({ erro: `Acao permitida para: ${papeis.join(', ')}.` });
            }
            req.usuario = usuario;
            return proximo();
        } catch (erro) {
            return proximo(erro);
        }
    };
}

module.exports = {
    COOKIE,
    PAPEIS,
    gerarHashSenha,
    conferirSenha,
    lerCookies,
    definirCookieSessao,
    limparCookieSessao,
    abrirSessao,
    encerrarSessao,
    usuarioDaRequisicao,
    exigirPapel,
};

const fs = require('fs');
const path = require('path');
const { Pool, types: tiposPadrao } = require('pg');

// O driver devolve bigint (oid 20) e numeric (oid 1700) como string para nao
// perder precisao. Aqui os ids cabem folgadamente em Number, e string vira
// comparacao errada no JS (`5 === '5'` e falso). Converter globalmente com
// `pg.types.setTypeParser` afetaria tambem as consultas do portal OCIS, que
// roda no mesmo processo — por isso o parser vai preso a este pool.
const tiposRestaurante = {
    getTypeParser(oid, formato) {
        if (oid === 20 || oid === 1700) {
            return (valor) => (valor === null ? null : Number(valor));
        }
        return tiposPadrao.getTypeParser(oid, formato);
    },
};

// Ordem de preferencia: RESTAURANTE_DB_* (explicito) -> OCI_DB_* -> POSTGRES_*
// (injetado pelo Zeabur) -> local. Mesma cadeia usada pelo restante do projeto.
const pool = new Pool({
    host: process.env.RESTAURANTE_DB_HOST || process.env.OCI_DB_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: Number(process.env.RESTAURANTE_DB_PORT || process.env.OCI_DB_PORT || process.env.POSTGRES_PORT || 55432),
    database: process.env.RESTAURANTE_DB_NAME || process.env.OCI_DB_NAME || process.env.POSTGRES_DATABASE || 'ocis_local',
    user: process.env.RESTAURANTE_DB_USER || process.env.OCI_DB_USER || process.env.POSTGRES_USERNAME || 'oci_admin',
    password: process.env.RESTAURANTE_DB_PASSWORD || process.env.OCI_DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'oci_admin_local',
    types: tiposRestaurante,
});

// Um erro em cliente ocioso (queda de rede, restart do banco) emite 'error' no
// pool; sem listener o processo inteiro cai.
pool.on('error', (erro) => {
    console.error('[restaurante] erro em cliente ocioso do pool:', erro.message);
});

let schemaPronto = null;

async function garantirSchema() {
    if (!schemaPronto) {
        const ddl = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        schemaPronto = pool.query(ddl).catch((erro) => {
            schemaPronto = null; // permite nova tentativa no proximo request
            throw erro;
        });
    }
    return schemaPronto;
}

async function consultar(texto, valores) {
    return pool.query(texto, valores);
}

// Executa `callback` dentro de uma transacao, com rollback automatico em erro.
// Todo caminho que mexe em dinheiro ou em status passa por aqui.
async function emTransacao(callback) {
    const cliente = await pool.connect();
    try {
        await cliente.query('BEGIN');
        const resultado = await callback(cliente);
        await cliente.query('COMMIT');
        return resultado;
    } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw erro;
    } finally {
        cliente.release();
    }
}

async function registrarAuditoria(cliente, { usuarioId, acao, entidade, entidadeId, detalhe }) {
    await (cliente || pool).query(
        `INSERT INTO restaurante.auditoria (usuario_id, acao, entidade, entidade_id, detalhe)
         VALUES ($1, $2, $3, $4, $5)`,
        [usuarioId || null, acao, entidade, entidadeId || null, detalhe ? JSON.stringify(detalhe) : null],
    );
}

module.exports = {
    pool,
    garantirSchema,
    consultar,
    emTransacao,
    registrarAuditoria,
};

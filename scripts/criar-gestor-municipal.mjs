import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
    host: process.env.OCI_DB_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || process.env.POSTGRES_PORT || 55432),
    database: process.env.OCI_DB_NAME || process.env.POSTGRES_DATABASE || 'ocis_local',
    user: process.env.OCI_DB_USER || process.env.POSTGRES_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'oci_admin_local',
});

const ITERATIONS = 310000;

function arg(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? null : process.argv[index + 1] || null;
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase();
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const digest = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, 32, 'sha256').toString('base64url');
    return `pbkdf2_sha256$${ITERATIONS}$${salt}$${digest}`;
}

function usage() {
    console.log(`
Uso:
  node scripts/criar-gestor-municipal.mjs --login gestor.irece --senha "senha-forte" --municipio "IRECE" --nome "Gestor Irece"

Obrigatorios:
  --login       Login do gestor
  --senha       Senha inicial
  --municipio   Nome exato do municipio ja cadastrado em oci.municipios

Opcional:
  --nome        Nome exibido no portal
`);
}

async function ensureSchema(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS oci.portal_gestor_usuarios (
            id bigserial PRIMARY KEY,
            login text NOT NULL UNIQUE,
            senha_hash text NOT NULL,
            nome text NULL,
            municipio_id bigint NOT NULL REFERENCES oci.municipios(id),
            ativo boolean NOT NULL DEFAULT true,
            ultimo_acesso timestamptz NULL,
            criado_em timestamptz NOT NULL DEFAULT now(),
            atualizado_em timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_portal_gestor_usuarios_municipio
            ON oci.portal_gestor_usuarios (municipio_id);
        CREATE TABLE IF NOT EXISTS oci.portal_gestor_sessoes (
            id bigserial PRIMARY KEY,
            usuario_id bigint NOT NULL REFERENCES oci.portal_gestor_usuarios(id) ON DELETE CASCADE,
            token_hash text NOT NULL UNIQUE,
            expires_at timestamptz NOT NULL,
            criado_em timestamptz NOT NULL DEFAULT now(),
            ultimo_uso timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS oci.portal_gestor_auditoria (
            id bigserial PRIMARY KEY,
            usuario_id bigint NULL REFERENCES oci.portal_gestor_usuarios(id) ON DELETE SET NULL,
            acao text NOT NULL,
            detalhe text NULL,
            ip text NULL,
            user_agent text NULL,
            criado_em timestamptz NOT NULL DEFAULT now()
        );
    `);
}

async function main() {
    const login = String(arg('login') || '').trim().toLowerCase();
    const senha = arg('senha');
    const municipio = arg('municipio');
    const nome = arg('nome') || login;

    if (!login || !senha || !municipio) {
        usage();
        process.exitCode = 1;
        return;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await ensureSchema(client);

        const municipios = await client.query('SELECT id, nome FROM oci.municipios');
        const municipioRow = municipios.rows.find(row => normalizeText(row.nome) === normalizeText(municipio));
        if (!municipioRow) {
            throw new Error(`Municipio nao encontrado em oci.municipios: ${municipio}`);
        }

        const senhaHash = hashPassword(senha);
        const result = await client.query(`
            INSERT INTO oci.portal_gestor_usuarios (login, senha_hash, nome, municipio_id, ativo)
            VALUES ($1, $2, $3, $4, true)
            ON CONFLICT (login) DO UPDATE SET
                senha_hash = EXCLUDED.senha_hash,
                nome = EXCLUDED.nome,
                municipio_id = EXCLUDED.municipio_id,
                ativo = true,
                atualizado_em = now()
            RETURNING id, login
        `, [login, senhaHash, nome, municipioRow.id]);

        await client.query('COMMIT');
        console.log(`Gestor salvo: ${result.rows[0].login} -> ${municipioRow.nome} (id ${result.rows[0].id})`);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch(error => {
        console.error(error.message);
        pool.end();
        process.exit(1);
    });

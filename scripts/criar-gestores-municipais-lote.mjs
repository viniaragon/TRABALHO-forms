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

const GESTORES = [
    { nome: 'Rizia', cargo: 'Coordenadora da Regulacao', municipio: 'Jacobina', telefone: '74988031715', email: 'riziamarques784@gmail.com' },
    { nome: 'Lutero Nunes Ramos', cargo: 'Regulador', municipio: 'Quixabeira', telefone: '74981322533', email: 'lutero.ramos@gmail.com' },
    { nome: 'Ana Flavia Pereira da Silva', cargo: 'Enfermeira reguladora', municipio: 'Morro do Chapeu', telefone: '75981757963', email: 'enfanaflavia3@gmail.com' },
    { nome: 'Francisleide ribeiro Barbosa', cargo: 'Reguladora', municipio: 'Umburanas', telefone: '74991485711', email: 'francisleideribeiro753@gmail.com' },
    { nome: 'Isabella Santos da Silva', cargo: 'Enfermeira - Apoiadora da APS', municipio: 'Mirangaba', telefone: '74991489450', email: 'ysinhass@hotmail.com' },
    { nome: 'Agricia Benicio de Souza', cargo: 'Reguladora/Ass. Social', municipio: 'Umburanas', login: 'umburanas.agricia', telefone: '74988228465', email: 'agriciabenicio@yahoo.com.br' },
    { nome: 'Deivison Rafael Santos Coelho', cargo: 'Coordenador de TI', municipio: 'Saude', telefone: '74988382729', email: 'Deivisonsaude@gmail.com' },
    { nome: 'Laysa da Silva Araujo', cargo: 'Coordenadora da Regulacao', municipio: 'Tapiramuta', telefone: '71996560404', email: 'laysaa950@gmail.com' },
    { nome: 'Maelly Lopes Nascimento', cargo: 'Reguladora', municipio: 'Piritiba', telefone: '74999914745', email: 'regulacao.piritiba@hotmail.com' },
    { nome: 'Marcelo Pereira dos Santos', cargo: 'Coordenador da Central de Regulacao', municipio: 'Miguel Calmon', telefone: '7499947170', email: 'coordenasemasa@gmail.com' },
    { nome: 'Marcos Silva Oliveira', cargo: 'Coordenador da regulacao Municipal', municipio: 'Sao Jose do Jacuipe', telefone: '74998042012', email: 'marcissilva14@hotmail.com' },
    { nome: 'Quelma Saadia Menezes Goncalves Silva', cargo: 'Reguladora', municipio: 'Serrolandia', telefone: '74981281894', email: 'quelmasilva16@gmail.com' },
    { nome: 'GRAZIELLE ALVES PEREIRA', cargo: 'Encarregado de Unidade de Saude', municipio: 'Ourolandia', telefone: '74999496352', email: 'galves2604@gmail.com' },
    { nome: 'Clara Horrana Maia de Oliveira Rios', cargo: 'Coordenadora do NAGRC', municipio: 'Capim Grosso', telefone: '74991533163', email: 'clara_horrana@hotmail.com' },
    { nome: 'Emiliane da Cunha Rios', cargo: 'Diretora de planejamento e regulacao', municipio: 'Jacobina', login: 'jacobina.emiliane', telefone: '74999959328', email: 'emilianecunharios2022@gmail.com' },
    { nome: 'Geanjila dos Santos', cargo: 'Reguladora municipal', municipio: 'Caem', telefone: '74981421452', email: 'ge.araujoge@outlook.com' },
    { nome: 'Daniel de Oliveira Silva', cargo: 'Regulador administrador', municipio: 'Caldeirao Grande', telefone: '74981079231', email: 'daniell.silva1072k@gmail.com' },
    { nome: 'Luana Mendes Silva', cargo: 'Enfermeira reguladora, coordenadora NGC.', municipio: 'Mairi', telefone: '75983135054', email: 'luana_angico@hotmail.com' },
];

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase();
}

function loginFromMunicipio(municipio) {
    return String(municipio || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '');
}

function digitsOnly(value) {
    return String(value || '').replace(/\D+/g, '');
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const digest = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, 32, 'sha256').toString('base64url');
    return `pbkdf2_sha256$${ITERATIONS}$${salt}$${digest}`;
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

function uniqueByLogin(rows) {
    const selected = [];
    const seen = new Map();
    const duplicates = [];
    for (const row of rows) {
        const key = loginFromMunicipio(row.login || row.municipio);
        if (seen.has(key)) {
            duplicates.push({ mantido: seen.get(key), ignorado: row });
            continue;
        }
        seen.set(key, row);
        selected.push(row);
    }
    return { selected, duplicates };
}

async function main() {
    const client = await pool.connect();
    const { selected, duplicates } = uniqueByLogin(GESTORES);
    try {
        await client.query('BEGIN');
        await ensureSchema(client);
        const municipios = await client.query('SELECT id, nome FROM oci.municipios');
        const municipioCache = new Map(municipios.rows.map(row => [normalizeText(row.nome), row]));
        const createdMunicipios = [];
        const saved = [];

        for (const gestor of selected) {
            let municipioRow = municipioCache.get(normalizeText(gestor.municipio));
            if (!municipioRow) {
                const created = await client.query(`
                    INSERT INTO oci.municipios (nome)
                    VALUES ($1)
                    ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
                    RETURNING id, nome
                `, [gestor.municipio]);
                municipioRow = created.rows[0];
                municipioCache.set(normalizeText(municipioRow.nome), municipioRow);
                createdMunicipios.push(municipioRow.nome);
            }

            const login = loginFromMunicipio(gestor.login || gestor.municipio);
            const senha = digitsOnly(gestor.telefone);
            const nome = `${gestor.nome} - ${gestor.cargo}`;
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
            `, [login, hashPassword(senha), nome, municipioRow.id]);
            saved.push({ id: result.rows[0].id, login, senha, municipio: municipioRow.nome, nome: gestor.nome });
        }

        await client.query('COMMIT');
        console.table(saved);
        if (createdMunicipios.length) {
            console.log('\nMunicipios criados automaticamente em oci.municipios:');
            console.table(createdMunicipios.map(nome => ({ municipio: nome })));
        }
        if (duplicates.length) {
            console.log('\nLogins repetidos ignorados:');
            console.table(duplicates.map(item => ({
                login: loginFromMunicipio(item.ignorado.login || item.ignorado.municipio),
                mantido: item.mantido.nome,
                ignorado: item.ignorado.nome,
            })));
        }
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

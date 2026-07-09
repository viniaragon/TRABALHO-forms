const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');

let admin;
let getFirestore;
let isFirebaseConfigured = false;
let db = null;

// ID do banco Firestore. Neste projeto o banco foi criado com o nome "default"
// (banco nomeado), e NÃO como o banco padrão "(default)". Por isso é necessário
// especificá-lo explicitamente; caso contrário o SDK retorna erro 5 NOT_FOUND.
const FIRESTORE_DATABASE_ID = process.env.FIREBASE_DATABASE_ID || 'default';

try {
    admin = require('firebase-admin');
    getFirestore = require('firebase-admin/firestore').getFirestore;
    
    const CREDENTIALS_PATH = path.join(__dirname, 'firebase-credentials.json');

    if (fs.existsSync(CREDENTIALS_PATH)) {
        const serviceAccount = require(CREDENTIALS_PATH);
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando arquivo local de credenciais (firebase-credentials.json).');
    } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL) {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: privateKey,
                })
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando variáveis de ambiente.');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando JSON stringificado de variável de ambiente.');
    } else {
        console.log('Modo de armazenamento local ativo: Nenhuma credencial do Firebase configurada.');
    }

    if (isFirebaseConfigured) {
        db = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
        console.log(`Conectado ao banco Firestore: "${FIRESTORE_DATABASE_ID}".`);
    }
} catch (err) {
    console.warn('AVISO: O pacote "firebase-admin" não está instalado ou falhou ao carregar. Rodando no modo de armazenamento local. Erro:', err.message);
    isFirebaseConfigured = false;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/pacientes/laudos', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portal-gestor.html'));
});

app.get('/portal-gestor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'portal-gestor.html'));
});

// Ordem de preferência: OCI_DB_* (explícito) -> POSTGRES_* (injetado pelo
// Zeabur quando há um serviço PostgreSQL no mesmo projeto) -> local (Docker).
const ociPool = new Pool({
    host: process.env.OCI_DB_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || process.env.POSTGRES_PORT || 55432),
    database: process.env.OCI_DB_NAME || process.env.POSTGRES_DATABASE || 'ocis_local',
    user: process.env.OCI_DB_USER || process.env.POSTGRES_USERNAME || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'oci_admin_local',
});

const OCI_CODES_ORDER = [
    '09.01.01.001-4',
    '09.06.01.001-2',
    '09.06.01.002-0',
    '09.01.01.005-7',
    '09.01.01.010-3',
    '09.01.01.011-1',
    '09.01.01.012-0',
];

function brMoney(value) {
    const number = Number(value || 0);
    return number.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const SPECIALIST_CONSULT_LABEL = 'Consulta Medica em Atencao Especializada / Teleconsulta Medica em Atencao Especializada';
const INTERNAL_PASSWORD = process.env.OCI_INTERNAL_PASSWORD || '123456789';
const MASTER_PASSWORD = process.env.OCI_MASTER_PASSWORD || '987654321';
const UNLINK_PASSWORD = process.env.OCI_UNLINK_PASSWORD || '010791';
const PATIENT_BANK_MASTER_PASSWORD = process.env.PATIENT_BANK_MASTER_PASSWORD || MASTER_PASSWORD;
const PORTAL_GESTOR_COOKIE = 'agsus_portal_session';
const PORTAL_GESTOR_SESSION_HOURS = Number(process.env.PORTAL_GESTOR_SESSION_HOURS || 12);
const PASSWORD_HASH_ITERATIONS = 310000;

function normalizeAccessText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toUpperCase();
}

function parsePatientBankProfiles() {
    if (!process.env.PATIENT_BANK_ACCESS_PROFILES) {
        return [];
    }
    try {
        const parsed = JSON.parse(process.env.PATIENT_BANK_ACCESS_PROFILES);
        if (!Array.isArray(parsed)) {
            throw new Error('PATIENT_BANK_ACCESS_PROFILES precisa ser um array JSON.');
        }
        return parsed
            .map(profile => ({
                key: String(profile.key || '').trim(),
                label: String(profile.label || 'Perfil local').trim(),
                localidades: Array.isArray(profile.localidades)
                    ? profile.localidades.map(normalizeAccessText).filter(Boolean)
                    : null,
                dateFrom: profile.dateFrom || profile.dataInicio || null,
                dateTo: profile.dateTo || profile.dataFim || null,
            }))
            .filter(profile => profile.key);
    } catch (error) {
        console.warn('PATIENT_BANK_ACCESS_PROFILES invalido. Usando apenas senha master.', error.message);
        return [];
    }
}

const PATIENT_BANK_ACCESS_PROFILES = parsePatientBankProfiles();

function parseOciFilters(req) {
    const regiao = String(req.query.regiao || '').trim().toUpperCase();
    const competencia = String(req.query.competencia || '').trim().toUpperCase();
    const search = String(req.query.search || '').trim();
    const accessKey = String(req.query.accessKey || '').trim();
    const isMaster = accessKey === MASTER_PASSWORD;
    const isInternal = isMaster || accessKey === INTERNAL_PASSWORD;
    return {
        regiao: regiao && regiao !== 'TODAS' ? regiao : null,
        competencia: competencia && competencia !== 'TODAS' ? competencia : null,
        search: search || null,
        includeValues: isInternal,
        canViewPending: isMaster,
    };
}

function resolvePatientBankAccess(req) {
    const accessKey = String(req.query.accessKey || '').trim();
    if (accessKey && accessKey === PATIENT_BANK_MASTER_PASSWORD) {
        return {
            level: 'master',
            label: 'Acesso master',
            localidades: null,
            dateFrom: null,
            dateTo: null,
        };
    }
    const profile = PATIENT_BANK_ACCESS_PROFILES.find(item => item.key === accessKey);
    if (!profile) {
        return null;
    }
    return {
        level: 'restricted',
        label: profile.label,
        localidades: profile.localidades,
        dateFrom: profile.dateFrom,
        dateTo: profile.dateTo,
    };
}

function patientBankBaseSql() {
    return `
        WITH base_laudos AS (
            SELECT
                lp.id,
                lp.paciente_id,
                COALESCE(p.nome_preferido, lp.nome_extraido) AS paciente,
                lp.nome_extraido,
                lp.nome_normalizado,
                lp.cartao_sus,
                lp.telefone,
                lp.municipio_paciente,
                lp.tipo_laudo,
                lp.numero_exame,
                lp.data_solicitacao,
                lp.data_realizacao,
                COALESCE(lp.data_realizacao, lp.data_solicitacao, lp.criado_em::date) AS data_laudo,
                lp.arquivo_original,
                lp.caminho_origem,
                lp.caminho_armazenado,
                lp.chave_logica,
                lp.duplicado_de_id,
                lp.status_vinculo,
                lp.confianca_vinculo,
                lp.erro_extracao,
                lp.criado_em,
                lp.procedimento_raw,
                lp.data_nascimento,
                lp.idade_texto,
                lp.idade_anos,
                lp.origem_importacao,
                lp.vinculo_motivo,
                COALESCE(lp.registro_ativo, true) AS registro_ativo,
                CASE
                    WHEN COALESCE(p.data_nascimento, lp.data_nascimento) IS NOT NULL
                        THEN DATE_PART('year', AGE(CURRENT_DATE, COALESCE(p.data_nascimento, lp.data_nascimento)))::int
                    ELSE lp.idade_anos
                END AS idade_calc,
                CASE
                    WHEN NULLIF(BTRIM(lp.municipio_paciente), '') IS NOT NULL
                        AND LENGTH(BTRIM(lp.municipio_paciente)) <= 80
                        AND lp.municipio_paciente !~* '(RESULTADO|PRONT|POWERED|MAMOGRAFIA| ID:| TIPO:)' THEN
                        UPPER(TRANSLATE(BTRIM(lp.municipio_paciente), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))
                    WHEN lp.caminho_origem ILIKE '%Irece%' OR lp.caminho_origem ILIKE '%Irecê%' THEN 'IRECE'
                    WHEN lp.caminho_origem ILIKE '%Jacobina%' THEN 'JACOBINA'
                    WHEN lp.caminho_origem ILIKE '%Valen%' THEN 'VALENCA'
                    ELSE 'NAO INFORMADA'
                END AS localidade,
                CASE
                    WHEN COALESCE(lp.data_realizacao, lp.data_solicitacao, lp.criado_em::date)
                        BETWEEN DATE '2026-03-27' AND DATE '2026-04-30' THEN 'IRECE'
                    WHEN COALESCE(lp.data_realizacao, lp.data_solicitacao, lp.criado_em::date)
                        BETWEEN DATE '2026-05-08' AND DATE '2026-06-05' THEN 'JACOBINA'
                    WHEN COALESCE(lp.data_realizacao, lp.data_solicitacao, lp.criado_em::date)
                        > DATE '2026-06-05' THEN 'EM ESPERA'
                    ELSE 'FORA DO PERIODO'
                END AS regiao_mae,
                CASE
                    WHEN lp.paciente_id IS NOT NULL THEN 'P:' || lp.paciente_id::text
                    ELSE 'L:' || lp.nome_normalizado || ':' || COALESCE(lp.data_nascimento::text, lp.idade_anos::text, 'SEMIDADE')
                END AS grupo_paciente
            FROM oci.laudos_pacientes lp
            LEFT JOIN oci.pacientes p ON p.id = lp.paciente_id
        ),
        -- Pacientes da planilha SEM NENHUM laudo vinculado entram como linhas
        -- virtuais (origem_importacao = 'SEM_LAUDO'; 1 linha por atendimento,
        -- para os filtros de data/localidade funcionarem). Só aparecem quando
        -- o interruptor "sem laudo" está ligado.
        base_sem_laudo AS (
            SELECT
                NULL::bigint AS id,
                p.id AS paciente_id,
                p.nome_preferido AS paciente,
                '' AS nome_extraido,
                p.patient_key AS nome_normalizado,
                p.cns AS cartao_sus,
                NULL::text AS telefone,
                m.nome AS municipio_paciente,
                NULL::text AS tipo_laudo,
                NULL::text AS numero_exame,
                NULL::date AS data_solicitacao,
                NULL::date AS data_realizacao,
                a.data_atendimento AS data_laudo,
                NULL::text AS arquivo_original,
                NULL::text AS caminho_origem,
                NULL::text AS caminho_armazenado,
                NULL::text AS chave_logica,
                NULL::bigint AS duplicado_de_id,
                'sem_laudo' AS status_vinculo,
                NULL::numeric AS confianca_vinculo,
                NULL::text AS erro_extracao,
                a.criado_em,
                NULL::text AS procedimento_raw,
                p.data_nascimento,
                NULL::text AS idade_texto,
                NULL::integer AS idade_anos,
                'SEM_LAUDO' AS origem_importacao,
                NULL::text AS vinculo_motivo,
                true AS registro_ativo,
                CASE
                    WHEN p.data_nascimento IS NOT NULL
                        THEN DATE_PART('year', AGE(CURRENT_DATE, p.data_nascimento))::int
                END AS idade_calc,
                m.nome AS localidade,
                a.regiao AS regiao_mae,
                'P:' || p.id::text AS grupo_paciente
            FROM oci.pacientes p
            JOIN oci.atendimentos a ON a.paciente_id = p.id
            JOIN oci.municipios m ON m.id = a.municipio_id
            WHERE NOT EXISTS (
                SELECT 1 FROM oci.laudos_pacientes l
                WHERE l.paciente_id = p.id
                  AND COALESCE(l.registro_ativo, true)
                  AND l.status_vinculo <> 'descartado'
            )
        ),
        base AS (
            SELECT * FROM base_laudos
            UNION ALL
            SELECT * FROM base_sem_laudo
        )
    `;
}

function buildPatientBankWhere(req, access, startIndex = 1) {
    const clauses = [];
    const values = [];
    let idx = startIndex;

    // descartados pela administração e cópias duplicadas (registro_ativo=false)
    // saem de todas as listagens e contagens do banco
    clauses.push(`status_vinculo <> 'descartado'`);
    clauses.push('registro_ativo');

    if (Array.isArray(access.localidades) && access.localidades.length) {
        clauses.push(`localidade = ANY($${idx++}::text[])`);
        values.push(access.localidades);
    }

    const requestedLocalidade = normalizeAccessText(req.query.localidade || '');
    if (requestedLocalidade && requestedLocalidade !== 'TODAS') {
        clauses.push(`localidade = $${idx++}`);
        values.push(requestedLocalidade);
    }

    const requestedRegiaoMae = normalizeAccessText(req.query.regiaoMae || '');
    if (requestedRegiaoMae && requestedRegiaoMae !== 'TODAS') {
        clauses.push(`regiao_mae = $${idx++}`);
        values.push(requestedRegiaoMae);
    }

    const requestedFrom = String(req.query.dateFrom || '').trim();
    const requestedTo = String(req.query.dateTo || '').trim();
    const effectiveFrom = [requestedFrom, access.dateFrom].filter(Boolean).sort().pop();
    const effectiveTo = [requestedTo, access.dateTo].filter(Boolean).sort()[0];

    if (effectiveFrom) {
        clauses.push(`data_laudo >= $${idx++}::date`);
        values.push(effectiveFrom);
    }

    if (effectiveTo) {
        clauses.push(`data_laudo <= $${idx++}::date`);
        values.push(effectiveTo);
    }

    const tipo = String(req.query.tipo || '').trim().toUpperCase();
    const laudoModo = String(req.query.laudoModo || 'com').trim().toLowerCase();
    if (tipo && tipo !== 'TODOS') {
        if (laudoModo === 'sem') {
            // pacientes (grupos) que NÃO têm nenhum laudo desse tipo; inclui os
            // pacientes sem laudo algum (linhas virtuais SEM_LAUDO)
            clauses.push(`grupo_paciente NOT IN (
                SELECT b2.grupo_paciente FROM base b2
                WHERE b2.tipo_laudo = $${idx} AND b2.status_vinculo <> 'descartado'
            )`);
            values.push(tipo);
            idx++;
        } else {
            clauses.push(`tipo_laudo = $${idx++}`);
            values.push(tipo);
        }
    } else if (laudoModo === 'sem') {
        // "sem laudo" com tipo "Todos": pacientes sem NENHUM laudo
        clauses.push(`origem_importacao = 'SEM_LAUDO'`);
    }
    if (laudoModo !== 'sem') {
        // no modo normal as linhas virtuais de pacientes sem laudo ficam ocultas
        clauses.push(`origem_importacao IS DISTINCT FROM 'SEM_LAUDO'`);
    }

    const status = String(req.query.status || '').trim().toLowerCase();
    if (status === 'vinculado') {
        clauses.push('paciente_id IS NOT NULL');
    } else if (status === 'orfao') {
        // todo laudo sem paciente (fila de revisão + não encontrados + ignorados)
        clauses.push(`paciente_id IS NULL AND status_vinculo <> 'quarentena'`);
    } else if (status === 'pendente') {
        clauses.push(`status_vinculo IN ('pendente', 'pendente_revisao')`);
    } else if (status === 'revisado') {
        clauses.push(`status_vinculo IN ('revisado_manual', 'nao_encontrado', 'ignorado_revisao')`);
    }

    const faixaIdade = String(req.query.faixaIdade || '').trim().toLowerCase();
    if (faixaIdade === '40mais') {
        clauses.push('idade_calc >= 40');
    } else if (faixaIdade === 'menor40') {
        clauses.push('idade_calc < 40');
    } else if (faixaIdade === 'desconhecida') {
        clauses.push('idade_calc IS NULL');
    }

    const search = String(req.query.search || '').trim();
    if (search) {
        clauses.push(`(
            paciente ILIKE $${idx}
            OR nome_extraido ILIKE $${idx}
            OR cartao_sus ILIKE $${idx}
            OR telefone ILIKE $${idx}
            OR tipo_laudo ILIKE $${idx}
            OR procedimento_raw ILIKE $${idx}
        )`);
        values.push(`%${search}%`);
        idx++;
    }

    return {
        whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
        values,
        effectiveFrom,
        effectiveTo,
    };
}

async function queryPatientBank(req, access) {
    const { whereSql, values, effectiveFrom, effectiveTo } = buildPatientBankWhere(req, access);
    const baseSql = patientBankBaseSql();
    // As opções dos dropdowns vêm de "base" (universo completo permitido), e não
    // de "filtered": senão o valor selecionado some do próprio filtro.
    const optionsAccessSql = Array.isArray(access.localidades) && access.localidades.length
        ? `AND localidade = ANY($1::text[])`
        : '';
    const summarySql = `
        ${baseSql},
        filtered AS (
            SELECT * FROM base
            ${whereSql}
        ),
        grouped AS (
            SELECT
                grupo_paciente,
                COUNT(*)::int AS total_laudos,
                BOOL_OR(paciente_id IS NOT NULL) AS tem_vinculo,
                BOOL_OR(paciente_id IS NULL) AS tem_pendente
            FROM filtered
            GROUP BY grupo_paciente
        )
        SELECT
            (SELECT COUNT(*)::int FROM grouped) AS total_pacientes,
            (SELECT COUNT(*)::int FROM filtered WHERE origem_importacao IS DISTINCT FROM 'SEM_LAUDO') AS total_laudos,
            (SELECT COUNT(*)::int FROM filtered WHERE paciente_id IS NOT NULL AND origem_importacao IS DISTINCT FROM 'SEM_LAUDO') AS pacientes_vinculados,
            (SELECT COUNT(*)::int FROM filtered WHERE paciente_id IS NULL AND status_vinculo <> 'quarentena') AS pacientes_pendentes,
            (SELECT COUNT(*)::int FROM filtered WHERE tipo_laudo = 'MAMOGRAFIA') AS mamografias,
            (SELECT COUNT(*)::int FROM filtered WHERE tipo_laudo LIKE 'USG_%') AS usgs,
            (SELECT COUNT(DISTINCT grupo_paciente)::int FROM filtered WHERE tipo_laudo = 'MAMOGRAFIA') AS pac_com_mamografia,
            (SELECT COUNT(DISTINCT grupo_paciente)::int FROM filtered WHERE tipo_laudo LIKE 'USG_%') AS pac_com_usg,
            (SELECT COUNT(DISTINCT grupo_paciente)::int FROM filtered WHERE tipo_laudo IN ('USG_TRANSVAGINAL', 'USG_TRANSVAGINAL_PELVICA')) AS pac_com_usg_tv,
            (SELECT COUNT(DISTINCT grupo_paciente)::int FROM filtered WHERE tipo_laudo IN ('USG_MAMA', 'USG_MAMA_COMPLEMENTACAO')) AS pac_com_usg_mama,
            (SELECT COUNT(DISTINCT grupo_paciente)::int FROM filtered WHERE tipo_laudo IN ('USG_PELVICA', 'USG_TRANSVAGINAL_PELVICA')) AS pac_com_usg_pelvica,
            (SELECT COUNT(*)::int FROM base
              WHERE (registro_ativo IS FALSE OR duplicado_de_id IS NOT NULL)
                AND status_vinculo <> 'descartado' ${optionsAccessSql}) AS duplicados_logicos,
            COALESCE((
                SELECT json_agg(row_to_json(t) ORDER BY t.qtd DESC, t.tipo_laudo)
                FROM (
                    SELECT tipo_laudo, COUNT(*)::int AS qtd
                    FROM filtered
                    WHERE tipo_laudo IS NOT NULL
                    GROUP BY tipo_laudo
                ) t
            ), '[]'::json) AS por_tipo,
            COALESCE((
                SELECT json_agg(row_to_json(l) ORDER BY l.qtd DESC, l.localidade)
                FROM (
                    SELECT localidade, COUNT(*)::int AS qtd
                    FROM filtered
                    GROUP BY localidade
                ) l
            ), '[]'::json) AS por_localidade,
            COALESCE((
                SELECT json_agg(row_to_json(r) ORDER BY r.regiao_mae)
                FROM (
                    SELECT regiao_mae, COUNT(*)::int AS qtd
                    FROM filtered
                    GROUP BY regiao_mae
                ) r
            ), '[]'::json) AS por_regiao_mae,
            COALESCE((
                SELECT json_agg(row_to_json(r) ORDER BY r.regiao_mae)
                FROM (
                    SELECT regiao_mae, MIN(data_laudo) AS min_data, MAX(data_laudo) AS max_data
                    FROM base
                    WHERE status_vinculo <> 'descartado' ${optionsAccessSql}
                    GROUP BY regiao_mae
                ) r
            ), '[]'::json) AS options_regioes_mae,
            COALESCE((
                SELECT json_agg(row_to_json(o) ORDER BY o.localidade)
                FROM (
                    SELECT localidade, MIN(data_laudo) AS min_data, MAX(data_laudo) AS max_data
                    FROM base
                    WHERE status_vinculo <> 'descartado' ${optionsAccessSql}
                    GROUP BY localidade
                ) o
            ), '[]'::json) AS options_localidades,
            COALESCE((
                SELECT json_agg(DISTINCT tipo_laudo ORDER BY tipo_laudo)
                FROM base
                WHERE status_vinculo <> 'descartado' ${optionsAccessSql}
                  AND tipo_laudo IS NOT NULL
            ), '[]'::json) AS options_tipos;
    `;
    const summaryValues = Array.isArray(access.localidades) && access.localidades.length
        ? [access.localidades, ...values.slice(1)]
        : values;
    const rowsSql = `
        ${baseSql},
        filtered AS (
            SELECT * FROM base
            ${whereSql}
        ),
        grouped AS (
            SELECT
                grupo_paciente,
                MIN(paciente) AS paciente,
                MIN(nome_normalizado) AS nome_normalizado,
                MIN(cartao_sus) FILTER (WHERE cartao_sus IS NOT NULL AND cartao_sus <> '') AS cartao_sus,
                MIN(telefone) FILTER (WHERE telefone IS NOT NULL AND telefone <> '') AS telefone,
                STRING_AGG(DISTINCT localidade, ', ' ORDER BY localidade) AS localidades,
                STRING_AGG(DISTINCT regiao_mae, ', ' ORDER BY regiao_mae) AS regioes_mae,
                MIN(data_nascimento) AS data_nascimento,
                MAX(idade_anos) AS idade_anos,
                MIN(data_laudo) AS primeira_data,
                MAX(data_laudo) AS ultima_data,
                COUNT(*) FILTER (WHERE origem_importacao IS DISTINCT FROM 'SEM_LAUDO')::int AS total_laudos,
                COUNT(*) FILTER (WHERE tipo_laudo = 'MAMOGRAFIA')::int AS mamografias,
                COUNT(*) FILTER (WHERE tipo_laudo LIKE 'USG_%')::int AS usgs,
                COUNT(*) FILTER (WHERE paciente_id IS NULL)::int AS pendentes,
                COUNT(*) FILTER (WHERE paciente_id IS NOT NULL AND origem_importacao IS DISTINCT FROM 'SEM_LAUDO')::int AS vinculados,
                MIN(paciente_id) AS paciente_id,
                COALESCE(JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'id', id,
                        'tipoLaudo', tipo_laudo,
                        'procedimento', procedimento_raw,
                        'data', data_laudo,
                        'statusVinculo', status_vinculo,
                        'pacienteId', paciente_id,
                        'arquivoOriginal', arquivo_original,
                        'temArquivoLocal', caminho_armazenado IS NOT NULL AND caminho_armazenado <> '',
                        'duplicadoDeId', duplicado_de_id,
                        'motivo', vinculo_motivo
                    )
                    ORDER BY data_laudo DESC NULLS LAST, id DESC
                ) FILTER (WHERE origem_importacao IS DISTINCT FROM 'SEM_LAUDO'), '[]'::json) AS documentos
            FROM filtered
            GROUP BY grupo_paciente
        )
        SELECT *
        FROM grouped
        ORDER BY ultima_data DESC NULLS LAST, paciente
        LIMIT 500;
    `;
    const [summaryResult, rowsResult] = await Promise.all([
        ociPool.query(summarySql, summaryValues),
        ociPool.query(rowsSql, values),
    ]);
    const summary = summaryResult.rows[0] || {};
    return {
        access: {
            level: access.level,
            label: access.label,
            localidades: access.localidades,
            dateFrom: access.dateFrom,
            dateTo: access.dateTo,
        },
        filters: {
            dateFrom: effectiveFrom || null,
            dateTo: effectiveTo || null,
        },
        kpis: {
            totalPacientes: Number(summary.total_pacientes || 0),
            totalLaudos: Number(summary.total_laudos || 0),
            pacientesVinculados: Number(summary.pacientes_vinculados || 0),
            pacientesPendentes: Number(summary.pacientes_pendentes || 0),
            mamografias: Number(summary.mamografias || 0),
            usgs: Number(summary.usgs || 0),
            duplicadosLogicos: Number(summary.duplicados_logicos || 0),
            pacComMamografia: Number(summary.pac_com_mamografia || 0),
            pacComUsg: Number(summary.pac_com_usg || 0),
            pacComUsgTransvaginal: Number(summary.pac_com_usg_tv || 0),
            pacComUsgMama: Number(summary.pac_com_usg_mama || 0),
            pacComUsgPelvica: Number(summary.pac_com_usg_pelvica || 0),
        },
        porTipo: summary.por_tipo || [],
        porLocalidade: summary.por_localidade || [],
        porRegiaoMae: summary.por_regiao_mae || [],
        options: {
            regioesMae: summary.options_regioes_mae || [],
            localidades: summary.options_localidades || [],
            tipos: summary.options_tipos || [],
        },
        rows: rowsResult.rows.map(row => ({
            grupoPaciente: row.grupo_paciente,
            paciente: row.paciente,
            nomeNormalizado: row.nome_normalizado,
            cartaoSus: row.cartao_sus,
            telefone: row.telefone,
            localidades: row.localidades,
            regioesMae: row.regioes_mae,
            dataNascimento: row.data_nascimento,
            idadeAnos: row.idade_anos,
            primeiraData: row.primeira_data,
            ultimaData: row.ultima_data,
            totalLaudos: Number(row.total_laudos || 0),
            mamografias: Number(row.mamografias || 0),
            usgs: Number(row.usgs || 0),
            pendentes: Number(row.pendentes || 0),
            vinculados: Number(row.vinculados || 0),
            pacienteId: row.paciente_id,
            documentos: row.documentos || [],
        })),
    };
}

async function queryPatientBankDocument(req, access, laudoId) {
    const scopedReq = { query: {} };
    const { whereSql, values } = buildPatientBankWhere(scopedReq, access);
    const baseSql = patientBankBaseSql();
    const sql = `
        ${baseSql},
        filtered AS (
            SELECT * FROM base
            ${whereSql}
        )
        SELECT id, arquivo_original, caminho_armazenado
        FROM filtered
        WHERE id = $${values.length + 1}::bigint
        LIMIT 1;
    `;
    const result = await ociPool.query(sql, [...values, laudoId]);
    return result.rows[0] || null;
}

function isInsideDirectory(baseDir, targetPath) {
    const relative = path.relative(baseDir, targetPath);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isPatientBankMaster(access) {
    return access && access.level === 'master';
}

function parseCookies(req) {
    return String(req.headers.cookie || '')
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)
        .reduce((cookies, item) => {
            const separator = item.indexOf('=');
            if (separator === -1) return cookies;
            const key = item.slice(0, separator).trim();
            const value = item.slice(separator + 1).trim();
            cookies[key] = decodeURIComponent(value);
            return cookies;
        }, {});
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqualText(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPortalPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const digest = crypto.pbkdf2Sync(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('base64url');
    return `pbkdf2_sha256$${PASSWORD_HASH_ITERATIONS}$${salt}$${digest}`;
}

function verifyPortalPassword(password, storedHash) {
    const [scheme, iterationsText, salt, digest] = String(storedHash || '').split('$');
    const iterations = Number(iterationsText);
    if (scheme !== 'pbkdf2_sha256' || !iterations || !salt || !digest) {
        return false;
    }
    const candidate = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('base64url');
    return timingSafeEqualText(candidate, digest);
}

function portalCookieOptions(maxAgeSeconds) {
    const parts = [
        `${PORTAL_GESTOR_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
    ];
    if (maxAgeSeconds === 0) {
        parts[0] += '; Max-Age=0';
    } else {
        parts[0] += `%TOKEN%; Max-Age=${maxAgeSeconds}`;
    }
    if (process.env.NODE_ENV === 'production') {
        parts.push('Secure');
    }
    return parts;
}

function setPortalSessionCookie(res, token) {
    const maxAge = PORTAL_GESTOR_SESSION_HOURS * 60 * 60;
    const header = portalCookieOptions(maxAge).join('; ').replace('%TOKEN%', encodeURIComponent(token));
    res.setHeader('Set-Cookie', header);
}

function clearPortalSessionCookie(res) {
    res.setHeader('Set-Cookie', portalCookieOptions(0).join('; '));
}

function normalizePortalLogin(login) {
    return String(login || '').trim().toLowerCase();
}

async function ensurePortalGestorSchema() {
    await ociPool.query(`
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
        CREATE INDEX IF NOT EXISTS idx_portal_gestor_sessoes_usuario
            ON oci.portal_gestor_sessoes (usuario_id);
        CREATE INDEX IF NOT EXISTS idx_portal_gestor_sessoes_expires
            ON oci.portal_gestor_sessoes (expires_at);

        CREATE TABLE IF NOT EXISTS oci.portal_gestor_auditoria (
            id bigserial PRIMARY KEY,
            usuario_id bigint NULL REFERENCES oci.portal_gestor_usuarios(id) ON DELETE SET NULL,
            acao text NOT NULL,
            detalhe text NULL,
            ip text NULL,
            user_agent text NULL,
            criado_em timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_portal_gestor_auditoria_usuario
            ON oci.portal_gestor_auditoria (usuario_id, criado_em DESC);
    `);
}

async function auditPortalGestor(req, userId, acao, detalhe = null) {
    try {
        await ociPool.query(`
            INSERT INTO oci.portal_gestor_auditoria (usuario_id, acao, detalhe, ip, user_agent)
            VALUES ($1, $2, $3, $4, $5)
        `, [
            userId || null,
            acao,
            detalhe,
            req.ip || req.socket?.remoteAddress || null,
            String(req.headers['user-agent'] || '').slice(0, 500) || null,
        ]);
    } catch (error) {
        console.warn('Falha ao auditar portal gestor:', error.message);
    }
}

function portalUserPayload(user) {
    return {
        id: Number(user.id),
        login: user.login,
        nome: user.nome || user.login,
        municipioId: Number(user.municipio_id),
        municipio: user.municipio,
    };
}

async function getPortalGestorSession(req) {
    const token = parseCookies(req)[PORTAL_GESTOR_COOKIE];
    if (!token) return null;
    const tokenHash = sha256(token);
    const result = await ociPool.query(`
        SELECT
            s.id AS session_id,
            u.id,
            u.login,
            u.nome,
            u.municipio_id,
            m.nome AS municipio
        FROM oci.portal_gestor_sessoes s
        JOIN oci.portal_gestor_usuarios u ON u.id = s.usuario_id
        JOIN oci.municipios m ON m.id = u.municipio_id
        WHERE s.token_hash = $1
          AND s.expires_at > now()
          AND u.ativo
        LIMIT 1
    `, [tokenHash]);
    const user = result.rows[0] || null;
    if (!user) return null;
    await ociPool.query('UPDATE oci.portal_gestor_sessoes SET ultimo_uso = now() WHERE id = $1', [user.session_id]);
    return { user: portalUserPayload(user), tokenHash, sessionId: Number(user.session_id) };
}

async function requirePortalGestor(req, res) {
    const session = await getPortalGestorSession(req);
    if (!session) {
        res.status(401).json({ success: false, message: 'Sessao expirada ou acesso nao autorizado.' });
        return null;
    }
    return session;
}

const PORTAL_MUNICIPIO_NORM_SQL = `
    UPPER(TRANSLATE(BTRIM(m.nome), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))
`;

const PORTAL_LAUDO_MUNICIPIO_NORM_SQL = `
    CASE
        WHEN NULLIF(BTRIM(lp.municipio_paciente), '') IS NOT NULL
            AND LENGTH(BTRIM(lp.municipio_paciente)) <= 80
            AND lp.municipio_paciente !~* '(RESULTADO|PRONT|POWERED|MAMOGRAFIA| ID:| TIPO:)'
        THEN UPPER(TRANSLATE(BTRIM(lp.municipio_paciente), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç', 'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'))
        ELSE NULL
    END
`;

function portalGestorBaseSql() {
    return `
        WITH portal_municipio AS (
            SELECT m.id, m.nome, ${PORTAL_MUNICIPIO_NORM_SQL} AS municipio_norm
            FROM oci.municipios m
            WHERE m.id = $1::bigint
        ),
        patients_scope AS (
            SELECT
                'P:' || p.id::text AS grupo,
                p.id AS paciente_id,
                p.nome_preferido AS paciente,
                p.cpf,
                p.cns,
                p.data_nascimento,
                CASE
                    WHEN p.data_nascimento IS NOT NULL THEN DATE_PART('year', AGE(CURRENT_DATE, p.data_nascimento))::int
                    ELSE NULL
                END AS idade_paciente,
                MIN(a.data_atendimento) AS primeira_data_atendimento,
                MAX(a.data_atendimento) AS ultima_data_atendimento,
                COALESCE(
                    JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT(
                        'data', a.data_atendimento,
                        'competencia', a.competencia,
                        'regiao', a.regiao,
                        'observacao', a.observacao
                    )),
                    '[]'::jsonb
                ) AS atendimentos,
                STRING_AGG(DISTINCT ap.procedimento, '; ' ORDER BY ap.procedimento)
                    FILTER (WHERE ap.status = 'REALIZADO') AS procedimentos
            FROM oci.pacientes p
            JOIN oci.atendimentos a ON a.paciente_id = p.id
            LEFT JOIN oci.atendimento_procedimentos ap ON ap.atendimento_uid = a.atendimento_uid
            WHERE a.municipio_id = $1::bigint
            GROUP BY p.id, p.nome_preferido, p.cpf, p.cns, p.data_nascimento
        ),
        laudos_norm AS (
            SELECT
                lp.*,
                COALESCE(p.nome_preferido, lp.nome_extraido) AS paciente_resolvido,
                p.cpf AS paciente_cpf,
                p.cns AS paciente_cns,
                p.data_nascimento AS paciente_nascimento,
                ${PORTAL_LAUDO_MUNICIPIO_NORM_SQL} AS municipio_norm
            FROM oci.laudos_pacientes lp
            LEFT JOIN oci.pacientes p ON p.id = lp.paciente_id
        ),
        docs_scope AS (
            SELECT
                CASE
                    WHEN ps.grupo IS NOT NULL THEN ps.grupo
                    ELSE 'L:' || COALESCE(NULLIF(ln.nome_normalizado, ''), 'SEM_NOME') || ':' || COALESCE(ln.data_nascimento::text, ln.idade_anos::text, 'SEMIDADE')
                END AS grupo,
                ln.id,
                ln.paciente_id,
                ln.paciente_resolvido AS paciente,
                ln.nome_extraido,
                COALESCE(ln.paciente_cpf, NULL) AS cpf,
                COALESCE(ln.paciente_cns, ln.cartao_sus) AS cns,
                ln.telefone,
                COALESCE(ln.paciente_nascimento, ln.data_nascimento) AS data_nascimento,
                CASE
                    WHEN COALESCE(ln.paciente_nascimento, ln.data_nascimento) IS NOT NULL
                        THEN DATE_PART('year', AGE(CURRENT_DATE, COALESCE(ln.paciente_nascimento, ln.data_nascimento)))::int
                    ELSE ln.idade_anos
                END AS idade_calc,
                ln.tipo_laudo,
                ln.procedimento_raw,
                COALESCE(ln.data_realizacao, ln.data_solicitacao, ln.criado_em::date) AS data_laudo,
                ln.status_vinculo,
                ln.arquivo_original,
                ln.caminho_armazenado,
                ln.vinculo_motivo
            FROM laudos_norm ln
            CROSS JOIN portal_municipio pm
            LEFT JOIN patients_scope ps ON ps.paciente_id = ln.paciente_id
            WHERE COALESCE(ln.registro_ativo, true)
              AND ln.status_vinculo <> 'descartado'
              AND (
                ln.municipio_norm = pm.municipio_norm
                OR (ln.municipio_norm IS NULL AND ps.paciente_id IS NOT NULL)
              )
        ),
        grouped AS (
            SELECT
                COALESCE(ps.grupo, ds.grupo) AS grupo,
                MIN(COALESCE(ps.paciente, ds.paciente, ds.nome_extraido)) AS paciente,
                MIN(COALESCE(ps.cpf, ds.cpf)) AS cpf,
                MIN(COALESCE(ps.cns, ds.cns)) AS cns,
                MIN(ds.telefone) FILTER (WHERE ds.telefone IS NOT NULL AND ds.telefone <> '') AS telefone,
                MIN(COALESCE(ps.data_nascimento, ds.data_nascimento)) AS data_nascimento,
                MAX(COALESCE(ps.idade_paciente, ds.idade_calc)) AS idade_anos,
                MIN(COALESCE(ps.primeira_data_atendimento, ds.data_laudo)) AS primeira_data,
                MAX(COALESCE(ps.ultima_data_atendimento, ds.data_laudo)) AS ultima_data,
                MAX(ps.procedimentos) AS procedimentos,
                COALESCE((ARRAY_AGG(ps.atendimentos) FILTER (WHERE ps.atendimentos IS NOT NULL))[1], '[]'::jsonb) AS atendimentos,
                COUNT(ds.id)::int AS total_laudos,
                COUNT(ds.id) FILTER (WHERE ds.tipo_laudo = 'MAMOGRAFIA')::int AS mamografias,
                COUNT(ds.id) FILTER (WHERE ds.tipo_laudo IN ('USG_MAMA', 'USG_MAMA_COMPLEMENTACAO'))::int AS usg_mama,
                COUNT(ds.id) FILTER (WHERE ds.tipo_laudo IN ('USG_TRANSVAGINAL', 'USG_TRANSVAGINAL_PELVICA'))::int AS usg_transvaginal,
                COUNT(ds.id) FILTER (WHERE ds.tipo_laudo LIKE 'USG_%')::int AS usgs,
                COUNT(ds.id) FILTER (WHERE ds.status_vinculo IN ('pendente', 'pendente_revisao'))::int AS pendentes,
                COALESCE(JSONB_AGG(
                    JSONB_BUILD_OBJECT(
                        'id', ds.id,
                        'tipoLaudo', ds.tipo_laudo,
                        'procedimento', ds.procedimento_raw,
                        'data', ds.data_laudo,
                        'statusVinculo', ds.status_vinculo,
                        'arquivoOriginal', ds.arquivo_original,
                        'temArquivoLocal', ds.caminho_armazenado IS NOT NULL AND ds.caminho_armazenado <> '',
                        'motivo', ds.vinculo_motivo
                    )
                    ORDER BY ds.data_laudo DESC NULLS LAST, ds.id DESC
                ) FILTER (WHERE ds.id IS NOT NULL), '[]'::jsonb) AS documentos
            FROM patients_scope ps
            FULL OUTER JOIN docs_scope ds ON ds.grupo = ps.grupo
            GROUP BY COALESCE(ps.grupo, ds.grupo)
        )
    `;
}

function buildPortalAlerts(row) {
    const idade = Number.isFinite(row.idadeAnos) ? row.idadeAnos : null;
    const alerts = [];
    if (idade === null) {
        alerts.push({ key: 'idade_desconhecida', label: 'Idade desconhecida', level: 'neutral' });
    }
    if (!row.totalLaudos) {
        alerts.push({ key: 'sem_laudo', label: 'Sem laudo disponivel', level: 'warning' });
    }
    if (idade !== null && idade >= 40 && !row.mamografias) {
        alerts.push({ key: '40mais_sem_mamografia', label: '40+ sem mamografia', level: 'warning' });
    }
    if (idade !== null && idade >= 40 && !row.mamografias && row.usgMama > 0) {
        alerts.push({ key: '40mais_apenas_usg_mama', label: '40+ apenas USG mama', level: 'info' });
    }
    if (idade !== null && idade < 40 && row.mamografias > 0) {
        alerts.push({ key: 'menor40_com_mamografia', label: 'Menor de 40 com mamografia', level: 'warning' });
    }
    return alerts;
}

function portalRowMatchesFilters(row, filters) {
    if (filters.search) {
        const haystack = [
            row.paciente,
            row.cpf,
            row.cns,
            row.telefone,
            row.procedimentos,
            ...(row.documentos || []).flatMap(doc => [doc.tipoLaudo, doc.procedimento, doc.arquivoOriginal]),
        ].join(' ').toLowerCase();
        if (!haystack.includes(filters.search.toLowerCase())) return false;
    }
    if (filters.tipo && !(row.documentos || []).some(doc => doc.tipoLaudo === filters.tipo)) {
        return false;
    }
    if (filters.status === 'com_laudo' && !row.totalLaudos) return false;
    if (filters.status === 'sem_laudo' && row.totalLaudos) return false;
    if (filters.status === 'pendente' && !row.pendentes) return false;
    if (filters.faixaIdade === '40mais' && !(row.idadeAnos >= 40)) return false;
    if (filters.faixaIdade === 'menor40' && !(row.idadeAnos < 40)) return false;
    if (filters.faixaIdade === 'desconhecida' && row.idadeAnos !== null) return false;
    if (filters.alerta && !(row.alertas || []).some(alert => alert.key === filters.alerta)) return false;
    const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00Z`) : null;
    const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59Z`) : null;
    if (dateFrom || dateTo) {
        const first = row.primeiraData ? new Date(row.primeiraData) : null;
        const last = row.ultimaData ? new Date(row.ultimaData) : null;
        if (!first && !last) return false;
        if (dateFrom && last && last < dateFrom) return false;
        if (dateTo && first && first > dateTo) return false;
    }
    return true;
}

async function queryPortalGestorPacientes(req, user) {
    const result = await ociPool.query(`${portalGestorBaseSql()} SELECT * FROM grouped ORDER BY ultima_data DESC NULLS LAST, paciente;`, [user.municipioId]);
    const allRows = result.rows.map(row => {
        const mapped = {
            grupoPaciente: row.grupo,
            paciente: row.paciente,
            cpf: row.cpf,
            cns: row.cns,
            telefone: row.telefone,
            dataNascimento: row.data_nascimento,
            idadeAnos: row.idade_anos === null ? null : Number(row.idade_anos),
            primeiraData: row.primeira_data,
            ultimaData: row.ultima_data,
            procedimentos: row.procedimentos || '',
            atendimentos: row.atendimentos || [],
            totalLaudos: Number(row.total_laudos || 0),
            mamografias: Number(row.mamografias || 0),
            usgMama: Number(row.usg_mama || 0),
            usgTransvaginal: Number(row.usg_transvaginal || 0),
            usgs: Number(row.usgs || 0),
            pendentes: Number(row.pendentes || 0),
            documentos: row.documentos || [],
        };
        mapped.alertas = buildPortalAlerts(mapped);
        return mapped;
    });

    const filters = {
        search: String(req.query.search || '').trim(),
        tipo: String(req.query.tipo || '').trim().toUpperCase(),
        status: String(req.query.status || '').trim().toLowerCase(),
        faixaIdade: String(req.query.faixaIdade || '').trim().toLowerCase(),
        alerta: String(req.query.alerta || '').trim().toLowerCase(),
        dateFrom: String(req.query.dateFrom || '').trim(),
        dateTo: String(req.query.dateTo || '').trim(),
    };
    const rows = allRows.filter(row => portalRowMatchesFilters(row, filters));
    const tipos = [...new Set(allRows.flatMap(row => (row.documentos || []).map(doc => doc.tipoLaudo).filter(Boolean)))].sort();
    const alertaOptions = [
        { key: '40mais_sem_mamografia', label: '40+ sem mamografia' },
        { key: '40mais_apenas_usg_mama', label: '40+ apenas USG mama' },
        { key: 'menor40_com_mamografia', label: 'Menor de 40 com mamografia' },
        { key: 'sem_laudo', label: 'Sem laudo disponivel' },
        { key: 'idade_desconhecida', label: 'Idade desconhecida' },
    ];
    return {
        user,
        filters,
        kpis: {
            totalPacientes: rows.length,
            comMamografia: rows.filter(row => row.mamografias > 0).length,
            comUsgMama: rows.filter(row => row.usgMama > 0).length,
            comUsgTransvaginal: rows.filter(row => row.usgTransvaginal > 0).length,
            semLaudo: rows.filter(row => row.totalLaudos === 0).length,
            comAlerta: rows.filter(row => row.alertas.length > 0).length,
        },
        options: { tipos, alertas: alertaOptions },
        rows: rows.slice(0, 500),
        totalRows: rows.length,
    };
}

async function queryPortalGestorDocument(user, laudoId) {
    const result = await ociPool.query(`
        ${portalGestorBaseSql()},
        docs AS (
            SELECT doc.*
            FROM grouped g
            CROSS JOIN LATERAL jsonb_to_recordset(g.documentos) AS doc(
                id bigint,
                "tipoLaudo" text,
                procedimento text,
                data date,
                "statusVinculo" text,
                "arquivoOriginal" text,
                "temArquivoLocal" boolean,
                motivo text
            )
        )
        SELECT lp.id, lp.arquivo_original, lp.caminho_armazenado, lp.storage_path
        FROM docs d
        JOIN oci.laudos_pacientes lp ON lp.id = d.id
        WHERE lp.id = $2::bigint
        LIMIT 1
    `, [user.municipioId, laudoId]);
    return result.rows[0] || null;
}

async function sendScopedLaudoPdf(res, document) {
    const storageRoot = path.resolve(__dirname, 'storage');
    const filePath = path.resolve(document.caminho_armazenado || '');
    const localOk = document.caminho_armazenado
        && isInsideDirectory(storageRoot, filePath)
        && path.extname(filePath).toLowerCase() === '.pdf'
        && fs.existsSync(filePath);

    if (!localOk) {
        const storagePath = document.storage_path;
        if (storagePath && isFirebaseConfigured && admin) {
            const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'vortexaiecolink.firebasestorage.app';
            const [signedUrl] = await admin.storage().bucket(bucketName).file(storagePath).getSignedUrl({
                action: 'read',
                expires: Date.now() + 15 * 60 * 1000,
            });
            return res.redirect(signedUrl);
        }
        return res.status(404).json({ success: false, message: 'Arquivo PDF nao disponivel.' });
    }

    return res.sendFile(filePath, {
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${path.basename(document.arquivo_original || filePath).replace(/"/g, '')}"`,
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

async function ensureLaudoReviewTable() {
    await ociPool.query(`
        CREATE TABLE IF NOT EXISTS oci.laudos_pacientes_revisoes (
            id bigserial PRIMARY KEY,
            laudo_id bigint NOT NULL REFERENCES oci.laudos_pacientes(id) ON DELETE CASCADE,
            acao text NOT NULL,
            paciente_id_anterior bigint NULL,
            paciente_id_novo bigint NULL REFERENCES oci.pacientes(id),
            revisado_por text NOT NULL DEFAULT 'master',
            motivo text NULL,
            criado_em timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_laudos_revisoes_laudo_id
            ON oci.laudos_pacientes_revisoes(laudo_id);
    `);
}

async function queryLaudoReviewCandidates(laudoId, search) {
    const laudoResult = await ociPool.query(`
        SELECT
            id,
            paciente_id,
            nome_extraido,
            nome_normalizado,
            cartao_sus,
            telefone,
            tipo_laudo,
            data_nascimento,
            idade_anos,
            status_vinculo,
            arquivo_original
        FROM oci.laudos_pacientes
        WHERE id = $1::bigint
        LIMIT 1;
    `, [laudoId]);
    const laudo = laudoResult.rows[0] || null;
    if (!laudo) {
        return null;
    }

    // dados extras do laudo usados como âncoras de decisão
    const laudoExtra = await ociPool.query(`
        SELECT data_realizacao, regiao_pasta FROM oci.laudos_pacientes WHERE id = $1::bigint
    `, [laudoId]);
    const dataLaudo = laudoExtra.rows[0]?.data_realizacao || null;
    const regiaoLaudo = laudoExtra.rows[0]?.regiao_pasta || null;

    const searchText = normalizeAccessText(search || laudo.nome_extraido || laudo.nome_normalizado || '');

    // Candidatos por similaridade trigram OU por conter os tokens do nome,
    // enriquecidos com âncoras: atendimento na data do laudo (±1 dia), regiões,
    // municípios e datas dos atendimentos do candidato.
    let candidates = [];
    if (searchText) {
        const candidateResult = await ociPool.query(`
            SELECT
                p.id,
                p.nome_preferido,
                p.patient_key,
                (p.patient_key = $1) AS exact_match,
                ROUND(similarity(p.patient_key, $1)::numeric, 3) AS similaridade,
                EXISTS (
                    SELECT 1 FROM oci.atendimentos a
                    WHERE a.paciente_id = p.id
                      AND $2::date IS NOT NULL
                      AND ABS(a.data_atendimento - $2::date) <= 1
                ) AS atendimento_na_data,
                (
                    SELECT STRING_AGG(DISTINCT a.regiao, ', ' ORDER BY a.regiao)
                    FROM oci.atendimentos a WHERE a.paciente_id = p.id
                ) AS regioes,
                (
                    SELECT STRING_AGG(DISTINCT m.nome, ', ' ORDER BY m.nome)
                    FROM oci.atendimentos a JOIN oci.municipios m ON m.id = a.municipio_id
                    WHERE a.paciente_id = p.id
                ) AS municipios,
                (
                    SELECT STRING_AGG(DISTINCT TO_CHAR(a.data_atendimento, 'DD/MM/YYYY'), ', '
                                      ORDER BY TO_CHAR(a.data_atendimento, 'DD/MM/YYYY'))
                    FROM oci.atendimentos a WHERE a.paciente_id = p.id
                ) AS datas_atendimento
            FROM oci.pacientes p
            WHERE similarity(p.patient_key, $1) >= 0.35
               OR p.patient_key LIKE '%' || REPLACE($1, ' ', '%') || '%'
            ORDER BY exact_match DESC, atendimento_na_data DESC, similaridade DESC, p.nome_preferido
            LIMIT 20;
        `, [searchText, dataLaudo]);
        candidates = candidateResult.rows.map(row => ({
            id: row.id,
            nomePreferido: row.nome_preferido,
            patientKey: row.patient_key,
            exactMatch: row.exact_match === true,
            similaridade: Number(row.similaridade || 0),
            atendimentoNaData: row.atendimento_na_data === true,
            regioes: row.regioes || '',
            municipios: row.municipios || '',
            datasAtendimento: row.datas_atendimento || '',
        }));
    }

    return {
        laudo: {
            id: laudo.id,
            pacienteId: laudo.paciente_id,
            nomeExtraido: laudo.nome_extraido,
            nomeNormalizado: laudo.nome_normalizado,
            cartaoSus: laudo.cartao_sus,
            telefone: laudo.telefone,
            tipoLaudo: laudo.tipo_laudo,
            dataNascimento: laudo.data_nascimento,
            idadeAnos: laudo.idade_anos,
            statusVinculo: laudo.status_vinculo,
            arquivoOriginal: laudo.arquivo_original,
            dataRealizacao: dataLaudo,
            regiaoPasta: regiaoLaudo,
        },
        candidates,
    };
}

async function applyLaudoManualReview(laudoId, payload) {
    await ensureLaudoReviewTable();

    const action = String(payload.acao || '').trim();
    const motivo = String(payload.motivo || '').trim() || null;
    const revisadoPor = String(payload.revisadoPor || 'master').trim() || 'master';
    const pacienteId = payload.pacienteId ? Number(payload.pacienteId) : null;

    if (!['vincular', 'nao_encontrado', 'ignorar', 'desvincular'].includes(action)) {
        const error = new Error('Acao de revisao invalida.');
        error.statusCode = 400;
        throw error;
    }

    if (action === 'vincular' && (!Number.isInteger(pacienteId) || pacienteId <= 0)) {
        const error = new Error('Selecione um paciente para vincular.');
        error.statusCode = 400;
        throw error;
    }

    if (action === 'desvincular' && String(payload.senha || '') !== UNLINK_PASSWORD) {
        const error = new Error('Senha de desvinculação incorreta.');
        error.statusCode = 403;
        throw error;
    }

    const client = await ociPool.connect();
    try {
        await client.query('BEGIN');

        const laudoResult = await client.query(`
            SELECT id, paciente_id
            FROM oci.laudos_pacientes
            WHERE id = $1::bigint
            FOR UPDATE;
        `, [laudoId]);
        const laudo = laudoResult.rows[0];
        if (!laudo) {
            const error = new Error('Laudo nao encontrado.');
            error.statusCode = 404;
            throw error;
        }

        let newPacienteId = null;
        if (action === 'vincular') {
            const patientResult = await client.query(
                'SELECT id FROM oci.pacientes WHERE id = $1::bigint LIMIT 1',
                [pacienteId],
            );
            if (!patientResult.rowCount) {
                const error = new Error('Paciente selecionado nao existe.');
                error.statusCode = 400;
                throw error;
            }
            newPacienteId = pacienteId;
            await client.query(`
                UPDATE oci.laudos_pacientes
                SET paciente_id = $2::bigint,
                    status_vinculo = 'revisado_manual',
                    confianca_vinculo = 1,
                    vinculo_motivo = COALESCE($3, 'revisao_manual')
                WHERE id = $1::bigint;
            `, [laudoId, newPacienteId, motivo]);
        } else if (action === 'nao_encontrado') {
            await client.query(`
                UPDATE oci.laudos_pacientes
                SET paciente_id = NULL,
                    status_vinculo = 'nao_encontrado',
                    confianca_vinculo = NULL,
                    vinculo_motivo = COALESCE($2, 'revisao_manual_nao_encontrado')
                WHERE id = $1::bigint;
            `, [laudoId, motivo]);
        } else if (action === 'desvincular') {
            if (!laudo.paciente_id) {
                const error = new Error('Este laudo ja esta sem vinculo.');
                error.statusCode = 400;
                throw error;
            }
            await client.query(`
                UPDATE oci.laudos_pacientes
                SET paciente_id = NULL,
                    atendimento_procedimento_id = NULL,
                    status_vinculo = 'pendente_revisao',
                    confianca_vinculo = NULL,
                    vinculo_motivo = COALESCE($2, 'desvinculado_manual')
                WHERE id = $1::bigint;
            `, [laudoId, motivo]);
        } else {
            await client.query(`
                UPDATE oci.laudos_pacientes
                SET status_vinculo = 'ignorado_revisao',
                    vinculo_motivo = COALESCE($2, 'revisao_manual_ignorado')
                WHERE id = $1::bigint;
            `, [laudoId, motivo]);
        }

        await client.query(`
            INSERT INTO oci.laudos_pacientes_revisoes (
                laudo_id,
                acao,
                paciente_id_anterior,
                paciente_id_novo,
                revisado_por,
                motivo
            )
            VALUES ($1, $2, $3, $4, $5, $6);
        `, [laudoId, action, laudo.paciente_id, newPacienteId, revisadoPor, motivo]);

        await client.query('COMMIT');
        return { laudoId, acao: action, pacienteIdAnterior: laudo.paciente_id, pacienteIdNovo: newPacienteId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function buildProcedureWhere(filters, startIndex = 1) {
    const clauses = [];
    const values = [];
    let idx = startIndex;

    if (filters.regiao) {
        clauses.push(`a.regiao = $${idx++}`);
        values.push(filters.regiao);
    }

    if (filters.competencia) {
        clauses.push(`a.competencia = $${idx++}`);
        values.push(filters.competencia);
    }

    if (filters.search) {
        clauses.push(`(
            p.nome_preferido ILIKE $${idx}
            OR m.nome ILIKE $${idx}
            OR a.oci_agendada ILIKE $${idx}
            OR a.oci_extra ILIKE $${idx}
            OR a.observacao ILIKE $${idx}
            OR a.source_sheet ILIKE $${idx}
        )`);
        values.push(`%${filters.search}%`);
        idx++;
    }

    return {
        whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
        values,
    };
}

function buildOciWhere(filters, startIndex = 1) {
    const clauses = [];
    const values = [];
    let idx = startIndex;

    if (filters.regiao) {
        clauses.push(`a.regiao = $${idx++}`);
        values.push(filters.regiao);
    }

    if (filters.competencia) {
        clauses.push(`a.competencia = $${idx++}`);
        values.push(filters.competencia);
    }

    if (filters.search) {
        clauses.push(`(
            p.nome_preferido ILIKE $${idx}
            OR m.nome ILIKE $${idx}
            OR ao.codigo_oci ILIKE $${idx}
            OR o.nome_oci ILIKE $${idx}
            OR a.source_sheet ILIKE $${idx}
        )`);
        values.push(`%${filters.search}%`);
        idx++;
    }

    return {
        whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
        values,
    };
}

async function queryOciProductionTotals(filters) {
    const { whereSql, values } = buildOciWhere(filters);
    const sql = `
        WITH filtered AS (
            SELECT
                p.patient_key,
                ao.codigo_oci,
                UPPER(CONCAT_WS(' ', COALESCE(a.oci_agendada, ''), COALESCE(a.oci_extra, ''), COALESCE(a.observacao, ''))) AS texto_origem
            FROM oci.atendimentos a
            JOIN oci.pacientes p ON p.id = a.paciente_id
            JOIN oci.municipios m ON m.id = a.municipio_id
            JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
            JOIN oci.ocis o ON o.codigo_oci = ao.codigo_oci
            ${whereSql}
        ),
        by_patient_oci AS (
            SELECT
                patient_key,
                codigo_oci,
                STRING_AGG(DISTINCT texto_origem, ' | ' ORDER BY texto_origem) AS texto_origem
            FROM filtered
            GROUP BY patient_key, codigo_oci
        )
        SELECT codigo_oci, texto_origem
        FROM by_patient_oci;
    `;
    const result = await ociPool.query(sql, values);
    let procedimentosSemConsulta = 0;
    let consultasEspecialistas = 0;
    for (const row of result.rows) {
        const procedures = proceduresForOci(row.codigo_oci, row.texto_origem);
        procedimentosSemConsulta += procedures.filter(proc => !proc.procedimento.toUpperCase().includes('CONSULTA')).length;
        consultasEspecialistas += 1;
    }
    return {
        procedimentosSemConsulta,
        consultasEspecialistas,
        totalProcedimentosEConsultas: procedimentosSemConsulta + consultasEspecialistas,
    };
}

async function queryOciSummary(filters) {
    const { whereSql, values } = buildOciWhere(filters);
    const consolidatedSql = `SELECT DISTINCT patient_key, paciente, codigo_oci, nome_oci, valor_sigtap
           FROM filtered
           WHERE codigo_oci IS NOT NULL`;
    const sql = `
        WITH filtered AS (
            SELECT
                a.atendimento_uid,
                a.data_atendimento,
                a.competencia,
                a.regiao,
                p.patient_key,
                p.nome_preferido AS paciente,
                m.nome AS municipio,
                ao.codigo_oci,
                o.nome_oci,
                o.valor_sigtap,
                UPPER(CONCAT_WS(' ', COALESCE(a.oci_agendada, ''), COALESCE(a.oci_extra, ''), COALESCE(a.observacao, ''))) AS texto_origem
            FROM oci.atendimentos a
            JOIN oci.pacientes p ON p.id = a.paciente_id
            JOIN oci.municipios m ON m.id = a.municipio_id
            LEFT JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
            LEFT JOIN oci.ocis o ON o.codigo_oci = ao.codigo_oci
            ${whereSql}
        ),
        consolidated AS (
            ${consolidatedSql}
        ),
        kpis AS (
            SELECT
                (SELECT COUNT(DISTINCT patient_key) FROM filtered) AS pacientes_atendidos,
                (SELECT COUNT(DISTINCT patient_key) FROM consolidated) AS pacientes_com_oci,
                (SELECT COUNT(*) FROM consolidated) AS total_ocis,
                (SELECT COUNT(DISTINCT patient_key) FROM consolidated) AS consultas_minimas,
                (SELECT COUNT(*) FROM consolidated) AS consultas_equivalentes_oci,
                (SELECT COALESCE(SUM(valor_sigtap), 0) FROM consolidated) AS valor_total,
                (SELECT COUNT(*) FROM filtered WHERE codigo_oci IS NULL) AS pendencias_sem_oci
        )
        SELECT
            (SELECT row_to_json(kpis) FROM kpis) AS kpis,
            COALESCE(
                (
                    SELECT json_agg(row_to_json(x) ORDER BY x.ordem)
                    FROM (
                        SELECT
                            c.codigo_oci,
                            c.nome_oci,
                            COUNT(*)::int AS qtd_oci,
                            COALESCE(SUM(c.valor_sigtap), 0)::numeric AS valor_total,
                            ARRAY_POSITION($${values.length + 1}::text[], c.codigo_oci) AS ordem
                        FROM consolidated c
                        GROUP BY c.codigo_oci, c.nome_oci
                    ) x
                ),
                '[]'::json
            ) AS por_oci;
    `;
    const result = await ociPool.query(sql, [...values, OCI_CODES_ORDER]);
    const data = result.rows[0] || { kpis: {}, por_oci: [] };
    const kpis = data.kpis || {};
    const productionTotals = await queryOciProductionTotals(filters);
    const laudosKpis = await queryLaudosKpis(filters);
    const response = {
        kpis: {
            pacientesAtendidos: Number(kpis.pacientes_atendidos || 0),
            pacientesComOci: Number(kpis.pacientes_com_oci || 0),
            totalOcis: Number(kpis.total_ocis || 0),
            consultasMinimas: Number(kpis.consultas_minimas || 0),
            consultasEquivalentesOci: Number(kpis.consultas_equivalentes_oci || 0),
            procedimentosSemConsulta: productionTotals.procedimentosSemConsulta,
            consultasEspecialistas: productionTotals.consultasEspecialistas,
            totalProcedimentosEConsultas: productionTotals.totalProcedimentosEConsultas,
            pendenciasSemOci: filters.canViewPending ? Number(kpis.pendencias_sem_oci || 0) : null,
        },
        laudos: laudosKpis,
        porOci: (data.por_oci || []).map(row => {
            const item = {
                codigoOci: row.codigo_oci,
                nomeOci: row.nome_oci,
                qtdOci: Number(row.qtd_oci || 0),
            };
            if (filters.includeValues) {
                item.valorTotal = Number(row.valor_total || 0);
            }
            return item;
        }),
    };
    if (filters.includeValues) {
        response.kpis.valorTotal = Number(kpis.valor_total || 0);
    }
    return response;
}

// KPIs de laudos vinculados por paciente, respeitando os filtros do dashboard.
// "Pacientes no filtro" vêm dos atendimentos (regiao/competencia/busca); os
// laudos contados são os vinculados e ativos desses pacientes — quando há
// filtro de competência, o laudo também precisa ser do mesmo mês.
async function queryLaudosKpis(filters) {
    const { whereSql, values } = buildProcedureWhere(filters);
    const params = [...values];
    let laudoCompetenciaSql = '';
    if (filters.competencia) {
        params.push(filters.competencia);
        laudoCompetenciaSql = `AND TO_CHAR(lp.data_realizacao, 'YYYY-MM') = $${params.length}`;
    }
    const sql = `
        WITH pacientes_filtrados AS (
            SELECT DISTINCT p.id
            FROM oci.atendimentos a
            JOIN oci.pacientes p ON p.id = a.paciente_id
            JOIN oci.municipios m ON m.id = a.municipio_id
            ${whereSql}
        ),
        laudos_validos AS (
            SELECT DISTINCT lp.paciente_id, lp.tipo_laudo
            FROM oci.laudos_pacientes lp
            JOIN pacientes_filtrados pf ON pf.id = lp.paciente_id
            WHERE lp.registro_ativo
              AND lp.status_vinculo NOT IN ('descartado', 'quarentena')
              ${laudoCompetenciaSql}
        )
        SELECT
            (SELECT COUNT(*) FROM pacientes_filtrados) AS pacientes_totais,
            COUNT(DISTINCT paciente_id) FILTER (WHERE tipo_laudo = 'MAMOGRAFIA') AS com_mamografia,
            COUNT(DISTINCT paciente_id) FILTER (WHERE tipo_laudo LIKE 'USG%') AS com_usg,
            COUNT(DISTINCT paciente_id) FILTER (WHERE tipo_laudo IN ('USG_TRANSVAGINAL', 'USG_TRANSVAGINAL_PELVICA')) AS com_usg_transvaginal,
            COUNT(DISTINCT paciente_id) FILTER (WHERE tipo_laudo IN ('USG_MAMA', 'USG_MAMA_COMPLEMENTACAO')) AS com_usg_mama,
            COUNT(DISTINCT paciente_id) FILTER (WHERE tipo_laudo IN ('USG_PELVICA', 'USG_TRANSVAGINAL_PELVICA')) AS com_usg_pelvica
        FROM laudos_validos;
    `;
    const result = await ociPool.query(sql, params);
    const row = result.rows[0] || {};
    return {
        pacientesTotais: Number(row.pacientes_totais || 0),
        comLaudoMamografia: Number(row.com_mamografia || 0),
        comLaudoUsg: Number(row.com_usg || 0),
        comLaudoUsgTransvaginal: Number(row.com_usg_transvaginal || 0),
        comLaudoUsgMama: Number(row.com_usg_mama || 0),
        comLaudoUsgPelvica: Number(row.com_usg_pelvica || 0),
    };
}

function proceduresForOci(codigoOci, sourceText = '') {
    const text = String(sourceText || '').toUpperCase();
    const consultation = {
        codigo: '03.01.01.007-2 / 03.01.01.030-7',
        procedimento: SPECIALIST_CONSULT_LABEL,
        status: 'CONCLUIDO',
    };
    const base = {
        '09.01.01.001-4': [
            { codigo: text.includes('MAMOGRAFIA') ? '02.04.03.003-0' : '02.04.03.003-0 / 02.05.02.009-7', procedimento: text.includes('MAMOGRAFIA') ? 'Mamografia' : 'Mamografia / Ultrassonografia Mamaria Bilateral', status: 'CONCLUIDO' },
        ],
        '09.06.01.001-2': [
            { codigo: '02.05.02.018-6', procedimento: 'Ultrassonografia Transvaginal', status: 'CONCLUIDO' },
        ],
        '09.06.01.002-0': [
            { codigo: '02.05.02.016-0', procedimento: 'Ultrassonografia Pelvica (Ginecologica)', status: 'CONCLUIDO' },
        ],
        '09.01.01.005-7': [
            { codigo: '02.11.04.002-9', procedimento: 'Colposcopia', status: 'CONCLUIDO' },
            ...(text.includes('BIO') || text.includes('BIÓPSIA') ? [
                { codigo: '02.01.01.066-6', procedimento: 'Biopsia do Colo Uterino', status: 'CONCLUIDO' },
                { codigo: '02.03.02.008-1', procedimento: 'Exame Anatomo-Patologico do Colo Uterino - Biopsia', status: 'CONCLUIDO' },
            ] : []),
        ],
        '09.01.01.010-3': [
            { codigo: '02.01.01.056-9 / 02.01.01.060-7', procedimento: 'Biopsia/Exerese de Nodulo de Mama ou Puncao de Mama por Agulha Grossa', status: 'CONCLUIDO' },
            { codigo: '02.03.02.006-5', procedimento: 'Exame Anatomopatologico de Mama - Biopsia', status: 'CONCLUIDO' },
        ],
        '09.01.01.011-1': [
            { codigo: '02.11.04.002-9', procedimento: 'Colposcopia', status: 'CONCLUIDO' },
            { codigo: '04.09.06.008-9', procedimento: 'Excisao Tipo I do Colo Uterino', status: 'CONCLUIDO' },
            { codigo: '02.03.02.002-2', procedimento: 'Exame Anatomo-Patologico do Colo Uterino - Peca Cirurgica', status: 'CONCLUIDO' },
        ],
        '09.01.01.012-0': [
            { codigo: '02.11.04.002-9', procedimento: 'Colposcopia', status: 'CONCLUIDO' },
            { codigo: '04.09.06.030-5', procedimento: 'Excisao Tipo 2 do Colo Uterino', status: 'CONCLUIDO' },
            { codigo: '02.03.02.002-2', procedimento: 'Exame Anatomo-Patologico do Colo Uterino - Peca Cirurgica', status: 'CONCLUIDO' },
        ],
    };
    return [...(base[codigoOci] || []), consultation];
}
async function queryOciNominal(filters) {
    const { whereSql, values } = buildOciWhere(filters);
    const sql = `
        WITH filtered AS (
            SELECT
                a.data_atendimento,
                a.competencia,
                p.patient_key,
                p.nome_preferido AS paciente,
                m.nome AS municipio,
                ao.codigo_oci,
                o.nome_oci,
                o.valor_sigtap,
                UPPER(CONCAT_WS(' ', COALESCE(a.oci_agendada, ''), COALESCE(a.oci_extra, ''), COALESCE(a.observacao, ''))) AS texto_origem
            FROM oci.atendimentos a
            JOIN oci.pacientes p ON p.id = a.paciente_id
            JOIN oci.municipios m ON m.id = a.municipio_id
            JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
            JOIN oci.ocis o ON o.codigo_oci = ao.codigo_oci
            ${whereSql}
        ),
        by_patient_oci AS (
            SELECT
                patient_key,
                MIN(paciente) AS paciente,
                codigo_oci,
                MIN(nome_oci) AS nome_oci,
                MIN(valor_sigtap) AS valor_sigtap,
                STRING_AGG(DISTINCT municipio, ', ' ORDER BY municipio) AS municipios_oci,
                STRING_AGG(DISTINCT TO_CHAR(data_atendimento, 'DD/MM/YYYY'), ', ' ORDER BY TO_CHAR(data_atendimento, 'DD/MM/YYYY')) AS datas_oci,
                STRING_AGG(DISTINCT competencia, ', ' ORDER BY competencia) AS competencias_oci,
                STRING_AGG(DISTINCT texto_origem, ' | ' ORDER BY texto_origem) AS texto_origem
            FROM filtered
            GROUP BY patient_key, codigo_oci
        ),
        by_patient AS (
            SELECT
                patient_key,
                MIN(paciente) AS paciente,
                STRING_AGG(DISTINCT municipios_oci, ', ' ORDER BY municipios_oci) AS municipios,
                STRING_AGG(DISTINCT datas_oci, ', ' ORDER BY datas_oci) AS datas,
                STRING_AGG(DISTINCT competencias_oci, ', ' ORDER BY competencias_oci) AS competencias,
                STRING_AGG(DISTINCT nome_oci, '; ' ORDER BY nome_oci) AS ocis_realizadas,
                STRING_AGG(DISTINCT codigo_oci, '; ' ORDER BY codigo_oci) AS codigos_oci,
                COUNT(*)::int AS total_ocis,
                CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END AS consulta_minima_especialista,
                COUNT(*)::int AS consulta_equivalente_por_oci,
                COALESCE(SUM(valor_sigtap), 0)::numeric AS valor_total,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'codigoOci', codigo_oci,
                        'nomeOci', nome_oci,
                        'datas', datas_oci,
                        'municipios', municipios_oci,
                        'textoOrigem', texto_origem
                    ) ORDER BY codigo_oci
                ) AS oci_details
            FROM by_patient_oci
            GROUP BY patient_key
        )
        SELECT *
        FROM by_patient
        ORDER BY paciente
        LIMIT 2000;
    `;
    const result = await ociPool.query(sql, values);
    return result.rows.map(row => {
        const ociDetails = (row.oci_details || []).map(detail => ({
            codigoOci: detail.codigoOci,
            nomeOci: detail.nomeOci,
            datas: detail.datas,
            municipios: detail.municipios,
            procedimentos: proceduresForOci(detail.codigoOci, detail.textoOrigem),
        }));
        const item = {
            pacienteKey: row.patient_key,
            paciente: row.paciente,
            municipios: row.municipios,
            datas: row.datas,
            competencias: row.competencias,
            ocisRealizadas: row.ocis_realizadas,
            codigosOci: row.codigos_oci,
            totalOcis: Number(row.total_ocis || 0),
            consultaMinimaEspecialista: Number(row.consulta_minima_especialista || 0),
            consultaEquivalentePorOci: Number(row.consulta_equivalente_por_oci || 0),
            consultaEspecialistaRotulo: SPECIALIST_CONSULT_LABEL,
            ociDetails,
        };
        if (filters.includeValues) {
            item.valorTotal = Number(row.valor_total || 0);
        }
        return item;
    });
}
async function queryOciProcedures(filters) {
    // Lê o grão fino gravado pelo importador (scripts/importar-planilha-brenda.mjs)
    // em oci.atendimento_procedimentos, em vez de derivar por regex do texto cru.
    // Isso cobre também os formatos da aba JUNHO VALENCA (MAMO, USG.MAMA, etc.).
    const { whereSql, values } = buildProcedureWhere(filters);
    const sql = `
        SELECT
            ap.procedimento,
            CASE
                WHEN ap.codigo_oci IN ('09.01.01.001-4', '09.01.01.010-3') THEN 'Mama'
                WHEN ap.codigo_oci LIKE '09.06.%' THEN 'Ginecologia'
                ELSE 'Colo do utero'
            END AS categoria,
            COUNT(*)::int AS quantidade,
            COUNT(DISTINCT p.patient_key)::int AS pacientes_unicos,
            STRING_AGG(DISTINCT ap.codigo_oci, '; ' ORDER BY ap.codigo_oci) AS ocis_relacionadas
        FROM oci.atendimento_procedimentos ap
        JOIN oci.atendimentos a ON a.atendimento_uid = ap.atendimento_uid
        JOIN oci.pacientes p ON p.id = a.paciente_id
        JOIN oci.municipios m ON m.id = a.municipio_id
        ${whereSql ? `${whereSql} AND ap.status = 'REALIZADO'` : `WHERE ap.status = 'REALIZADO'`}
        GROUP BY ap.procedimento, categoria
        ORDER BY quantidade DESC, ap.procedimento;
    `;
    const result = await ociPool.query(sql, values);
    return result.rows.map(row => ({
        procedimento: row.procedimento,
        categoria: row.categoria,
        quantidade: Number(row.quantidade || 0),
        pacientesUnicos: Number(row.pacientes_unicos || 0),
        ocisRelacionadas: row.ocis_relacionadas || '',
    }));
}
async function queryOciPending(filters) {
    const { whereSql, values } = buildOciWhere(filters);
    const sql = `
        SELECT
            a.data_atendimento,
            p.nome_preferido AS paciente,
            m.nome AS municipio,
            a.competencia,
            a.regiao,
            a.source_sheet,
            a.source_row,
            COALESCE(a.oci_agendada, '') AS oci_agendada,
            COALESCE(a.oci_extra, '') AS oci_extra,
            COALESCE(a.observacao, '') AS observacao
        FROM oci.atendimentos a
        JOIN oci.pacientes p ON p.id = a.paciente_id
        JOIN oci.municipios m ON m.id = a.municipio_id
        LEFT JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
        LEFT JOIN oci.ocis o ON o.codigo_oci = ao.codigo_oci
        ${whereSql ? `${whereSql} AND ao.atendimento_uid IS NULL` : 'WHERE ao.atendimento_uid IS NULL'}
        ORDER BY a.regiao, a.competencia, a.data_atendimento, p.nome_preferido
        LIMIT 500;
    `;
    const result = await ociPool.query(sql, values);
    return result.rows.map(row => ({
        data: row.data_atendimento ? new Date(row.data_atendimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '',
        paciente: row.paciente,
        municipio: row.municipio,
        competencia: row.competencia,
        regiao: row.regiao,
        sourceSheet: row.source_sheet,
        sourceRow: row.source_row,
        ociAgendada: row.oci_agendada,
        ociExtra: row.oci_extra,
        observacao: row.observacao,
    }));
}

function addWorksheetRows(ws, headers, rows) {
    ws.addRow(headers.map(h => h.label));
    ws.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    rows.forEach(row => {
        ws.addRow(headers.map(h => row[h.key]));
    });
    ws.columns = headers.map(h => ({ width: h.width || 18 }));
    ws.autoFilter = { from: 'A1', to: ws.getRow(1).getCell(headers.length).address };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
}

const DEFAULT_FILE_PATH = path.join(__dirname, 'formes base consolidados.md');
const FILE_PATH = process.env.DATABASE_PATH || DEFAULT_FILE_PATH;

// Se DATABASE_PATH for definido (ex: volume persistente no Zeabur) e o arquivo não existir lá,
// inicializamos copiando o arquivo consolidado padrão do repositório para evitar que comece vazio.
if (process.env.DATABASE_PATH && !fs.existsSync(FILE_PATH) && fs.existsSync(DEFAULT_FILE_PATH)) {
    try {
        const parentDir = path.dirname(FILE_PATH);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.copyFileSync(DEFAULT_FILE_PATH, FILE_PATH);
        console.log(`Banco de dados consolidado inicial copiado para: ${FILE_PATH}`);
    } catch (err) {
        console.error(`Erro ao inicializar arquivo no volume persistente:`, err);
    }
}

// Estrutura de campos mapeada exatamente na ordem em que aparecem no Markdown
const FIELDS = [
    { key: 'dates', header: '1. Data de preenchimento:' },
    { key: 'agendadas', header: 'Número de pessoas agendadas:' },
    { key: 'atendidas', header: 'Número de pessoas atendidas:' },
    { key: 'faltaram', header: 'Número de pessoas que faltaram:' },
    { key: 'vagas', header: 'Número de Vagas ofertadas' },
    { key: 'consultas', header: 'Número de Consultas Médicas:' },
    { key: 'usg_mamaria', header: 'Número de USG de Mamária:' },
    { key: 'usg_transvaginal', header: 'Número de USG Transvaginal:' },
    { key: 'usg_pelvica', header: 'Número de USG Pélvica:' },
    { key: 'mamografia', header: 'Número de Mamografia:' },
    { key: 'puncao_mama', header: 'Número de Punção de Mama por Agulha Grossa:' },
    { key: 'biopsia_mama', header: 'Número de Exame Anatomopatológico de Mama - Biópsia:' },
    { key: 'colposcopia', header: 'Número de Colposcopia:' },
    { key: 'biopsia_colo', header: 'Número de Biópsia do Colo Uterino:' },
    { key: 'biopsia_colo_anatomopatologico', header: 'Número de Exame Anatomo-Patológico do Colo Uterino - Biópsia:' },
    { key: 'oci_fechadas', header: 'Número de OCI fechadas:' },
    { key: 'responsavel', header: 'Nome do responsável pelo preenchimento:' }
];

// Função para fazer o parser do arquivo Markdown em JSON
function readData() {
    if (!fs.existsSync(FILE_PATH)) {
        return [];
    }

    const content = fs.readFileSync(FILE_PATH, 'utf-8');
    
    // Identificar a ordem das seções no arquivo de acordo com a posição dos cabeçalhos
    const positions = [];
    FIELDS.forEach(f => {
        const idx = content.indexOf(f.header);
        if (idx !== -1) {
            positions.push({ key: f.key, header: f.header, index: idx });
        }
    });

    // Ordenar de acordo com a ordem de aparição física no arquivo
    positions.sort((a, b) => a.index - b.index);

    const parsedData = {};

    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const nextPos = positions[i + 1];
        const start = pos.index + pos.header.length;
        const end = nextPos ? nextPos.index : content.length;
        
        const blockText = content.substring(start, end);
        const starIdx = blockText.indexOf('*');
        
        if (starIdx !== -1) {
            const valuesText = blockText.substring(starIdx + 1);
            let lines = valuesText.split(/\r?\n/).map(l => l.trim());
            
            // Remove linhas vazias iniciais de formatação física (mas preserva o resto)
            if (lines.length > 0 && lines[0] === '') {
                lines.shift();
            }

            if (pos.key === 'dates') {
                // Datas não devem conter linhas em branco
                parsedData[pos.key] = lines.filter(l => l !== '');
            } else {
                parsedData[pos.key] = lines;
            }
        } else {
            parsedData[pos.key] = [];
        }
    }

    const dates = parsedData.dates || [];
    const records = [];

    for (let i = 0; i < dates.length; i++) {
        const record = {};
        FIELDS.forEach(f => {
            if (f.key === 'dates') {
                record.dates = dates[i];
            } else {
                const values = parsedData[f.key] || [];
                let val = values[i];
                if (val === undefined || val === '') {
                    val = (f.key === 'responsavel') ? '-' : '0';
                }
                record[f.key] = val;
            }
        });
        records.push(record);
    }

    return records;
}

// Ordenar registros cronologicamente
function sortRecords(records) {
    return records.sort((a, b) => {
        const [dayA, monthA, yearA] = a.dates.split('/').map(Number);
        const [dayB, monthB, yearB] = b.dates.split('/').map(Number);
        const dateA = new Date(yearA, monthA - 1, dayA);
        const dateB = new Date(yearB, monthB - 1, dayB);
        return dateA - dateB;
    });
}

// Salvar registros no arquivo Markdown mantendo a formatação exata
function writeData(records) {
    const sorted = sortRecords(records);
    
    let content = 'formes base consolidados diaria carreta programa agora tem especialista\n\n\n\n\n';
    
    FIELDS.forEach(f => {
        content += `${f.header}\n`;
        content += `*\n`;
        
        sorted.forEach(r => {
            let val = r[f.key];
            if (val === undefined || val === '') {
                val = (f.key === 'responsavel') ? '-' : '0';
            }
            content += `${val}\n`;
        });
        
        content += `\n\n\n\n`;

        // Seção estática de Tipologia após o campo 'vagas'
        if (f.key === 'vagas') {
            content += `7. Tipologia: \n*Tipologia 2: Prevenção e Cuidado da Saúde da Mulher\n\n\n\n`;
        }
    });

    fs.writeFileSync(FILE_PATH, content.trim() + '\n', 'utf-8');
}

// Endpoint GET: Retornar todos os registros
app.get('/api/data', async (req, res) => {
    try {
        if (isFirebaseConfigured && db) {
            const snapshot = await db.collection('daily_records').get();
            const records = [];
            snapshot.forEach(doc => {
                records.push(doc.data());
            });
            const sorted = sortRecords(records);
            res.json({ success: true, data: sorted });
        } else {
            const records = readData();
            res.json({ success: true, data: records });
        }
    } catch (error) {
        console.error('Erro ao ler os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar os dados.' });
    }
});

// Endpoint POST: Salvar ou atualizar registro diário
app.post('/api/save', async (req, res) => {
    try {
        const newRecord = req.body;
        
        if (!newRecord.dates || !/^\d{2}\/\d{2}\/\d{4}$/.test(newRecord.dates)) {
            return res.status(400).json({ success: false, message: 'Data inválida. Use o formato DD/MM/AAAA.' });
        }

        if (isFirebaseConfigured && db) {
            // IDs de documentos do Firestore não podem conter "/"
            const docId = newRecord.dates.replace(/\//g, '-');
            await db.collection('daily_records').doc(docId).set(newRecord, { merge: true });
            
            // Buscar todos para retornar atualizados
            const snapshot = await db.collection('daily_records').get();
            const records = [];
            snapshot.forEach(doc => {
                records.push(doc.data());
            });
            const sorted = sortRecords(records);
            
            // Backup opcional local no arquivo Markdown
            try {
                writeData(sorted);
            } catch (err) {
                console.warn('Falha ao atualizar backup do Markdown local:', err.message);
            }

            res.json({ success: true, message: 'Dados salvos no Firebase com sucesso!', data: sorted });
        } else {
            let records = readData();
            
            // Verifica se já existe um registro para a data e substitui, ou cria um novo
            const existingIndex = records.findIndex(r => r.dates === newRecord.dates);
            if (existingIndex !== -1) {
                records[existingIndex] = { ...records[existingIndex], ...newRecord };
            } else {
                records.push(newRecord);
            }

            writeData(records);
            res.json({ success: true, message: 'Dados salvos localmente com sucesso!', data: readData() });
        }
    } catch (error) {
        console.error('Erro ao salvar os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar os dados.' });
    }
});

app.get('/api/pacientes-banco', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!access) {
            return res.status(403).json({
                success: false,
                message: 'Acesso nao autorizado para o Banco de Pacientes.',
            });
        }
        const data = await queryPatientBank(req, access);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar Banco de Pacientes:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar Banco de Pacientes.' });
    }
});

app.post('/api/portal-gestor/login', async (req, res) => {
    try {
        await ensurePortalGestorSchema();
        const login = normalizePortalLogin(req.body?.login);
        const senha = String(req.body?.senha || '');
        if (!login || !senha) {
            return res.status(400).json({ success: false, message: 'Informe login e senha.' });
        }
        const result = await ociPool.query(`
            SELECT u.id, u.login, u.senha_hash, u.nome, u.municipio_id, u.ativo, m.nome AS municipio
            FROM oci.portal_gestor_usuarios u
            JOIN oci.municipios m ON m.id = u.municipio_id
            WHERE lower(u.login) = lower($1)
            LIMIT 1
        `, [login]);
        const user = result.rows[0] || null;
        if (!user || !verifyPortalPassword(senha, user.senha_hash)) {
            await auditPortalGestor(req, user?.id || null, 'login_falhou', login);
            return res.status(401).json({ success: false, message: 'Login ou senha invalidos.' });
        }
        if (!user.ativo) {
            await auditPortalGestor(req, user.id, 'login_inativo', login);
            return res.status(403).json({ success: false, message: 'Usuario inativo.' });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const tokenHash = sha256(token);
        await ociPool.query(`
            INSERT INTO oci.portal_gestor_sessoes (usuario_id, token_hash, expires_at)
            VALUES ($1, $2, now() + ($3::int * interval '1 hour'))
        `, [user.id, tokenHash, PORTAL_GESTOR_SESSION_HOURS]);
        await ociPool.query('UPDATE oci.portal_gestor_usuarios SET ultimo_acesso = now(), atualizado_em = now() WHERE id = $1', [user.id]);
        await auditPortalGestor(req, user.id, 'login_ok', user.municipio);
        setPortalSessionCookie(res, token);
        res.json({ success: true, data: { user: portalUserPayload(user) } });
    } catch (error) {
        console.error('Erro no login do Portal Gestor:', error);
        res.status(500).json({ success: false, message: 'Erro ao autenticar gestor.' });
    }
});

app.post('/api/portal-gestor/logout', async (req, res) => {
    try {
        const session = await getPortalGestorSession(req);
        if (session) {
            await ociPool.query('DELETE FROM oci.portal_gestor_sessoes WHERE id = $1', [session.sessionId]);
            await auditPortalGestor(req, session.user.id, 'logout', session.user.municipio);
        }
        clearPortalSessionCookie(res);
        res.json({ success: true });
    } catch (error) {
        console.error('Erro no logout do Portal Gestor:', error);
        clearPortalSessionCookie(res);
        res.status(500).json({ success: false, message: 'Erro ao encerrar sessao.' });
    }
});

app.get('/api/portal-gestor/me', async (req, res) => {
    try {
        const session = await requirePortalGestor(req, res);
        if (!session) return;
        res.json({ success: true, data: { user: session.user } });
    } catch (error) {
        console.error('Erro ao consultar sessao do Portal Gestor:', error);
        res.status(500).json({ success: false, message: 'Erro ao consultar sessao.' });
    }
});

app.get('/api/portal-gestor/pacientes', async (req, res) => {
    try {
        const session = await requirePortalGestor(req, res);
        if (!session) return;
        const data = await queryPortalGestorPacientes(req, session.user);
        await auditPortalGestor(req, session.user.id, 'listar_pacientes', `total=${data.totalRows}`);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar Portal Gestor:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar pacientes do municipio.' });
    }
});

app.get('/api/portal-gestor/laudos/:id/pdf', async (req, res) => {
    try {
        const session = await requirePortalGestor(req, res);
        if (!session) return;
        const laudoId = Number(req.params.id);
        if (!Number.isInteger(laudoId) || laudoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de laudo invalido.' });
        }
        const document = await queryPortalGestorDocument(session.user, laudoId);
        if (!document) {
            await auditPortalGestor(req, session.user.id, 'pdf_negado', `laudo=${laudoId}`);
            return res.status(404).json({ success: false, message: 'Laudo nao encontrado neste municipio.' });
        }
        await auditPortalGestor(req, session.user.id, 'abrir_pdf', `laudo=${laudoId}`);
        return sendScopedLaudoPdf(res, document);
    } catch (error) {
        console.error('Erro ao abrir PDF do Portal Gestor:', error);
        res.status(500).json({ success: false, message: 'Erro ao abrir PDF do laudo.' });
    }
});

app.get('/api/pacientes-banco/laudos/:id/pdf', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!access) {
            return res.status(403).json({
                success: false,
                message: 'Acesso nao autorizado para abrir este laudo.',
            });
        }

        const laudoId = Number(req.params.id);
        if (!Number.isInteger(laudoId) || laudoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de laudo invalido.' });
        }

        const document = await queryPatientBankDocument(req, access, laudoId);
        if (!document || !document.caminho_armazenado) {
            return res.status(404).json({ success: false, message: 'Laudo nao encontrado neste perfil de acesso.' });
        }

        // O arquivo local só é servido se o caminho for válido nesta máquina;
        // caso contrário (deploy na nuvem, caminho Windows, arquivo ausente)
        // cai no fallback do Firebase Storage com URL assinada temporária.
        const storageRoot = path.resolve(__dirname, 'storage');
        const filePath = path.resolve(document.caminho_armazenado);
        const localOk = isInsideDirectory(storageRoot, filePath)
            && path.extname(filePath).toLowerCase() === '.pdf'
            && fs.existsSync(filePath);

        if (!localOk) {
            const stored = await ociPool.query(
                'SELECT storage_path FROM oci.laudos_pacientes WHERE id = $1::bigint',
                [laudoId]
            );
            const storagePath = stored.rows[0]?.storage_path;
            if (storagePath && isFirebaseConfigured && admin) {
                const bucketName = process.env.FIREBASE_STORAGE_BUCKET || 'vortexaiecolink.firebasestorage.app';
                const [signedUrl] = await admin.storage().bucket(bucketName).file(storagePath).getSignedUrl({
                    action: 'read',
                    expires: Date.now() + 15 * 60 * 1000,
                });
                return res.redirect(signedUrl);
            }
            return res.status(404).json({ success: false, message: 'Arquivo PDF nao disponivel (local ou nuvem).' });
        }

        res.sendFile(filePath, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${path.basename(document.arquivo_original || filePath).replace(/"/g, '')}"`,
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        console.error('Erro ao abrir PDF do Banco de Pacientes:', error);
        res.status(500).json({ success: false, message: 'Erro ao abrir PDF do laudo.' });
    }
});

app.get('/api/pacientes-banco/laudos/:id/candidatos', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!isPatientBankMaster(access)) {
            return res.status(403).json({ success: false, message: 'A revisao manual exige senha master.' });
        }

        const laudoId = Number(req.params.id);
        if (!Number.isInteger(laudoId) || laudoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de laudo invalido.' });
        }

        const data = await queryLaudoReviewCandidates(laudoId, req.query.search);
        if (!data) {
            return res.status(404).json({ success: false, message: 'Laudo nao encontrado.' });
        }
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao buscar candidatos para revisao:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar candidatos para revisao.' });
    }
});

app.post('/api/pacientes-banco/laudos/:id/revisao', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!isPatientBankMaster(access)) {
            return res.status(403).json({ success: false, message: 'A revisao manual exige senha master.' });
        }

        const laudoId = Number(req.params.id);
        if (!Number.isInteger(laudoId) || laudoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de laudo invalido.' });
        }

        const data = await applyLaudoManualReview(laudoId, req.body || {});
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao aplicar revisao manual:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: error.statusCode ? error.message : 'Erro ao aplicar revisao manual.',
        });
    }
});

// Administração: documentos em quarentena (fora do escopo mamografia/USG)
app.get('/api/pacientes-banco/quarentena', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!isPatientBankMaster(access)) {
            return res.status(403).json({ success: false, message: 'A administracao exige senha master.' });
        }
        const result = await ociPool.query(`
            SELECT id, arquivo_original, titulo_raw, nome_extraido, data_realizacao,
                   caminho_origem, status_vinculo, vinculo_motivo, criado_em
            FROM oci.laudos_pacientes
            WHERE status_vinculo IN ('quarentena', 'descartado')
            ORDER BY (status_vinculo = 'descartado'), arquivo_original;
        `);
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('Erro ao listar quarentena:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar quarentena.' });
    }
});

// Exclui (descarta) um laudo em quarentena. Soft delete: a linha permanece
// para auditoria com status "descartado" e sai de todas as listagens.
app.post('/api/pacientes-banco/laudos/:id/descartar', async (req, res) => {
    try {
        const access = resolvePatientBankAccess(req);
        if (!isPatientBankMaster(access)) {
            return res.status(403).json({ success: false, message: 'A exclusao exige senha master.' });
        }
        const laudoId = Number(req.params.id);
        if (!Number.isInteger(laudoId) || laudoId <= 0) {
            return res.status(400).json({ success: false, message: 'ID de laudo invalido.' });
        }
        await ensureLaudoReviewTable();
        const result = await ociPool.query(`
            UPDATE oci.laudos_pacientes
            SET status_vinculo = 'descartado', registro_ativo = false,
                vinculo_motivo = COALESCE($2, 'descartado_pela_administracao')
            WHERE id = $1::bigint AND status_vinculo IN ('quarentena', 'descartado')
            RETURNING id;
        `, [laudoId, String(req.body?.motivo || '').trim() || null]);
        if (!result.rowCount) {
            return res.status(400).json({ success: false, message: 'Somente laudos em quarentena podem ser descartados.' });
        }
        await ociPool.query(`
            INSERT INTO oci.laudos_pacientes_revisoes (laudo_id, acao, revisado_por, motivo)
            VALUES ($1, 'descartar', $2, $3);
        `, [laudoId, String(req.body?.revisadoPor || 'master'), String(req.body?.motivo || '') || null]);
        res.json({ success: true, data: { laudoId } });
    } catch (error) {
        console.error('Erro ao descartar laudo:', error);
        res.status(500).json({ success: false, message: 'Erro ao descartar laudo.' });
    }
});

app.get('/api/ocis/summary', async (req, res) => {
    try {
        const filters = parseOciFilters(req);
        const data = await queryOciSummary(filters);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar resumo de OCIs:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar resumo de OCIs.' });
    }
});

app.get('/api/ocis/nominal', async (req, res) => {
    try {
        const filters = parseOciFilters(req);
        const data = await queryOciNominal(filters);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar nominal de OCIs:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar nominal de OCIs.' });
    }
});

app.get('/api/ocis/procedures', async (req, res) => {
    try {
        const filters = parseOciFilters(req);
        const data = await queryOciProcedures(filters);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar procedimentos de OCIs:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar procedimentos de OCIs.' });
    }
});

app.get('/api/ocis/pending', async (req, res) => {
    try {
        const filters = parseOciFilters(req);
        if (!filters.canViewPending) {
            return res.json({ success: true, data: [] });
        }
        const data = await queryOciPending(filters);
        res.json({ success: true, data });
    } catch (error) {
        console.error('Erro ao carregar pendencias de OCIs:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar pendencias de OCIs.' });
    }
});

app.get('/api/ocis/export.xlsx', async (req, res) => {
    try {
        const filters = parseOciFilters(req);
        if (req.query.mode === 'internal' && !filters.includeValues) {
            return res.status(403).json({ success: false, message: 'Senha interna invalida.' });
        }
        const [summary, nominal, pending, procedures] = await Promise.all([
            queryOciSummary(filters),
            queryOciNominal(filters),
            queryOciPending(filters),
            queryOciProcedures(filters),
        ]);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Controle de OCIs';
        workbook.created = new Date();

        const resumoRows = [
            { indicador: 'Pacientes atendidos', valor: summary.kpis.pacientesAtendidos },
            { indicador: 'Pacientes com OCI', valor: summary.kpis.pacientesComOci },
            { indicador: 'OCIs consolidadas', valor: summary.kpis.totalOcis },
            { indicador: 'Procedimentos sem consulta especializada', valor: summary.kpis.procedimentosSemConsulta },
            { indicador: 'Consultas especializadas', valor: summary.kpis.consultasEspecialistas },
            { indicador: 'Total procedimentos + consultas', valor: summary.kpis.totalProcedimentosEConsultas },
            { indicador: 'Consultas minimas', valor: summary.kpis.consultasMinimas },
            { indicador: 'Consultas equivalentes por OCI', valor: summary.kpis.consultasEquivalentesOci },
            ...(filters.canViewPending ? [{ indicador: 'Pendencias sem OCI', valor: summary.kpis.pendenciasSemOci }] : []),
        ];
        if (filters.includeValues) {
            resumoRows.push({ indicador: 'Valor SIGTAP total', valor: summary.kpis.valorTotal });
        }
        addWorksheetRows(
            workbook.addWorksheet('Resumo'),
            [
                { key: 'indicador', label: 'Indicador', width: 32 },
                { key: 'valor', label: filters.includeValues ? 'Valor' : 'Quantidade', width: 22 },
            ],
            resumoRows
        );

        addWorksheetRows(
            workbook.addWorksheet('Por OCI'),
            [
                { key: 'codigoOci', label: 'Codigo OCI', width: 18 },
                { key: 'nomeOci', label: 'OCI', width: 58 },
                { key: 'qtdOci', label: 'Qtd OCI', width: 14 },
                ...(filters.includeValues ? [{ key: 'valorTotal', label: 'Valor total', width: 18 }] : []),
            ],
            summary.porOci
        );

        addWorksheetRows(
            workbook.addWorksheet('Nominal'),
            [
                { key: 'paciente', label: 'Paciente', width: 38 },
                { key: 'municipios', label: 'Municipios', width: 28 },
                { key: 'datas', label: 'Datas', width: 30 },
                { key: 'competencias', label: 'Competencias', width: 18 },
                { key: 'ocisRealizadas', label: 'OCIs realizadas', width: 64 },
                { key: 'codigosOci', label: 'Codigos OCI', width: 42 },
                { key: 'totalOcis', label: 'Total OCIs', width: 14 },
                { key: 'consultaMinimaEspecialista', label: 'Consulta minima', width: 18 },
                { key: 'consultaEquivalentePorOci', label: 'Consulta equivalente OCI', width: 24 },
                { key: 'consultaEspecialistaRotulo', label: 'Procedimento clinico de validacao', width: 58 },
                ...(filters.includeValues ? [{ key: 'valorTotal', label: 'Valor total', width: 18 }] : []),
            ],
            nominal
        );

        addWorksheetRows(
            workbook.addWorksheet('Procedimentos'),
            [
                { key: 'categoria', label: 'Categoria', width: 20 },
                { key: 'procedimento', label: 'Procedimento derivado', width: 54 },
                { key: 'quantidade', label: 'Quantidade', width: 14 },
                { key: 'pacientesUnicos', label: 'Pacientes unicos', width: 18 },
                { key: 'ocisRelacionadas', label: 'OCIs relacionadas', width: 38 },
            ],
            procedures
        );

        if (filters.canViewPending) {
            addWorksheetRows(
                workbook.addWorksheet('Pendencias'),
                [
                    { key: 'data', label: 'Data', width: 14 },
                    { key: 'paciente', label: 'Paciente', width: 38 },
                    { key: 'municipio', label: 'Municipio', width: 24 },
                    { key: 'competencia', label: 'Competencia', width: 16 },
                    { key: 'regiao', label: 'Regiao', width: 16 },
                    { key: 'sourceSheet', label: 'Aba origem', width: 20 },
                    { key: 'sourceRow', label: 'Linha', width: 10 },
                    { key: 'ociAgendada', label: 'OCI agendada', width: 24 },
                    { key: 'ociExtra', label: 'OCI extra', width: 24 },
                    { key: 'observacao', label: 'Observacao', width: 36 },
                ],
                pending
            );
        }

        addWorksheetRows(
            workbook.addWorksheet('Metodologia'),
            [
                { key: 'item', label: 'Item', width: 28 },
                { key: 'descricao', label: 'Descricao', width: 90 },
            ],
            [
                { item: 'Fonte', descricao: 'PostgreSQL local ocis_local, schema oci.' },
                { item: 'Consolidacao', descricao: 'A mesma paciente com a mesma OCI conta uma unica vez no periodo filtrado.' },
                { item: 'Tipo', descricao: filters.includeValues ? 'Exportacao interna com valores SIGTAP.' : 'Exportacao externa para envio institucional.' },
                { item: 'Pendencias', descricao: filters.canViewPending ? 'Linhas sem OCI calculada liberadas por senha master.' : 'Pendencias ocultas nesta exportacao.' },
                { item: 'Procedimentos', descricao: 'Procedimentos sao derivados das siglas e observacoes registradas; nao alteram dados brutos.' },
                { item: 'Consultas', descricao: 'Consulta minima considera 1 consulta por paciente com OCI; consulta equivalente considera 1 validacao clinica por OCI fechada.' },
            ]
        );

        workbook.eachSheet(ws => {
            ws.eachRow(row => {
                row.eachCell(cell => {
                    cell.alignment = { vertical: 'middle', wrapText: true };
                    cell.border = {
                        top: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                        left: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                        bottom: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                        right: { style: 'thin', color: { argb: 'FFD9E2EC' } },
                    };
                });
            });
        });

        const suffix = filters.includeValues ? 'interno' : 'sem-valores';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="controle-ocis-${suffix}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Erro ao exportar OCIs:', error);
        res.status(500).json({ success: false, message: 'Erro ao exportar OCIs.' });
    }
});

// Função para migração automática do banco local para o Firestore
async function migrateIfNeeded() {
    if (!isFirebaseConfigured || !db) return;
    try {
        const recordsCol = db.collection('daily_records');
        const snapshot = await recordsCol.limit(1).get();
        if (snapshot.empty) {
            console.log('Banco de dados do Firestore está vazio. Verificando dados locais para migração...');
            const localRecords = readData();
            if (localRecords.length > 0) {
                console.log(`Iniciando migração de ${localRecords.length} registros para o Firestore...`);
                const batch = db.batch();
                localRecords.forEach(record => {
                    const docId = record.dates.replace(/\//g, '-');
                    const docRef = recordsCol.doc(docId);
                    batch.set(docRef, record);
                });
                await batch.commit();
                console.log('Migração concluída com sucesso!');
            } else {
                console.log('Nenhum dado local encontrado para migração.');
            }
        } else {
            console.log('Firestore já contém dados. Migração automática ignorada.');
        }
    } catch (err) {
        console.error('Erro durante a migração para o Firestore:', err);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    await ensurePortalGestorSchema().catch(error => {
        console.warn('Portal Gestor nao inicializado:', error.message);
    });
    // Tenta migrar os dados locais se o Firebase estiver configurado
    await migrateIfNeeded();
});








const express = require('express');
const fs = require('fs');
const path = require('path');
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

const ociPool = new Pool({
    host: process.env.OCI_DB_HOST || 'localhost',
    port: Number(process.env.OCI_DB_PORT || 5432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
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
    const { whereSql, values } = buildProcedureWhere(filters);
    const sql = `
        WITH base AS (
            SELECT
                a.atendimento_uid,
                a.data_atendimento,
                a.competencia,
                a.regiao,
                p.patient_key,
                p.nome_preferido AS paciente,
                m.nome AS municipio,
                COALESCE(a.oci_agendada, '') AS oci_agendada,
                COALESCE(a.oci_extra, '') AS oci_extra,
                COALESCE(a.observacao, '') AS observacao,
                UPPER(CONCAT_WS(' ', COALESCE(a.oci_agendada, ''), COALESCE(a.oci_extra, ''), COALESCE(a.observacao, ''))) AS texto,
                STRING_AGG(DISTINCT ao.codigo_oci, '; ' ORDER BY ao.codigo_oci) AS codigos_oci
            FROM oci.atendimentos a
            JOIN oci.pacientes p ON p.id = a.paciente_id
            JOIN oci.municipios m ON m.id = a.municipio_id
            LEFT JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
            LEFT JOIN oci.ocis o ON o.codigo_oci = ao.codigo_oci
            ${whereSql}
            GROUP BY
                a.atendimento_uid,
                a.data_atendimento,
                a.competencia,
                a.regiao,
                p.patient_key,
                p.nome_preferido,
                m.nome,
                a.oci_agendada,
                a.oci_extra,
                a.observacao
        ),
        procedimentos_raw AS (
            SELECT atendimento_uid, patient_key, 'Mama' AS categoria, 'Avaliacao inicial de mama: USG mamaria/Mamografia' AS procedimento, codigos_oci
            FROM base
            WHERE texto ~* '(^|[^A-Z0-9])MAMA I([^A-Z0-9]|$)'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Ginecologia', 'USG transvaginal', codigos_oci
            FROM base
            WHERE texto ~* '(^|[^A-Z0-9])GIN I([^A-Z0-9]|$)'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Ginecologia', 'USG pelvica', codigos_oci
            FROM base
            WHERE texto ~* '(^|[^A-Z0-9])GIN II([^A-Z0-9]|$)'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Colo do utero', 'Colposcopia', codigos_oci
            FROM base
            WHERE texto LIKE '%COLPOSCOPIA%'
               OR texto LIKE '%COLO DO UTERO%'
               OR texto LIKE '%INVESTIGACAO%COLO%'
               OR texto LIKE '%INVESTIGAÇÃO%COLO%'
               OR texto LIKE '%BIO%COLO%'
               OR texto ~* '(^|[^A-Z0-9])COLO UTERO I([^A-Z0-9]|$)'
               OR texto ~* '(^|[^A-Z0-9])COLO UTERO II([^A-Z0-9]|$)'
               OR texto ~* '(^|[^A-Z0-9])TERAPEUTICA I([^A-Z0-9]|$)'
               OR texto ~* '(^|[^A-Z0-9])TERAPEUTICA II([^A-Z0-9]|$)'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Colo do utero', 'Biopsia do colo uterino', codigos_oci
            FROM base
            WHERE texto LIKE '%BIO%COLO%'
               OR texto LIKE '%BIÓPSIA%COLO%'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Mama', 'Biopsia de mama', codigos_oci
            FROM base
            WHERE texto LIKE '%PROGRESS%MAMA%'
               OR texto LIKE '%BIO%MAMA%'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Colo do utero', 'Excisao tipo I do colo uterino', codigos_oci
            FROM base
            WHERE texto ~* '(^|[^A-Z0-9])COLO UTERO I([^A-Z0-9]|$)'
               OR texto ~* '(^|[^A-Z0-9])TERAPEUTICA I([^A-Z0-9]|$)'

            UNION ALL
            SELECT atendimento_uid, patient_key, 'Colo do utero', 'Excisao tipo 2 do colo uterino', codigos_oci
            FROM base
            WHERE texto ~* '(^|[^A-Z0-9])COLO UTERO II([^A-Z0-9]|$)'
               OR texto ~* '(^|[^A-Z0-9])TERAPEUTICA II([^A-Z0-9]|$)'
        ),
        procedimentos AS (
            SELECT DISTINCT atendimento_uid, patient_key, categoria, procedimento, codigos_oci
            FROM procedimentos_raw
        )
        SELECT
            p.procedimento,
            p.categoria,
            COUNT(*)::int AS quantidade,
            COUNT(DISTINCT p.patient_key)::int AS pacientes_unicos,
            COALESCE((
                SELECT STRING_AGG(DISTINCT code.codigo, '; ' ORDER BY code.codigo)
                FROM procedimentos p2
                CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p2.codigos_oci, ''), '; ') AS code(codigo)
                WHERE p2.procedimento = p.procedimento
                  AND p2.categoria = p.categoria
                  AND code.codigo <> ''
            ), '') AS ocis_relacionadas
        FROM procedimentos p
        GROUP BY p.procedimento, p.categoria
        ORDER BY quantidade DESC, procedimento;
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
    // Tenta migrar os dados locais se o Firebase estiver configurado
    await migrateIfNeeded();
});








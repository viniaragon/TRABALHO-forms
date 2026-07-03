// Importa a planilha de pacientes "PLANILHAS BRENDA VERIDIANA" para o banco oci (Postgres).
//
// Uso:
//   node scripts/importar-planilha-brenda.mjs "C:\caminho\PLANILHAS BRENDA VERIDIANA .xlsx"
//
// O script é idempotente: reexecutar com a mesma planilha apaga os atendimentos
// importados anteriormente dessas abas e regrava tudo. Gera um relatório de
// qualidade em reports/importacao-brenda-<timestamp>.md com tokens não
// reconhecidos e demais avisos.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import pg from 'pg';

const WORKBOOK_PATH = process.argv[2] || 'C:\\Users\\ECOLINK\\Downloads\\PLANILHAS BRENDA VERIDIANA .xlsx';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

// ---------------------------------------------------------------------------
// Normalização de texto
// ---------------------------------------------------------------------------

function clean(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    // caracteres de encoding quebrado (ex.: bytes invalidos) e espacos especiais
    text = text.replace(/[^\x20-\x7E]/g, ' ');
    return text.replace(/\s+/g, ' ').trim().toUpperCase();
}

function cellText(cell) {
    const v = cell?.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(part => part.text).join('');
        if (v.text !== undefined) return String(v.text);
        if (v.result !== undefined) return String(v.result);
        return '';
    }
    return String(v);
}

function cellDate(cell) {
    const v = cell?.value;
    if (v instanceof Date) return v;
    if (typeof v === 'object' && v?.result instanceof Date) return v.result;
    const text = clean(cellText(cell));
    const m = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    // data digitada sem a segunda barra, ex.: "08/052026" = 08/05/2026
    const semBarra = text.match(/^(\d{1,2})[\/\-](\d{1,2})(\d{4})$/);
    if (semBarra) return new Date(Date.UTC(Number(semBarra[3]), Number(semBarra[2]) - 1, Number(semBarra[1])));
    return null;
}

function digitsOnly(value, padTo) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (!digits) return null;
    return padTo ? digits.padStart(padTo, '0') : digits;
}

// ---------------------------------------------------------------------------
// Dicionário de conceitos: sigla da planilha -> OCI + procedimento(s)
// ---------------------------------------------------------------------------

const OCI = {
    MAMA: '09.01.01.001-4',        // Avaliacao Diagnostica Inicial de Cancer de Mama
    PROGRESSAO: '09.01.01.010-3',  // Progressao da Avaliacao Diagnostica de Cancer de Mama-II
    COLO_INVESTIGACAO: '09.01.01.005-7', // Investigacao Diagnostica de Cancer de Colo de Utero
    COLO_TERAPEUTICA1: '09.01.01.011-1', // Aval. Diag. e Terapeutica de Cancer de Colo do Utero - I
    COLO_TERAPEUTICA2: '09.01.01.012-0', // Aval. Diag. e Terapeutica de Cancer de Colo do Utero - II
    GIN1: '09.06.01.001-2',        // Ginecologia I (USG transvaginal)
    GIN2: '09.06.01.002-0',        // Ginecologia II (USG pelvica)
};

// Cada conceito vira: 1 OCI para o atendimento + N procedimentos do paciente.
// "especificado=false" marca procedimento inferido do pacote (a planilha não
// disse exatamente qual exame foi feito, ex.: "MAMA I" antes de JUNHO VALENCA).
const CONCEPTS = {
    GIN_I: {
        oci: OCI.GIN1,
        procs: [{ codigo: '02.05.02.018-6', nome: 'Ultrassonografia Transvaginal', especificado: true }],
    },
    GIN_II: {
        oci: OCI.GIN2,
        procs: [{ codigo: '02.05.02.016-0', nome: 'Ultrassonografia Pelvica (Ginecologica)', especificado: true }],
    },
    MAMA_PACOTE: {
        oci: OCI.MAMA,
        procs: [
            { codigo: '02.04.03.003-0', nome: 'Mamografia', especificado: false },
            { codigo: '02.05.02.009-7', nome: 'Ultrassonografia Mamaria Bilateral', especificado: false },
        ],
    },
    MAMOGRAFIA: {
        oci: OCI.MAMA,
        procs: [{ codigo: '02.04.03.003-0', nome: 'Mamografia', especificado: true }],
    },
    USG_MAMA: {
        oci: OCI.MAMA,
        procs: [{ codigo: '02.05.02.009-7', nome: 'Ultrassonografia Mamaria Bilateral', especificado: true }],
    },
    COLPOSCOPIA: {
        oci: OCI.COLO_INVESTIGACAO,
        procs: [{ codigo: '02.11.04.002-9', nome: 'Colposcopia', especificado: true }],
    },
    BIOPSIA_COLO: {
        oci: OCI.COLO_INVESTIGACAO,
        procs: [{ codigo: '02.01.01.066-6', nome: 'Biopsia do Colo Uterino', especificado: true }],
    },
    PROGRESSAO_MAMA_II: {
        oci: OCI.PROGRESSAO,
        procs: [{ codigo: null, nome: 'Biopsia de mama (procedimento do pacote nao especificado)', especificado: false }],
    },
    EXCISAO_I: {
        oci: OCI.COLO_TERAPEUTICA1,
        procs: [{ codigo: '04.09.06.008-9', nome: 'Excisao Tipo I do Colo Uterino', especificado: true }],
    },
    EXCISAO_II: {
        oci: OCI.COLO_TERAPEUTICA2,
        procs: [{ codigo: '04.09.06.030-5', nome: 'Excisao Tipo 2 do Colo Uterino', especificado: true }],
    },
};

// Tokens já normalizados por clean(). Ordem não importa: match é exato,
// com fallback em regras de prefixo logo abaixo.
const TOKEN_MAP = {
    'GIN I': 'GIN_I',
    'GIN 1': 'GIN_I',
    'GN I': 'GIN_I',
    'GIN': 'GIN_I', // 1 ocorrência isolada; tratada como GIN I (mais comum) e registrada em avisos
    'GIN II': 'GIN_II',
    'GIN 2': 'GIN_II',
    'MAMA I': 'MAMA_PACOTE',
    'MAMA 1': 'MAMA_PACOTE',
    'MAMAI': 'MAMA_PACOTE',
    'MAMA': 'MAMA_PACOTE',
    'MAMO': 'MAMOGRAFIA',
    'USG MAMA': 'USG_MAMA',
    'USG.MAMA': 'USG_MAMA',
    'COLPOSCOPIA': 'COLPOSCOPIA',
    'COLOSCOPIA': 'COLPOSCOPIA',
    'BIOPSIA': 'BIOPSIA_COLO',
    'COLO DO UTERO': 'EXCISAO_I',
    'COLO DO UTERO I': 'EXCISAO_I',
    'COLO UTERO': 'EXCISAO_I',
    'COLO UTERO I': 'EXCISAO_I',
    'CANCER COLO UTERO I': 'EXCISAO_I',
    'TERAPEUTICA I': 'EXCISAO_I',
    'COLO DO UTERO II': 'EXCISAO_II',
    'COLO UTERO II': 'EXCISAO_II',
    'TERAPEUTICA II': 'EXCISAO_II',
};

const HEADER_TOKENS = new Set(['OCI AGENDADA', 'OCI EXTRA', 'OBSERVACAO', 'DESFECHO', 'COLPOSCOPIA BIOPSIA', 'MUNICIPIO']);
const AMBIGUOUS_TOKENS = new Set(['GIN', 'MAMA', 'MAMAI', 'GN I']);

function mapToken(rawToken, warnings, context) {
    let token = clean(rawToken).replace(/^[\-\.\s]+|[\-\.\s]+$/g, '');
    if (!token) return null;
    // normaliza pontos internos: "USG.MAMA" / "USG. MAMA" -> "USG MAMA"
    const dotless = token.replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    if (HEADER_TOKENS.has(dotless)) return null;

    let key = TOKEN_MAP[token] || TOKEN_MAP[dotless];
    if (!key && /^REALIZOU BIO/.test(dotless)) key = 'BIOPSIA_COLO';
    if (!key && /^PROGRESS/.test(dotless) && dotless.includes('MAMA')) key = 'PROGRESSAO_MAMA_II';

    if (!key) {
        warnings.push({ tipo: 'TOKEN_NAO_RECONHECIDO', token: rawToken, ...context });
        return null;
    }
    if (AMBIGUOUS_TOKENS.has(token)) {
        warnings.push({ tipo: 'TOKEN_AMBIGUO_NORMALIZADO', token: rawToken, interpretado_como: key, ...context });
    }
    return key;
}

// Divide "MAMA I /GIN II", "MAMO+USG.MAMA", "MAMA I / /COLPOSCOPIA" em tokens.
function splitTokens(rawText) {
    return String(rawText || '')
        .split(/[\/+;,]/)
        .map(t => t.trim())
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Interpretação da coluna OBSERVAÇÃO
// ---------------------------------------------------------------------------

function parseObservacao(rawObs, warnings, context) {
    const obs = clean(rawObs);
    const result = { concepts: [], naoRealizados: [] };
    if (!obs || obs === 'OBSERVACAO') return result;

    if (/^REALIZOU BIO/.test(obs)) {
        // "REALIZOU BIOPSIA" (e variantes com erro de digitação)
        result.concepts.push('BIOPSIA_COLO');
        return result;
    }
    const naoRealizou = obs.match(/^NAO REALIZOU (GIN I{1,2})\b/);
    if (naoRealizou) {
        result.naoRealizados.push(naoRealizou[1] === 'GIN II' ? 'GIN_II' : 'GIN_I');
        return result;
    }
    if (obs.includes('MODIFICADA PARA GIN I')) {
        // agendada p/ GIN II mas fez GIN I: garante GIN I; nada de GIN II
        result.concepts.push('GIN_I');
        return result;
    }
    if (/^PROGRESS/.test(obs) && obs.includes('MAMA')) {
        result.concepts.push('PROGRESSAO_MAMA_II');
        return result;
    }
    warnings.push({ tipo: 'OBSERVACAO_NAO_INTERPRETADA', token: rawObs, ...context });
    return result;
}

// ---------------------------------------------------------------------------
// Leitura das abas
// ---------------------------------------------------------------------------

function detectRegiao(sheetName) {
    const n = clean(sheetName);
    if (n.includes('IRECE')) return 'IRECE';
    if (n.includes('JACOBINA')) return 'JACOBINA';
    if (n.includes('VALENCA')) return 'VALENCA';
    return n;
}

function headerIndexMap(row) {
    const map = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
        const h = clean(cellText(cell)).replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
        if (!h) return;
        if (h === 'DATA') map.data = col;
        else if (h === 'NOME') map.nome = col;
        else if (h === 'MUNICIPIO') map.municipio = col;
        else if (h === 'OCI AGENDADA') map.agendada = col;
        else if (h === 'OCI EXTRA') map.extra = col;
        else if (h.startsWith('OBSERVA')) map.observacao = col;
        else if (h === 'CPF') map.cpf = col;
        else if (h === 'CNS' || h === 'SUS') map.cns = col; // a coluna muda de nome entre blocos
        else if (h === 'CID') map.cid = col;
        else if (h.includes('COLPOSCOPIA')) map.colposcopiaBiopsia = col;
        else if (h === 'DESFECHO') map.desfecho = col;
    });
    return map;
}

function parseSheet(ws, warnings) {
    const sheetName = ws.name.trim();
    const regiao = detectRegiao(sheetName);
    const records = [];
    let cols = null;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const firstCell = clean(cellText(row.getCell(1)));
        if (firstCell === 'DATA') {
            cols = headerIndexMap(row); // cabeçalho (pode repetir dentro da aba)
            return;
        }
        if (!cols) return;

        const nome = clean(cellText(row.getCell(cols.nome)));
        if (!nome || nome === 'NOME') return;

        const data = cellDate(row.getCell(cols.data));
        const context = { aba: sheetName, linha: rowNumber, paciente: nome };
        if (!data || Number.isNaN(data.getTime())) {
            warnings.push({ tipo: 'DATA_INVALIDA', token: cellText(row.getCell(cols.data)), ...context });
            return;
        }

        const rawAgendada = cellText(row.getCell(cols.agendada)).trim();
        const rawExtra = cellText(row.getCell(cols.extra)).trim();
        const rawObs = cols.observacao ? cellText(row.getCell(cols.observacao)).trim() : '';
        const rawColpo = cols.colposcopiaBiopsia ? cellText(row.getCell(cols.colposcopiaBiopsia)).trim() : '';
        const rawDesfecho = cols.desfecho ? clean(cellText(row.getCell(cols.desfecho))) : '';

        // conceito -> origem (primeira origem em que apareceu)
        const concepts = new Map();
        const addConcept = (key, origem) => {
            if (key && !concepts.has(key)) concepts.set(key, origem);
        };

        for (const token of splitTokens(rawAgendada)) addConcept(mapToken(token, warnings, context), 'AGENDADA');
        for (const token of splitTokens(rawExtra)) addConcept(mapToken(token, warnings, context), 'EXTRA');
        for (const token of splitTokens(rawColpo)) addConcept(mapToken(token, warnings, context), 'COLPOSCOPIA_BIOPSIA');

        const obsParsed = parseObservacao(rawObs, warnings, context);
        for (const key of obsParsed.concepts) addConcept(key, 'OBSERVACAO');

        records.push({
            sheetName,
            regiao,
            rowNumber,
            data,
            nome,
            municipio: clean(cellText(row.getCell(cols.municipio))) || 'SEM MUNICIPIO',
            cpf: cols.cpf ? digitsOnly(cellText(row.getCell(cols.cpf)), 11) : null,
            cns: cols.cns ? digitsOnly(cellText(row.getCell(cols.cns)), 15) : null,
            cid: cols.cid ? clean(cellText(row.getCell(cols.cid))) || null : null,
            desfecho: rawDesfecho && rawDesfecho !== 'DESFECHO' ? rawDesfecho : null,
            ociAgendada: rawAgendada || null,
            ociExtra: rawExtra || null,
            observacao: [rawObs, rawColpo ? `COLPOSCOPIA/BIOPSIA: ${rawColpo}` : ''].filter(Boolean).join(' | ') || null,
            concepts,
            naoRealizados: obsParsed.naoRealizados,
        });
    });

    return records;
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

async function ensureSchema(client) {
    await client.query(`
        ALTER TABLE oci.pacientes ADD COLUMN IF NOT EXISTS cpf text;
        ALTER TABLE oci.pacientes ADD COLUMN IF NOT EXISTS cns text;
        ALTER TABLE oci.atendimentos ADD COLUMN IF NOT EXISTS cid text;
        ALTER TABLE oci.atendimentos ADD COLUMN IF NOT EXISTS desfecho text;
        CREATE TABLE IF NOT EXISTS oci.atendimento_procedimentos (
            id bigserial PRIMARY KEY,
            atendimento_uid text NOT NULL REFERENCES oci.atendimentos(atendimento_uid) ON DELETE CASCADE,
            codigo_oci text NOT NULL REFERENCES oci.ocis(codigo_oci) ON UPDATE CASCADE,
            codigo_procedimento text,
            procedimento text NOT NULL,
            origem text NOT NULL,
            status text NOT NULL DEFAULT 'REALIZADO',
            especificado boolean NOT NULL DEFAULT true,
            UNIQUE (atendimento_uid, codigo_oci, procedimento, status)
        );
        CREATE INDEX IF NOT EXISTS idx_atend_proc_oci ON oci.atendimento_procedimentos (codigo_oci);
        CREATE INDEX IF NOT EXISTS idx_atend_proc_status ON oci.atendimento_procedimentos (status);
        CREATE TABLE IF NOT EXISTS oci.pacientes_homonimos (
            nome_key text NOT NULL,
            regiao text NOT NULL,
            paciente_id bigint NOT NULL REFERENCES oci.pacientes(id),
            observacao text,
            criado_em timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (nome_key, regiao)
        );
    `);
}

async function getOrCreate(client, cache, sql, key, params) {
    if (cache.has(key)) return cache.get(key);
    const { rows } = await client.query(sql, params);
    cache.set(key, rows[0].id);
    return rows[0].id;
}

async function main() {
    if (!fs.existsSync(WORKBOOK_PATH)) {
        throw new Error(`Planilha não encontrada: ${WORKBOOK_PATH}`);
    }

    console.log(`Lendo planilha: ${WORKBOOK_PATH}`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(WORKBOOK_PATH);

    const warnings = [];
    const allRecords = [];
    for (const ws of workbook.worksheets) {
        const records = parseSheet(ws, warnings);
        console.log(`  aba "${ws.name.trim()}": ${records.length} atendimentos`);
        allRecords.push(...records);
    }
    if (!allRecords.length) throw new Error('Nenhum atendimento encontrado na planilha.');

    const sheetNames = [...new Set(allRecords.map(r => r.sheetName))];
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(WORKBOOK_PATH)).digest('hex');

    const client = await pool.connect();
    const stats = { pacientesNovos: 0, atendimentos: 0, ocis: 0, procedimentos: 0, naoRealizados: 0 };
    try {
        await client.query('BEGIN');
        await ensureSchema(client);

        const { rows: arquivoRows } = await client.query(
            `INSERT INTO oci.arquivos_importados (nome_arquivo, caminho_origem, sha256, tipo_arquivo, observacao)
             VALUES ($1, $2, $3, 'xlsx', $4)
             ON CONFLICT (sha256) DO UPDATE SET importado_em = now(), observacao = EXCLUDED.observacao
             RETURNING id`,
            [path.basename(WORKBOOK_PATH), WORKBOOK_PATH, sha256, `Reimportação em ${new Date().toISOString()}`]
        );
        const arquivoId = arquivoRows[0].id;

        // Remove import anterior dessas mesmas abas (idempotência)
        const del = await client.query(
            'DELETE FROM oci.atendimentos WHERE source_sheet = ANY($1)', [sheetNames]
        );
        if (del.rowCount) console.log(`Removidos ${del.rowCount} atendimentos de importação anterior.`);

        const municipioCache = new Map();
        const pacienteCache = new Map();

        // homônimos divididos manualmente: (nome, região) -> paciente fixo,
        // para reimportações não desfazerem a separação
        const homRes = await client.query('SELECT nome_key, regiao, paciente_id FROM oci.pacientes_homonimos');
        const homonimos = new Map(homRes.rows.map(r => [`${r.nome_key}|${r.regiao}`, Number(r.paciente_id)]));

        for (const rec of allRecords) {
            const municipioId = await getOrCreate(
                client, municipioCache,
                `INSERT INTO oci.municipios (nome) VALUES ($1)
                 ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
                rec.municipio, [rec.municipio]
            );

            const mapeado = homonimos.get(`${rec.nome}|${rec.regiao}`);
            if (mapeado) {
                if (rec.cpf || rec.cns) {
                    await client.query(
                        `UPDATE oci.pacientes SET cpf = COALESCE(cpf, $2), cns = COALESCE(cns, $3), atualizado_em = now() WHERE id = $1`,
                        [mapeado, rec.cpf, rec.cns]
                    );
                }
            }
            let pacienteId = mapeado || pacienteCache.get(rec.nome);
            if (!pacienteId) {
                const { rows } = await client.query(
                    `INSERT INTO oci.pacientes (patient_key, nome_preferido, cpf, cns)
                     VALUES ($1, $1, $2, $3)
                     ON CONFLICT (patient_key) DO UPDATE SET
                        cpf = COALESCE(oci.pacientes.cpf, EXCLUDED.cpf),
                        cns = COALESCE(oci.pacientes.cns, EXCLUDED.cns),
                        atualizado_em = now()
                     RETURNING id, (xmax = 0) AS inserted`,
                    [rec.nome, rec.cpf, rec.cns]
                );
                pacienteId = rows[0].id;
                if (rows[0].inserted) stats.pacientesNovos += 1;
                pacienteCache.set(rec.nome, pacienteId);
            } else if (rec.cpf || rec.cns) {
                await client.query(
                    `UPDATE oci.pacientes SET cpf = COALESCE(cpf, $2), cns = COALESCE(cns, $3), atualizado_em = now() WHERE id = $1`,
                    [pacienteId, rec.cpf, rec.cns]
                );
            }

            const uid = `${rec.sheetName}#R${String(rec.rowNumber).padStart(4, '0')}`;
            // Datas viajam como texto ISO: node-pg serializa objetos Date no fuso
            // local, o que deslocava a data (-1 dia) na coluna date.
            const dataISO = rec.data.toISOString().slice(0, 10);
            const competencia = dataISO.slice(0, 7); // YYYY-MM
            await client.query(
                `INSERT INTO oci.atendimentos (
                    atendimento_uid, paciente_id, municipio_id, data_atendimento, competencia,
                    regiao, source_sheet, source_row, oci_agendada, oci_extra, observacao,
                    cid, desfecho, arquivo_importado_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [uid, pacienteId, municipioId, dataISO, competencia, rec.regiao,
                 rec.sheetName, rec.rowNumber, rec.ociAgendada, rec.ociExtra, rec.observacao,
                 rec.cid, rec.desfecho, arquivoId]
            );
            stats.atendimentos += 1;

            // OCIs do atendimento (1 linha por OCI distinta, apenas realizadas)
            const ociOrigem = new Map();
            for (const [conceptKey, origem] of rec.concepts) {
                const concept = CONCEPTS[conceptKey];
                if (!ociOrigem.has(concept.oci)) ociOrigem.set(concept.oci, origem);
            }
            for (const [codigoOci, origem] of ociOrigem) {
                await client.query(
                    `INSERT INTO oci.atendimento_ocis (atendimento_uid, codigo_oci, origem_regra)
                     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
                    [uid, codigoOci, origem]
                );
                stats.ocis += 1;
            }

            // Procedimentos do paciente (grão fino, dentro da OCI)
            for (const [conceptKey, origem] of rec.concepts) {
                const concept = CONCEPTS[conceptKey];
                for (const proc of concept.procs) {
                    await client.query(
                        `INSERT INTO oci.atendimento_procedimentos
                            (atendimento_uid, codigo_oci, codigo_procedimento, procedimento, origem, status, especificado)
                         VALUES ($1,$2,$3,$4,$5,'REALIZADO',$6)
                         ON CONFLICT (atendimento_uid, codigo_oci, procedimento, status) DO NOTHING`,
                        [uid, concept.oci, proc.codigo, proc.nome, origem, proc.especificado]
                    );
                    stats.procedimentos += 1;
                }
            }

            // "NÃO REALIZOU GIN X": registro de absenteísmo (não entra em atendimento_ocis)
            for (const conceptKey of rec.naoRealizados) {
                const concept = CONCEPTS[conceptKey];
                for (const proc of concept.procs) {
                    await client.query(
                        `INSERT INTO oci.atendimento_procedimentos
                            (atendimento_uid, codigo_oci, codigo_procedimento, procedimento, origem, status, especificado)
                         VALUES ($1,$2,$3,$4,'OBSERVACAO','NAO_REALIZADO',$5)
                         ON CONFLICT (atendimento_uid, codigo_oci, procedimento, status) DO NOTHING`,
                        [uid, concept.oci, proc.codigo, proc.nome, proc.especificado]
                    );
                    stats.naoRealizados += 1;
                }
            }
        }

        // Remove pacientes órfãos de importações anteriores
        await client.query(`
            DELETE FROM oci.pacientes p
            WHERE NOT EXISTS (SELECT 1 FROM oci.atendimentos a WHERE a.paciente_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM oci.laudos_pacientes l WHERE l.paciente_id = p.id)
              AND NOT EXISTS (SELECT 1 FROM oci.laudos_pacientes_revisoes r WHERE r.paciente_id_novo = p.id)
        `);

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // -----------------------------------------------------------------------
    // Relatório
    // -----------------------------------------------------------------------
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17);
    const reportPath = path.join(process.cwd(), 'reports', `importacao-brenda-${ts}.md`);
    const grouped = {};
    for (const w of warnings) {
        grouped[w.tipo] = grouped[w.tipo] || [];
        grouped[w.tipo].push(w);
    }
    const lines = [
        `# Importação — ${path.basename(WORKBOOK_PATH)}`,
        '',
        `- Data da importação: ${new Date().toLocaleString('pt-BR')}`,
        `- SHA-256: \`${sha256}\``,
        `- Abas: ${sheetNames.join(', ')}`,
        '',
        '## Totais',
        '',
        `| Métrica | Quantidade |`,
        `|---|---|`,
        `| Atendimentos (linhas da planilha) | ${stats.atendimentos} |`,
        `| Pacientes únicos novos | ${stats.pacientesNovos} |`,
        `| OCIs lançadas (atendimento × OCI) | ${stats.ocis} |`,
        `| Procedimentos lançados | ${stats.procedimentos} |`,
        `| Registros de "não realizou" | ${stats.naoRealizados} |`,
        '',
        '## Avisos de qualidade',
        '',
    ];
    if (!warnings.length) lines.push('Nenhum aviso. Todos os tokens foram reconhecidos.');
    for (const [tipo, list] of Object.entries(grouped)) {
        lines.push(`### ${tipo} (${list.length})`, '');
        for (const w of list.slice(0, 100)) {
            lines.push(`- Aba **${w.aba}**, linha ${w.linha} (${w.paciente}): \`${w.token}\`${w.interpretado_como ? ` → ${w.interpretado_como}` : ''}`);
        }
        if (list.length > 100) lines.push(`- ... e mais ${list.length - 100}`);
        lines.push('');
    }
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

    console.log('\nResumo:');
    console.table([stats]);
    console.log(`Avisos: ${warnings.length} (detalhes em ${reportPath})`);
}

main()
    .then(() => pool.end())
    .catch(err => {
        console.error('ERRO na importação:', err);
        pool.end();
        process.exit(1);
    });

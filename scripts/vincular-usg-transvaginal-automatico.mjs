import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const COMMIT = process.argv.includes('--commit');
const REPORT_DIR = path.join(process.cwd(), 'reports');

const pool = new Pool({
  host: process.env.OCI_DB_HOST || '127.0.0.1',
  port: Number(process.env.OCI_DB_PORT || 55432),
  database: process.env.OCI_DB_NAME || 'ocis_local',
  user: process.env.OCI_DB_USER || 'oci_admin',
  password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

function nowStamp() {
  const d = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (!max) return 0;
  return 1 - (levenshtein(a, b) / max);
}

function tokens(value) {
  return String(value || '').split(/\s+/).filter(Boolean);
}

function tokenJaccard(a, b) {
  const aSet = new Set(tokens(a));
  const bSet = new Set(tokens(b));
  const union = new Set([...aSet, ...bSet]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function firstLastOk(a, b) {
  const at = tokens(a);
  const bt = tokens(b);
  if (at.length < 2 || bt.length < 2) return false;
  return at[0] === bt[0] && at[at.length - 1] === bt[bt.length - 1];
}

function laudoRegiaoMae(row) {
  const date = row.data_realizacao || row.data_solicitacao;
  if (!date) return 'NAO CLASSIFICADA';
  const iso = new Date(date).toISOString().slice(0, 10);
  if (iso >= '2026-03-27' && iso <= '2026-04-30') return 'IRECE';
  if (iso >= '2026-05-08' && iso <= '2026-06-05') return 'JACOBINA';
  if (iso > '2026-06-05') return 'EM ESPERA';
  return 'FORA DO PERIODO';
}

function candidateScore(laudo, paciente) {
  const nameSimilarity = similarity(laudo.nome_normalizado || '', paciente.patient_key || '');
  const tokenSimilarity = tokenJaccard(laudo.nome_normalizado || '', paciente.patient_key || '');
  const score = (nameSimilarity * 0.72) + (tokenSimilarity * 0.28);
  const regiaoMae = laudoRegiaoMae(laudo);
  const regionOk = regiaoMae === 'NAO CLASSIFICADA' || (paciente.regioes || []).includes(regiaoMae);
  return {
    laudoId: Number(laudo.id),
    laudoNome: laudo.nome_normalizado || '',
    laudoArquivo: laudo.arquivo_original || '',
    laudoData: laudo.data_realizacao || laudo.data_solicitacao || null,
    regiaoMae,
    pacienteId: Number(paciente.id),
    pacienteNome: paciente.patient_key || '',
    nomePreferido: paciente.nome_preferido || '',
    score,
    nameSimilarity,
    tokenSimilarity,
    exact: laudo.nome_normalizado === paciente.patient_key,
    firstLast: firstLastOk(laudo.nome_normalizado, paciente.patient_key),
    hasTvOci: Boolean(paciente.has_tv_oci),
    regionOk,
    regioes: paciente.regioes || [],
    municipios: paciente.municipios || [],
  };
}

function decide(best, second) {
  const secondScore = second?.score || 0;
  const margin = best.score - secondScore;
  if (!best.laudoNome) {
    return { action: 'duvida', classe: 'nome_extraido_vazio', motivo: 'Nome extraido vazio ou ilegivel.' };
  }
  if (best.regiaoMae === 'EM ESPERA') {
    return { action: 'duvida', classe: 'em_espera_cadastro', motivo: 'Laudo apos 05/06/2026; pacientes desta competencia ainda nao foram cadastrados para correlacao segura.' };
  }
  if (best.regiaoMae === 'FORA DO PERIODO') {
    return { action: 'duvida', classe: 'fora_periodo_operacional', motivo: 'Laudo fora dos intervalos operacionais cadastrados.' };
  }
  if (best.exact && best.hasTvOci && best.regionOk && margin >= 0.08) {
    return { action: 'aplicar', classe: 'auto_exato_seguro', motivo: 'Nome exato, OCI transvaginal, regiao operacional compativel e candidato unico.' };
  }
  if (best.score >= 0.94 && best.hasTvOci && best.regionOk && best.firstLast && margin >= 0.08) {
    return { action: 'aplicar', classe: 'auto_quase_exato_seguro', motivo: 'Nome quase identico, primeiro/ultimo nome iguais, OCI transvaginal, regiao compativel e boa margem.' };
  }
  if (best.score >= 0.86 && best.hasTvOci && best.regionOk && best.firstLast && margin >= 0.18) {
    return { action: 'aplicar', classe: 'auto_correcao_ortografica_segura', motivo: 'Erro ortografico pequeno com primeiro/ultimo nome iguais, OCI transvaginal, regiao compativel e margem alta.' };
  }
  if (best.exact && !best.hasTvOci) {
    return { action: 'duvida', classe: 'nome_exato_sem_oci_tv', motivo: 'Nome exato, mas paciente nao tem OCI transvaginal registrada.' };
  }
  if (!best.regionOk) {
    return { action: 'duvida', classe: 'regiao_divergente', motivo: 'Melhor candidato esta em regiao operacional diferente.' };
  }
  if (margin < 0.08) {
    return { action: 'duvida', classe: 'candidatos_proximos', motivo: 'Ha mais de um candidato com pontuacao muito proxima.' };
  }
  if (best.score >= 0.82) {
    return { action: 'duvida', classe: 'possivel_correlacao', motivo: 'Existe candidato plausivel, mas a evidencia nao e suficiente para automatizar.' };
  }
  return { action: 'duvida', classe: 'sem_candidato_bom', motivo: 'Nenhum candidato com similaridade suficiente.' };
}

async function ensureReviewTable(clientOrPool = pool) {
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS oci.laudos_pacientes_revisoes (
      id bigserial PRIMARY KEY,
      laudo_id bigint NOT NULL REFERENCES oci.laudos_pacientes(id) ON DELETE CASCADE,
      acao text NOT NULL,
      paciente_id_anterior bigint NULL,
      paciente_id_novo bigint NULL REFERENCES oci.pacientes(id),
      revisado_por text NOT NULL DEFAULT 'auto',
      motivo text NULL,
      criado_em timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_laudos_revisoes_laudo_id
      ON oci.laudos_pacientes_revisoes(laudo_id);
  `);
}

async function loadData() {
  const laudos = (await pool.query(`
    SELECT
      id,
      nome_extraido,
      nome_normalizado,
      data_solicitacao,
      data_realizacao,
      data_nascimento,
      idade_anos,
      arquivo_original
    FROM oci.laudos_pacientes
    WHERE tipo_laudo = 'USG_TRANSVAGINAL'
      AND paciente_id IS NULL
    ORDER BY nome_normalizado, id;
  `)).rows;

  const pacientes = (await pool.query(`
    SELECT
      p.id,
      p.nome_preferido,
      p.patient_key,
      COALESCE(BOOL_OR(ao.codigo_oci = '09.06.01.001-2'), false) AS has_tv_oci,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT a.regiao), NULL) AS regioes,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.nome), NULL) AS municipios,
      MIN(a.data_atendimento) AS primeira_data,
      MAX(a.data_atendimento) AS ultima_data
    FROM oci.pacientes p
    LEFT JOIN oci.atendimentos a ON a.paciente_id = p.id
    LEFT JOIN oci.municipios m ON m.id = a.municipio_id
    LEFT JOIN oci.atendimento_ocis ao ON ao.atendimento_uid = a.atendimento_uid
    WHERE NOT EXISTS (
      SELECT 1
      FROM oci.laudos_pacientes lp
      WHERE lp.paciente_id = p.id
        AND lp.tipo_laudo = 'USG_TRANSVAGINAL'
    )
    GROUP BY p.id, p.nome_preferido, p.patient_key
    ORDER BY p.patient_key;
  `)).rows;

  return { laudos, pacientes };
}

function buildPlan(laudos, pacientes) {
  return laudos.map((laudo) => {
    const ranked = pacientes
      .map(paciente => candidateScore(laudo, paciente))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];
    const decision = decide(best, second);
    return {
      ...best,
      secondPacienteId: second?.pacienteId || null,
      secondPacienteNome: second?.pacienteNome || null,
      secondScore: second?.score || 0,
      margem: best.score - (second?.score || 0),
      action: decision.action,
      classe: decision.classe,
      motivo: decision.motivo,
    };
  });
}

async function writeReports(plan, stamp) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, `usg-tv-correlacoes-${stamp}.json`);
  const csvPath = path.join(REPORT_DIR, `usg-tv-correlacoes-${stamp}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify(plan, null, 2), 'utf8');
  const headers = [
    'action', 'classe', 'motivo', 'laudoId', 'laudoNome', 'laudoArquivo',
    'pacienteId', 'pacienteNome', 'score', 'secondPacienteId',
    'secondPacienteNome', 'secondScore', 'margem', 'hasTvOci', 'regionOk',
    'regiaoMae', 'regioes',
  ];
  const lines = [
    headers.join(','),
    ...plan.map(row => headers.map(header => csvEscape(
      header === 'regioes' ? (row.regioes || []).join('; ') : row[header],
    )).join(',')),
  ];
  await fs.writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, csvPath };
}

async function applyPlan(plan) {
  const applicable = plan.filter(row => row.action === 'aplicar');
  let applied = 0;
  let skipped = 0;
  await ensureReviewTable();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of applicable) {
      const current = await client.query(
        `SELECT paciente_id FROM oci.laudos_pacientes WHERE id = $1::bigint FOR UPDATE`,
        [row.laudoId],
      );
      if (!current.rowCount || current.rows[0].paciente_id !== null) {
        skipped += 1;
        continue;
      }
      const stillNoTv = await client.query(`
        SELECT NOT EXISTS (
          SELECT 1
          FROM oci.laudos_pacientes lp
          WHERE lp.paciente_id = $1::bigint
            AND lp.tipo_laudo = 'USG_TRANSVAGINAL'
        ) AS ok;
      `, [row.pacienteId]);
      if (!stillNoTv.rows[0]?.ok) {
        skipped += 1;
        continue;
      }
      await client.query(`
        UPDATE oci.laudos_pacientes
        SET paciente_id = $2::bigint,
            status_vinculo = 'vinculado_auto_tv',
            confianca_vinculo = $3,
            vinculo_motivo = $4
        WHERE id = $1::bigint;
      `, [row.laudoId, row.pacienteId, row.score, row.classe]);
      await client.query(`
        INSERT INTO oci.laudos_pacientes_revisoes (
          laudo_id,
          acao,
          paciente_id_anterior,
          paciente_id_novo,
          revisado_por,
          motivo
        )
        VALUES ($1, 'auto_vincular_usg_tv', NULL, $2, 'codex_auto', $3);
      `, [row.laudoId, row.pacienteId, `${row.classe}: ${row.motivo}`]);
      applied += 1;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { planned: applicable.length, applied, skipped };
}

function summarize(plan) {
  return plan.reduce((acc, row) => {
    const key = `${row.action}:${row.classe}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  const stamp = nowStamp();
  const { laudos, pacientes } = await loadData();
  const plan = buildPlan(laudos, pacientes);
  const report = await writeReports(plan, stamp);
  let applied = 0;
  let applyStats = { planned: plan.filter(row => row.action === 'aplicar').length, applied: 0, skipped: 0 };
  if (COMMIT) {
    applyStats = await applyPlan(plan);
    applied = applyStats.applied;
  }
  const after = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE tipo_laudo = 'USG_TRANSVAGINAL')::int AS tv_total,
      COUNT(*) FILTER (WHERE tipo_laudo = 'USG_TRANSVAGINAL' AND paciente_id IS NOT NULL)::int AS tv_vinculados,
      COUNT(*) FILTER (WHERE tipo_laudo = 'USG_TRANSVAGINAL' AND paciente_id IS NULL)::int AS tv_pendentes
    FROM oci.laudos_pacientes;
  `);
  console.log(JSON.stringify({
    modo: COMMIT ? 'commit' : 'dry-run',
    pendentesAnalisados: laudos.length,
    pacientesCandidatosSemTv: pacientes.length,
    resumo: summarize(plan),
    aplicar: plan.filter(row => row.action === 'aplicar').length,
    duvidas: plan.filter(row => row.action === 'duvida').length,
    applied,
    applyStats,
    report,
    bancoDepois: after.rows[0],
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

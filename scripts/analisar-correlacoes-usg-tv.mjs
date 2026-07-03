import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.OCI_DB_HOST || '127.0.0.1',
  port: Number(process.env.OCI_DB_PORT || 55432),
  database: process.env.OCI_DB_NAME || 'ocis_local',
  user: process.env.OCI_DB_USER || 'oci_admin',
  password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

const SCOPE = process.argv.includes('--sem-tv') ? 'sem_tv' : 'sem_laudo';

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
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
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

function classify(best, second) {
  const margin = best.score - (second?.score || 0);
  if (best.regiaoMae === 'EM ESPERA') return 'em_espera_cadastro';
  if (best.regiaoMae === 'FORA DO PERIODO') return 'fora_periodo_operacional';
  if (best.exact && best.hasTvOci) return 'auto_exato';
  if (best.score >= 0.96 && margin >= 0.04 && best.hasTvOci && best.regionOk) return 'auto_quase_exato';
  if (best.score >= 0.92 && margin >= 0.05 && best.hasTvOci && best.regionOk && best.firstLast) return 'revisao_alta_chance';
  if (best.score >= 0.86 && margin >= 0.06 && best.hasTvOci) return 'revisao_media_chance';
  if (best.score >= 0.82) return 'conflito_ou_baixa_chance';
  return 'sem_candidato_bom';
}

async function main() {
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

  const candidateWhere = SCOPE === 'sem_tv'
    ? `NOT EXISTS (
      SELECT 1
      FROM oci.laudos_pacientes lp
      WHERE lp.paciente_id = p.id
        AND lp.tipo_laudo = 'USG_TRANSVAGINAL'
    )`
    : `NOT EXISTS (
      SELECT 1
      FROM oci.laudos_pacientes lp
      WHERE lp.paciente_id = p.id
    )`;

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
    WHERE ${candidateWhere}
    GROUP BY p.id, p.nome_preferido, p.patient_key
    ORDER BY p.patient_key;
  `)).rows;

  const results = [];
  for (const laudo of laudos) {
    const regiaoMae = laudoRegiaoMae(laudo);
    const ranked = pacientes.map((paciente) => {
      const nameSimilarity = similarity(laudo.nome_normalizado || '', paciente.patient_key || '');
      const tokenSimilarity = tokenJaccard(laudo.nome_normalizado || '', paciente.patient_key || '');
      const score = (nameSimilarity * 0.72) + (tokenSimilarity * 0.28);
      const regionOk = regiaoMae === 'NAO CLASSIFICADA' || (paciente.regioes || []).includes(regiaoMae);
      return {
        laudoId: Number(laudo.id),
        laudoNome: laudo.nome_normalizado,
        laudoArquivo: laudo.arquivo_original,
        regiaoMae,
        pacienteId: Number(paciente.id),
        pacienteNome: paciente.patient_key,
        nomePreferido: paciente.nome_preferido,
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
    }).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];
    results.push({ ...best, secondScore: second?.score || 0, className: classify(best, second) });
  }

  const summary = results.reduce((acc, row) => {
    acc[row.className] = (acc[row.className] || 0) + 1;
    return acc;
  }, {});

  const examples = Object.fromEntries(
    Object.keys(summary).sort().map(className => [
      className,
      results
        .filter(row => row.className === className)
        .slice(0, 8)
        .map(row => ({
          laudoId: row.laudoId,
          laudoNome: row.laudoNome,
          pacienteId: row.pacienteId,
          pacienteNome: row.pacienteNome,
          score: Number(row.score.toFixed(4)),
          secondScore: Number(row.secondScore.toFixed(4)),
          hasTvOci: row.hasTvOci,
          regionOk: row.regionOk,
          regioes: row.regioes,
        })),
    ]),
  );

  console.log(JSON.stringify({
    pendentesTransvaginal: laudos.length,
    escopoCandidatos: SCOPE,
    pacientesCandidatos: pacientes.length,
    resumo: summary,
    exemplos: examples,
  }, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

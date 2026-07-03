// Fase 3 do pipeline de laudos: vinculação em cascata laudo -> paciente.
//
// Níveis (do determinístico ao fuzzy; cada laudo entra no primeiro que casar):
//   1. Cartão SUS do laudo = CNS do paciente (único)
//   2. Nome exato + atendimento na data do laudo (±1 dia) + procedimento compatível
//   3. Nome exato + procedimento compatível (sem data casando)
//   4. Nome exato apenas (laudo sem procedimento registrado na planilha -> alerta)
//   5. Nome similar (pg_trgm) com âncoras: atendimento na data (±1), região da
//      pasta quando conhecida e procedimento compatível; exige margem sobre o
//      2º candidato. Similaridade sozinha nunca vincula.
//   Restante -> pendente_revisao (fila humana no pacientes.html).
//
// Laudos de grupos homônimos (mesmo nome/tipo/data com nascimentos/idades
// divergentes) nunca são vinculados automaticamente.
//
// Uso:
//   node scripts/vincular-laudos-pacientes.mjs            (simulação, não grava)
//   node scripts/vincular-laudos-pacientes.mjs --aplicar  (grava vínculos)

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const APLICAR = process.argv.includes('--aplicar');

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

const SETUP_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS oci.pacientes_homonimos (
    nome_key text NOT NULL,
    regiao text NOT NULL,
    paciente_id bigint NOT NULL REFERENCES oci.pacientes(id),
    observacao text,
    criado_em timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (nome_key, regiao)
);

-- apelidos confirmados: outras grafias/formas do nome que apontam para o
-- mesmo paciente (ex.: nome incompleto na planilha, sobrenome extra no laudo)
CREATE TABLE IF NOT EXISTS oci.pacientes_alias (
    nome_alias text PRIMARY KEY,
    paciente_id bigint NOT NULL REFERENCES oci.pacientes(id),
    observacao text,
    criado_em timestamptz NOT NULL DEFAULT now()
);

-- procedimento SIGTAP esperado para cada tipo de laudo
CREATE TEMP TABLE tipo_proc (tipo_laudo text, codigo_procedimento text);
INSERT INTO tipo_proc VALUES
    ('MAMOGRAFIA',               '02.04.03.003-0'),
    ('USG_MAMA',                 '02.05.02.009-7'),
    ('USG_MAMA_COMPLEMENTACAO',  '02.05.02.009-7'),
    ('USG_TRANSVAGINAL',         '02.05.02.018-6'),
    ('USG_PELVICA',              '02.05.02.016-0'),
    ('USG_TRANSVAGINAL_PELVICA', '02.05.02.018-6'),
    ('USG_TRANSVAGINAL_PELVICA', '02.05.02.016-0');

-- laudos elegíveis (ativos, pendentes, fora da quarentena). Nomes de
-- homônimos divididos manualmente nunca são vinculados automaticamente:
-- vão sempre para revisão humana.
CREATE TEMP TABLE laudos_alvo AS
SELECT l.id, l.tipo_laudo, l.nome_normalizado, l.cartao_sus, l.data_realizacao,
       l.regiao_pasta, l.data_nascimento, l.idade_anos
FROM oci.laudos_pacientes l
WHERE l.registro_ativo
  AND l.status_vinculo IN ('pendente', 'pendente_revisao')
  AND l.tipo_laudo <> 'QUARENTENA_OUTRO'
  AND l.nome_normalizado NOT IN (SELECT nome_key FROM oci.pacientes_homonimos);

-- grupos homônimos: mesmo nome/tipo/data com identidades divergentes
CREATE TEMP TABLE homonimos AS
SELECT id FROM laudos_alvo la
WHERE EXISTS (
    SELECT 1 FROM laudos_alvo l2
    WHERE l2.nome_normalizado = la.nome_normalizado
      AND l2.tipo_laudo = la.tipo_laudo
      AND l2.data_realizacao = la.data_realizacao
      AND l2.id <> la.id
      AND (
        (l2.data_nascimento IS NOT NULL AND la.data_nascimento IS NOT NULL
            AND l2.data_nascimento <> la.data_nascimento)
        OR (l2.idade_anos IS NOT NULL AND la.idade_anos IS NOT NULL
            AND l2.idade_anos <> la.idade_anos)
      )
);

-- nomes que resolvem para paciente: chave oficial + apelidos confirmados
CREATE TEMP TABLE nomes_pacientes AS
SELECT patient_key, id, data_nascimento FROM oci.pacientes
UNION
SELECT a.nome_alias, a.paciente_id, p2.data_nascimento
FROM oci.pacientes_alias a
JOIN oci.pacientes p2 ON p2.id = a.paciente_id
WHERE a.nome_alias NOT IN (SELECT patient_key FROM oci.pacientes);

CREATE TEMP TABLE sim_vinculos (
    laudo_id bigint PRIMARY KEY,
    paciente_id bigint NOT NULL,
    nivel int NOT NULL,
    confianca numeric NOT NULL,
    motivo text NOT NULL
);

-- Nível 1: Cartão SUS = CNS (paciente único com esse CNS)
INSERT INTO sim_vinculos
SELECT l.id, p.id, 1, 1.0, 'cartao_sus_igual_cns'
FROM laudos_alvo l
JOIN oci.pacientes p ON p.cns = l.cartao_sus
WHERE l.cartao_sus IS NOT NULL
  AND l.id NOT IN (SELECT id FROM homonimos)
  AND NOT EXISTS (SELECT 1 FROM oci.pacientes p2 WHERE p2.cns = l.cartao_sus AND p2.id <> p.id);

-- Nível 2: nome exato + atendimento na data (±1 dia) + procedimento compatível
INSERT INTO sim_vinculos
SELECT l.id, p.id, 2, 1.0, 'nome_exato+data_atendimento+procedimento'
FROM laudos_alvo l
JOIN nomes_pacientes p ON p.patient_key = l.nome_normalizado
WHERE l.id NOT IN (SELECT laudo_id FROM sim_vinculos)
  AND l.id NOT IN (SELECT id FROM homonimos)
  AND (l.data_nascimento IS NULL OR p.data_nascimento IS NULL OR l.data_nascimento = p.data_nascimento)
  AND l.data_realizacao IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM oci.atendimentos a
      WHERE a.paciente_id = p.id
        AND ABS(a.data_atendimento - l.data_realizacao) <= 1
  )
  AND EXISTS (
      SELECT 1
      FROM oci.atendimentos a
      JOIN oci.atendimento_procedimentos ap ON ap.atendimento_uid = a.atendimento_uid
      JOIN tipo_proc tp ON tp.tipo_laudo = l.tipo_laudo
                       AND tp.codigo_procedimento = ap.codigo_procedimento
      WHERE a.paciente_id = p.id AND ap.status = 'REALIZADO'
  );

-- Nível 3: nome exato + procedimento compatível (data não casa)
INSERT INTO sim_vinculos
SELECT l.id, p.id, 3, 0.92, 'nome_exato+procedimento_sem_data'
FROM laudos_alvo l
JOIN nomes_pacientes p ON p.patient_key = l.nome_normalizado
WHERE l.id NOT IN (SELECT laudo_id FROM sim_vinculos)
  AND l.id NOT IN (SELECT id FROM homonimos)
  AND (l.data_nascimento IS NULL OR p.data_nascimento IS NULL OR l.data_nascimento = p.data_nascimento)
  AND EXISTS (
      SELECT 1
      FROM oci.atendimentos a
      JOIN oci.atendimento_procedimentos ap ON ap.atendimento_uid = a.atendimento_uid
      JOIN tipo_proc tp ON tp.tipo_laudo = l.tipo_laudo
                       AND tp.codigo_procedimento = ap.codigo_procedimento
      WHERE a.paciente_id = p.id AND ap.status = 'REALIZADO'
  );

-- Nível 4: nome exato apenas (procedimento não registrado na planilha)
INSERT INTO sim_vinculos
SELECT l.id, p.id, 4, 0.85, 'nome_exato_sem_procedimento_registrado'
FROM laudos_alvo l
JOIN nomes_pacientes p ON p.patient_key = l.nome_normalizado
WHERE l.id NOT IN (SELECT laudo_id FROM sim_vinculos)
  AND l.id NOT IN (SELECT id FROM homonimos)
  AND (l.data_nascimento IS NULL OR p.data_nascimento IS NULL OR l.data_nascimento = p.data_nascimento);

-- Nível 5: fuzzy com âncoras (data ±1 e região quando conhecida, procedimento
-- compatível). Rivais são medidos a partir de 0.45 para que um segundo
-- candidato plausível bloqueie o vínculo; auto-vínculo só com sim >= 0.65 e
-- margem >= 0.05 sobre o rival mais próximo.
INSERT INTO sim_vinculos
SELECT l.id, cand.paciente_id, 5, ROUND(cand.sim::numeric, 4),
       'nome_similar(' || ROUND(cand.sim::numeric, 2) || ')+data+procedimento'
FROM laudos_alvo l
CROSS JOIN LATERAL (
    SELECT p.id AS paciente_id, similarity(p.patient_key, l.nome_normalizado) AS sim,
           LEAD(similarity(p.patient_key, l.nome_normalizado))
               OVER (ORDER BY similarity(p.patient_key, l.nome_normalizado) DESC) AS sim2
    FROM oci.pacientes p
    WHERE similarity(p.patient_key, l.nome_normalizado) >= 0.45
      AND (l.data_nascimento IS NULL OR p.data_nascimento IS NULL OR l.data_nascimento = p.data_nascimento)
      AND EXISTS (
          SELECT 1 FROM oci.atendimentos a
          WHERE a.paciente_id = p.id
            AND ABS(a.data_atendimento - l.data_realizacao) <= 1
            AND (l.regiao_pasta IS NULL OR a.regiao = l.regiao_pasta)
      )
      AND EXISTS (
          SELECT 1
          FROM oci.atendimentos a
          JOIN oci.atendimento_procedimentos ap ON ap.atendimento_uid = a.atendimento_uid
          JOIN tipo_proc tp ON tp.tipo_laudo = l.tipo_laudo
                           AND tp.codigo_procedimento = ap.codigo_procedimento
          WHERE a.paciente_id = p.id AND ap.status = 'REALIZADO'
      )
    ORDER BY sim DESC
    LIMIT 1
) cand
WHERE l.id NOT IN (SELECT laudo_id FROM sim_vinculos)
  AND l.id NOT IN (SELECT id FROM homonimos)
  AND l.data_realizacao IS NOT NULL
  AND cand.sim >= 0.65
  AND (cand.sim2 IS NULL OR cand.sim - cand.sim2 >= 0.05);
`;

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(SETUP_SQL);

        const porNivel = await client.query(`
            SELECT nivel, motivo, COUNT(*) AS laudos, COUNT(DISTINCT paciente_id) AS pacientes
            FROM sim_vinculos GROUP BY nivel, motivo ORDER BY nivel
        `);
        const totais = await client.query(`
            SELECT
                (SELECT COUNT(*) FROM laudos_alvo) AS elegiveis,
                (SELECT COUNT(*) FROM sim_vinculos) AS vinculaveis,
                (SELECT COUNT(*) FROM homonimos) AS homonimos,
                (SELECT COUNT(*) FROM laudos_alvo
                  WHERE id NOT IN (SELECT laudo_id FROM sim_vinculos)
                    AND id NOT IN (SELECT id FROM homonimos)) AS sem_vinculo
        `);
        const amostraFuzzy = await client.query(`
            SELECT l.nome_normalizado AS nome_laudo, p.patient_key AS nome_banco,
                   s.confianca, l.tipo_laudo, l.data_realizacao::text
            FROM sim_vinculos s
            JOIN laudos_alvo l ON l.id = s.laudo_id
            JOIN oci.pacientes p ON p.id = s.paciente_id
            WHERE s.nivel = 5
            ORDER BY s.confianca ASC
            LIMIT 15
        `);
        const semVinculo = await client.query(`
            SELECT l.nome_normalizado, l.tipo_laudo, l.data_realizacao::text, l.regiao_pasta
            FROM laudos_alvo l
            WHERE l.id NOT IN (SELECT laudo_id FROM sim_vinculos)
              AND l.id NOT IN (SELECT id FROM homonimos)
            ORDER BY l.nome_normalizado
            LIMIT 25
        `);

        console.log(`\n=== ${APLICAR ? 'APLICANDO' : 'SIMULAÇÃO (nada será gravado)'} ===`);
        console.table(totais.rows);
        console.log('== Por nível:');
        console.table(porNivel.rows);
        console.log('== Fuzzy (nível 5) — os 15 de menor confiança:');
        console.table(amostraFuzzy.rows);
        console.log('== Amostra dos sem vínculo (vão para revisão):');
        console.table(semVinculo.rows);

        if (APLICAR) {
            // grava vínculos
            const upd = await client.query(`
                UPDATE oci.laudos_pacientes lp
                SET paciente_id = s.paciente_id,
                    status_vinculo = 'vinculado_auto',
                    confianca_vinculo = s.confianca,
                    vinculo_motivo = 'nivel_' || s.nivel || ':' || s.motivo
                FROM sim_vinculos s
                WHERE lp.id = s.laudo_id
                RETURNING lp.id
            `);
            // liga ao procedimento específico mais próximo da data do laudo
            const updProc = await client.query(`
                UPDATE oci.laudos_pacientes lp
                SET atendimento_procedimento_id = melhor.ap_id
                FROM (
                    SELECT DISTINCT ON (lp2.id) lp2.id AS laudo_id, ap.id AS ap_id
                    FROM oci.laudos_pacientes lp2
                    JOIN tipo_proc tp ON tp.tipo_laudo = lp2.tipo_laudo
                    JOIN oci.atendimentos a ON a.paciente_id = lp2.paciente_id
                    JOIN oci.atendimento_procedimentos ap
                        ON ap.atendimento_uid = a.atendimento_uid
                       AND ap.codigo_procedimento = tp.codigo_procedimento
                       AND ap.status = 'REALIZADO'
                    WHERE lp2.registro_ativo
                      AND (lp2.status_vinculo = 'vinculado_auto'
                           OR (lp2.status_vinculo = 'revisado_manual' AND lp2.atendimento_procedimento_id IS NULL))
                    ORDER BY lp2.id,
                             ABS(a.data_atendimento - COALESCE(lp2.data_realizacao, a.data_atendimento)) ASC,
                             ap.id ASC
                ) melhor
                WHERE lp.id = melhor.laudo_id
                RETURNING lp.id
            `);
            // homônimos e não-vinculados -> fila de revisão
            await client.query(`
                UPDATE oci.laudos_pacientes lp
                SET status_vinculo = 'pendente_revisao',
                    vinculo_motivo = 'conflito_identidade_homonimo'
                WHERE lp.id IN (SELECT id FROM homonimos)
            `);
            await client.query(`
                UPDATE oci.laudos_pacientes lp
                SET status_vinculo = 'pendente_revisao',
                    vinculo_motivo = COALESCE(NULLIF(vinculo_motivo, 'aguarda_revisao'), 'sem_candidato_seguro')
                WHERE lp.registro_ativo
                  AND lp.tipo_laudo <> 'QUARENTENA_OUTRO'
                  AND lp.status_vinculo = 'pendente'
            `);
            // cópias duplicadas herdam o vínculo do laudo vencedor
            await client.query(`
                UPDATE oci.laudos_pacientes d
                SET paciente_id = v.paciente_id,
                    atendimento_procedimento_id = v.atendimento_procedimento_id,
                    status_vinculo = 'vinculado_duplicado',
                    confianca_vinculo = v.confianca_vinculo,
                    vinculo_motivo = 'copia_duplicada_do_laudo_' || v.id
                FROM oci.laudos_pacientes v
                WHERE v.id = d.duplicado_de_id
                  AND v.paciente_id IS NOT NULL
                  AND d.paciente_id IS NULL
            `);

            // Regra de negócio: 1 laudo por tipo por paciente (fica o mais novo).
            // Pega duplicados que o dedup por nome não enxerga (grafias diferentes
            // do nome, números de exame distintos do mesmo exame). Nunca rebaixa
            // revisões manuais, e não mexe em grupos com nascimentos/idades
            // divergentes (podem ser duas pessoas — ficam para revisão humana).
            const dupTipo = await client.query(`
                WITH candidatos AS (
                    SELECT id, paciente_id, tipo_laudo, data_realizacao, arquivo_mtime,
                           data_nascimento, idade_anos, status_vinculo
                    FROM oci.laudos_pacientes
                    WHERE registro_ativo AND paciente_id IS NOT NULL
                      AND tipo_laudo IS NOT NULL AND tipo_laudo <> 'QUARENTENA_OUTRO'
                ),
                grupos_ok AS (
                    SELECT paciente_id, tipo_laudo
                    FROM candidatos
                    GROUP BY 1, 2
                    HAVING COUNT(*) > 1
                       AND COUNT(DISTINCT data_nascimento) <= 1
                       AND COUNT(DISTINCT idade_anos) <= 1
                ),
                ranked AS (
                    SELECT c.id, c.status_vinculo,
                        ROW_NUMBER() OVER w AS rn,
                        FIRST_VALUE(c.id) OVER w AS vencedor
                    FROM candidatos c
                    JOIN grupos_ok g USING (paciente_id, tipo_laudo)
                    WINDOW w AS (
                        PARTITION BY c.paciente_id, c.tipo_laudo
                        ORDER BY (c.status_vinculo IN ('revisado_manual', 'revisado')) DESC,
                                 c.data_realizacao DESC NULLS LAST,
                                 c.arquivo_mtime DESC NULLS LAST, c.id ASC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                    )
                )
                UPDATE oci.laudos_pacientes lp
                SET registro_ativo = false,
                    duplicado_de_id = COALESCE(lp.duplicado_de_id, r.vencedor),
                    status_vinculo = 'vinculado_duplicado',
                    vinculo_motivo = 'duplicado_mesmo_tipo_do_laudo_' || r.vencedor
                FROM ranked r
                WHERE lp.id = r.id AND r.rn > 1
                  AND r.status_vinculo NOT IN ('revisado_manual', 'revisado')
                RETURNING lp.id
            `);
            console.log(`Duplicados por tipo/paciente rebaixados: ${dupTipo.rowCount}`);

            // grupos paciente+tipo com identidades divergentes: possível laudo
            // de outra pessoa vinculado — listar para revisão
            const conflitosTipo = await client.query(`
                SELECT lp.paciente_id, p.nome_preferido, lp.tipo_laudo,
                       COUNT(*) AS qtd,
                       STRING_AGG(DISTINCT COALESCE(lp.data_nascimento::text, 'idade ' || lp.idade_anos), ' | ') AS identidades
                FROM oci.laudos_pacientes lp
                JOIN oci.pacientes p ON p.id = lp.paciente_id
                WHERE lp.registro_ativo AND lp.tipo_laudo <> 'QUARENTENA_OUTRO'
                GROUP BY 1, 2, 3
                HAVING COUNT(*) > 1
                   AND (COUNT(DISTINCT lp.data_nascimento) > 1 OR COUNT(DISTINCT lp.idade_anos) > 1)
            `);
            if (conflitosTipo.rows.length) {
                console.log(`ATENÇÃO: ${conflitosTipo.rows.length} pacientes com laudos do mesmo tipo e identidades divergentes (revisar — pode ser laudo de outra pessoa):`);
                console.table(conflitosTipo.rows);
            }
            console.log(`\nGravado: ${upd.rowCount} laudos vinculados; ${updProc.rowCount} ligados a um procedimento específico.`);
            await client.query('COMMIT');
        } else {
            await client.query('ROLLBACK');
        }

        // relatório em arquivo
        const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        const reportPath = path.join('reports', `vinculacao-laudos-${ts}${APLICAR ? '' : '-simulacao'}.md`);
        const t = totais.rows[0];
        fs.writeFileSync(reportPath, [
            `# Vinculação de laudos — ${APLICAR ? 'aplicada' : 'simulação'} — ${new Date().toLocaleString('pt-BR')}`, '',
            `- Laudos elegíveis: ${t.elegiveis}`,
            `- Vinculáveis automaticamente: ${t.vinculaveis}`,
            `- Homônimos bloqueados: ${t.homonimos}`,
            `- Sem vínculo (fila de revisão): ${t.sem_vinculo}`, '',
            '## Por nível', '',
            '| Nível | Motivo | Laudos | Pacientes |', '|---|---|---|---|',
            ...porNivel.rows.map(r => `| ${r.nivel} | ${r.motivo} | ${r.laudos} | ${r.pacientes} |`), '',
            '## Sem vínculo (amostra)', '',
            ...semVinculo.rows.map(r => `- ${r.nome_normalizado} | ${r.tipo_laudo} | ${r.data_realizacao} | ${r.regiao_pasta || '-'}`),
        ].join('\n'), 'utf8');
        console.log(`Relatório: ${reportPath}`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch(err => { console.error('ERRO na vinculação:', err); pool.end(); process.exit(1); });

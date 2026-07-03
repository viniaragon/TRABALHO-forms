// Refina os procedimentos do pacote MAMA I (Mamografia + USG Mama gravados em
// dupla quando a planilha não especifica) usando a idade da paciente:
//
//   - < 40 anos: só fez USG de mama            -> mamografia vira INFERIDO_NAO_REALIZADO
//   - >= 40 anos COM laudo de USG de mama: fez os dois -> nada muda
//   - >= 40 anos SEM laudo de USG de mama: só mamografia -> USG vira INFERIDO_NAO_REALIZADO
//   - idade desconhecida: pacote fica como está
//
// Proteção: uma linha nunca é rebaixada se existe laudo PDF vinculado a ela
// (laudo prova que o exame aconteceu, independente da regra).
//
// A idade vem do consenso de nascimento dos laudos vinculados (moda), com
// fallback na idade em anos informada no laudo mais próximo do atendimento.
// Idempotente: cada execução desfaz as inferências anteriores e recalcula.
//
// Rodar SEMPRE depois de: importar planilha -> carregar laudos -> vincular.
//
// Uso: node scripts/refinar-mama-pacote.mjs

import pg from 'pg';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

const CODIGO_MAMOGRAFIA = '02.04.03.003-0';
const CODIGO_USG_MAMA = '02.05.02.009-7';

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE oci.pacientes ADD COLUMN IF NOT EXISTS data_nascimento date;
            ALTER TABLE oci.atendimento_procedimentos ADD COLUMN IF NOT EXISTS inferencia text;
        `);

        // 1) Nascimento do paciente = moda dos nascimentos nos laudos vinculados
        const nasc = await client.query(`
            WITH consenso AS (
                SELECT paciente_id, data_nascimento,
                       ROW_NUMBER() OVER (PARTITION BY paciente_id ORDER BY COUNT(*) DESC, data_nascimento) AS rn
                FROM oci.laudos_pacientes
                WHERE paciente_id IS NOT NULL AND data_nascimento IS NOT NULL
                GROUP BY paciente_id, data_nascimento
            )
            UPDATE oci.pacientes p
            SET data_nascimento = c.data_nascimento
            FROM consenso c
            WHERE c.rn = 1 AND p.id = c.paciente_id
              AND p.data_nascimento IS DISTINCT FROM c.data_nascimento
            RETURNING p.id
        `);

        // 2) Desfaz inferências anteriores (idempotência)
        await client.query(`
            UPDATE oci.atendimento_procedimentos
            SET status = 'REALIZADO', inferencia = NULL
            WHERE status = 'INFERIDO_NAO_REALIZADO'
        `);

        // 3) Idade por atendimento do pacote: nascimento (preferido) ou idade do
        //    laudo mais próximo da data do atendimento
        await client.query(`
            CREATE TEMP TABLE pacote AS
            SELECT ap.id AS ap_id, ap.codigo_procedimento, a.atendimento_uid, a.paciente_id,
                   a.data_atendimento,
                   CASE
                       WHEN p.data_nascimento IS NOT NULL
                           THEN DATE_PART('year', AGE(a.data_atendimento, p.data_nascimento))::int
                       ELSE (
                           SELECT l.idade_anos FROM oci.laudos_pacientes l
                           WHERE l.paciente_id = a.paciente_id AND l.idade_anos IS NOT NULL
                           ORDER BY ABS(COALESCE(l.data_realizacao, a.data_atendimento) - a.data_atendimento)
                           LIMIT 1
                       )
                   END AS idade,
                   EXISTS (
                       SELECT 1 FROM oci.laudos_pacientes l
                       WHERE l.paciente_id = a.paciente_id AND l.registro_ativo
                         AND l.tipo_laudo IN ('USG_MAMA', 'USG_MAMA_COMPLEMENTACAO')
                   ) AS tem_laudo_usg_mama,
                   EXISTS (
                       SELECT 1 FROM oci.laudos_pacientes l
                       WHERE l.atendimento_procedimento_id = ap.id AND l.registro_ativo
                   ) AS tem_laudo_nesta_linha
            FROM oci.atendimento_procedimentos ap
            JOIN oci.atendimentos a ON a.atendimento_uid = ap.atendimento_uid
            JOIN oci.pacientes p ON p.id = a.paciente_id
            WHERE ap.codigo_oci = '09.01.01.001-4'
              AND ap.especificado = false
              AND ap.status = 'REALIZADO'
              AND ap.codigo_procedimento IN ($1, $2)
        `, [CODIGO_MAMOGRAFIA, CODIGO_USG_MAMA]);

        // 4a) < 40 anos: não fez mamografia (a menos que haja laudo provando)
        const menor40 = await client.query(`
            UPDATE oci.atendimento_procedimentos ap
            SET status = 'INFERIDO_NAO_REALIZADO', inferencia = 'IDADE_MENOR_40'
            FROM pacote pc
            WHERE ap.id = pc.ap_id
              AND pc.codigo_procedimento = $1
              AND pc.idade IS NOT NULL AND pc.idade < 40
              AND NOT pc.tem_laudo_nesta_linha
            RETURNING ap.id
        `, [CODIGO_MAMOGRAFIA]);

        // 4b) >= 40 sem laudo de USG de mama: não fez a USG (só mamografia)
        const maior40 = await client.query(`
            UPDATE oci.atendimento_procedimentos ap
            SET status = 'INFERIDO_NAO_REALIZADO', inferencia = 'IDADE_40MAIS_SEM_LAUDO_USG_MAMA'
            FROM pacote pc
            WHERE ap.id = pc.ap_id
              AND pc.codigo_procedimento = $1
              AND pc.idade IS NOT NULL AND pc.idade >= 40
              AND NOT pc.tem_laudo_usg_mama
              AND NOT pc.tem_laudo_nesta_linha
            RETURNING ap.id
        `, [CODIGO_USG_MAMA]);

        const restante = await client.query(`
            SELECT COUNT(*) FILTER (WHERE idade IS NULL) AS sem_idade,
                   COUNT(*) AS linhas_pacote
            FROM pacote
        `);

        await client.query('COMMIT');

        console.log(`Nascimentos atualizados em oci.pacientes: ${nasc.rowCount}`);
        console.log(`Mamografias inferidas como não realizadas (< 40 anos): ${menor40.rowCount}`);
        console.log(`USG de mama inferidas como não realizadas (>= 40 sem laudo): ${maior40.rowCount}`);
        console.log(`Linhas de pacote sem idade conhecida (mantidas como estavam): ${restante.rows[0].sem_idade}`);

        const contagem = await pool.query(`
            SELECT procedimento, COUNT(*) FILTER (WHERE status = 'REALIZADO') AS realizados,
                   COUNT(*) FILTER (WHERE status = 'INFERIDO_NAO_REALIZADO') AS inferidos_nao
            FROM oci.atendimento_procedimentos
            WHERE codigo_oci = '09.01.01.001-4'
            GROUP BY procedimento ORDER BY procedimento
        `);
        console.table(contagem.rows);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });

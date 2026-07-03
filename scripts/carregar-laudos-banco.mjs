// Fases 1-2 do pipeline de laudos: carga no banco e deduplicação lógica.
//
// Consome o NDJSON gerado por scripts/extrair-laudos-pdf.py, faz upsert por
// sha256 em oci.laudos_pacientes e marca duplicados lógicos (mantendo o mais
// novo). NÃO vincula a pacientes — isso é a fase 3, executada à parte.
//
// Uso:
//   node scripts/carregar-laudos-banco.mjs [reports/laudos-extraidos.ndjson]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pg from 'pg';

const NDJSON_PATH = process.argv[2] || 'reports/laudos-extraidos.ndjson';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

async function ensureSchema(client) {
    await client.query(`
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS regiao_pasta text;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS data_pasta date;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS em_pasta_duplicados boolean NOT NULL DEFAULT false;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS arquivo_mtime timestamptz;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS paginas integer;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS titulo_raw text;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS atendimento_procedimento_id bigint
            REFERENCES oci.atendimento_procedimentos(id);
        CREATE INDEX IF NOT EXISTS laudos_pacientes_tipo_data_idx
            ON oci.laudos_pacientes (tipo_laudo, data_realizacao);
    `);
}

async function main() {
    if (!fs.existsSync(NDJSON_PATH)) throw new Error(`NDJSON não encontrado: ${NDJSON_PATH}`);

    const client = await pool.connect();
    const stats = {
        lidos: 0, inseridos: 0, atualizados: 0, sem_sha256: 0,
    };
    try {
        await client.query('BEGIN');
        await ensureSchema(client);

        const rl = readline.createInterface({ input: fs.createReadStream(NDJSON_PATH, 'utf8') });
        for await (const line of rl) {
            if (!line.trim()) continue;
            const rec = JSON.parse(line);
            stats.lidos += 1;
            if (!rec.sha256) { stats.sem_sha256 += 1; continue; }
            const c = rec.campos || {};
            const { rows } = await client.query(
                `INSERT INTO oci.laudos_pacientes (
                    nome_extraido, nome_normalizado, cartao_sus, telefone, municipio_paciente,
                    tipo_laudo, numero_exame, data_solicitacao, data_realizacao, data_nascimento,
                    idade_anos, arquivo_original, caminho_origem, caminho_armazenado, sha256,
                    erro_extracao, origem_importacao, regiao_pasta, data_pasta, em_pasta_duplicados,
                    arquivo_mtime, paginas, titulo_raw, status_vinculo, registro_ativo
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                           CASE WHEN $6 = 'QUARENTENA_OUTRO' THEN 'quarentena' ELSE 'pendente' END, true)
                 ON CONFLICT (sha256) DO UPDATE SET
                    nome_extraido = EXCLUDED.nome_extraido,
                    nome_normalizado = EXCLUDED.nome_normalizado,
                    cartao_sus = EXCLUDED.cartao_sus,
                    telefone = EXCLUDED.telefone,
                    municipio_paciente = EXCLUDED.municipio_paciente,
                    tipo_laudo = EXCLUDED.tipo_laudo,
                    numero_exame = EXCLUDED.numero_exame,
                    data_solicitacao = EXCLUDED.data_solicitacao,
                    data_realizacao = EXCLUDED.data_realizacao,
                    data_nascimento = EXCLUDED.data_nascimento,
                    idade_anos = EXCLUDED.idade_anos,
                    erro_extracao = EXCLUDED.erro_extracao,
                    origem_importacao = EXCLUDED.origem_importacao,
                    regiao_pasta = EXCLUDED.regiao_pasta,
                    data_pasta = EXCLUDED.data_pasta,
                    em_pasta_duplicados = EXCLUDED.em_pasta_duplicados,
                    arquivo_mtime = EXCLUDED.arquivo_mtime,
                    paginas = EXCLUDED.paginas,
                    titulo_raw = EXCLUDED.titulo_raw
                 RETURNING (xmax = 0) AS inserted`,
                [
                    c.nome_extraido || '', c.nome_normalizado || '', c.cartao_sus || null,
                    c.telefone || null, c.municipio_paciente || null,
                    c.tipo_laudo || null, c.numero_exame || null, c.data_solicitacao || null,
                    c.data_realizacao || null, c.data_nascimento || null, c.idade_anos ?? null,
                    rec.arquivo_original, rec.caminho_origem, rec.caminho_armazenado, rec.sha256,
                    rec.erro_extracao || null, rec.fonte, rec.regiao_pasta || null,
                    rec.data_pasta || null, rec.em_pasta_duplicados || false,
                    rec.arquivo_mtime || null, rec.paginas ?? null, c.titulo_raw || null,
                ]
            );
            if (rows[0].inserted) stats.inseridos += 1; else stats.atualizados += 1;
        }

        // -------------------------------------------------------------------
        // Fase 2: deduplicação lógica (recalculada do zero a cada execução,
        // exceto para laudos já revisados manualmente)
        // -------------------------------------------------------------------
        await client.query(`
            UPDATE oci.laudos_pacientes
            SET duplicado_de_id = NULL, registro_ativo = true
            WHERE status_vinculo NOT IN ('vinculado_manual', 'revisado')
        `);

        // Mamografia: mesmo nº de exame + cartão SUS => mantém realização mais
        // recente (depois arquivo mais novo, depois mais páginas)
        const dupMamo = await client.query(`
            WITH candidatos AS (
                SELECT id, numero_exame, cartao_sus, data_realizacao, arquivo_mtime, paginas
                FROM oci.laudos_pacientes
                WHERE origem_importacao = 'SAUDEMOVEL'
                  AND numero_exame IS NOT NULL AND cartao_sus IS NOT NULL
                  AND status_vinculo NOT IN ('vinculado_manual', 'revisado')
            ),
            ranked AS (
                SELECT id,
                    ROW_NUMBER() OVER w AS rn,
                    FIRST_VALUE(id) OVER w AS vencedor
                FROM candidatos
                WINDOW w AS (
                    PARTITION BY numero_exame, cartao_sus
                    ORDER BY data_realizacao DESC NULLS LAST, arquivo_mtime DESC NULLS LAST,
                             paginas DESC NULLS LAST, id ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                )
            )
            UPDATE oci.laudos_pacientes lp
            SET duplicado_de_id = r.vencedor, registro_ativo = false,
                chave_logica = 'MAMO|' || lp.numero_exame || '|' || lp.cartao_sus
            FROM ranked r
            WHERE lp.id = r.id AND r.rn > 1
            RETURNING lp.id
        `);

        // USG: mesmo nome + tipo + data => duplicado, DESDE QUE não haja
        // conflito de identidade (nascimentos ou idades distintos no grupo).
        // Vencedor: fora da pasta _duplicados_arquivados, depois o mais novo.
        const dupUsg = await client.query(`
            WITH candidatos AS (
                SELECT id, nome_normalizado, tipo_laudo, data_realizacao,
                       data_nascimento, idade_anos, em_pasta_duplicados, arquivo_mtime
                FROM oci.laudos_pacientes
                WHERE origem_importacao = 'USG' AND tipo_laudo LIKE 'USG%'
                  AND nome_normalizado <> '' AND data_realizacao IS NOT NULL
                  AND status_vinculo NOT IN ('vinculado_manual', 'revisado')
            ),
            grupos_ok AS (
                SELECT nome_normalizado, tipo_laudo, data_realizacao
                FROM candidatos
                GROUP BY 1, 2, 3
                HAVING COUNT(*) > 1
                   AND COUNT(DISTINCT data_nascimento) <= 1
                   AND COUNT(DISTINCT idade_anos) <= 1
            ),
            ranked AS (
                SELECT c.id,
                    ROW_NUMBER() OVER w AS rn,
                    FIRST_VALUE(c.id) OVER w AS vencedor
                FROM candidatos c
                JOIN grupos_ok g USING (nome_normalizado, tipo_laudo, data_realizacao)
                WINDOW w AS (
                    PARTITION BY c.nome_normalizado, c.tipo_laudo, c.data_realizacao
                    ORDER BY c.em_pasta_duplicados ASC, c.arquivo_mtime DESC NULLS LAST, c.id ASC
                    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                )
            )
            UPDATE oci.laudos_pacientes lp
            SET duplicado_de_id = r.vencedor, registro_ativo = false,
                chave_logica = 'USG|' || lp.tipo_laudo || '|' || lp.nome_normalizado || '|' || lp.data_realizacao
            FROM ranked r
            WHERE lp.id = r.id AND r.rn > 1
            RETURNING lp.id
        `);

        // Grupos USG com conflito de identidade (mesmo nome/tipo/data, mas
        // nascimento ou idade divergentes): não deduplicar, sinalizar.
        const conflitos = await client.query(`
            WITH candidatos AS (
                SELECT id, nome_normalizado, tipo_laudo, data_realizacao, data_nascimento, idade_anos
                FROM oci.laudos_pacientes
                WHERE origem_importacao = 'USG' AND tipo_laudo LIKE 'USG%'
                  AND nome_normalizado <> '' AND data_realizacao IS NOT NULL
                  AND registro_ativo
            ),
            conflito AS (
                SELECT nome_normalizado, tipo_laudo, data_realizacao
                FROM candidatos
                GROUP BY 1, 2, 3
                HAVING COUNT(*) > 1
                   AND (COUNT(DISTINCT data_nascimento) > 1 OR COUNT(DISTINCT idade_anos) > 1)
            )
            SELECT c.nome_normalizado, c.tipo_laudo, c.data_realizacao::text,
                   COUNT(*) AS qtd,
                   STRING_AGG(DISTINCT COALESCE(c.data_nascimento::text, 'idade ' || c.idade_anos), ' | ') AS identidades
            FROM candidatos c
            JOIN conflito USING (nome_normalizado, tipo_laudo, data_realizacao)
            GROUP BY 1, 2, 3
        `);

        await client.query('COMMIT');

        // -------------------------------------------------------------------
        // Relatório
        // -------------------------------------------------------------------
        const resumo = await client.query(`
            SELECT origem_importacao AS fonte, COALESCE(tipo_laudo, '(sem tipo)') AS tipo,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE registro_ativo) AS ativos,
                   COUNT(*) FILTER (WHERE NOT registro_ativo) AS duplicados,
                   COUNT(*) FILTER (WHERE erro_extracao IS NOT NULL) AS com_erro
            FROM oci.laudos_pacientes
            GROUP BY 1, 2 ORDER BY 1, 2
        `);
        const erros = await client.query(`
            SELECT erro_extracao, COUNT(*) AS qtd
            FROM oci.laudos_pacientes
            WHERE erro_extracao IS NOT NULL
            GROUP BY 1 ORDER BY qtd DESC LIMIT 25
        `);

        console.log('\n== Carga:', stats);
        console.log(`== Dedup: ${dupMamo.rowCount} mamografias e ${dupUsg.rowCount} USGs marcadas como duplicadas`);
        console.log('\n== Laudos por fonte/tipo:');
        console.table(resumo.rows);
        console.log('== Erros de extração mais comuns:');
        console.table(erros.rows);
        if (conflitos.rows.length) {
            console.log(`== ATENÇÃO: ${conflitos.rows.length} grupos com mesmo nome/tipo/data mas identidades divergentes (possíveis homônimos):`);
            console.table(conflitos.rows.slice(0, 20));
        }

        const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        const reportPath = path.join('reports', `carga-laudos-${ts}.md`);
        const md = [
            `# Carga de laudos — ${new Date().toLocaleString('pt-BR')}`, '',
            `- NDJSON: ${NDJSON_PATH}`,
            `- Registros lidos: ${stats.lidos} (inseridos ${stats.inseridos}, atualizados ${stats.atualizados}, sem sha256 ${stats.sem_sha256})`,
            `- Duplicados marcados: ${dupMamo.rowCount} mamografia, ${dupUsg.rowCount} USG`, '',
            '## Por fonte/tipo', '',
            '| Fonte | Tipo | Total | Ativos | Duplicados | Com erro |', '|---|---|---|---|---|---|',
            ...resumo.rows.map(r => `| ${r.fonte} | ${r.tipo} | ${r.total} | ${r.ativos} | ${r.duplicados} | ${r.com_erro} |`), '',
            '## Erros de extração', '',
            ...erros.rows.map(r => `- ${r.qtd}× ${r.erro_extracao}`), '',
            '## Grupos com identidade divergente (homônimos potenciais)', '',
            ...(conflitos.rows.length
                ? conflitos.rows.map(r => `- ${r.nome_normalizado} | ${r.tipo_laudo} | ${r.data_realizacao} | ${r.qtd} laudos | identidades: ${r.identidades}`)
                : ['Nenhum.']),
        ].join('\n');
        fs.writeFileSync(reportPath, md, 'utf8');
        console.log(`\nRelatório: ${reportPath}`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch(err => { console.error('ERRO na carga:', err); pool.end(); process.exit(1); });

// Gera relatório de apoio à decisão para os laudos em pendente_revisao:
// para cada laudo, os 3 melhores candidatos do banco com os sinais de âncora
// (similaridade de nome, atendimento na data do laudo, região, municípios).
//
// Uso: node scripts/analisar-pendentes-revisao.mjs

import fs from 'node:fs';
import pg from 'pg';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

async function main() {
    const { rows: laudos } = await pool.query(`
        SELECT id, tipo_laudo, nome_extraido, nome_normalizado, data_realizacao::text AS data,
               regiao_pasta, data_nascimento::text AS nascimento, idade_anos, arquivo_original,
               vinculo_motivo
        FROM oci.laudos_pacientes
        WHERE status_vinculo = 'pendente_revisao' AND registro_ativo
        ORDER BY (vinculo_motivo = 'conflito_identidade_homonimo') DESC, regiao_pasta, data_realizacao, nome_normalizado
    `);

    const linhas = [
        `# Apoio à revisão manual — ${laudos.length} laudos pendentes — ${new Date().toLocaleString('pt-BR')}`,
        '',
        'Para cada laudo: os melhores candidatos do banco com sinais. Regra de ouro:',
        'similaridade alta SEM âncora (data/região/procedimento) não basta para vincular.',
        '',
    ];

    for (const l of laudos) {
        const { rows: cands } = await pool.query(`
            SELECT p.id, p.nome_preferido,
                   ROUND(similarity(p.patient_key, $1)::numeric, 2) AS sim,
                   EXISTS (SELECT 1 FROM oci.atendimentos a WHERE a.paciente_id = p.id
                           AND $2::date IS NOT NULL AND ABS(a.data_atendimento - $2::date) <= 1) AS na_data,
                   (SELECT STRING_AGG(DISTINCT a.regiao || '/' || m.nome, ', ')
                      FROM oci.atendimentos a JOIN oci.municipios m ON m.id = a.municipio_id
                     WHERE a.paciente_id = p.id) AS onde,
                   (SELECT STRING_AGG(DISTINCT TO_CHAR(a.data_atendimento, 'DD/MM'), ', ')
                      FROM oci.atendimentos a WHERE a.paciente_id = p.id) AS quando
            FROM oci.pacientes p
            WHERE similarity(p.patient_key, $1) >= 0.35
            ORDER BY na_data DESC, sim DESC
            LIMIT 3
        `, [l.nome_normalizado, l.data]);

        const identidade = l.nascimento || (l.idade_anos ? `${l.idade_anos} anos` : 'sem identidade');
        const marcador = l.vinculo_motivo === 'conflito_identidade_homonimo' ? ' ⚠️ HOMÔNIMO' : '';
        linhas.push(`## Laudo #${l.id} — ${l.nome_extraido}${marcador}`);
        linhas.push(`${l.tipo_laudo} | exame ${l.data || '?'} | região ${l.regiao_pasta || '?'} | ${identidade} | \`${l.arquivo_original}\``);
        if (!cands.length) {
            linhas.push('- (nenhum candidato nem com 35% de similaridade — provável paciente fora da planilha)');
        }
        for (const c of cands) {
            const sinais = [
                `similaridade ${(c.sim * 100).toFixed(0)}%`,
                c.na_data ? '✓ ATENDIMENTO NA DATA DO LAUDO' : 'sem atendimento na data',
            ];
            linhas.push(`- Candidata **${c.nome_preferido}** (id ${c.id}) — ${sinais.join(' · ')} — ${c.onde || ''} — atendida: ${c.quando || ''}`);
        }
        linhas.push('');
    }

    const out = 'reports/analise-pendentes-revisao.md';
    fs.writeFileSync(out, linhas.join('\n'), 'utf8');
    console.log(`${laudos.length} laudos analisados -> ${out}`);
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });

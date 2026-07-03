// Correções de laudos órfãos confirmadas pelo Vinicius em 02/07/2026 contra o
// cadastro oficial:
//  - JUCICLEIDE SOUZA (laudo 3460) = JUCICLEIDE SOUZA DO NASCIMENTO (id 2402),
//      nasc 31/01/1982, CNS 709609633011372, CPF 01176492527
//  - ADIRIANA DE JESUS BRITO LEITE (laudo 3606) = ADRIANA DE JESUS BRITO LEITE
//      (id 2267), nasc 28/09/1991, CNS 707007800346430, CPF 04508058590
//  - LUCAS HANIEL DINIZ GOMES DA SILVA (laudo 1658): pessoa real (JACOBINA18017),
//      ausente da planilha Brenda; aviso de possível erro (sexo masculino /
//      possível paciente trans)
//  - MARGARIDA ALVES DA SILVA (laudo 1648): pessoa real (JACOBINA18013, nasc
//      06/10/1972, CNS 706600560147110, CPF 86925164572); consta na versão
//      ATUALIZADA da planilha Brenda (JUNHO-JACOBINA linha 272, 04/06) que ainda
//      não foi reimportada -> paciente criada agora, atendimento virá do reimport
//  - RAMILES SILVA DE JESUS (laudo 3546): cadastro oficial anotado (JACOBINA
//      18043, nasc 15/06/1998, CNS 703004872326570); aguardando confirmação

import pg from 'pg';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

async function vincula(client, laudoId, pacienteId, codigoProc, motivo) {
    let apId = null;
    if (codigoProc) {
        const proc = await client.query(`
            SELECT ap.id FROM oci.atendimento_procedimentos ap
            JOIN oci.atendimentos a ON a.atendimento_uid = ap.atendimento_uid
            JOIN oci.laudos_pacientes l ON l.id = $3
            WHERE a.paciente_id = $1 AND ap.codigo_procedimento = $2 AND ap.status = 'REALIZADO'
            ORDER BY ABS(a.data_atendimento - COALESCE(l.data_realizacao, a.data_atendimento))
            LIMIT 1
        `, [pacienteId, codigoProc, laudoId]);
        apId = proc.rows[0]?.id || null;
    }
    await client.query(`
        UPDATE oci.laudos_pacientes
        SET paciente_id = $2, status_vinculo = 'revisado_manual', confianca_vinculo = 1,
            atendimento_procedimento_id = $3, vinculo_motivo = $4
        WHERE id = $1
    `, [laudoId, pacienteId, apId, motivo]);
    await client.query(`
        INSERT INTO oci.laudos_pacientes_revisoes (laudo_id, acao, paciente_id_novo, revisado_por, motivo)
        VALUES ($1, 'vincular', $2, 'vinicius', $3)
    `, [laudoId, pacienteId, motivo]);
    return apId;
}

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // JUCICLEIDE SOUZA DO NASCIMENTO
        await client.query(`
            UPDATE oci.pacientes SET cpf = '01176492527', cns = '709609633011372',
                data_nascimento = '1982-01-31', atualizado_em = now()
            WHERE id = 2402
        `);
        await vincula(client, 3460, 2402, '02.05.02.016-0',
            'nome incompleto no laudo (JUCICLEIDE SOUZA); cadastro oficial confirmado pelo Vinicius');

        // ADRIANA DE JESUS BRITO LEITE
        await client.query(`
            UPDATE oci.pacientes SET cpf = '04508058590', cns = '707007800346430',
                data_nascimento = '1991-09-28', atualizado_em = now()
            WHERE id = 2267
        `);
        await vincula(client, 3606, 2267, '02.05.02.009-7',
            'nome digitado errado no laudo (ADIRIANA -> ADRIANA); cadastro oficial confirmado pelo Vinicius');

        // LUCAS HANIEL: real, fora da planilha, aviso registrado
        await client.query(`
            UPDATE oci.laudos_pacientes
            SET status_vinculo = 'nao_encontrado',
                vinculo_motivo = 'ATENCAO: possivel erro - paciente de sexo masculino (possivel paciente trans). Pessoa real no cadastro oficial (JACOBINA18017, CNS 700504972960256, nasc 01/10/2001), ausente da planilha Brenda.'
            WHERE id = 1658
        `);
        await client.query(`
            INSERT INTO oci.laudos_pacientes_revisoes (laudo_id, acao, revisado_por, motivo)
            VALUES (1658, 'nao_encontrado', 'vinicius', 'possivel erro: paciente sexo masculino; nao consta na planilha Brenda')
        `);

        // MARGARIDA ALVES DA SILVA: paciente criada; atendimento virá da planilha atualizada
        const marg = await client.query(`
            INSERT INTO oci.pacientes (patient_key, nome_preferido, cpf, cns, data_nascimento)
            VALUES ('MARGARIDA ALVES DA SILVA', 'MARGARIDA ALVES DA SILVA',
                    '86925164572', '706600560147110', '1972-10-06')
            ON CONFLICT (patient_key) DO UPDATE SET
                cpf = COALESCE(oci.pacientes.cpf, EXCLUDED.cpf),
                cns = COALESCE(oci.pacientes.cns, EXCLUDED.cns),
                atualizado_em = now()
            RETURNING id
        `);
        const margId = marg.rows[0].id;
        await vincula(client, 1648, margId, null,
            'cadastro oficial JACOBINA18013; consta na planilha Brenda ATUALIZADA (JUNHO-JACOBINA linha 272, 04/06/2026, GIN I / MAMA I) ainda nao reimportada');

        // RAMILES: só anotação — aguardando confirmação do Vinicius
        await client.query(`
            UPDATE oci.laudos_pacientes
            SET vinculo_motivo = 'verificado no cadastro oficial: RAMILES SILVA DE JESUS, JACOBINA 18043, nasc 15/06/1998, CNS 703004872326570; ausente da copia atual da planilha Brenda - aguardando planilha atualizada'
            WHERE id = 3546
        `);

        await client.query('COMMIT');
        console.log('Correções aplicadas. MARGARIDA paciente id:', margId);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });

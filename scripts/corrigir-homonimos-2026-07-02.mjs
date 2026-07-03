// Correções de identidade confirmadas pelo Vinicius em 02/07/2026 contra o
// sistema de cadastro oficial (prints dos prontuários):
//
//  - ANTONIA PEREIRA DA SILVA: são 2 pessoas -> dividir
//      Valença: nasc 26/08/1979, CNS 703507041960530, CPF 02230385550 (mantém id 1542)
//      Jacobina/Caém: nasc 13/06/1978, CNS 704000821529460, CPF 85775676564 (nova)
//  - MARIA LUCIA DOS SANTOS: são 2 pessoas -> dividir
//      Valença: nasc 16/09/1976, CNS 703408102955800, CPF 02879734513 (mantém id 2235)
//      Jacobina: nasc 24/12/1974, CNS 704106177763371, CPF 01717010547 (nova)
//  - MARIA JOSE DOS SANTOS: mesma pessoa; laudos com nasc 19/03/1977 estão errados,
//      correto 25/05/1967
//  - GERILANDIA SOUSA DE OLIVEIRA: mesma pessoa; laudo com nasc 28/03/1980 errado,
//      correto 28/04/1974; CNS 708704187051590, CPF 73195545500
//  - ROSEMEIRE DE JESUS: mesma pessoa; laudo com nasc 19/06/1967 errado,
//      correto 05/06/1980
//
// Também cria oci.pacientes_homonimos, consultada pelo importador da planilha
// para rotear homônimos divididos por (nome, região) em reimportações.

import pg from 'pg';

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

async function corrigeLaudos(client, ids, nascimentoCorreto, motivo) {
    await client.query(`
        UPDATE oci.laudos_pacientes
        SET data_nascimento = $2,
            idade_anos = NULL,
            erro_extracao = COALESCE(erro_extracao || '; ', '') || 'nascimento corrigido manualmente (estava errado no PDF)'
        WHERE id = ANY($1)
    `, [ids, nascimentoCorreto]);
    for (const id of ids) {
        await client.query(`
            INSERT INTO oci.laudos_pacientes_revisoes (laudo_id, acao, revisado_por, motivo)
            VALUES ($1, 'correcao_identidade', 'vinicius', $2)
        `, [id, motivo]);
    }
}

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            CREATE TABLE IF NOT EXISTS oci.pacientes_homonimos (
                nome_key text NOT NULL,
                regiao text NOT NULL,
                paciente_id bigint NOT NULL REFERENCES oci.pacientes(id),
                observacao text,
                criado_em timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (nome_key, regiao)
            );
        `);

        // ------------------- ANTONIA PEREIRA DA SILVA (dividir) -------------
        await client.query(`
            UPDATE oci.pacientes
            SET data_nascimento = '1979-08-26', atualizado_em = now()
            WHERE id = 1542
        `);
        const antoniaJ = await client.query(`
            INSERT INTO oci.pacientes (patient_key, nome_preferido, cpf, cns, data_nascimento)
            VALUES ('ANTONIA PEREIRA DA SILVA #1978-06-13', 'ANTONIA PEREIRA DA SILVA',
                    '85775676564', '704000821529460', '1978-06-13')
            ON CONFLICT (patient_key) DO UPDATE SET atualizado_em = now()
            RETURNING id
        `);
        const antoniaJId = antoniaJ.rows[0].id;
        await client.query(`UPDATE oci.atendimentos SET paciente_id = $1 WHERE atendimento_uid = 'MAIO-JACOBINA#R0396'`, [antoniaJId]);
        await client.query(`UPDATE oci.laudos_pacientes SET paciente_id = $1 WHERE id = ANY(ARRAY[633,634,635,4390]::bigint[])`, [antoniaJId]);
        await client.query(`
            INSERT INTO oci.pacientes_homonimos (nome_key, regiao, paciente_id, observacao) VALUES
                ('ANTONIA PEREIRA DA SILVA', 'JACOBINA', $1, 'confirmado no cadastro oficial em 02/07/2026'),
                ('ANTONIA PEREIRA DA SILVA', 'VALENCA', 1542, 'confirmado no cadastro oficial em 02/07/2026')
            ON CONFLICT (nome_key, regiao) DO UPDATE SET paciente_id = EXCLUDED.paciente_id
        `, [antoniaJId]);

        // ------------------- MARIA LUCIA DOS SANTOS (dividir) ---------------
        const mariaLJ = await client.query(`
            INSERT INTO oci.pacientes (patient_key, nome_preferido, cpf, cns, data_nascimento)
            VALUES ('MARIA LUCIA DOS SANTOS #1974-12-24', 'MARIA LUCIA DOS SANTOS',
                    '01717010547', '704106177763371', '1974-12-24')
            ON CONFLICT (patient_key) DO UPDATE SET atualizado_em = now()
            RETURNING id
        `);
        const mariaLJId = mariaLJ.rows[0].id;
        await client.query(`UPDATE oci.atendimentos SET paciente_id = $1 WHERE atendimento_uid = 'JUNHO-JACOBINA#R0142'`, [mariaLJId]);
        await client.query(`UPDATE oci.laudos_pacientes SET paciente_id = $1 WHERE id = ANY(ARRAY[1660,1661]::bigint[])`, [mariaLJId]);
        await client.query(`
            INSERT INTO oci.pacientes_homonimos (nome_key, regiao, paciente_id, observacao) VALUES
                ('MARIA LUCIA DOS SANTOS', 'JACOBINA', $1, 'confirmado no cadastro oficial em 02/07/2026'),
                ('MARIA LUCIA DOS SANTOS', 'VALENCA', 2235, 'confirmado no cadastro oficial em 02/07/2026')
            ON CONFLICT (nome_key, regiao) DO UPDATE SET paciente_id = EXCLUDED.paciente_id
        `, [mariaLJId]);

        // ------------------- correções de nascimento digitado errado --------
        await corrigeLaudos(client, [334, 335, 336, 3990], '1967-05-25',
            'MARIA JOSE DOS SANTOS: nascimento correto 25/05/1967 (cadastro oficial); 19/03/1977 estava errado no laudo');
        await corrigeLaudos(client, [3496], '1980-06-05',
            'ROSEMEIRE DE JESUS: nascimento correto 05/06/1980 (cadastro oficial); 19/06/1967 estava errado no laudo');
        await corrigeLaudos(client, [1522], '1974-04-28',
            'GERILANDIA SOUSA DE OLIVEIRA: nascimento correto 28/04/1974 (cadastro oficial); 28/03/1980 estava errado no laudo');

        // ------------------- identificadores oficiais -----------------------
        await client.query(`
            UPDATE oci.pacientes SET cpf = '73195545500', cns = '708704187051590',
                   data_nascimento = '1974-04-28', atualizado_em = now()
            WHERE id = 1908
        `);

        await client.query('COMMIT');
        console.log('Correções aplicadas.');
        console.log(`Nova paciente ANTONIA (Jacobina): id ${antoniaJId}`);
        console.log(`Nova paciente MARIA LUCIA (Jacobina): id ${mariaLJId}`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });

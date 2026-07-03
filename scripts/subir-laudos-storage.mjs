// Sobe para o Firebase Storage (bucket privado) apenas os laudos VINCULADOS a
// paciente: órfãos, cópias duplicadas, quarentena e descartados ficam de fora.
//
// Retomável: cada arquivo enviado grava storage_path no banco; reexecutar pula
// o que já subiu. Destino: laudos/<sha256>.pdf
//
// Uso:
//   node scripts/subir-laudos-storage.mjs            (sobe pendentes)
//   node scripts/subir-laudos-storage.mjs --dry-run  (só conta, não sobe)

import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const DRY_RUN = process.argv.includes('--dry-run');
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'vortexaiecolink.firebasestorage.app';
const CONCORRENCIA = 6;

admin.initializeApp({ credential: admin.credential.cert(require('../firebase-credentials.json')) });
const bucket = admin.storage().bucket(BUCKET);

const pool = new pg.Pool({
    host: process.env.OCI_DB_HOST || '127.0.0.1',
    port: Number(process.env.OCI_DB_PORT || 55432),
    database: process.env.OCI_DB_NAME || 'ocis_local',
    user: process.env.OCI_DB_USER || 'oci_admin',
    password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

async function main() {
    await pool.query(`
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS storage_path text;
        ALTER TABLE oci.laudos_pacientes ADD COLUMN IF NOT EXISTS storage_subido_em timestamptz;
    `);

    const { rows } = await pool.query(`
        SELECT id, sha256, caminho_armazenado
        FROM oci.laudos_pacientes
        WHERE registro_ativo
          AND paciente_id IS NOT NULL
          AND status_vinculo NOT IN ('quarentena', 'descartado')
          AND storage_path IS NULL
        ORDER BY id
    `);
    console.log(`Elegíveis ainda não enviados: ${rows.length} (bucket ${BUCKET})`);
    if (DRY_RUN || !rows.length) return;

    let enviados = 0, erros = 0, faltando = 0;
    const fila = [...rows];
    async function worker() {
        for (;;) {
            const item = fila.shift();
            if (!item) return;
            if (!item.caminho_armazenado || !fs.existsSync(item.caminho_armazenado)) {
                faltando += 1;
                continue;
            }
            const destino = `laudos/${item.sha256}.pdf`;
            try {
                await bucket.upload(item.caminho_armazenado, {
                    destination: destino,
                    contentType: 'application/pdf',
                    resumable: false,
                    metadata: { cacheControl: 'private, max-age=0' },
                });
                await pool.query(
                    `UPDATE oci.laudos_pacientes SET storage_path = $2, storage_subido_em = now() WHERE id = $1`,
                    [item.id, destino]
                );
                enviados += 1;
                if (enviados % 200 === 0) console.log(`  ... ${enviados}/${rows.length}`);
            } catch (err) {
                erros += 1;
                if (erros <= 5) console.error(`erro no laudo ${item.id}: ${err.message}`);
            }
        }
    }
    await Promise.all(Array.from({ length: CONCORRENCIA }, worker));
    console.log(`Enviados: ${enviados} | erros: ${erros} | arquivo local ausente: ${faltando}`);

    const resumo = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE storage_path IS NOT NULL) AS na_nuvem,
               COUNT(*) AS elegiveis
        FROM oci.laudos_pacientes
        WHERE registro_ativo AND paciente_id IS NOT NULL
          AND status_vinculo NOT IN ('quarentena', 'descartado')
    `);
    console.log('Situação:', resumo.rows[0]);
}

main().then(() => pool.end()).catch(err => { console.error(err); pool.end(); process.exit(1); });

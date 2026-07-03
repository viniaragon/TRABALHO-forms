import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';

const COMMIT = process.argv.includes('--commit');
const ROOT = process.cwd();
const BACKUP_ROOT = path.join(ROOT, 'storage', 'backup_duplicados');

const pool = new Pool({
  host: process.env.OCI_DB_HOST || '127.0.0.1',
  port: Number(process.env.OCI_DB_PORT || 55432),
  database: process.env.OCI_DB_NAME || 'ocis_local',
  user: process.env.OCI_DB_USER || 'oci_admin',
  password: process.env.OCI_DB_PASSWORD || 'oci_admin_local',
});

function finalNumber(filename) {
  const base = path.basename(filename || '');
  const match = base.match(/(\d+)(?=\.pdf$)/i);
  return match ? Number(match[1]) : -1;
}

function sortKeepFirst(a, b) {
  const numberDiff = finalNumber(b.arquivo_original) - finalNumber(a.arquivo_original);
  if (numberDiff !== 0) return numberDiff;
  return Number(b.id) - Number(a.id);
}

function stamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFileWithFallback(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
}

function buildPlan(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.chave_logica) continue;
    if (!groups.has(row.chave_logica)) groups.set(row.chave_logica, []);
    groups.get(row.chave_logica).push(row);
  }

  const duplicateGroups = [];
  const keepRows = [];
  const deleteRows = [];

  for (const [chaveLogica, groupRows] of groups.entries()) {
    if (groupRows.length < 2) continue;
    const sorted = [...groupRows].sort(sortKeepFirst);
    const keep = sorted[0];
    const remove = sorted.slice(1);
    duplicateGroups.push({ chaveLogica, keep, remove });
    keepRows.push(keep);
    deleteRows.push(...remove);
  }

  return { duplicateGroups, keepRows, deleteRows };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT
      id,
      chave_logica,
      arquivo_original,
      caminho_armazenado,
      duplicado_de_id,
      registro_ativo
    FROM oci.laudos_pacientes
    WHERE tipo_laudo = 'MAMOGRAFIA'
      AND chave_logica IS NOT NULL
    ORDER BY chave_logica, id;
  `);

  const plan = buildPlan(rows);
  const deleteIds = plan.deleteRows.map(row => Number(row.id));
  const keepIds = plan.keepRows.map(row => Number(row.id));
  const backupDir = path.join(BACKUP_ROOT, `mamografia-${stamp()}`);

  const missingFiles = [];
  for (const row of plan.deleteRows) {
    if (!row.caminho_armazenado || !(await fileExists(row.caminho_armazenado))) {
      missingFiles.push({ id: row.id, arquivo: row.arquivo_original, caminho: row.caminho_armazenado });
    }
  }

  const sample = plan.duplicateGroups.slice(0, 8).map(group => ({
    chaveLogica: group.chaveLogica,
    manter: `${group.keep.id}:${group.keep.arquivo_original}`,
    moverRemover: group.remove.map(row => `${row.id}:${row.arquivo_original}`),
  }));

  console.log(JSON.stringify({
    modo: COMMIT ? 'commit' : 'dry-run',
    gruposDuplicados: plan.duplicateGroups.length,
    laudosMamografiaAnalisados: rows.length,
    manter: keepIds.length,
    moverERemover: deleteIds.length,
    arquivosAusentes: missingFiles.length,
    backupDir: COMMIT ? backupDir : null,
    amostra: sample,
  }, null, 2));

  if (missingFiles.length) {
    console.error('Existem arquivos fisicos ausentes. Abortando para evitar limpar o banco sem mover todos os PDFs.');
    console.error(JSON.stringify(missingFiles.slice(0, 20), null, 2));
    process.exit(1);
  }

  if (!COMMIT) {
    await pool.end();
    return;
  }

  const moved = [];
  try {
    for (const row of plan.deleteRows) {
      const destination = path.join(backupDir, `${row.id}_${path.basename(row.caminho_armazenado)}`);
      await moveFileWithFallback(row.caminho_armazenado, destination);
      moved.push({ from: row.caminho_armazenado, to: destination });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE oci.laudos_pacientes
         SET duplicado_de_id = NULL,
             registro_ativo = TRUE
         WHERE id = ANY($1::bigint[])`,
        [keepIds],
      );
      await client.query(
        'DELETE FROM oci.laudos_pacientes WHERE id = ANY($1::bigint[])',
        [deleteIds],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const after = await pool.query(`
      SELECT
        COUNT(*)::int AS mamografias,
        COUNT(*) FILTER (WHERE paciente_id IS NOT NULL)::int AS vinculadas,
        COUNT(*) FILTER (WHERE paciente_id IS NULL)::int AS pendentes,
        COUNT(*) FILTER (WHERE duplicado_de_id IS NOT NULL OR registro_ativo IS FALSE)::int AS duplicados_logicos
      FROM oci.laudos_pacientes
      WHERE tipo_laudo = 'MAMOGRAFIA';
    `);

    console.log(JSON.stringify({
      concluido: true,
      arquivosMovidos: moved.length,
      backupDir,
      bancoDepois: after.rows[0],
    }, null, 2));
  } catch (error) {
    console.error('Falha durante limpeza. Tentando desfazer movimentacao fisica ja feita.');
    for (const move of moved.reverse()) {
      try {
        if (await fileExists(move.to)) {
          await moveFileWithFallback(move.to, move.from);
        }
      } catch (rollbackError) {
        console.error(`Falha ao devolver arquivo ${move.to}: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch(async error => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});

import fs from 'node:fs/promises';
import path from 'node:path';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Uso: node scripts/resumir-relatorio-usg-tv.mjs <relatorio.json>');
  process.exit(1);
}

const rows = JSON.parse(await fs.readFile(reportPath, 'utf8'));
const grouped = rows.reduce((acc, row) => {
  const key = `${row.action}:${row.classe}`;
  if (!acc[key]) acc[key] = [];
  acc[key].push(row);
  return acc;
}, {});

const lines = [];
lines.push('# Relatorio de correlacoes USG transvaginal');
lines.push('');
lines.push(`Arquivo fonte: ${reportPath}`);
lines.push(`Total analisado: ${rows.length}`);
lines.push('');
lines.push('## Resumo');
for (const key of Object.keys(grouped).sort()) {
  lines.push(`- ${key}: ${grouped[key].length}`);
}
lines.push('');
lines.push('## Aplicados automaticamente');
for (const key of Object.keys(grouped).filter(key => key.startsWith('aplicar:')).sort()) {
  lines.push(`### ${key}`);
  for (const row of grouped[key].slice(0, 40)) {
    lines.push(`- Laudo ${row.laudoId}: ${row.laudoNome} -> Paciente ${row.pacienteId}: ${row.pacienteNome} | score ${Number(row.score).toFixed(4)} | ${row.motivo}`);
  }
  if (grouped[key].length > 40) {
    lines.push(`- ... mais ${grouped[key].length - 40} casos no CSV/JSON completo`);
  }
  lines.push('');
}
lines.push('## Casos duvidosos');
for (const key of Object.keys(grouped).filter(key => key.startsWith('duvida:')).sort()) {
  lines.push(`### ${key}`);
  for (const row of grouped[key].slice(0, 50)) {
    lines.push(`- Laudo ${row.laudoId}: ${row.laudoNome || '[nome vazio]'} | sugestao: Paciente ${row.pacienteId} ${row.pacienteNome} | score ${Number(row.score).toFixed(4)} | segundo ${row.secondPacienteId || '-'} ${row.secondPacienteNome || '-'} (${Number(row.secondScore || 0).toFixed(4)}) | ${row.motivo}`);
  }
  if (grouped[key].length > 50) {
    lines.push(`- ... mais ${grouped[key].length - 50} casos no CSV/JSON completo`);
  }
  lines.push('');
}

const outPath = reportPath.replace(/\.json$/i, '-resumo.md');
await fs.writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(outPath);

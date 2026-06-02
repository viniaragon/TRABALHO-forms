const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FILE_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'formes base consolidados.md');

// Estrutura de campos mapeada exatamente na ordem em que aparecem no Markdown
const FIELDS = [
    { key: 'dates', header: '1. Data de preenchimento:' },
    { key: 'agendadas', header: 'Número de pessoas agendadas:' },
    { key: 'atendidas', header: 'Número de pessoas atendidas:' },
    { key: 'faltaram', header: 'Número de pessoas que faltaram:' },
    { key: 'vagas', header: 'Número de Vagas ofertadas' },
    { key: 'consultas', header: 'Número de Consultas Médicas:' },
    { key: 'usg_mamaria', header: 'Número de USG de Mamária:' },
    { key: 'usg_transvaginal', header: 'Número de USG Transvaginal:' },
    { key: 'usg_pelvica', header: 'Número de USG Pélvica:' },
    { key: 'mamografia', header: 'Número de Mamografia:' },
    { key: 'puncao_mama', header: 'Número de Punção de Mama por Agulha Grossa:' },
    { key: 'biopsia_mama', header: 'Número de Exame Anatomopatológico de Mama - Biópsia:' },
    { key: 'colposcopia', header: 'Número de Colposcopia:' },
    { key: 'biopsia_colo', header: 'Número de Biópsia do Colo Uterino:' },
    { key: 'biopsia_colo_anatomopatologico', header: 'Número de Exame Anatomo-Patológico do Colo Uterino - Biópsia:' },
    { key: 'oci_fechadas', header: 'Número de OCI fechadas:' },
    { key: 'responsavel', header: 'Nome do responsável pelo preenchimento:' }
];

// Função para fazer o parser do arquivo Markdown em JSON
function readData() {
    if (!fs.existsSync(FILE_PATH)) {
        return [];
    }

    const content = fs.readFileSync(FILE_PATH, 'utf-8');
    
    // Identificar a ordem das seções no arquivo de acordo com a posição dos cabeçalhos
    const positions = [];
    FIELDS.forEach(f => {
        const idx = content.indexOf(f.header);
        if (idx !== -1) {
            positions.push({ key: f.key, header: f.header, index: idx });
        }
    });

    // Ordenar de acordo com a ordem de aparição física no arquivo
    positions.sort((a, b) => a.index - b.index);

    const parsedData = {};

    for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        const nextPos = positions[i + 1];
        const start = pos.index + pos.header.length;
        const end = nextPos ? nextPos.index : content.length;
        
        const blockText = content.substring(start, end);
        const starIdx = blockText.indexOf('*');
        
        if (starIdx !== -1) {
            const valuesText = blockText.substring(starIdx + 1);
            let lines = valuesText.split(/\r?\n/).map(l => l.trim());
            
            // Remove linhas vazias iniciais de formatação física (mas preserva o resto)
            if (lines.length > 0 && lines[0] === '') {
                lines.shift();
            }

            if (pos.key === 'dates') {
                // Datas não devem conter linhas em branco
                parsedData[pos.key] = lines.filter(l => l !== '');
            } else {
                parsedData[pos.key] = lines;
            }
        } else {
            parsedData[pos.key] = [];
        }
    }

    const dates = parsedData.dates || [];
    const records = [];

    for (let i = 0; i < dates.length; i++) {
        const record = {};
        FIELDS.forEach(f => {
            if (f.key === 'dates') {
                record.dates = dates[i];
            } else {
                const values = parsedData[f.key] || [];
                let val = values[i];
                if (val === undefined || val === '') {
                    val = (f.key === 'responsavel') ? '-' : '0';
                }
                record[f.key] = val;
            }
        });
        records.push(record);
    }

    return records;
}

// Ordenar registros cronologicamente
function sortRecords(records) {
    return records.sort((a, b) => {
        const [dayA, monthA, yearA] = a.dates.split('/').map(Number);
        const [dayB, monthB, yearB] = b.dates.split('/').map(Number);
        const dateA = new Date(yearA, monthA - 1, dayA);
        const dateB = new Date(yearB, monthB - 1, dayB);
        return dateA - dateB;
    });
}

// Salvar registros no arquivo Markdown mantendo a formatação exata
function writeData(records) {
    const sorted = sortRecords(records);
    
    let content = 'formes base consolidados diaria carreta programa agora tem especialista\n\n\n\n\n';
    
    FIELDS.forEach(f => {
        content += `${f.header}\n`;
        content += `*\n`;
        
        sorted.forEach(r => {
            let val = r[f.key];
            if (val === undefined || val === '') {
                val = (f.key === 'responsavel') ? '-' : '0';
            }
            content += `${val}\n`;
        });
        
        content += `\n\n\n\n`;

        // Seção estática de Tipologia após o campo 'vagas'
        if (f.key === 'vagas') {
            content += `7. Tipologia: \n*Tipologia 2: Prevenção e Cuidado da Saúde da Mulher\n\n\n\n`;
        }
    });

    fs.writeFileSync(FILE_PATH, content.trim() + '\n', 'utf-8');
}

// Endpoint GET: Retornar todos os registros
app.get('/api/data', (req, res) => {
    try {
        const records = readData();
        res.json({ success: true, data: records });
    } catch (error) {
        console.error('Erro ao ler os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar os dados.' });
    }
});

// Endpoint POST: Salvar ou atualizar registro diário
app.post('/api/save', (req, res) => {
    try {
        const newRecord = req.body;
        
        if (!newRecord.dates || !/^\d{2}\/\d{2}\/\d{4}$/.test(newRecord.dates)) {
            return res.status(400).json({ success: false, message: 'Data inválida. Use o formato DD/MM/AAAA.' });
        }

        let records = readData();
        
        // Verifica se já existe um registro para a data e substitui, ou cria um novo
        const existingIndex = records.findIndex(r => r.dates === newRecord.dates);
        if (existingIndex !== -1) {
            records[existingIndex] = { ...records[existingIndex], ...newRecord };
        } else {
            records.push(newRecord);
        }

        writeData(records);
        res.json({ success: true, message: 'Dados salvos com sucesso!', data: readData() });
    } catch (error) {
        console.error('Erro ao salvar os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar os dados.' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse http://localhost:${PORT}`);
});

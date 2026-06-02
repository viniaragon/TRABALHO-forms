const express = require('express');
const fs = require('fs');
const path = require('path');

let admin;
let getFirestore;
let isFirebaseConfigured = false;
let db = null;

// ID do banco Firestore. Neste projeto o banco foi criado com o nome "default"
// (banco nomeado), e NÃO como o banco padrão "(default)". Por isso é necessário
// especificá-lo explicitamente; caso contrário o SDK retorna erro 5 NOT_FOUND.
const FIRESTORE_DATABASE_ID = process.env.FIREBASE_DATABASE_ID || 'default';

try {
    admin = require('firebase-admin');
    getFirestore = require('firebase-admin/firestore').getFirestore;
    
    const CREDENTIALS_PATH = path.join(__dirname, 'firebase-credentials.json');

    if (fs.existsSync(CREDENTIALS_PATH)) {
        const serviceAccount = require(CREDENTIALS_PATH);
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando arquivo local de credenciais (firebase-credentials.json).');
    } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL) {
        const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: privateKey,
                })
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando variáveis de ambiente.');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        isFirebaseConfigured = true;
        console.log('Firebase inicializado usando JSON stringificado de variável de ambiente.');
    } else {
        console.log('Modo de armazenamento local ativo: Nenhuma credencial do Firebase configurada.');
    }

    if (isFirebaseConfigured) {
        db = getFirestore(admin.app(), FIRESTORE_DATABASE_ID);
        console.log(`Conectado ao banco Firestore: "${FIRESTORE_DATABASE_ID}".`);
    }
} catch (err) {
    console.warn('AVISO: O pacote "firebase-admin" não está instalado ou falhou ao carregar. Rodando no modo de armazenamento local. Erro:', err.message);
    isFirebaseConfigured = false;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_FILE_PATH = path.join(__dirname, 'formes base consolidados.md');
const FILE_PATH = process.env.DATABASE_PATH || DEFAULT_FILE_PATH;

// Se DATABASE_PATH for definido (ex: volume persistente no Zeabur) e o arquivo não existir lá,
// inicializamos copiando o arquivo consolidado padrão do repositório para evitar que comece vazio.
if (process.env.DATABASE_PATH && !fs.existsSync(FILE_PATH) && fs.existsSync(DEFAULT_FILE_PATH)) {
    try {
        const parentDir = path.dirname(FILE_PATH);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.copyFileSync(DEFAULT_FILE_PATH, FILE_PATH);
        console.log(`Banco de dados consolidado inicial copiado para: ${FILE_PATH}`);
    } catch (err) {
        console.error(`Erro ao inicializar arquivo no volume persistente:`, err);
    }
}

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
app.get('/api/data', async (req, res) => {
    try {
        if (isFirebaseConfigured && db) {
            const snapshot = await db.collection('daily_records').get();
            const records = [];
            snapshot.forEach(doc => {
                records.push(doc.data());
            });
            const sorted = sortRecords(records);
            res.json({ success: true, data: sorted });
        } else {
            const records = readData();
            res.json({ success: true, data: records });
        }
    } catch (error) {
        console.error('Erro ao ler os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar os dados.' });
    }
});

// Endpoint POST: Salvar ou atualizar registro diário
app.post('/api/save', async (req, res) => {
    try {
        const newRecord = req.body;
        
        if (!newRecord.dates || !/^\d{2}\/\d{2}\/\d{4}$/.test(newRecord.dates)) {
            return res.status(400).json({ success: false, message: 'Data inválida. Use o formato DD/MM/AAAA.' });
        }

        if (isFirebaseConfigured && db) {
            // IDs de documentos do Firestore não podem conter "/"
            const docId = newRecord.dates.replace(/\//g, '-');
            await db.collection('daily_records').doc(docId).set(newRecord, { merge: true });
            
            // Buscar todos para retornar atualizados
            const snapshot = await db.collection('daily_records').get();
            const records = [];
            snapshot.forEach(doc => {
                records.push(doc.data());
            });
            const sorted = sortRecords(records);
            
            // Backup opcional local no arquivo Markdown
            try {
                writeData(sorted);
            } catch (err) {
                console.warn('Falha ao atualizar backup do Markdown local:', err.message);
            }

            res.json({ success: true, message: 'Dados salvos no Firebase com sucesso!', data: sorted });
        } else {
            let records = readData();
            
            // Verifica se já existe um registro para a data e substitui, ou cria um novo
            const existingIndex = records.findIndex(r => r.dates === newRecord.dates);
            if (existingIndex !== -1) {
                records[existingIndex] = { ...records[existingIndex], ...newRecord };
            } else {
                records.push(newRecord);
            }

            writeData(records);
            res.json({ success: true, message: 'Dados salvos localmente com sucesso!', data: readData() });
        }
    } catch (error) {
        console.error('Erro ao salvar os dados:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar os dados.' });
    }
});

// Função para migração automática do banco local para o Firestore
async function migrateIfNeeded() {
    if (!isFirebaseConfigured || !db) return;
    try {
        const recordsCol = db.collection('daily_records');
        const snapshot = await recordsCol.limit(1).get();
        if (snapshot.empty) {
            console.log('Banco de dados do Firestore está vazio. Verificando dados locais para migração...');
            const localRecords = readData();
            if (localRecords.length > 0) {
                console.log(`Iniciando migração de ${localRecords.length} registros para o Firestore...`);
                const batch = db.batch();
                localRecords.forEach(record => {
                    const docId = record.dates.replace(/\//g, '-');
                    const docRef = recordsCol.doc(docId);
                    batch.set(docRef, record);
                });
                await batch.commit();
                console.log('Migração concluída com sucesso!');
            } else {
                console.log('Nenhum dado local encontrado para migração.');
            }
        } else {
            console.log('Firestore já contém dados. Migração automática ignorada.');
        }
    } catch (err) {
        console.error('Erro durante a migração para o Firestore:', err);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    // Tenta migrar os dados locais se o Firebase estiver configurado
    await migrateIfNeeded();
});

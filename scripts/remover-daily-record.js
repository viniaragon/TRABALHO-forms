const fs = require('fs');
const path = require('path');

const targetDate = process.argv[2] || '03/07/2026';
const commit = process.argv.includes('--commit');
const docId = targetDate.replace(/\//g, '-');

async function main() {
    let admin;
    try {
        admin = require('firebase-admin');
    } catch (error) {
        throw new Error(`firebase-admin indisponivel: ${error.message}`);
    }

    const credentialsPath = path.join(__dirname, '..', 'firebase-credentials.json');
    if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Credenciais Firebase nao encontradas em ${credentialsPath}`);
    }

    if (admin.apps.length === 0) {
        const serviceAccount = require(credentialsPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
    }

    const databaseId = process.env.FIREBASE_DATABASE_ID || 'default';
    const db = require('firebase-admin/firestore').getFirestore(admin.app(), databaseId);
    const ref = db.collection('daily_records').doc(docId);
    const snap = await ref.get();

    const result = {
        targetDate,
        docId,
        databaseId,
        existsInFirestore: snap.exists,
        commit,
        backupPath: null,
        deletedFromFirestore: false,
        existsInLocalMarkdown: false,
    };

    if (snap.exists) {
        const reportsDir = path.join(__dirname, '..', 'reports');
        fs.mkdirSync(reportsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const backupPath = path.join(reportsDir, `daily-record-${docId}-backup-${stamp}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(snap.data(), null, 2), 'utf8');
        result.backupPath = backupPath;

        if (commit) {
            await ref.delete();
            result.deletedFromFirestore = true;
        }
    }

    const localPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'formes base consolidados.md');
    if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf8');
        result.existsInLocalMarkdown = content.includes(targetDate);
    }

    console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});

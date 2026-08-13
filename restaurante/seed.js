// Carga inicial do modulo de restaurante: cardapio de exemplo, mesas e o
// primeiro usuario gerente. Idempotente — rodar de novo nao duplica nada.
//
//   node restaurante/seed.js
//   node restaurante/seed.js --senha "senha-forte-do-gerente"
//   node restaurante/seed.js --somente-usuarios
//
// Sem `--senha` (e sem RESTAURANTE_ADMIN_SENHA) o script sorteia uma senha
// forte e imprime uma unica vez. Nao existe senha padrao embutida: senha fixa
// em codigo publicado e porta aberta.

const crypto = require('crypto');
const { pool, garantirSchema } = require('./db');
const { gerarHashSenha } = require('./auth');

const CARDAPIO = [
    {
        categoria: 'Entradas', setor: 'cozinha', ordem: 1, produtos: [
            { nome: 'Bolinho de bacalhau (6un)', preco: 3890, tempo: 15 },
            { nome: 'Pastel de carne (6un)', preco: 3200, tempo: 12 },
            { nome: 'Bruschetta de tomate', preco: 2800, tempo: 8 },
        ],
    },
    {
        categoria: 'Pratos principais', setor: 'cozinha', ordem: 2, produtos: [
            { nome: 'Picanha na chapa (2 pessoas)', preco: 12900, tempo: 35, setor: 'chapa' },
            { nome: 'File a parmegiana', preco: 7450, tempo: 30 },
            { nome: 'Risoto de camarao', preco: 8900, tempo: 25 },
            { nome: 'Moqueca de peixe', preco: 9800, tempo: 30 },
            { nome: 'Feijoada individual', preco: 6900, tempo: 20 },
        ],
    },
    {
        categoria: 'Guarnicoes', setor: 'cozinha', ordem: 3, produtos: [
            { nome: 'Batata frita', preco: 2900, tempo: 12 },
            { nome: 'Arroz branco', preco: 1400, tempo: 5 },
            { nome: 'Farofa da casa', preco: 1600, tempo: 5 },
        ],
    },
    {
        categoria: 'Bebidas', setor: 'bar', ordem: 4, produtos: [
            { nome: 'Agua mineral 500ml', preco: 700, tempo: 0 },
            { nome: 'Refrigerante lata', preco: 900, tempo: 0 },
            { nome: 'Suco natural 400ml', preco: 1600, tempo: 5 },
            { nome: 'Cerveja long neck', preco: 1400, tempo: 0 },
            { nome: 'Caipirinha', preco: 2400, tempo: 6 },
        ],
    },
    {
        categoria: 'Sobremesas', setor: 'sobremesa', ordem: 5, produtos: [
            { nome: 'Pudim de leite', preco: 1900, tempo: 3 },
            { nome: 'Petit gateau', preco: 2600, tempo: 12, setor: 'cozinha' },
            { nome: 'Taca de sorvete', preco: 1700, tempo: 3 },
        ],
    },
];

const USUARIOS_EXEMPLO = [
    { login: 'garcom', nome: 'Garcom do salao', papel: 'garcom' },
    { login: 'cozinha', nome: 'Praca da cozinha', papel: 'cozinha' },
    { login: 'caixa', nome: 'Operador de caixa', papel: 'caixa' },
];

function lerArgumento(nome) {
    const indice = process.argv.indexOf(`--${nome}`);
    return indice > -1 ? process.argv[indice + 1] : null;
}

function senhaSorteada() {
    return crypto.randomBytes(9).toString('base64url');
}

async function criarUsuario({ login, nome, papel, senha }) {
    const { rows } = await pool.query(
        `INSERT INTO restaurante.usuarios (login, senha_hash, nome, papel)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (login) DO NOTHING
         RETURNING id`,
        [login, gerarHashSenha(senha), nome, papel],
    );
    return { login, papel, senha, criado: rows.length > 0 };
}

async function semearCardapio() {
    for (const grupo of CARDAPIO) {
        const { rows } = await pool.query(
            `INSERT INTO restaurante.categorias (nome, setor, ordem) VALUES ($1, $2, $3)
             ON CONFLICT (nome) DO UPDATE SET setor = EXCLUDED.setor, ordem = EXCLUDED.ordem
             RETURNING id`,
            [grupo.categoria, grupo.setor, grupo.ordem],
        );
        const categoriaId = rows[0].id;
        for (const produto of grupo.produtos) {
            await pool.query(
                `INSERT INTO restaurante.produtos
                     (categoria_id, nome, preco_centavos, tempo_preparo_minutos, setor)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (categoria_id, lower(nome)) WHERE ativo DO NOTHING`,
                [categoriaId, produto.nome, produto.preco, produto.tempo, produto.setor || null],
            );
        }
    }
}

async function semearMesas(quantidade = 12) {
    for (let numero = 1; numero <= quantidade; numero += 1) {
        await pool.query(
            `INSERT INTO restaurante.mesas (numero, capacidade) VALUES ($1, $2)
             ON CONFLICT (numero) DO NOTHING`,
            [String(numero), numero > 8 ? 6 : 4],
        );
    }
}

async function principal() {
    await garantirSchema();

    const senhaGerente = lerArgumento('senha') || process.env.RESTAURANTE_ADMIN_SENHA || senhaSorteada();
    const criados = [await criarUsuario({
        login: lerArgumento('login') || 'gerente',
        nome: 'Gerente do restaurante',
        papel: 'gerente',
        senha: senhaGerente,
    })];

    if (!process.argv.includes('--sem-exemplos')) {
        for (const usuario of USUARIOS_EXEMPLO) {
            criados.push(await criarUsuario({ ...usuario, senha: senhaSorteada() }));
        }
    }

    if (!process.argv.includes('--somente-usuarios')) {
        await semearCardapio();
        await semearMesas(Number(lerArgumento('mesas') || 12));
    }

    console.log('\nModulo de restaurante preparado.\n');
    for (const usuario of criados) {
        if (usuario.criado) {
            console.log(`  ${usuario.papel.padEnd(8)} login: ${usuario.login.padEnd(10)} senha: ${usuario.senha}`);
        } else {
            console.log(`  ${usuario.papel.padEnd(8)} login: ${usuario.login.padEnd(10)} (ja existia, senha preservada)`);
        }
    }
    console.log('\nAnote as senhas: elas nao sao exibidas de novo.');
    console.log('Troque-as em Admin > Equipe apos o primeiro acesso.\n');
    console.log('Tela do sistema: /restaurante\n');
    await pool.end();
}

principal().catch((erro) => {
    console.error('Falha na carga inicial:', erro.message);
    process.exitCode = 1;
    pool.end();
});

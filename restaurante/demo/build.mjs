/* Monta a demo publicavel a partir dos arquivos reais da aplicacao.
 *
 *   node restaurante/demo/build.mjs [saida.html]
 *
 * A tela (`public/restaurante.js`) entra byte a byte igual a de producao. O que
 * muda e so a fronteira: `backend-local.js` falsifica `fetch` e `EventSource`
 * antes dela carregar. Rode de novo depois de mexer na aplicacao para a demo
 * nao descolar do sistema.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ler = (caminho) => readFileSync(join(raiz, caminho), 'utf8');

const html = ler('public/restaurante.html');
const css = ler('public/restaurante.css');
const app = ler('public/restaurante.js');
const backend = ler('restaurante/demo/backend-local.js');

const corpo = html.match(/<body>([\s\S]*?)<\/body>/)[1]
    .replace(/<script src="restaurante\.js"><\/script>/, '')
    .trim();

// A pagina publicada nao carrega fonte externa (bloqueada por CSP), entao a
// referencia a Outfit so produziria um fallback silencioso. Melhor assumir a
// pilha do sistema de forma explicita.
const cssDemo = css.replace(
    /font-family: 'Outfit'[^;]*;/,
    "font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;",
);

const ESTILO_DEMO = `
/* --------------------------------------------------- afordancias da demo */
.demo-atalhos { display: grid; gap: 8px; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.demo-atalhos p { font-size: .78rem; color: var(--muted); }
.demo-postos { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.demo-postos button {
    min-height: 42px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfd;
    color: var(--slate); font-weight: 600; cursor: pointer; display: grid; gap: 1px; padding: 5px;
}
.demo-postos button:hover { border-color: var(--blue); background: #f2f7fc; }
.demo-postos strong { font-size: .9rem; }
.demo-postos span { font-size: .7rem; color: var(--muted); font-weight: 500; }
/* O selo vive no cabecalho, nao flutuando: elemento fixo sobre a interface
   acaba cobrindo o botao de acao da gaveta do cardapio. */
.demo-chip {
    font-size: .66rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    color: var(--teal); border: 1px solid #bfe3ea; background: #f0fafc;
    border-radius: 999px; padding: 3px 9px; white-space: nowrap;
}
@media (max-width: 720px) { .demo-chip { display: none; } }
`;

// A pagina publicada e embrulhada num <head> que nao controlamos. Sem
// `viewport`, o celular assume a largura padrao de 980px e a tela inteira sai
// reduzida e com rolagem lateral — justamente no aparelho do garcom.
const VIEWPORT = `
if (!document.querySelector('meta[name="viewport"]')) {
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    document.head.appendChild(meta);
}`;

const ATALHOS = `
<div class="demo-atalhos">
    <p>Demonstração — toque num posto para entrar direto. Se preferir digitar:
    usuário <strong>garcom</strong>, <strong>cozinha</strong>, <strong>caixa</strong>
    ou <strong>gerente</strong>, senha <strong>123456</strong>.</p>
    <p>Os dados ficam só neste aparelho e voltam ao início quando a página recarrega.</p>
    <div class="demo-postos">
        <button type="button" data-posto="garcom"><strong>Garçom</strong><span>salão e comandas</span></button>
        <button type="button" data-posto="cozinha"><strong>Cozinha</strong><span>fila de produção</span></button>
        <button type="button" data-posto="caixa"><strong>Caixa</strong><span>receber e fechar</span></button>
        <button type="button" data-posto="gerente"><strong>Gerente</strong><span>vê tudo</span></button>
    </div>
</div>`;

const SELO = `<span class="demo-chip">demo</span>
            <button id="demoReiniciar" class="btn discreto" type="button">Reiniciar</button>
            `;

const CHROME_DEMO = `
(() => {
    for (const botao of document.querySelectorAll('.demo-postos button')) {
        botao.addEventListener('click', () => {
            document.querySelector('#loginInput').value = botao.dataset.posto;
            document.querySelector('#senhaInput').value = window.__demoRestaurante.senha;
            document.querySelector('#loginForm').requestSubmit();
        });
    }
    document.querySelector('#demoReiniciar').addEventListener('click', () => {
        window.__demoRestaurante.reiniciar();
    });
})();`;

const corpoComDemo = corpo
    .replace('</form>', `${ATALHOS}\n    </form>`)
    .replace('<button id="sairButton"', `${SELO}<button id="sairButton"`);

const pagina = `<title>Comanda</title>
<script>
${VIEWPORT}
</script>

<style>
${cssDemo}
${ESTILO_DEMO}
</style>

${corpoComDemo}

<script>
${backend}
</script>

<script>
${app}
</script>

<script>
${CHROME_DEMO}
</script>
`;

const saida = process.argv[2] || join(raiz, 'restaurante/demo/comanda.html');
writeFileSync(saida, pagina, 'utf8');
console.log(`demo gerada: ${saida} (${(pagina.length / 1024).toFixed(1)} kB)`);

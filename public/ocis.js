const filterRegiao = document.getElementById('filterRegiao');
const filterCompetencia = document.getElementById('filterCompetencia');
const filterSearch = document.getElementById('filterSearch');
const toggleInternal = document.getElementById('toggleInternal');
const accessBadge = document.getElementById('accessBadge');
const btnExportExternal = document.getElementById('btnExportExternal');
const btnExportInternal = document.getElementById('btnExportInternal');
const toast = document.getElementById('toast');

const kpiPacientesAtendidos = document.getElementById('kpiPacientesAtendidos');
const kpiPacientesComOci = document.getElementById('kpiPacientesComOci');
const kpiTotalOcis = document.getElementById('kpiTotalOcis');
const kpiConsultasMinimas = document.getElementById('kpiConsultasMinimas');
const kpiConsultasEquivalentes = document.getElementById('kpiConsultasEquivalentes');
const kpiPendencias = document.getElementById('kpiPendencias');
const kpiProcedimentosSemConsulta = document.getElementById('kpiProcedimentosSemConsulta');
const kpiConsultasEspecialistas = document.getElementById('kpiConsultasEspecialistas');
const kpiTotalProcedimentosConsultas = document.getElementById('kpiTotalProcedimentosConsultas');
const kpiValorTotal = document.getElementById('kpiValorTotal');
const valueCard = document.getElementById('valueCard');

const summaryHead = document.getElementById('summaryHead');
const summaryBody = document.getElementById('summaryBody');
const summaryStatus = document.getElementById('summaryStatus');
const nominalHead = document.getElementById('nominalHead');
const nominalBody = document.getElementById('nominalBody');
const nominalCount = document.getElementById('nominalCount');
const proceduresHead = document.getElementById('proceduresHead');
const proceduresBody = document.getElementById('proceduresBody');
const proceduresCount = document.getElementById('proceduresCount');
const pendingList = document.getElementById('pendingList');
const pendingPanel = document.getElementById('pendingPanel');

let searchTimer = null;
let accessKey = '';
let accessLevel = 'external';

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 3600);
}

function currentParams() {
    const params = new URLSearchParams();
    if (filterRegiao.value) params.set('regiao', filterRegiao.value);
    if (filterCompetencia.value) params.set('competencia', filterCompetencia.value);
    if (filterSearch.value.trim()) params.set('search', filterSearch.value.trim());
    if (accessKey) params.set('accessKey', accessKey);
    return params;
}

function updateAccessUi() {
    toggleInternal.checked = accessLevel !== 'external';
    pendingPanel.classList.toggle('hidden', accessLevel !== 'master');
    if (accessLevel === 'master') {
        accessBadge.textContent = 'Interno master: valores + pendências';
        accessBadge.className = 'access-badge master';
    } else if (accessLevel === 'internal') {
        accessBadge.textContent = 'Interno: valores sem pendências';
        accessBadge.className = 'access-badge internal';
    } else {
        accessBadge.textContent = 'Externo';
        accessBadge.className = 'access-badge';
    }
}

function setAccessFromPassword(password) {
    if (password === '987654321') {
        accessKey = password;
        accessLevel = 'master';
        return true;
    }
    if (password === '123456789') {
        accessKey = password;
        accessLevel = 'internal';
        return true;
    }
    return false;
}

function requestInternalAccess() {
    const password = window.prompt('Digite a senha de acesso interno:');
    if (!setAccessFromPassword(password || '')) {
        accessKey = '';
        accessLevel = 'external';
        updateAccessUi();
        showToast('Senha inválida. Modo externo mantido.', 'error');
        return false;
    }
    updateAccessUi();
    showToast(accessLevel === 'master' ? 'Modo master liberado.' : 'Modo interno liberado.');
    return true;
}

async function fetchJson(url) {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.message || 'Falha ao carregar dados.');
    }
    return payload.data;
}

function renderSummary(summary) {
    const internal = accessLevel !== 'external';
    const kpis = summary.kpis || {};

    valueCard.classList.toggle('hidden', !internal);
    kpiPacientesAtendidos.textContent = formatNumber(kpis.pacientesAtendidos);
    kpiPacientesComOci.textContent = formatNumber(kpis.pacientesComOci);
    kpiTotalOcis.textContent = formatNumber(kpis.totalOcis);
    kpiConsultasMinimas.textContent = formatNumber(kpis.consultasMinimas);
    kpiConsultasEquivalentes.textContent = formatNumber(kpis.consultasEquivalentesOci);
    kpiProcedimentosSemConsulta.textContent = formatNumber(kpis.procedimentosSemConsulta);
    kpiConsultasEspecialistas.textContent = formatNumber(kpis.consultasEspecialistas);
    kpiTotalProcedimentosConsultas.textContent = formatNumber(kpis.totalProcedimentosEConsultas);
    kpiPendencias.textContent = accessLevel === 'master' ? formatNumber(kpis.pendenciasSemOci) : '***';
    kpiValorTotal.textContent = formatMoney(kpis.valorTotal);

    const headers = ['Codigo OCI', 'OCI', 'Qtd'];
    if (internal) headers.push('Valor interno');
    summaryHead.innerHTML = headers.map(h => `<th>${h}</th>`).join('');

    const rows = summary.porOci || [];
    summaryBody.innerHTML = rows.length
        ? rows.map(row => `
            <tr>
                <td>${escapeHtml(row.codigoOci)}</td>
                <td>${escapeHtml(row.nomeOci)}</td>
                <td>${formatNumber(row.qtdOci)}</td>
                ${internal ? `<td>${formatMoney(row.valorTotal)}</td>` : ''}
            </tr>
        `).join('')
        : `<tr><td colspan="${headers.length}">Nenhuma OCI encontrada para o filtro atual.</td></tr>`;

    summaryStatus.textContent = `${formatNumber(rows.length)} codigos`;
}

function renderOciDetails(row) {
    const details = row.ociDetails || [];
    if (!details.length) {
        return '<div class="oci-detail-empty">Sem detalhamento de procedimentos para esta paciente.</div>';
    }
    return `
        <div class="patient-oci-detail">
            ${details.map(oci => `
                <section class="oci-package">
                    <h3>${escapeHtml(oci.codigoOci)} — ${escapeHtml(oci.nomeOci)}</h3>
                    <div class="oci-context">Datas: ${escapeHtml(oci.datas || '-')} · Município(s): ${escapeHtml(oci.municipios || '-')}</div>
                    <ul class="procedure-tree">
                        ${(oci.procedimentos || []).map(proc => `
                            <li>
                                <span class="tree-branch">└</span>
                                <span class="procedure-code">${escapeHtml(proc.codigo)}</span>
                                <span class="procedure-name">${escapeHtml(proc.procedimento)}</span>
                                <span class="done-pill">${escapeHtml(proc.status || 'CONCLUIDO')}</span>
                            </li>
                        `).join('')}
                    </ul>
                </section>
            `).join('')}
            <p class="detail-note">Prévia estimada pela regra operacional. Fechamento e faturamento oficiais dependem da validação do revisor.</p>
        </div>
    `;
}

function renderNominal(rows) {
    const internal = accessLevel !== 'external';
    const headers = ['', 'Paciente', 'Municipios', 'Datas', 'Competencias', 'OCIs realizadas', 'Codigos', 'Total', 'Consulta minima', 'Consulta equivalente OCI'];
    if (internal) headers.push('Valor interno');
    nominalHead.innerHTML = headers.map(h => `<th>${h}</th>`).join('');

    nominalBody.innerHTML = rows.length
        ? rows.map((row, index) => `
            <tr class="patient-row" data-detail="patient-detail-${index}">
                <td><button class="expand-btn" type="button" aria-label="Ver procedimentos">+</button></td>
                <td>${escapeHtml(row.paciente)}</td>
                <td>${escapeHtml(row.municipios)}</td>
                <td>${escapeHtml(row.datas)}</td>
                <td>${escapeHtml(row.competencias)}</td>
                <td>${escapeHtml(row.ocisRealizadas)}</td>
                <td>${escapeHtml(row.codigosOci)}</td>
                <td>${formatNumber(row.totalOcis)}</td>
                <td>${formatNumber(row.consultaMinimaEspecialista)}</td>
                <td>${formatNumber(row.consultaEquivalentePorOci)}</td>
                ${internal ? `<td>${formatMoney(row.valorTotal)}</td>` : ''}
            </tr>
            <tr id="patient-detail-${index}" class="patient-detail-row hidden">
                <td colspan="${headers.length}">${renderOciDetails(row)}</td>
            </tr>
        `).join('')
        : `<tr><td colspan="${headers.length}">Nenhuma paciente encontrada para o filtro atual.</td></tr>`;

    nominalBody.querySelectorAll('.patient-row').forEach(rowEl => {
        rowEl.addEventListener('click', event => {
            const detailId = rowEl.dataset.detail;
            const detailEl = document.getElementById(detailId);
            const button = rowEl.querySelector('.expand-btn');
            const isHidden = detailEl.classList.toggle('hidden');
            button.textContent = isHidden ? '+' : '−';
            event.stopPropagation();
        });
    });

    nominalCount.textContent = `${formatNumber(rows.length)} pacientes`;
}
function renderProcedures(rows) {
    const headers = ['Procedimento', 'Categoria', 'Quantidade', 'Pacientes unicos', 'OCIs relacionadas'];
    proceduresHead.innerHTML = headers.map(h => `<th>${h}</th>`).join('');
    proceduresBody.innerHTML = rows.length
        ? rows.map(row => `
            <tr>
                <td>${escapeHtml(row.procedimento)}</td>
                <td>${escapeHtml(row.categoria)}</td>
                <td>${formatNumber(row.quantidade)}</td>
                <td>${formatNumber(row.pacientesUnicos)}</td>
                <td>${escapeHtml(row.ocisRelacionadas || '-')}</td>
            </tr>
        `).join('')
        : `<tr><td colspan="${headers.length}">Nenhum procedimento derivado para o filtro atual.</td></tr>`;
    proceduresCount.textContent = `${formatNumber(rows.length)} procedimentos`;
}
function renderPending(rows) {
    if (accessLevel !== 'master') {
        pendingList.innerHTML = '<div class="pending-item"><strong>Pendências protegidas.</strong><span>Use a senha master para visualizar estas linhas.</span></div>';
        return;
    }
    pendingList.innerHTML = rows.length
        ? rows.map(row => `
            <div class="pending-item">
                <strong>${escapeHtml(row.paciente)}</strong>
                <span>${escapeHtml(row.data)} · ${escapeHtml(row.municipio)} · ${escapeHtml(row.regiao)} / ${escapeHtml(row.competencia)}</span>
                <span>Origem: ${escapeHtml(row.sourceSheet)}, linha ${escapeHtml(row.sourceRow)}</span>
                <span>Agendada: ${escapeHtml(row.ociAgendada || '-')} · Extra: ${escapeHtml(row.ociExtra || '-')}</span>
            </div>
        `).join('')
        : '<div class="pending-item"><strong>Sem pendências no filtro atual.</strong><span>Todas as linhas filtradas têm OCI calculada.</span></div>';
}

async function loadOcis() {
    const params = currentParams();
    summaryStatus.textContent = 'Atualizando';
    try {
        const [summary, nominal, pending, procedures] = await Promise.all([
            fetchJson(`/api/ocis/summary?${params.toString()}`),
            fetchJson(`/api/ocis/nominal?${params.toString()}`),
            fetchJson(`/api/ocis/pending?${params.toString()}`),
            fetchJson(`/api/ocis/procedures?${params.toString()}`),
        ]);
        renderSummary(summary);
        renderNominal(nominal);
        renderPending(pending);
        renderProcedures(procedures);
    } catch (error) {
        console.error(error);
        showToast(error.message || 'Erro ao carregar OCIs.', 'error');
        summaryStatus.textContent = 'Erro';
    }
}

function exportWorkbook(mode) {
    if (mode === 'internal' && accessLevel === 'external') {
        if (!requestInternalAccess()) return;
    }
    const params = currentParams();
    params.set('mode', mode);
    window.location.href = '/api/ocis/export.xlsx?' + params.toString();
}

filterRegiao.addEventListener('change', loadOcis);
filterCompetencia.addEventListener('change', loadOcis);
toggleInternal.addEventListener('change', () => {
    if (toggleInternal.checked) {
        if (requestInternalAccess()) loadOcis();
    } else {
        accessKey = '';
        accessLevel = 'external';
        updateAccessUi();
        loadOcis();
    }
});
filterSearch.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(loadOcis, 300);
});
btnExportExternal.addEventListener('click', () => exportWorkbook('external'));
btnExportInternal.addEventListener('click', () => exportWorkbook('internal'));

updateAccessUi();
loadOcis();

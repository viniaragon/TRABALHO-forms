const loginView = document.getElementById('loginView');
const portalView = document.getElementById('portalView');
const loginForm = document.getElementById('loginForm');
const loginInput = document.getElementById('loginInput');
const passwordInput = document.getElementById('passwordInput');
const loginButton = document.getElementById('loginButton');
const loginMessage = document.getElementById('loginMessage');
const logoutButton = document.getElementById('logoutButton');
const municipioLabel = document.getElementById('municipioLabel');
const searchInput = document.getElementById('searchInput');
const typeFilter = document.getElementById('typeFilter');
const ageFilter = document.getElementById('ageFilter');
const statusFilter = document.getElementById('statusFilter');
const alertFilter = document.getElementById('alertFilter');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const refreshButton = document.getElementById('refreshButton');
const patientRows = document.getElementById('patientRows');
const resultSummary = document.getElementById('resultSummary');
const toast = document.getElementById('toast');

const kpiPatients = document.getElementById('kpiPatients');
const kpiMammo = document.getElementById('kpiMammo');
const kpiUsgMama = document.getElementById('kpiUsgMama');
const kpiUsgTv = document.getElementById('kpiUsgTv');
const kpiSemLaudo = document.getElementById('kpiSemLaudo');
const kpiAlertas = document.getElementById('kpiAlertas');

let currentUser = null;
let currentRows = [];
let searchTimer = null;
const expandedRows = new Set();

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 3600);
}

function showLogin(message = '') {
    currentUser = null;
    portalView.classList.add('hidden');
    loginView.classList.remove('hidden');
    if (message) {
        loginMessage.textContent = message;
        loginMessage.classList.remove('hidden');
    } else {
        loginMessage.classList.add('hidden');
    }
}

function showPortal(user) {
    currentUser = user;
    municipioLabel.textContent = `${user.municipio} - ${user.nome}`;
    loginView.classList.add('hidden');
    portalView.classList.remove('hidden');
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        const error = new Error(payload.message || 'Falha na requisicao.');
        error.status = response.status;
        throw error;
    }
    return payload.data;
}

function buildParams() {
    const params = new URLSearchParams();
    if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
    if (typeFilter.value) params.set('tipo', typeFilter.value);
    if (ageFilter.value) params.set('faixaIdade', ageFilter.value);
    if (statusFilter.value) params.set('status', statusFilter.value);
    if (alertFilter.value) params.set('alerta', alertFilter.value);
    if (dateFrom.value) params.set('dateFrom', dateFrom.value);
    if (dateTo.value) params.set('dateTo', dateTo.value);
    return params;
}

function setLoading(isLoading) {
    refreshButton.disabled = isLoading;
    refreshButton.innerHTML = isLoading
        ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Carregando'
        : '<i class="fa-solid fa-rotate"></i> Atualizar';
}

function renderSelectOptions(select, items, getValue, getLabel) {
    const current = select.value;
    const first = select.querySelector('option');
    select.innerHTML = '';
    select.appendChild(first);
    items.forEach(item => {
        const option = document.createElement('option');
        option.value = getValue(item);
        option.textContent = getLabel(item);
        select.appendChild(option);
    });
    select.value = [...select.options].some(option => option.value === current) ? current : '';
}

async function loadPatients() {
    if (!currentUser) return;
    setLoading(true);
    try {
        const data = await apiFetch(`/api/portal-gestor/pacientes?${buildParams().toString()}`);
        currentRows = data.rows || [];
        renderSelectOptions(typeFilter, data.options.tipos || [], item => item, item => item);
        renderSelectOptions(alertFilter, data.options.alertas || [], item => item.key, item => item.label);
        renderKpis(data.kpis || {});
        renderRows();
        const trunc = data.totalRows > currentRows.length
            ? ` Mostrando os primeiros ${formatNumber(currentRows.length)}.`
            : '';
        resultSummary.textContent = `${formatNumber(data.totalRows)} pacientes no filtro atual.${trunc}`;
    } catch (error) {
        if (error.status === 401) {
            showLogin('Sessao expirada. Entre novamente.');
            return;
        }
        showToast(error.message, 'error');
    } finally {
        setLoading(false);
    }
}

function renderKpis(kpis) {
    kpiPatients.textContent = formatNumber(kpis.totalPacientes);
    kpiMammo.textContent = formatNumber(kpis.comMamografia);
    kpiUsgMama.textContent = formatNumber(kpis.comUsgMama);
    kpiUsgTv.textContent = formatNumber(kpis.comUsgTransvaginal);
    kpiSemLaudo.textContent = formatNumber(kpis.semLaudo);
    kpiAlertas.textContent = formatNumber(kpis.comAlerta);
}

function renderRows() {
    if (!currentRows.length) {
        patientRows.innerHTML = '<tr><td colspan="9" class="empty-cell">Nenhum paciente encontrado para os filtros atuais.</td></tr>';
        return;
    }
    patientRows.innerHTML = currentRows.map((row, index) => {
        const key = row.grupoPaciente || String(index);
        const isOpen = expandedRows.has(key);
        const age = row.dataNascimento
            ? `${formatDate(row.dataNascimento)}${row.idadeAnos !== null ? ` / ${row.idadeAnos} anos` : ''}`
            : (row.idadeAnos !== null ? `${row.idadeAnos} anos` : '-');
        const alerts = (row.alertas || []).map(alert => `<span class="pill ${escapeHtml(alert.level)}">${escapeHtml(alert.label)}</span>`).join('');
        const laudos = [
            row.mamografias ? `<span class="pill">MAMO ${formatNumber(row.mamografias)}</span>` : '',
            row.usgMama ? `<span class="pill">USG mama ${formatNumber(row.usgMama)}</span>` : '',
            row.usgTransvaginal ? `<span class="pill">USG TV ${formatNumber(row.usgTransvaginal)}</span>` : '',
        ].join('');
        return `
            <tr class="patient-row" data-key="${escapeHtml(key)}">
                <td><button class="expand-btn" type="button">${isOpen ? '-' : '+'}</button></td>
                <td>
                    <strong>${escapeHtml(row.paciente || '-')}</strong>
                    <div class="meta">${escapeHtml(row.grupoPaciente || '')}</div>
                </td>
                <td>
                    <div>${row.cpf ? `CPF ${escapeHtml(row.cpf)}` : 'CPF -'}</div>
                    <div class="meta">${row.cns ? `CNS ${escapeHtml(row.cns)}` : 'CNS -'}</div>
                </td>
                <td>${escapeHtml(row.telefone || '-')}</td>
                <td>${escapeHtml(age)}</td>
                <td>${escapeHtml(row.procedimentos || '-')}</td>
                <td><strong>${formatNumber(row.totalLaudos)}</strong><div>${laudos || '-'}</div></td>
                <td>${alerts || '<span class="pill neutral">Sem alerta</span>'}</td>
                <td>${formatDate(row.ultimaData)}</td>
            </tr>
            ${isOpen ? renderDetails(row) : ''}
        `;
    }).join('');
}

function renderDetails(row) {
    const docs = row.documentos || [];
    const atendimentos = row.atendimentos || [];
    const atendimentosHtml = atendimentos.length
        ? atendimentos.map(item => `
            <div class="meta">
                ${formatDate(item.data)} - ${escapeHtml(item.competencia || '-')} - ${escapeHtml(item.regiao || '-')}
            </div>
        `).join('')
        : '<div class="meta">Sem atendimento registrado.</div>';
    const docsHtml = docs.length
        ? docs.map(doc => {
            const pdfUrl = `/api/portal-gestor/laudos/${encodeURIComponent(doc.id)}/pdf`;
            return `
                <div class="document-item">
                    <div>
                        <strong>${escapeHtml(doc.tipoLaudo || '-')}</strong>
                        <div class="meta">Laudo #${escapeHtml(doc.id)}</div>
                    </div>
                    <div>
                        ${escapeHtml(doc.procedimento || doc.arquivoOriginal || '-')}
                        <div class="meta">${escapeHtml(doc.arquivoOriginal || '')}</div>
                    </div>
                    <div>${formatDate(doc.data)}</div>
                    <a class="pdf-link" href="${pdfUrl}" target="_blank" rel="noopener">
                        <i class="fa-solid fa-file-pdf"></i>
                        Abrir PDF
                    </a>
                </div>
            `;
        }).join('')
        : '<div class="meta">Nenhum laudo disponivel para este paciente.</div>';

    return `
        <tr class="detail-row">
            <td colspan="9">
                <div class="detail-panel">
                    <div class="detail-grid">
                        <section class="detail-box">
                            <h3>Atendimentos</h3>
                            ${atendimentosHtml}
                        </section>
                        <section class="detail-box">
                            <h3>Laudos disponiveis</h3>
                            <div class="document-list">${docsHtml}</div>
                        </section>
                    </div>
                </div>
            </td>
        </tr>
    `;
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginButton.disabled = true;
    loginMessage.classList.add('hidden');
    try {
        const data = await apiFetch('/api/portal-gestor/login', {
            method: 'POST',
            body: JSON.stringify({
                login: loginInput.value.trim(),
                senha: passwordInput.value,
            }),
        });
        passwordInput.value = '';
        showPortal(data.user);
        expandedRows.clear();
        await loadPatients();
    } catch (error) {
        loginMessage.textContent = error.message;
        loginMessage.classList.remove('hidden');
    } finally {
        loginButton.disabled = false;
    }
});

logoutButton.addEventListener('click', async () => {
    try {
        await apiFetch('/api/portal-gestor/logout', { method: 'POST', body: '{}' });
    } catch {
        // A tela local sempre deve sair mesmo se o servidor ja expirou a sessao.
    }
    showLogin();
});

refreshButton.addEventListener('click', loadPatients);

[typeFilter, ageFilter, statusFilter, alertFilter, dateFrom, dateTo].forEach(control => {
    control.addEventListener('change', () => {
        expandedRows.clear();
        loadPatients();
    });
});

searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        expandedRows.clear();
        loadPatients();
    }, 350);
});

patientRows.addEventListener('click', event => {
    if (event.target.closest('a')) return;
    const row = event.target.closest('.patient-row');
    if (!row) return;
    const key = row.dataset.key;
    if (expandedRows.has(key)) {
        expandedRows.delete(key);
    } else {
        expandedRows.add(key);
    }
    renderRows();
});

async function boot() {
    try {
        const data = await apiFetch('/api/portal-gestor/me');
        showPortal(data.user);
        await loadPatients();
    } catch {
        showLogin();
    }
}

boot();

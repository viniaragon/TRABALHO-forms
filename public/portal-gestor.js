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
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const clearFiltersButton = document.getElementById('clearFiltersButton');
const refreshButton = document.getElementById('refreshButton');
const patientRows = document.getElementById('patientRows');
const resultSummary = document.getElementById('resultSummary');
const toast = document.getElementById('toast');
const patientDrawer = document.getElementById('patientDrawer');
const drawerBackdrop = document.getElementById('drawerBackdrop');
const closeDrawerButton = document.getElementById('closeDrawerButton');
const drawerTitle = document.getElementById('drawerTitle');
const drawerContent = document.getElementById('drawerContent');

const kpiPatients = document.getElementById('kpiPatients');
const kpiReports = document.getElementById('kpiReports');
const kpiMammo = document.getElementById('kpiMammo');
const kpiUsgMama = document.getElementById('kpiUsgMama');
const kpiUsgTv = document.getElementById('kpiUsgTv');

let currentUser = null;
let currentRows = [];
let searchTimer = null;
let lastDrawerTrigger = null;

const REPORT_TYPE_LABELS = {
    MAMOGRAFIA: 'Mamografia',
    USG_MAMA: 'USG de mama',
    USG_MAMA_COMPLEMENTACAO: 'USG de mama complementar',
    USG_PELVICA: 'USG pélvica',
    USG_TRANSVAGINAL: 'USG transvaginal',
};

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

function formatReportType(value) {
    const key = String(value || '').trim().toUpperCase();
    if (!key) return 'Laudo';
    return REPORT_TYPE_LABELS[key] || key
        .toLowerCase()
        .replaceAll('_', ' ')
        .replace(/^./, character => character.toUpperCase());
}

function displayValue(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : 'Não informado';
}

function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 3600);
}

function showLogin(message = '') {
    closePatientDrawer(false);
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
        renderSelectOptions(typeFilter, data.options.tipos || [], item => item, formatReportType);
        renderKpis(data.kpis || {});
        renderRows();
        const trunc = data.totalRows > currentRows.length
            ? ` Mostrando os primeiros ${formatNumber(currentRows.length)}.`
            : '';
        resultSummary.textContent = `${formatNumber(data.totalRows)} pacientes com laudo no filtro atual.${trunc}`;
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
    kpiReports.textContent = formatNumber(kpis.totalLaudos);
    kpiMammo.textContent = formatNumber(kpis.comMamografia);
    kpiUsgMama.textContent = formatNumber(kpis.comUsgMama);
    kpiUsgTv.textContent = formatNumber(kpis.comUsgTransvaginal);
}

function renderRows() {
    if (!currentRows.length) {
        patientRows.innerHTML = '<tr><td colspan="5" class="empty-cell">Nenhum paciente com laudo encontrado para os filtros atuais.</td></tr>';
        return;
    }
    patientRows.innerHTML = currentRows.map((row, index) => {
        const age = row.dataNascimento
            ? `${formatDate(row.dataNascimento)}${row.idadeAnos !== null ? ` / ${row.idadeAnos} anos` : ''}`
            : (row.idadeAnos !== null ? `${row.idadeAnos} anos` : '-');
        const laudos = [
            row.mamografias ? `<span class="pill">MAMO ${formatNumber(row.mamografias)}</span>` : '',
            row.usgMama ? `<span class="pill">USG mama ${formatNumber(row.usgMama)}</span>` : '',
            row.usgTransvaginal ? `<span class="pill">USG TV ${formatNumber(row.usgTransvaginal)}</span>` : '',
        ].join('');
        const reportLabel = row.totalLaudos === 1 ? 'Ver 1 laudo' : `Ver ${formatNumber(row.totalLaudos)} laudos`;
        return `
            <tr class="patient-row">
                <td data-label="Paciente"><strong class="patient-name">${escapeHtml(row.paciente || 'Não informado')}</strong></td>
                <td data-label="Nascimento / idade">${escapeHtml(age)}</td>
                <td data-label="Laudos disponíveis">
                    <div class="report-summary"><strong>${formatNumber(row.totalLaudos)}</strong>${laudos}</div>
                </td>
                <td data-label="Última data">${formatDate(row.ultimaData)}</td>
                <td class="action-cell" data-label="Ação">
                    <button class="btn secondary view-reports-btn" type="button" data-row-index="${index}" aria-label="${escapeHtml(reportLabel)} de ${escapeHtml(row.paciente || 'paciente')}">
                        <i class="fa-solid fa-file-medical"></i>
                        ${escapeHtml(reportLabel)}
                    </button>
                </td>
            </tr>
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
                        <strong>${escapeHtml(formatReportType(doc.tipoLaudo))}</strong>
                    </div>
                    <div>
                        ${escapeHtml(doc.procedimento || 'Procedimento não informado')}
                    </div>
                    <div>${formatDate(doc.data)}</div>
                    <a class="pdf-link" href="${pdfUrl}" target="_blank" rel="noopener">
                        <i class="fa-solid fa-file-pdf"></i>
                        Abrir PDF
                    </a>
                </div>
            `;
        }).join('')
        : '<div class="meta">Nenhum documento para exibir.</div>';

    const age = row.dataNascimento
        ? `${formatDate(row.dataNascimento)}${row.idadeAnos !== null ? ` / ${row.idadeAnos} anos` : ''}`
        : (row.idadeAnos !== null ? `${row.idadeAnos} anos` : 'Não informado');

    return `
        <section class="detail-box patient-facts" aria-label="Dados da paciente">
            <div class="fact-item"><span>Nascimento / idade</span><strong>${escapeHtml(age)}</strong></div>
            <div class="fact-item"><span>Telefone</span><strong>${escapeHtml(displayValue(row.telefone))}</strong></div>
            <div class="fact-item"><span>CPF</span><strong>${escapeHtml(displayValue(row.cpf))}</strong></div>
            <div class="fact-item"><span>CNS</span><strong>${escapeHtml(displayValue(row.cns))}</strong></div>
            <div class="fact-item"><span>Procedimentos registrados</span><strong>${escapeHtml(displayValue(row.procedimentos))}</strong></div>
            <div class="fact-item"><span>Última data</span><strong>${formatDate(row.ultimaData)}</strong></div>
        </section>
        <div class="detail-grid">
            <section class="detail-box">
                <h3>Atendimentos registrados</h3>
                ${atendimentosHtml}
            </section>
            <section class="detail-box">
                <h3>Laudos disponíveis</h3>
                <div class="document-list">${docsHtml}</div>
            </section>
        </div>
    `;
}

function openPatientDrawer(row, trigger) {
    lastDrawerTrigger = trigger || null;
    drawerTitle.textContent = row.paciente || 'Detalhes da paciente';
    drawerContent.innerHTML = renderDetails(row);
    patientDrawer.classList.remove('hidden');
    patientDrawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    closeDrawerButton.focus();
}

function closePatientDrawer(restoreFocus = true) {
    if (!patientDrawer || patientDrawer.classList.contains('hidden')) return;
    patientDrawer.classList.add('hidden');
    patientDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    if (restoreFocus && lastDrawerTrigger?.isConnected) lastDrawerTrigger.focus();
    lastDrawerTrigger = null;
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

clearFiltersButton.addEventListener('click', () => {
    window.clearTimeout(searchTimer);
    searchInput.value = '';
    typeFilter.value = '';
    ageFilter.value = '';
    dateFrom.value = '';
    dateTo.value = '';
    closePatientDrawer(false);
    loadPatients();
    searchInput.focus();
});

[typeFilter, ageFilter, dateFrom, dateTo].forEach(control => {
    control.addEventListener('change', () => {
        closePatientDrawer(false);
        loadPatients();
    });
});

searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        closePatientDrawer(false);
        loadPatients();
    }, 350);
});

patientRows.addEventListener('click', event => {
    const button = event.target.closest('[data-row-index]');
    if (!button) return;
    const row = currentRows[Number(button.dataset.rowIndex)];
    if (row) openPatientDrawer(row, button);
});

closeDrawerButton.addEventListener('click', () => closePatientDrawer());
drawerBackdrop.addEventListener('click', () => closePatientDrawer());

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePatientDrawer();
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

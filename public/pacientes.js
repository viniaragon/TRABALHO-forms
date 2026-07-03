const accessForm = document.getElementById('accessForm');
const accessKeyInput = document.getElementById('accessKey');
const clearAccess = document.getElementById('clearAccess');
const accessBadge = document.getElementById('accessBadge');
const filterRegiaoMae = document.getElementById('filterRegiaoMae');
const filterLocalidade = document.getElementById('filterLocalidade');
const filterTipo = document.getElementById('filterTipo');
const filterLaudoModo = document.getElementById('filterLaudoModo');
const laudoModoText = document.getElementById('laudoModoText');
const filterIdade = document.getElementById('filterIdade');
const filterStatus = document.getElementById('filterStatus');
const filterDateFrom = document.getElementById('filterDateFrom');
const filterDateTo = document.getElementById('filterDateTo');
const filterSearch = document.getElementById('filterSearch');
const refreshBtn = document.getElementById('refreshBtn');
const patientRows = document.getElementById('patientRows');
const resultSummary = document.getElementById('resultSummary');
const motherRegionList = document.getElementById('motherRegionList');
const typeList = document.getElementById('typeList');
const localityList = document.getElementById('localityList');
const toast = document.getElementById('toast');
const reviewModal = document.getElementById('reviewModal');
const reviewClose = document.getElementById('reviewClose');
const reviewLaudoInfo = document.getElementById('reviewLaudoInfo');
const reviewSearch = document.getElementById('reviewSearch');
const reviewSearchBtn = document.getElementById('reviewSearchBtn');
const reviewCandidates = document.getElementById('reviewCandidates');
const reviewReason = document.getElementById('reviewReason');
const reviewLinkBtn = document.getElementById('reviewLinkBtn');
const reviewNotFoundBtn = document.getElementById('reviewNotFoundBtn');
const reviewIgnoreBtn = document.getElementById('reviewIgnoreBtn');

const kpiPatients = document.getElementById('kpiPatients');
const kpiReports = document.getElementById('kpiReports');
const kpiLinked = document.getElementById('kpiLinked');
const kpiPending = document.getElementById('kpiPending');
const kpiMammo = document.getElementById('kpiMammo');
const kpiUsg = document.getElementById('kpiUsg');
const kpiPacMamografia = document.getElementById('kpiPacMamografia');
const kpiPacUsg = document.getElementById('kpiPacUsg');
const kpiPacUsgTv = document.getElementById('kpiPacUsgTv');
const kpiPacUsgMama = document.getElementById('kpiPacUsgMama');
const kpiPacUsgPelvica = document.getElementById('kpiPacUsgPelvica');

let accessKey = sessionStorage.getItem('patientBankAccessKey') || '';
let searchTimer = null;
let currentRows = [];
let currentAccessLevel = null;
let reviewState = { laudoId: null, selectedPatientId: null };
const expandedRows = new Set();

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
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

function setLoading(isLoading) {
    refreshBtn.disabled = isLoading;
    refreshBtn.innerHTML = isLoading
        ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Carregando'
        : '<i class="fa-solid fa-rotate"></i> Atualizar';
}

function buildParams() {
    const params = new URLSearchParams();
    params.set('accessKey', accessKey);
    if (filterRegiaoMae.value) params.set('regiaoMae', filterRegiaoMae.value);
    if (filterLocalidade.value) params.set('localidade', filterLocalidade.value);
    if (filterTipo.value) params.set('tipo', filterTipo.value);
    if (filterLaudoModo.checked) params.set('laudoModo', 'sem');
    if (filterStatus.value) params.set('status', filterStatus.value);
    if (filterIdade.value) params.set('faixaIdade', filterIdade.value);
    if (filterDateFrom.value) params.set('dateFrom', filterDateFrom.value);
    if (filterDateTo.value) params.set('dateTo', filterDateTo.value);
    if (filterSearch.value.trim()) params.set('search', filterSearch.value.trim());
    return params;
}

async function fetchPatientBank() {
    if (!accessKey) {
        renderLocked();
        return;
    }

    setLoading(true);
    try {
        const response = await fetch(`/api/pacientes-banco?${buildParams().toString()}`);
        const payload = await response.json();
        if (!response.ok || !payload.success) {
            throw new Error(payload.message || 'Falha ao carregar Banco de Pacientes.');
        }
        sessionStorage.setItem('patientBankAccessKey', accessKey);
        renderData(payload.data);
    } catch (error) {
        renderLocked();
        showToast(error.message, 'error');
    } finally {
        setLoading(false);
    }
}

function renderLocked() {
    currentAccessLevel = null;
    accessBadge.textContent = 'Bloqueado';
    accessBadge.className = 'access-badge locked';
    patientRows.innerHTML = '<tr><td colspan="8" class="empty-cell">Informe uma chave de acesso valida.</td></tr>';
    resultSummary.textContent = 'Informe a chave de acesso para carregar.';
    motherRegionList.innerHTML = '';
    typeList.innerHTML = '';
    localityList.innerHTML = '';
    updateKpis({});
}

function updateKpis(kpis = {}) {
    kpiPatients.textContent = formatNumber(kpis.totalPacientes);
    kpiReports.textContent = formatNumber(kpis.totalLaudos);
    kpiLinked.textContent = formatNumber(kpis.pacientesVinculados);
    kpiPending.textContent = formatNumber(kpis.pacientesPendentes);
    kpiMammo.textContent = formatNumber(kpis.mamografias);
    kpiUsg.textContent = formatNumber(kpis.usgs);
    kpiPacMamografia.textContent = formatNumber(kpis.pacComMamografia);
    kpiPacUsg.textContent = formatNumber(kpis.pacComUsg);
    kpiPacUsgTv.textContent = formatNumber(kpis.pacComUsgTransvaginal);
    kpiPacUsgMama.textContent = formatNumber(kpis.pacComUsgMama);
    kpiPacUsgPelvica.textContent = formatNumber(kpis.pacComUsgPelvica);
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

function renderData(data) {
    currentRows = data.rows || [];
    currentAccessLevel = data.access.level;
    const accessClass = data.access.level === 'master' ? 'master' : 'restricted';
    accessBadge.textContent = data.access.level === 'master'
        ? 'Master: todas as localidades'
        : `${data.access.label}`;
    accessBadge.className = `access-badge ${accessClass}`;

    renderSelectOptions(
        filterRegiaoMae,
        data.options.regioesMae || [],
        item => item.regiao_mae,
        item => `${item.regiao_mae} (${formatDate(item.min_data)} a ${formatDate(item.max_data)})`
    );
    renderSelectOptions(
        filterLocalidade,
        data.options.localidades || [],
        item => item.localidade,
        item => `${item.localidade} (${formatDate(item.min_data)} a ${formatDate(item.max_data)})`
    );
    renderSelectOptions(
        filterTipo,
        data.options.tipos || [],
        item => item,
        item => item
    );

    updateKpis(data.kpis);
    renderMetricList(motherRegionList, data.porRegiaoMae || [], 'regiao_mae');
    renderMetricList(typeList, data.porTipo || [], 'tipo_laudo');
    renderMetricList(localityList, data.porLocalidade || [], 'localidade');
    renderRows();
    adminBtn.classList.toggle('hidden', currentAccessLevel !== 'master');

    const from = data.filters.dateFrom ? formatDate(data.filters.dateFrom) : 'inicio';
    const to = data.filters.dateTo ? formatDate(data.filters.dateTo) : 'hoje';
    const duplicateNote = data.kpis.duplicadosLogicos
        ? ` ${formatNumber(data.kpis.duplicadosLogicos)} copias duplicadas estao ocultas (mantido o laudo mais recente de cada tipo).`
        : '';
    const totalPacientes = Number(data.kpis.totalPacientes || 0);
    const truncNote = totalPacientes > currentRows.length
        ? ` (mostrando os primeiros ${formatNumber(currentRows.length)})`
        : '';
    resultSummary.textContent = `${formatNumber(totalPacientes)} pacientes batem com os filtros${truncNote}. Periodo efetivo: ${from} ate ${to}.${duplicateNote}`;
}

const adminBtn = document.getElementById('adminBtn');
const adminModal = document.getElementById('adminModal');
const adminClose = document.getElementById('adminClose');
const quarantineList = document.getElementById('quarantineList');

async function loadQuarantine() {
    quarantineList.innerHTML = '<tr><td colspan="6">Carregando...</td></tr>';
    const response = await fetch(`/api/pacientes-banco/quarentena?accessKey=${encodeURIComponent(accessKey)}`);
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        quarantineList.innerHTML = `<tr><td colspan="6">${escapeHtml(payload.message || 'Falha ao carregar.')}</td></tr>`;
        return;
    }
    const docs = payload.data || [];
    if (!docs.length) {
        quarantineList.innerHTML = '<tr><td colspan="6">Nenhum documento em quarentena.</td></tr>';
        return;
    }
    quarantineList.innerHTML = docs.map(doc => {
        const descartado = doc.status_vinculo === 'descartado';
        const pdfUrl = `/api/pacientes-banco/laudos/${encodeURIComponent(doc.id)}/pdf?accessKey=${encodeURIComponent(accessKey)}`;
        return `
        <tr class="${descartado ? 'descartado' : ''}">
            <td><a href="${pdfUrl}" target="_blank" rel="noopener">${escapeHtml(doc.titulo_raw || doc.arquivo_original || ('Laudo #' + doc.id))}</a></td>
            <td>${escapeHtml(doc.nome_extraido || '-')}</td>
            <td>${doc.data_realizacao ? formatDate(doc.data_realizacao) : '-'}</td>
            <td title="${escapeHtml(doc.caminho_origem || '')}">${escapeHtml(doc.arquivo_original || '-')}</td>
            <td>${descartado ? 'Descartado' : 'Quarentena'}</td>
            <td>${descartado ? '' : `<button class="btn danger quarantine-discard" data-id="${escapeHtml(doc.id)}" type="button" style="padding:4px 12px; font-size:12px;">Excluir</button>`}</td>
        </tr>`;
    }).join('');
}

adminBtn?.addEventListener('click', () => {
    adminModal.classList.remove('hidden');
    loadQuarantine().catch(error => showToast(error.message, 'error'));
});
adminClose?.addEventListener('click', () => adminModal.classList.add('hidden'));
adminModal?.addEventListener('click', event => {
    if (event.target === adminModal) adminModal.classList.add('hidden');
});

quarantineList?.addEventListener('click', async event => {
    const button = event.target.closest('.quarantine-discard');
    if (!button) return;
    if (!window.confirm('Excluir este documento da base? Ele sai de todas as listagens (fica auditado como descartado).')) return;
    try {
        const response = await fetch(`/api/pacientes-banco/laudos/${encodeURIComponent(button.dataset.id)}/descartar?accessKey=${encodeURIComponent(accessKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revisadoPor: 'master' }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || 'Falha ao excluir.');
        showToast('Documento descartado.');
        await loadQuarantine();
    } catch (error) {
        showToast(error.message, 'error');
    }
});

function renderMetricList(container, rows, labelKey) {
    if (!rows.length) {
        container.innerHTML = '<div class="metric-item"><span>Sem dados no filtro</span><strong>0</strong></div>';
        return;
    }
    container.innerHTML = rows.map(row => `
        <div class="metric-item">
            <span>${escapeHtml(row[labelKey] || '-')}</span>
            <strong>${formatNumber(row.qtd)}</strong>
        </div>
    `).join('');
}

function patientStatus(row) {
    if (!Number(row.totalLaudos)) {
        return '<span class="status-pill pending">Sem laudo</span>';
    }
    if (String(row.regioesMae || '').includes('EM ESPERA') && row.pendentes > 0) {
        return '<span class="status-pill waiting">Em espera</span>';
    }
    if (row.pendentes > 0 && row.vinculados > 0) {
        return '<span class="status-pill pending">Misto</span>';
    }
    if (row.pendentes > 0) {
        return '<span class="status-pill pending">Pendente</span>';
    }
    return '<span class="status-pill linked">Vinculado</span>';
}

function renderRows() {
    if (!currentRows.length) {
        patientRows.innerHTML = '<tr><td colspan="8" class="empty-cell">Nenhum paciente encontrado para o filtro atual.</td></tr>';
        return;
    }

    patientRows.innerHTML = currentRows.map((row, index) => {
        const key = row.grupoPaciente || String(index);
        const isOpen = expandedRows.has(key);
        const age = row.dataNascimento
            ? `${formatDate(row.dataNascimento)}${row.idadeAnos ? ` / ${row.idadeAnos} anos` : ''}`
            : (row.idadeAnos ? `${row.idadeAnos} anos` : '-');
        const laudos = [
            row.mamografias ? `<span class="mini-pill">MAMO ${formatNumber(row.mamografias)}</span>` : '',
            row.usgs ? `<span class="mini-pill">USG ${formatNumber(row.usgs)}</span>` : '',
        ].join('');
        return `
            <tr class="patient-row" data-key="${escapeHtml(key)}">
                <td><button class="expand-btn" type="button">${isOpen ? '-' : '+'}</button></td>
                <td>
                    <strong>${escapeHtml(row.paciente || '-')}</strong>
                    <div class="doc-meta">${row.pacienteId ? `ID paciente ${escapeHtml(row.pacienteId)}` : 'Sem paciente_id automatico'}</div>
                    ${row.cartaoSus ? `<div class="doc-meta">CNS ${escapeHtml(row.cartaoSus)}</div>` : ''}
                </td>
                <td>${escapeHtml(row.regioesMae || '-')}</td>
                <td>${escapeHtml(row.localidades || '-')}</td>
                <td>${escapeHtml(age)}</td>
                <td><strong>${formatNumber(row.totalLaudos)}</strong><div>${laudos || '-'}</div></td>
                <td>${patientStatus(row)}</td>
                <td>${formatDate(row.ultimaData)}</td>
            </tr>
            ${isOpen ? renderDetails(row) : ''}
        `;
    }).join('');
}

function renderDetails(row) {
    const docs = row.documentos || [];
    const content = docs.map(doc => {
        const pdfUrl = `/api/pacientes-banco/laudos/${encodeURIComponent(doc.id)}/pdf?accessKey=${encodeURIComponent(accessKey)}`;
        const pdfButton = doc.temArquivoLocal
            ? `<a class="pdf-link" href="${pdfUrl}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> Abrir PDF</a>`
            : '<span class="doc-meta">PDF local ausente</span>';
        const reviewButton = currentAccessLevel === 'master' && !doc.pacienteId
            ? `<button class="review-link" type="button" data-review-laudo="${escapeHtml(doc.id)}"><i class="fa-solid fa-user-check"></i> Revisar</button>`
            : '';
        const unlinkButton = currentAccessLevel === 'master' && doc.pacienteId
            ? `<button class="review-link" type="button" data-unlink-laudo="${escapeHtml(doc.id)}" title="Remove o vinculo deste laudo com o paciente (exige senha)"><i class="fa-solid fa-link-slash"></i> Desvincular</button>`
            : '';
        const statusLabel = doc.pacienteId
            ? '<span class="status-pill linked">Vinculado</span>'
            : (doc.statusVinculo === 'pendente_espera_cadastro'
                ? '<span class="status-pill waiting">Em espera</span>'
                : '<span class="status-pill pending">Pendente</span>');
        const aviso = doc.motivo && doc.motivo.toUpperCase().startsWith('ATENCAO')
            ? `<div class="doc-meta" style="color:#dc2626; font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(doc.motivo)}</div>`
            : '';
        return `
            <div class="document-item">
                <div>
                    <div class="doc-type">${escapeHtml(doc.tipoLaudo || '-')}</div>
                    <div class="doc-meta">Laudo #${escapeHtml(doc.id)}</div>
                </div>
                <div>
                    ${escapeHtml(doc.procedimento || doc.arquivoOriginal || 'Documento sem procedimento descrito')}
                    <div class="doc-meta">${escapeHtml(doc.arquivoOriginal || '')}</div>
                    ${aviso}
                </div>
                <div>${formatDate(doc.data)}</div>
                <div>${statusLabel}</div>
                <div class="doc-actions">${pdfButton}${reviewButton}${unlinkButton}</div>
            </div>
        `;
    }).join('');

    return `
        <tr class="patient-detail-row">
            <td colspan="8">
                <div class="patient-detail">
                    <h3>Documentos vinculados localmente</h3>
                    <div class="document-list">${content || '<div class="doc-meta">Sem documentos.</div>'}</div>
                </div>
            </td>
        </tr>
    `;
}

accessForm.addEventListener('submit', event => {
    event.preventDefault();
    accessKey = accessKeyInput.value.trim();
    expandedRows.clear();
    fetchPatientBank();
});

clearAccess.addEventListener('click', () => {
    accessKey = '';
    accessKeyInput.value = '';
    sessionStorage.removeItem('patientBankAccessKey');
    expandedRows.clear();
    renderLocked();
});

refreshBtn.addEventListener('click', fetchPatientBank);

filterLaudoModo.addEventListener('change', () => {
    laudoModoText.textContent = filterLaudoModo.checked ? 'Sem laudo' : 'Com laudo';
});

[filterRegiaoMae, filterLocalidade, filterTipo, filterStatus, filterDateFrom, filterDateTo, filterLaudoModo, filterIdade].forEach(control => {
    control.addEventListener('change', () => {
        expandedRows.clear();
        fetchPatientBank();
    });
});

filterSearch.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        expandedRows.clear();
        fetchPatientBank();
    }, 350);
});

patientRows.addEventListener('click', event => {
    const reviewButton = event.target.closest('[data-review-laudo]');
    if (reviewButton) {
        event.stopPropagation();
        openReviewModal(reviewButton.dataset.reviewLaudo);
        return;
    }

    const unlinkButton = event.target.closest('[data-unlink-laudo]');
    if (unlinkButton) {
        event.stopPropagation();
        desvincularLaudo(unlinkButton.dataset.unlinkLaudo);
        return;
    }

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

function closeReviewModal() {
    reviewModal.classList.add('hidden');
    reviewState = { laudoId: null, selectedPatientId: null };
    reviewLaudoInfo.innerHTML = '';
    reviewCandidates.innerHTML = '';
    reviewSearch.value = '';
    reviewReason.value = '';
    reviewLinkBtn.disabled = true;
}

async function fetchReviewCandidates() {
    if (!reviewState.laudoId) return;
    const params = new URLSearchParams();
    params.set('accessKey', accessKey);
    if (reviewSearch.value.trim()) params.set('search', reviewSearch.value.trim());

    const response = await fetch(`/api/pacientes-banco/laudos/${encodeURIComponent(reviewState.laudoId)}/candidatos?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.message || 'Falha ao buscar candidatos.');
    }
    renderReviewData(payload.data);
}

async function desvincularLaudo(laudoId) {
    const senha = window.prompt('Desvincular laudo do paciente.\nDigite a senha de desvinculação:');
    if (senha === null) return;
    const motivo = window.prompt('Motivo da desvinculação (opcional):') || '';
    try {
        const response = await fetch(`/api/pacientes-banco/laudos/${encodeURIComponent(laudoId)}/revisao?accessKey=${encodeURIComponent(accessKey)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ acao: 'desvincular', senha, motivo, revisadoPor: 'master' }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || 'Falha ao desvincular.');
        showToast('Laudo desvinculado. Ele voltou para a fila de revisao.');
        fetchPatientBank();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function openReviewModal(laudoId) {
    if (currentAccessLevel !== 'master') {
        showToast('A revisao manual exige senha master.', 'error');
        return;
    }
    reviewState = { laudoId, selectedPatientId: null };
    reviewModal.classList.remove('hidden');
    reviewLaudoInfo.innerHTML = '<div class="doc-meta">Carregando laudo...</div>';
    reviewCandidates.innerHTML = '';
    reviewReason.value = '';
    reviewLinkBtn.disabled = true;
    try {
        await fetchReviewCandidates();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function renderReviewData(data) {
    const laudo = data.laudo;
    reviewSearch.value = reviewSearch.value || laudo.nomeExtraido || '';
    reviewLaudoInfo.innerHTML = `
        <div><strong>${escapeHtml(laudo.nomeExtraido || '-')}</strong></div>
        <div class="doc-meta">${escapeHtml(laudo.tipoLaudo || '-')} · Laudo #${escapeHtml(laudo.id)} · ${escapeHtml(laudo.arquivoOriginal || '')}</div>
        <div class="doc-meta">
            ${laudo.dataRealizacao ? `Exame em ${formatDate(laudo.dataRealizacao)} · ` : ''}
            ${laudo.regiaoPasta ? `Região ${escapeHtml(laudo.regiaoPasta)} · ` : ''}
            ${laudo.cartaoSus ? `CNS ${escapeHtml(laudo.cartaoSus)} · ` : ''}
            ${laudo.telefone ? `Tel ${escapeHtml(laudo.telefone)} · ` : ''}
            ${laudo.dataNascimento ? `Nasc. ${formatDate(laudo.dataNascimento)} · ` : ''}
            ${laudo.idadeAnos ? `${escapeHtml(laudo.idadeAnos)} anos` : ''}
        </div>
    `;

    if (!data.candidates.length) {
        reviewCandidates.innerHTML = '<div class="empty-review">Nenhum candidato encontrado. Ajuste a busca ou marque como não encontrado.</div>';
        return;
    }

    reviewCandidates.innerHTML = data.candidates.map(candidate => {
        const sinais = [];
        if (candidate.exactMatch) sinais.push('nome exato');
        else if (candidate.similaridade) sinais.push(`similaridade ${(candidate.similaridade * 100).toFixed(0)}%`);
        if (candidate.atendimentoNaData) sinais.push('✓ atendimento na data do laudo');
        return `
        <label class="candidate-item">
            <input type="radio" name="reviewCandidate" value="${escapeHtml(candidate.id)}">
            <span>
                <strong>${escapeHtml(candidate.nomePreferido)}</strong>
                <small>ID ${escapeHtml(candidate.id)}${sinais.length ? ' · ' + escapeHtml(sinais.join(' · ')) : ''}</small>
                <small>${escapeHtml(candidate.municipios || '')}${candidate.datasAtendimento ? ' · atendida em: ' + escapeHtml(candidate.datasAtendimento) : ''}</small>
            </span>
        </label>`;
    }).join('');
}

async function submitReview(acao) {
    if (!reviewState.laudoId) return;
    const body = {
        acao,
        motivo: reviewReason.value.trim(),
        revisadoPor: 'master',
    };
    if (acao === 'vincular') {
        body.pacienteId = reviewState.selectedPatientId;
    }

    const response = await fetch(`/api/pacientes-banco/laudos/${encodeURIComponent(reviewState.laudoId)}/revisao?accessKey=${encodeURIComponent(accessKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.message || 'Falha ao salvar revisao.');
    }
    showToast('Revisao registrada.');
    closeReviewModal();
    fetchPatientBank();
}

reviewClose.addEventListener('click', closeReviewModal);
reviewModal.addEventListener('click', event => {
    if (event.target === reviewModal) closeReviewModal();
});
reviewSearchBtn.addEventListener('click', () => {
    fetchReviewCandidates().catch(error => showToast(error.message, 'error'));
});
reviewSearch.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        fetchReviewCandidates().catch(error => showToast(error.message, 'error'));
    }
});
reviewCandidates.addEventListener('change', event => {
    const input = event.target.closest('input[name="reviewCandidate"]');
    if (!input) return;
    reviewState.selectedPatientId = Number(input.value);
    reviewLinkBtn.disabled = !reviewState.selectedPatientId;
});
reviewLinkBtn.addEventListener('click', () => {
    submitReview('vincular').catch(error => showToast(error.message, 'error'));
});
reviewNotFoundBtn.addEventListener('click', () => {
    submitReview('nao_encontrado').catch(error => showToast(error.message, 'error'));
});
reviewIgnoreBtn.addEventListener('click', () => {
    submitReview('ignorar').catch(error => showToast(error.message, 'error'));
});

accessKeyInput.value = accessKey;
if (accessKey) {
    fetchPatientBank();
} else {
    renderLocked();
}

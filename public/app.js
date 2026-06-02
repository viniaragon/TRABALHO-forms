// Estado Global do Client
let allData = [];
let filteredData = [];
let trendChartInstance = null;
let proceduresChartInstance = null;

// Elementos DOM
const dateModeSelect = document.getElementById('dateModeSelect');
const singleDateGroup = document.getElementById('singleDateGroup');
const rangeDateGroup = document.getElementById('rangeDateGroup');
const singleDateSelect = document.getElementById('singleDateSelect');
const startDateInput = document.getElementById('startDateInput');
const endDateInput = document.getElementById('endDateInput');
const btnApplyRange = document.getElementById('btnApplyRange');
const btnPrevDate = document.getElementById('btnPrevDate');
const btnNextDate = document.getElementById('btnNextDate');
const periodDisplay = document.getElementById('periodDisplay');

// KPIs
const kpiAgendados = document.getElementById('kpiAgendados');
const kpiAgendadosSub = document.getElementById('kpiAgendadosSub');
const kpiAtendidos = document.getElementById('kpiAtendidos');
const kpiAtendidosSub = document.getElementById('kpiAtendidosSub');
const kpiFaltas = document.getElementById('kpiFaltas');
const kpiFaltasSub = document.getElementById('kpiFaltasSub');
const kpiOcupacao = document.getElementById('kpiOcupacao');
const kpiOcupacaoSub = document.getElementById('kpiOcupacaoSub');

// Valores de Procedimento
const valConsultas = document.getElementById('valConsultas');
const valOciFechadas = document.getElementById('valOciFechadas');
const valMamografia = document.getElementById('valMamografia');
const valColposcopia = document.getElementById('valColposcopia');
const valUsgMamaria = document.getElementById('valUsgMamaria');
const valUsgTransvaginal = document.getElementById('valUsgTransvaginal');
const valUsgPelvica = document.getElementById('valUsgPelvica');
const valPuncaoMama = document.getElementById('valPuncaoMama');
const valBiopsiaMama = document.getElementById('valBiopsiaMama');
const valBiopsiaColo = document.getElementById('valBiopsiaColo');
const valBiopsiaColoAnatomopatologico = document.getElementById('valBiopsiaColoAnatomopatologico');

// Modal & Form
const recordModal = document.getElementById('recordModal');
const btnOpenModal = document.getElementById('btnOpenModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnCancelModal = document.getElementById('btnCancelModal');
const recordForm = document.getElementById('recordForm');
const formDate = document.getElementById('formDate');
const formResponsavel = document.getElementById('formResponsavel');
const formVagas = document.getElementById('formVagas');
const formAgendadas = document.getElementById('formAgendadas');
const formAtendidas = document.getElementById('formAtendidas');
const formFaltaram = document.getElementById('formFaltaram');
const formConsultas = document.getElementById('formConsultas');
const formOci = document.getElementById('formOci');
const formUsgMamaria = document.getElementById('formUsgMamaria');
const formUsgTransvaginal = document.getElementById('formUsgTransvaginal');
const formUsgPelvica = document.getElementById('formUsgPelvica');
const formMamografia = document.getElementById('formMamografia');
const formColposcopia = document.getElementById('formColposcopia');
const formPuncaoMama = document.getElementById('formPuncaoMama');
const formBiopsiaMama = document.getElementById('formBiopsiaMama');
const formBiopsiaColo = document.getElementById('formBiopsiaColo');
const formBiopsiaColoAnatomo = document.getElementById('formBiopsiaColoAnatomo');

// Toast
const toast = document.getElementById('toast');

// Utilitários de Data
function parseDDMMYYYY(str) {
    if (!str) return null;
    const [d, m, y] = str.split('/').map(Number);
    return new Date(y, m - 1, d);
}

function toDDMMYYYY(date) {
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    return `${d}/${m}/${y}`;
}

function toISODate(ddmmyyyy) {
    if (!ddmmyyyy) return '';
    const [d, m, y] = ddmmyyyy.split('/');
    return `${y}-${m}-${d}`;
}

// Mostrar Toast
function showToast(message, type = 'success') {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hide');
    setTimeout(() => {
        toast.classList.add('hide');
    }, 4000);
}

// Inicializar e Carregar Dados
async function loadData(selectDateStr = null) {
    try {
        const response = await fetch('/api/data');
        const res = await response.json();
        if (res.success) {
            allData = res.data;
            populateDateSelector();
            
            if (selectDateStr) {
                dateModeSelect.value = 'single';
                singleDateSelect.value = selectDateStr;
            }
            
            updateUIState();
            applyFilters();
        } else {
            showToast('Erro ao carregar dados do servidor.', 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Erro de conexão com o servidor.', 'error');
    }
}

// Preencher o seletor de datas
function populateDateSelector() {
    const currentVal = singleDateSelect.value;
    singleDateSelect.innerHTML = '';
    
    // As datas já vêm ordenadas cronologicamente do backend
    allData.forEach(r => {
        const option = document.createElement('option');
        option.value = r.dates;
        option.textContent = r.dates;
        singleDateSelect.appendChild(option);
    });

    if (currentVal && allData.some(r => r.dates === currentVal)) {
        singleDateSelect.value = currentVal;
    } else if (allData.length > 0) {
        // Seleciona a data mais recente por padrão se não houver seleção anterior
        singleDateSelect.value = allData[allData.length - 1].dates;
    }
}

// Monitorar alteração do modo de data
dateModeSelect.addEventListener('change', () => {
    updateUIState();
    applyFilters();
});

function updateUIState() {
    const mode = dateModeSelect.value;
    if (mode === 'single') {
        singleDateGroup.classList.remove('hide');
        rangeDateGroup.classList.add('hide');
    } else if (mode === 'range') {
        singleDateGroup.classList.add('hide');
        rangeDateGroup.classList.remove('hide');
        
        // Define intervalo inicial (primeira e última data)
        if (allData.length > 0) {
            if (!startDateInput.value) {
                startDateInput.value = toISODate(allData[0].dates);
            }
            if (!endDateInput.value) {
                endDateInput.value = toISODate(allData[allData.length - 1].dates);
            }
        }
    } else {
        singleDateGroup.classList.add('hide');
        rangeDateGroup.classList.add('hide');
    }
}

// Alteração de Data Única
singleDateSelect.addEventListener('change', applyFilters);

// Botões Anterior/Próximo
btnPrevDate.addEventListener('click', () => {
    const idx = singleDateSelect.selectedIndex;
    if (idx > 0) {
        singleDateSelect.selectedIndex = idx - 1;
        applyFilters();
    }
});

btnNextDate.addEventListener('click', () => {
    const idx = singleDateSelect.selectedIndex;
    if (idx < singleDateSelect.options.length - 1) {
        singleDateSelect.selectedIndex = idx + 1;
        applyFilters();
    }
});

// Aplicar Filtro de Intervalo
btnApplyRange.addEventListener('click', applyFilters);

// Lógica de Filtro dos Dados
function applyFilters() {
    const mode = dateModeSelect.value;
    
    if (mode === 'all') {
        filteredData = [...allData];
        periodDisplay.textContent = 'Período: Histórico Completo';
    } else if (mode === 'single') {
        const selected = singleDateSelect.value;
        filteredData = allData.filter(r => r.dates === selected);
        periodDisplay.textContent = `Dia selecionado: ${selected}`;
        
        // Desabilitar botões prev/next caso chegue nos limites
        btnPrevDate.disabled = (singleDateSelect.selectedIndex === 0);
        btnNextDate.disabled = (singleDateSelect.selectedIndex === singleDateSelect.options.length - 1);
    } else if (mode === 'range') {
        const start = new Date(startDateInput.value + 'T00:00:00');
        const end = new Date(endDateInput.value + 'T00:00:00');
        
        filteredData = allData.filter(r => {
            const date = parseDDMMYYYY(r.dates);
            return date >= start && date <= end;
        });
        
        const startStr = toDDMMYYYY(start);
        const endStr = toDDMMYYYY(end);
        periodDisplay.textContent = `Período: ${startStr} a ${endStr}`;
    }

    renderDashboard();
}

// Renderizar painéis e gráficos
function renderDashboard() {
    calculateKPIs();
    updateProcedureCounters();
    renderCharts();
}

// Calcular Indicadores (KPIs)
function calculateKPIs() {
    if (filteredData.length === 0) {
        kpiAgendados.textContent = '0';
        kpiAgendadosSub.textContent = 'Média diária: 0';
        kpiAtendidos.textContent = '0';
        kpiAtendidosSub.textContent = 'Taxa de presença: 0%';
        kpiFaltas.textContent = '0';
        kpiFaltasSub.textContent = 'Taxa de absenteísmo: 0%';
        kpiOcupacao.textContent = '0%';
        kpiOcupacaoSub.textContent = 'Vagas ofertadas: 0';
        return;
    }

    let totalAgendados = 0;
    let totalAtendidos = 0;
    let totalFaltas = 0;
    let totalVagas = 0;

    filteredData.forEach(r => {
        totalAgendados += Number(r.agendadas) || 0;
        totalAtendidos += Number(r.atendidas) || 0;
        totalFaltas += Number(r.faltaram) || 0;
        totalVagas += Number(r.vagas) || 0;
    });

    const isSingleDay = filteredData.length === 1;

    // Atualização de valores principais
    kpiAgendados.textContent = totalAgendados;
    kpiAtendidos.textContent = totalAtendidos;
    kpiFaltas.textContent = totalFaltas;

    // Subtextos e Taxas
    if (isSingleDay) {
        kpiAgendadosSub.textContent = `Lançamento único do dia`;
        
        const presenceRate = totalAgendados > 0 ? ((totalAtendidos / totalAgendados) * 100).toFixed(1) : 0;
        kpiAtendidosSub.textContent = `Presença: ${presenceRate}%`;
        
        const absenteeRate = totalAgendados > 0 ? ((totalFaltas / totalAgendados) * 100).toFixed(1) : 0;
        kpiFaltasSub.textContent = `Faltas: ${absenteeRate}%`;

        const occupancyRate = totalVagas > 0 ? ((totalAtendidos / totalVagas) * 100).toFixed(1) : 0;
        kpiOcupacao.textContent = `${occupancyRate}%`;
        kpiOcupacaoSub.textContent = `Vagas ofertadas: ${totalVagas}`;
    } else {
        const avgAgendados = (totalAgendados / filteredData.length).toFixed(1);
        kpiAgendadosSub.textContent = `Média: ${avgAgendados} por dia`;

        const presenceRate = totalAgendados > 0 ? ((totalAtendidos / totalAgendados) * 100).toFixed(1) : 0;
        kpiAtendidosSub.textContent = `Presença acumulada: ${presenceRate}%`;

        const absenteeRate = totalAgendados > 0 ? ((totalFaltas / totalAgendados) * 100).toFixed(1) : 0;
        kpiFaltasSub.textContent = `Absenteísmo acumulado: ${absenteeRate}%`;

        const occupancyRate = totalVagas > 0 ? ((totalAtendidos / totalVagas) * 100).toFixed(1) : 0;
        kpiOcupacao.textContent = `${occupancyRate}%`;
        kpiOcupacaoSub.textContent = `Total vagas: ${totalVagas} (Méd: ${(totalVagas / filteredData.length).toFixed(1)}/dia)`;
    }
}

// Atualizar contadores individuais de exames
function updateProcedureCounters() {
    let sumConsultas = 0;
    let sumOci = 0;
    let sumMamografia = 0;
    let sumColposcopia = 0;
    let sumUsgMamaria = 0;
    let sumUsgTrans = 0;
    let sumUsgPelvica = 0;
    let sumPuncao = 0;
    let sumBiopsiaMama = 0;
    let sumBiopsiaColo = 0;
    let sumBiopsiaColoAnatomo = 0;

    filteredData.forEach(r => {
        sumConsultas += Number(r.consultas) || 0;
        sumOci += Number(r.oci_fechadas) || 0;
        sumMamografia += Number(r.mamografia) || 0;
        sumColposcopia += Number(r.colposcopia) || 0;
        sumUsgMamaria += Number(r.usg_mamaria) || 0;
        sumUsgTrans += Number(r.usg_transvaginal) || 0;
        sumUsgPelvica += Number(r.usg_pelvica) || 0;
        sumPuncao += Number(r.puncao_mama) || 0;
        sumBiopsiaMama += Number(r.biopsia_mama) || 0;
        sumBiopsiaColo += Number(r.biopsia_colo) || 0;
        sumBiopsiaColoAnatomo += Number(r.biopsia_colo_anatomopatologico) || 0;
    });

    valConsultas.textContent = sumConsultas;
    valOciFechadas.textContent = sumOci;
    valMamografia.textContent = sumMamografia;
    valColposcopia.textContent = sumColposcopia;
    valUsgMamaria.textContent = sumUsgMamaria;
    valUsgTransvaginal.textContent = sumUsgTrans;
    valUsgPelvica.textContent = sumUsgPelvica;
    valPuncaoMama.textContent = sumPuncao;
    valBiopsiaMama.textContent = sumBiopsiaMama;
    valBiopsiaColo.textContent = sumBiopsiaColo;
    valBiopsiaColoAnatomopatologico.textContent = sumBiopsiaColoAnatomo;
}

// Renderizar Gráficos dinâmicos do Chart.js
function renderCharts() {
    // Destruir instâncias existentes se houver
    if (trendChartInstance) trendChartInstance.destroy();
    if (proceduresChartInstance) proceduresChartInstance.destroy();

    const labels = filteredData.map(r => r.dates);
    
    // Gráfico de Tendência (Fluxo de pacientes)
    const ctxTrend = document.getElementById('trendChart').getContext('2d');
    trendChartInstance = new Chart(ctxTrend, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Agendados',
                    data: filteredData.map(r => Number(r.agendadas) || 0),
                    borderColor: '#0056b3',
                    backgroundColor: 'rgba(0, 86, 179, 0.05)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Atendidos',
                    data: filteredData.map(r => Number(r.atendidas) || 0),
                    borderColor: '#1e7e34',
                    backgroundColor: 'transparent',
                    borderWidth: 3,
                    tension: 0.3
                },
                {
                    label: 'Faltas',
                    data: filteredData.map(r => Number(r.faltaram) || 0),
                    borderColor: '#d32f2f',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#475569', font: { family: 'Outfit', weight: '500' } }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(15, 23, 42, 0.05)' },
                    ticks: { color: '#475569', font: { family: 'Outfit' } }
                },
                y: {
                    grid: { color: 'rgba(15, 23, 42, 0.05)' },
                    ticks: { color: '#475569', font: { family: 'Outfit' } }
                }
            }
        }
    });

    // Calcular somas para o gráfico de procedimentos
    let sumConsultas = 0;
    let sumMamografia = 0;
    let sumUsg = 0;
    let sumColp = 0;
    let sumBiop = 0;

    filteredData.forEach(r => {
        sumConsultas += Number(r.consultas) || 0;
        sumMamografia += Number(r.mamografia) || 0;
        sumUsg += (Number(r.usg_mamaria) || 0) + (Number(r.usg_transvaginal) || 0) + (Number(r.usg_pelvica) || 0);
        sumColp += Number(r.colposcopia) || 0;
        sumBiop += (Number(r.puncao_mama) || 0) + (Number(r.biopsia_mama) || 0) + (Number(r.biopsia_colo) || 0) + (Number(r.biopsia_colo_anatomopatologico) || 0);
    });

    // Gráfico de Pizza/Barra dos Procedimentos
    const ctxProcedures = document.getElementById('proceduresChart').getContext('2d');
    proceduresChartInstance = new Chart(ctxProcedures, {
        type: 'bar',
        data: {
            labels: ['Consultas', 'Mamografias', 'Ultrassons (Todos)', 'Colposcopias', 'Biópsias/Punções'],
            datasets: [{
                label: 'Total Realizado',
                data: [sumConsultas, sumMamografia, sumUsg, sumColp, sumBiop],
                backgroundColor: [
                    'rgba(0, 86, 179, 0.75)',
                    'rgba(0, 141, 165, 0.75)',
                    'rgba(30, 126, 52, 0.75)',
                    'rgba(211, 47, 47, 0.75)',
                    'rgba(197, 160, 89, 0.75)'
                ],
                borderColor: [
                    '#0056b3',
                    '#008da5',
                    '#1e7e34',
                    '#d32f2f',
                    '#c5a059'
                ],
                borderWidth: 1.5,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#475569', font: { family: 'Outfit' } }
                },
                y: {
                    grid: { color: 'rgba(15, 23, 42, 0.05)' },
                    ticks: { color: '#475569', font: { family: 'Outfit' } }
                }
            }
        }
    });
}

// Abertura/Fechamento do Modal
btnOpenModal.addEventListener('click', () => {
    // Limpar formulário ou carregar dados do dia selecionado
    recordForm.reset();
    
    // Se o filtro atual for de uma data específica, pré-carregar os dados dela para facilitar a edição
    if (dateModeSelect.value === 'single' && singleDateSelect.value) {
        const activeDayData = allData.find(r => r.dates === singleDateSelect.value);
        if (activeDayData) {
            formDate.value = toISODate(activeDayData.dates);
            formResponsavel.value = activeDayData.responsavel || '';
            formVagas.value = activeDayData.vagas || '70';
            formAgendadas.value = activeDayData.agendadas || '';
            formAtendidas.value = activeDayData.atendidas || '';
            formFaltaram.value = activeDayData.faltaram || '';
            formConsultas.value = activeDayData.consultas || '';
            formOci.value = activeDayData.oci_fechadas || '';
            formUsgMamaria.value = activeDayData.usg_mamaria || '';
            formUsgTransvaginal.value = activeDayData.usg_transvaginal || '';
            formUsgPelvica.value = activeDayData.usg_pelvica || '';
            formMamografia.value = activeDayData.mamografia || '';
            formColposcopia.value = activeDayData.colposcopia || '';
            formPuncaoMama.value = activeDayData.puncao_mama || '';
            formBiopsiaMama.value = activeDayData.biopsia_mama || '';
            formBiopsiaColo.value = activeDayData.biopsia_colo || '';
            formBiopsiaColoAnatomo.value = activeDayData.biopsia_colo_anatomopatologico || '';
        }
    } else {
        // Data atual por padrão no campo de cadastro se não houver dia selecionado
        const today = new Date();
        formDate.value = today.toISOString().split('T')[0];
        formVagas.value = '70';
    }
    
    recordModal.classList.remove('hide');
});

// Fechar Modal
function closeModal() {
    recordModal.classList.add('hide');
}
btnCloseModal.addEventListener('click', closeModal);
btnCancelModal.addEventListener('click', closeModal);

// Clique fora do modal fecha
window.addEventListener('click', (e) => {
    if (e.target === recordModal) {
        closeModal();
    }
});

// Submissão do Lançamento
recordForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Montar objeto de dados
    const rawDate = formDate.value; // YYYY-MM-DD
    if (!rawDate) return;
    
    const [year, month, day] = rawDate.split('-');
    const formattedDate = `${day}/${month}/${year}`; // DD/MM/YYYY

    const payload = {
        dates: formattedDate,
        responsavel: formResponsavel.value || '',
        vagas: formVagas.value,
        agendadas: formAgendadas.value,
        atendidas: formAtendidas.value,
        faltaram: formFaltaram.value,
        consultas: formConsultas.value,
        oci_fechadas: formOci.value,
        usg_mamaria: formUsgMamaria.value,
        usg_transvaginal: formUsgTransvaginal.value,
        usg_pelvica: formUsgPelvica.value,
        mamografia: formMamografia.value,
        colposcopia: formColposcopia.value,
        puncao_mama: formPuncaoMama.value,
        biopsia_mama: formBiopsiaMama.value,
        biopsia_colo: formBiopsiaColo.value,
        biopsia_colo_anatomopatologico: formBiopsiaColoAnatomo.value
    };

    // Validação matemática simples local: agendadas - atendidas = faltaram?
    const ag = Number(payload.agendadas) || 0;
    const at = Number(payload.atendidas) || 0;
    const fa = Number(payload.faltaram) || 0;
    
    if (ag !== (at + fa)) {
        if (!confirm(`Aviso: O número de Agendados (${ag}) é diferente da soma de Atendidos (${at}) + Faltas (${fa}). Deseja gravar assim mesmo?`)) {
            return;
        }
    }

    try {
        const response = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const res = await response.json();
        
        if (res.success) {
            showToast(res.message, 'success');
            closeModal();
            // Recarregar os dados do backend e selecionar o dia recém inserido/atualizado
            await loadData(formattedDate);
        } else {
            showToast(res.message || 'Erro ao gravar os dados.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Falha na comunicação com o servidor.', 'error');
    }
});

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    loadData();
});

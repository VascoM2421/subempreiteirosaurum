const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let config = null;
let empresaDocsAtual = {};
let trabalhadores = [];
let selecionadoTrabalhadorId = null;
let subempreiteirosAdmin = [];
let credenciaisAlvoId = null;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function toast(mensagem, erro = false) {
  const el = $('#toast');
  el.textContent = mensagem;
  el.className = `toast mostrar${erro ? ' erro' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function confirmarModal(mensagem) {
  return new Promise((resolve) => {
    const overlay = $('#modal-overlay');
    $('#modal-mensagem').textContent = mensagem;
    overlay.hidden = false;
    const limpar = () => {
      overlay.hidden = true;
      btnConfirmar.removeEventListener('click', onConfirmar);
      btnCancelar.removeEventListener('click', onCancelar);
    };
    const btnConfirmar = $('#modal-btn-confirmar');
    const btnCancelar = $('#modal-btn-cancelar');
    const onConfirmar = () => { limpar(); resolve(true); };
    const onCancelar = () => { limpar(); resolve(false); };
    btnConfirmar.addEventListener('click', onConfirmar);
    btnCancelar.addEventListener('click', onCancelar);
  });
}

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, credentials: 'same-origin' });
  let body = null;
  try { body = await res.json(); } catch (e) { /* sem corpo JSON */ }
  if (!res.ok) throw new Error((body && body.erro) || `Erro ${res.status}`);
  return body;
}

function formatarData(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function formatarDataCurta(isoData) {
  if (!isoData) return '';
  const [ano, mes, dia] = isoData.split('-');
  return `${dia}/${mes}/${ano}`;
}
function dataLocalIso(date) {
  const ano = date.getFullYear();
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const dia = String(date.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}
function estadoValidade(dataValidade) {
  if (!dataValidade) return { estado: 'sem_data', dias: null };
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const alvo = new Date(`${dataValidade}T00:00:00`);
  const dias = Math.round((alvo - hoje) / (1000 * 60 * 60 * 24));
  if (dias < 0) return { estado: 'expirado', dias };
  if (dias <= (config ? config.diasAvisoValidade : 30)) return { estado: 'a_expirar', dias };
  return { estado: 'valido', dias };
}
function docPreenchido(docs, docKey) {
  return Boolean(docs && docs[docKey] && docs[docKey].length > 0);
}

// ---------- Cartão de documento (reutilizado para empresa e trabalhador) ----------

const ESTADO_VALIDADE_LABEL = {
  sem_data: '❓ sem data de validade',
  valido: (dias, data) => `✅ válido até ${formatarDataCurta(data)}`,
  a_expirar: (dias, data) => `⚠️ expira em ${dias} dia${dias === 1 ? '' : 's'} (${formatarDataCurta(data)})`,
  expirado: (dias, data) => `❌ expirado desde ${formatarDataCurta(data)} (há ${Math.abs(dias)} dia${Math.abs(dias) === 1 ? '' : 's'})`,
};
function validadeHtml(f) {
  const { estado, dias } = estadoValidade(f.dataValidade);
  const texto = typeof ESTADO_VALIDADE_LABEL[estado] === 'function' ? ESTADO_VALIDADE_LABEL[estado](dias, f.dataValidade) : ESTADO_VALIDADE_LABEL[estado];
  return `
    <div class="doc-ficheiro-validade">
      <span class="validade-tag validade-${estado}">${texto}</span>
      <label class="validade-label">Validade:
        <input type="date" class="input-validade" value="${f.dataValidade || ''}">
      </label>
    </div>
  `;
}

function criarDocCard(tipo, ficheiros, { baseUrl, onDone, comValidade, obrigatorio, accept }) {
  ficheiros = ficheiros || [];
  const card = document.createElement('div');
  card.className = 'doc-card';
  const aceite = accept || '.pdf,.png,.jpg,.jpeg';
  const ehObrigatorio = obrigatorio !== undefined ? obrigatorio : tipo.obrigatorio !== false;
  const opcionalTag = ehObrigatorio ? '' : '<span class="doc-opcional">opcional</span>';

  const listaHtml = ficheiros.length
    ? `<ul class="doc-ficheiros">${ficheiros.map((f) => `
        <li data-file-id="${f.id}">
          <div class="doc-ficheiro-info">
            <span class="doc-ficheiro-nome">✅ ${escapeHtml(f.originalName)}</span>
            <span class="doc-ficheiro-data">Carregado em ${formatarData(f.uploadedAt)}</span>
          </div>
          ${comValidade ? validadeHtml(f) : ''}
          <div class="doc-ficheiro-actions">
            <button type="button" class="btn btn-secondary btn-sm btn-ver">Ver</button>
            <button type="button" class="btn btn-secondary btn-sm btn-download">Descarregar</button>
            <label class="btn btn-secondary btn-sm">
              Substituir
              <input type="file" accept="${aceite}" class="input-substituir">
            </label>
            <button type="button" class="btn btn-danger btn-sm btn-remover">Remover</button>
          </div>
        </li>
      `).join('')}</ul>`
    : `<p class="doc-status falta">Nenhum ficheiro carregado.</p>`;

  card.innerHTML = `
    <div class="doc-card-header">
      <h3>${escapeHtml(tipo.label)}</h3>
      ${opcionalTag}
    </div>
    ${listaHtml}
    <label class="btn btn-primary btn-sm doc-add-btn">
      ${ficheiros.length ? '+ Adicionar outro ficheiro' : 'Carregar ficheiro'}
      <input type="file" accept="${aceite}" class="input-adicionar">
    </label>
  `;

  card.querySelector('.input-adicionar').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      await api(baseUrl, { method: 'POST', body: formData });
      toast('Ficheiro carregado com sucesso.');
      onDone();
    } catch (err) {
      toast(err.message, true);
    }
    e.target.value = '';
  });

  ficheiros.forEach((f) => {
    const li = card.querySelector(`li[data-file-id="${f.id}"]`);
    li.querySelector('.btn-ver').addEventListener('click', () => window.open(`${baseUrl}/${f.id}?inline=1`, '_blank'));
    li.querySelector('.btn-download').addEventListener('click', () => { window.location.href = `${baseUrl}/${f.id}`; });

    const inputValidade = li.querySelector('.input-validade');
    if (inputValidade) {
      inputValidade.addEventListener('blur', async (e) => {
        if (e.target.value === (f.dataValidade || '')) return;
        try {
          await api(`${baseUrl}/${f.id}/validade`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataValidade: e.target.value || null }) });
          toast('Data de validade atualizada.');
          onDone();
        } catch (err) { toast(err.message, true); }
      });
    }

    li.querySelector('.input-substituir').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const confirmado = await confirmarModal(`Substituir o ficheiro "${f.originalName}"?`);
      if (!confirmado) { e.target.value = ''; return; }
      const formData = new FormData();
      formData.append('file', file);
      try {
        await api(`${baseUrl}/${f.id}`, { method: 'POST', body: formData });
        toast('Ficheiro substituído com sucesso.');
        onDone();
      } catch (err) { toast(err.message, true); }
      e.target.value = '';
    });

    li.querySelector('.btn-remover').addEventListener('click', async () => {
      const confirmado = await confirmarModal(`Remover o ficheiro "${f.originalName}"?`);
      if (!confirmado) return;
      try {
        await api(`${baseUrl}/${f.id}`, { method: 'DELETE' });
        toast('Ficheiro removido.');
        onDone();
      } catch (err) { toast(err.message, true); }
    });
  });

  return card;
}

// ---------- Login ----------

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  $('#login-erro').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    await iniciarComoSubempreiteiro();
  } catch (err) {
    $('#login-erro').textContent = err.message;
  }
});


$('#form-login-admin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#login-admin-password').value;
  $('#login-admin-erro').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    await iniciarComoAdmin();
  } catch (err) {
    $('#login-admin-erro').textContent = err.message;
  }
});

$('#btn-sub-logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.reload();
});
$('#btn-admin-logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  window.location.reload();
});

// ---------- Fluxo de troca de password obrigatória ----------

$('#btn-guardar-nova-password').addEventListener('click', async () => {
  const passwordAtual = $('#input-password-atual').value;
  const passwordNova = $('#input-password-nova').value;
  $('#trocar-password-erro').textContent = '';
  try {
    await api('/api/alterar-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passwordAtual, passwordNova }) });
    $('#trocar-password-overlay').hidden = true;
    toast('Password alterada com sucesso.');
  } catch (err) {
    $('#trocar-password-erro').textContent = err.message;
  }
});

// ---------- App do subempreiteiro ----------

async function iniciarComoSubempreiteiro() {
  const eu = await api('/api/eu');
  config = await api('/api/config');
  empresaDocsAtual = eu.docs || {};
  trabalhadores = await api('/api/trabalhadores');

  $('#ecra-login').hidden = true;
  $('#app-admin').hidden = true;
  $('#app-subempreiteiro').hidden = false;
  $('#sub-nome-header').textContent = eu.nome;
  $('#banner-como-admin').hidden = !eu.comoAdmin;

  $('#trocar-password-overlay').hidden = Boolean(eu.passwordAlterada) || Boolean(eu.comoAdmin);

  renderEmpresaDocs();
  renderListaTrabalhadores();
  atualizarBannerSub();
}

async function carregarEmpresaDocs() {
  const eu = await api('/api/eu');
  empresaDocsAtual = eu.docs || {};
  renderEmpresaDocs();
  atualizarBannerSub();
}

function renderEmpresaDocs() {
  const grid = $('#empresa-docs');
  grid.innerHTML = '';
  config.empresaDocs.forEach((tipo) => {
    grid.appendChild(criarDocCard(tipo, empresaDocsAtual[tipo.key], {
      baseUrl: `/api/docs/${tipo.key}`,
      onDone: carregarEmpresaDocs,
      comValidade: config.empresaDocsComValidade.includes(tipo.key),
    }));
  });
}

function coletarDocsFaltantesSub() {
  const faltantes = [];
  config.empresaDocs.forEach((tipo) => {
    if (!docPreenchido(empresaDocsAtual, tipo.key)) faltantes.push(tipo.label);
  });
  const porTrabalhador = [];
  trabalhadores.forEach((t) => {
    const faltam = config.trabalhadorDocs.filter((d) => d.obrigatorio !== false).filter((d) => !docPreenchido(t.docs, d.key)).map((d) => d.label);
    if (faltam.length) porTrabalhador.push(`${t.nome} — ${faltam.join(', ')}`);
  });
  return { faltantes, porTrabalhador };
}

function coletarAvisosValidadeSub() {
  const avisos = [];
  function verificar(docs, comValidadeKeys, docsConfig, nomePessoa) {
    docsConfig.forEach((tipo) => {
      if (!comValidadeKeys.includes(tipo.key)) return;
      const files = (docs && docs[tipo.key]) || [];
      files.forEach((f) => {
        if (!f.dataValidade) return;
        const { estado, dias } = estadoValidade(f.dataValidade);
        if (estado === 'a_expirar' || estado === 'expirado') {
          const label = nomePessoa ? `${nomePessoa} — ${tipo.label}` : tipo.label;
          avisos.push({ label, dias, estado, data: f.dataValidade });
        }
      });
    });
  }
  verificar(empresaDocsAtual, config.empresaDocsComValidade, config.empresaDocs, null);
  trabalhadores.forEach((t) => verificar(t.docs, config.trabalhadorDocsComValidade, config.trabalhadorDocs, t.nome));
  avisos.sort((a, b) => a.dias - b.dias);
  return avisos;
}

function atualizarBannerSub() {
  const banner = $('#banner-validade-sub');
  const { faltantes, porTrabalhador } = coletarDocsFaltantesSub();
  const avisos = coletarAvisosValidadeSub();
  if (!faltantes.length && !porTrabalhador.length && !avisos.length) { banner.hidden = true; return; }
  const blocos = [];
  if (faltantes.length) blocos.push(`<div>❌ <strong>Documentos da empresa em falta:</strong> ${faltantes.map(escapeHtml).join(' &nbsp;•&nbsp; ')}</div>`);
  if (porTrabalhador.length) blocos.push(`<div>❌ <strong>Documentos de trabalhadores em falta:</strong> ${porTrabalhador.map(escapeHtml).join(' &nbsp;•&nbsp; ')}</div>`);
  if (avisos.length) {
    const itens = avisos.map((a) => {
      const desc = a.estado === 'expirado' ? `expirado há ${Math.abs(a.dias)} dia${Math.abs(a.dias) === 1 ? '' : 's'}` : `expira em ${a.dias} dia${a.dias === 1 ? '' : 's'}`;
      return `${escapeHtml(a.label)} (${desc}, ${formatarDataCurta(a.data)})`;
    });
    blocos.push(`<div>⚠️ <strong>Documentos a expirar/expirados:</strong> ${itens.join(' &nbsp;•&nbsp; ')}</div>`);
  }
  banner.innerHTML = blocos.join('');
  banner.hidden = false;
}

// ---------- Trabalhadores ----------

function renderListaTrabalhadores() {
  const ul = $('#lista-trabalhadores');
  ul.innerHTML = '';
  if (!trabalhadores.length) {
    ul.innerHTML = '<li class="estado-vazio" style="cursor:default">Nenhum trabalhador ainda.</li>';
  }
  trabalhadores.forEach((t) => {
    const li = document.createElement('li');
    li.className = t.id === selecionadoTrabalhadorId ? 'selecionado' : '';
    const total = config.trabalhadorDocs.length;
    const preenchidos = config.trabalhadorDocs.filter((d) => docPreenchido(t.docs, d.key)).length;
    li.innerHTML = `<span>${escapeHtml(t.nome)}</span><span class="trabalhador-badge">${preenchidos}/${total}</span>`;
    li.addEventListener('click', () => {
      selecionadoTrabalhadorId = t.id;
      renderListaTrabalhadores();
      renderDetalheTrabalhador();
    });
    ul.appendChild(li);
  });
}

function renderDetalheTrabalhador() {
  const container = $('#trabalhador-detalhe');
  const trabalhador = trabalhadores.find((t) => t.id === selecionadoTrabalhadorId);
  if (!trabalhador) {
    container.innerHTML = '<p class="estado-vazio">Selecione ou adicione um trabalhador para gerir os seus documentos.</p>';
    return;
  }
  container.innerHTML = `
    <div class="trabalhador-detalhe-header">
      <h3>${escapeHtml(trabalhador.nome)}</h3>
      <button class="btn btn-danger btn-sm" id="btn-remover-trabalhador">Remover trabalhador</button>
    </div>
    <div class="docs-grid" id="trabalhador-docs"></div>
  `;
  $('#btn-remover-trabalhador').addEventListener('click', () => removerTrabalhador(trabalhador));
  const grid = $('#trabalhador-docs');
  config.trabalhadorDocs.forEach((tipo) => {
    grid.appendChild(criarDocCard(tipo, trabalhador.docs[tipo.key], {
      baseUrl: `/api/trabalhadores/${trabalhador.id}/docs/${tipo.key}`,
      onDone: carregarTrabalhadores,
      comValidade: config.trabalhadorDocsComValidade.includes(tipo.key),
    }));
  });
}

async function carregarTrabalhadores() {
  trabalhadores = await api('/api/trabalhadores');
  renderListaTrabalhadores();
  if (selecionadoTrabalhadorId) renderDetalheTrabalhador();
  atualizarBannerSub();
}

async function removerTrabalhador(trabalhador) {
  const confirmado = await confirmarModal(`Remover "${trabalhador.nome}" e todos os seus documentos? Esta ação não pode ser desfeita.`);
  if (!confirmado) return;
  try {
    await api(`/api/trabalhadores/${trabalhador.id}`, { method: 'DELETE' });
    selecionadoTrabalhadorId = null;
    toast('Trabalhador removido.');
    await carregarTrabalhadores();
  } catch (err) { toast(err.message, true); }
}

function mostrarFormNovoTrabalhador(mostrar) {
  $('#form-novo-trabalhador').hidden = !mostrar;
  $('#btn-novo-trabalhador').hidden = mostrar;
  if (mostrar) {
    $('#input-novo-trabalhador').value = '';
    $('#input-novo-trabalhador').focus();
  }
}

$('#btn-novo-trabalhador').addEventListener('click', () => mostrarFormNovoTrabalhador(true));
$('#btn-cancelar-novo-trabalhador').addEventListener('click', () => mostrarFormNovoTrabalhador(false));
$('#form-novo-trabalhador').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#input-novo-trabalhador').value.trim();
  if (!nome) { toast('Indica o nome do trabalhador.', true); return; }
  try {
    const novo = await api('/api/trabalhadores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }) });
    mostrarFormNovoTrabalhador(false);
    await carregarTrabalhadores();
    selecionadoTrabalhadorId = novo.id;
    renderListaTrabalhadores();
    renderDetalheTrabalhador();
    toast('Trabalhador adicionado.');
  } catch (err) { toast(err.message, true); }
});

// ---------- Painel de administração ----------

async function iniciarComoAdmin() {
  const lista = await api('/api/admin/subempreiteiros');
  $('#ecra-login').hidden = true;
  $('#app-subempreiteiro').hidden = true;
  $('#app-admin').hidden = false;
  subempreiteirosAdmin = lista;
  renderTabelaAdmin();
}

async function carregarAdmin() {
  subempreiteirosAdmin = await api('/api/admin/subempreiteiros');
  renderTabelaAdmin();
}

// Um formulário com target="_blank" abre sempre num separador novo sem ser bloqueado pelo
// browser (ao contrário de window.open() depois de um pedido assíncrono).
function entrarComoSubempreiteiro(id) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/api/admin/subempreiteiros/${id}/entrar-como`;
  form.target = '_blank';
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function renderTabelaAdmin() {
  const corpo = $('#tabela-subempreiteiros-corpo');
  corpo.innerHTML = '';
  subempreiteirosAdmin.forEach((s) => {
    const tr = document.createElement('tr');
    const faltaResumo = [];
    if (s.faltamEmpresa.length) faltaResumo.push(`Empresa: ${s.faltamEmpresa.join(', ')}`);
    s.trabalhadoresComFalta.forEach((t) => faltaResumo.push(`${t.nome}: ${t.faltam.join(', ')}`));
    tr.innerHTML = `
      <td>${escapeHtml(s.nome)}${s.ativo ? '' : ' <span class="admin-inativo">(inativo)</span>'}</td>
      <td>${s.username ? escapeHtml(s.username) : '<span class="admin-inativo">sem conta</span>'}</td>
      <td>${s.temCredenciais ? (s.passwordAlterada ? '<span class="admin-ok">✅ ativo</span>' : '<span class="admin-falta">⏳ aguarda 1º login</span>') : '<span class="admin-falta">sem credenciais</span>'}</td>
      <td>${s.numTrabalhadores}</td>
      <td>${faltaResumo.length ? `<span class="admin-falta">${faltaResumo.map(escapeHtml).join('<br>')}</span>` : '<span class="admin-ok">✅ completo</span>'}</td>
      <td class="admin-acoes"></td>
    `;
    const acoes = tr.querySelector('.admin-acoes');
    const btnEntrar = document.createElement('button');
    btnEntrar.className = 'btn btn-secondary btn-sm';
    btnEntrar.textContent = 'Entrar como';
    btnEntrar.title = 'Ver e gerir esta conta como se fosses o subempreiteiro';
    btnEntrar.disabled = !s.ativo;
    btnEntrar.addEventListener('click', () => entrarComoSubempreiteiro(s.id));
    acoes.appendChild(btnEntrar);

    const btnCred = document.createElement('button');
    btnCred.style.marginLeft = '6px';
    btnCred.className = 'btn btn-secondary btn-sm';
    btnCred.textContent = s.temCredenciais ? 'Repor password' : 'Definir credenciais';
    btnCred.addEventListener('click', () => abrirModalCredenciais(s));
    acoes.appendChild(btnCred);

    const btnExport = document.createElement('button');
    btnExport.className = 'btn btn-secondary btn-sm';
    btnExport.textContent = 'Descarregar (.zip)';
    btnExport.style.marginLeft = '6px';
    btnExport.addEventListener('click', () => { window.location.href = `/api/admin/subempreiteiros/${s.id}/export`; });
    acoes.appendChild(btnExport);

    const btnAtivo = document.createElement('button');
    btnAtivo.className = 'btn btn-secondary btn-sm';
    btnAtivo.style.marginLeft = '6px';
    btnAtivo.textContent = s.ativo ? 'Desativar' : 'Ativar';
    btnAtivo.addEventListener('click', () => alternarAtivo(s));
    acoes.appendChild(btnAtivo);

    corpo.appendChild(tr);
  });
}

function abrirModalCredenciais(sub) {
  credenciaisAlvoId = sub.id;
  $('#modal-credenciais-titulo').textContent = `Definir credenciais — ${sub.nome}`;
  $('#input-credenciais-username').value = sub.username || sub.nome.toLowerCase().replace(/[^a-z0-9]/g, '');
  $('#input-credenciais-password').value = '';
  $('#modal-credenciais').hidden = false;
}
$('#btn-fechar-credenciais').addEventListener('click', () => { $('#modal-credenciais').hidden = true; });
$('#btn-guardar-credenciais').addEventListener('click', async () => {
  const username = $('#input-credenciais-username').value.trim();
  const password = $('#input-credenciais-password').value;
  try {
    const resultado = await api(`/api/admin/subempreiteiros/${credenciaisAlvoId}/credenciais`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    $('#modal-credenciais').hidden = true;
    toast(`Credenciais definidas — utilizador "${resultado.username}", password "${resultado.password}". Anota e entrega ao subempreiteiro.`);
    await carregarAdmin();
  } catch (err) { toast(err.message, true); }
});

async function alternarAtivo(sub) {
  try {
    await api(`/api/admin/subempreiteiros/${sub.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ativo: !sub.ativo }) });
    await carregarAdmin();
  } catch (err) { toast(err.message, true); }
}

$('#btn-novo-subempreiteiro').addEventListener('click', () => {
  $('#input-novo-subempreiteiro-nome').value = '';
  $('#modal-novo-subempreiteiro').hidden = false;
  $('#input-novo-subempreiteiro-nome').focus();
});
$('#btn-fechar-novo-subempreiteiro').addEventListener('click', () => { $('#modal-novo-subempreiteiro').hidden = true; });
$('#btn-guardar-novo-subempreiteiro').addEventListener('click', async () => {
  const nome = $('#input-novo-subempreiteiro-nome').value.trim();
  if (!nome) { toast('Indica o nome do subempreiteiro.', true); return; }
  try {
    await api('/api/admin/subempreiteiros', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome }) });
    $('#modal-novo-subempreiteiro').hidden = true;
    toast('Subempreiteiro criado. Define agora as credenciais.');
    await carregarAdmin();
  } catch (err) { toast(err.message, true); }
});

// ---------- Arranque ----------

(async function iniciar() {
  const ehPathAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin';

  if (ehPathAdmin) {
    $('#login-normal').hidden = true;
    $('#login-admin-bloco').hidden = false;
    try {
      await iniciarComoAdmin();
      return;
    } catch (e) { /* não autenticado como admin */ }
    $('#ecra-login').hidden = false;
    return;
  }

  try {
    await iniciarComoSubempreiteiro();
    return;
  } catch (e) { /* não autenticado como subempreiteiro */ }
  $('#ecra-login').hidden = false;
})();

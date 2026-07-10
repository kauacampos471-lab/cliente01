/* ==========================================================================
   BS AÇAITERIA — Sistema de Gestão v2 (Firebase + PIN + módulos completos)
   ========================================================================== */

/* ==================== FIREBASE ==================== */
const firebaseConfig = {
  apiKey: "AIzaSyBfHQxqIdxnOqPPntri7vlruzdrtj1fb-4",
  authDomain: "acai01-a9548.firebaseapp.com",
  projectId: "acai01-a9548",
  storageBucket: "acai01-a9548.firebasestorage.app",
  messagingSenderId: "226894833989",
  appId: "1:226894833989:web:cb1cf1b6e73d2e283a762c",
  measurementId: "G-QPSWKDWBRD"
};
firebase.initializeApp(firebaseConfig);
const fdb = firebase.firestore();
fdb.enablePersistence({ synchronizeTabs: true }).catch(() => { /* multi-tab or unsupported, ignore */ });

/* ==================== UTILITÁRIOS ==================== */
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function undoToast(msg, onUndo) {
  const el = document.getElementById('undoToast');
  const text = document.getElementById('undoText');
  const btn = document.getElementById('undoBtn');
  text.textContent = msg;
  el.classList.add('show');
  const cleanup = () => { el.classList.remove('show'); btn.onclick = null; };
  btn.onclick = () => { onUndo(); cleanup(); };
  clearTimeout(undoToast._t);
  undoToast._t = setTimeout(cleanup, 5200);
}
function brl(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/* ==================== MÓDULO: AUTENTICAÇÃO POR PIN ==================== */
const Auth = (() => {
  let currentUser = null; // { nome, pin, role }
  let pinBuffer = '';
  const DEFAULT_OWNER = { nome: 'Dono', pin: '912579', role: 'dono', id: 'default-owner' };

  function getUsers() { return [DEFAULT_OWNER, ...Users.cache]; }

  function updateDots() {
    const dots = document.querySelectorAll('#pinDots span');
    dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
  }

  function showError(msg) {
    const el = document.getElementById('pinError');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 1800);
  }

  function tryLogin() {
    const users = getUsers();
    const found = users.find(u => u.pin === pinBuffer);
    if (found) {
      currentUser = found;
      pinBuffer = '';
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('mainApp').style.display = 'block';
      document.getElementById('userChip').textContent = `${found.nome} · ${found.role === 'dono' ? 'Dono' : 'Atendente'}`;
      Nav.applyRole(found.role);
      Nav.goTo(found.role === 'dono' ? 'entrada' : 'venda');
      toast(`Bem-vindo(a), ${found.nome}! 🍇`);
    } else {
      showError('PIN incorreto.');
      pinBuffer = '';
      updateDots();
    }
  }

  function press(key) {
    if (key === 'clear') { pinBuffer = ''; updateDots(); return; }
    if (key === 'back') { pinBuffer = pinBuffer.slice(0, -1); updateDots(); return; }
    if (pinBuffer.length >= 6) return;
    pinBuffer += key;
    updateDots();
    if (pinBuffer.length >= 4) {
      // tenta login automaticamente a cada dígito a partir de 4
      const users = getUsers();
      if (users.some(u => u.pin === pinBuffer)) tryLogin();
      else if (pinBuffer.length === 6) tryLogin();
    }
  }

  function logout() {
    currentUser = null;
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
    pinBuffer = '';
    updateDots();
  }

  function init() {
    document.querySelectorAll('.pin-key').forEach(btn => {
      btn.addEventListener('click', () => press(btn.dataset.key));
    });
    document.getElementById('logoutBtn').addEventListener('click', logout);
  }

  function getCurrentUser() { return currentUser; }
  function isDono() { return currentUser && currentUser.role === 'dono'; }

  return { init, getCurrentUser, isDono, logout, DEFAULT_OWNER };
})();

/* ==================== MÓDULO: USUÁRIOS (Firestore) ==================== */
const Users = (() => {
  let cache = [];

  function watch() {
    fdb.collection('usuarios').onSnapshot(snap => {
      cache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderList();
    }, () => {});
  }

  function add(nome, pin, role) {
    if (!nome || !/^\d{4,6}$/.test(pin)) { toast('Preencha nome e um PIN de 4 a 6 dígitos.'); return; }
    fdb.collection('usuarios').add({ nome, pin, role, criadoEm: new Date().toISOString() });
    toast('Usuário adicionado ✅');
  }

  function remove(id) {
    fdb.collection('usuarios').doc(id).delete();
    toast('Usuário removido.');
  }

  function renderList() {
    const container = document.getElementById('cfg-user-list');
    if (!container) return;
    container.innerHTML = '';
    const all = [Auth.DEFAULT_OWNER, ...cache];
    all.forEach(u => {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `<span>${u.nome} <span class="user-role-badge">${u.role}</span></span>
        <span>${u.id === 'default-owner' ? '' : `<button class="li-icon-btn danger" data-del="${u.id}">🗑️</button>`}</span>`;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => remove(b.dataset.del)));
  }

  return { watch, add, remove, get cache() { return cache; } };
})();

/* ==================== MÓDULO: BANCO DE DADOS (Firestore + cache local) ==================== */
const DB = (() => {
  const cache = { estoque: [], produtos: [], vendas: [] };
  const pendingDelete = {}; // ids ocultos otimisticamente até confirmação/expiração
  const listeners = [];

  function notify() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }
  function onChange(fn) { listeners.push(fn); }

  function watchCollection(name, key) {
    fdb.collection(name).onSnapshot(snap => {
      cache[key] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      notify();
    }, err => {
      console.error(name, err);
      toast(`⚠️ Erro ao ler "${name}": ${err.code === 'permission-denied' ? 'sem permissão (verifique as Regras do Firestore)' : err.message}`);
    });
  }

  function reportError(action, err) {
    console.error(action, err);
    const msg = err.code === 'permission-denied'
      ? `⚠️ Sem permissão para ${action}. Verifique as Regras do Firestore (aba Regras → Publicar).`
      : `⚠️ Erro ao ${action}: ${err.message}`;
    toast(msg);
  }

  function init() {
    watchCollection('estoque', 'estoque');
    watchCollection('produtos', 'produtos');
    watchCollection('vendas', 'vendas');
  }

  function visible(list) { return list.filter(i => !pendingDelete[i.id]); }

  return {
    onChange,
    init,

    // ----- Estoque -----
    getEstoque: () => visible(cache.estoque).sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm)),
    addEstoqueItem(item) {
      item.criadoEm = new Date().toISOString();
      return fdb.collection('estoque').add(item).catch(err => reportError('salvar item no estoque', err));
    },
    updateEstoqueItem(id, patch) {
      return fdb.collection('estoque').doc(id).update(patch).catch(err => reportError('atualizar estoque', err));
    },
    deleteEstoqueItemWithUndo(id, label) {
      pendingDelete[id] = true; notify();
      const timer = setTimeout(() => {
        fdb.collection('estoque').doc(id).delete().catch(err => reportError('excluir item', err));
        delete pendingDelete[id];
      }, 5000);
      undoToast(`"${label}" excluído.`, () => { clearTimeout(timer); delete pendingDelete[id]; notify(); });
    },
    adjustEstoqueQtd(id, delta) {
      const item = cache.estoque.find(i => i.id === id);
      if (item) {
        const novaQtd = Math.max(0, (parseFloat(item.quantidade) || 0) + delta);
        fdb.collection('estoque').doc(id).update({ quantidade: novaQtd }).catch(err => reportError('baixar estoque', err));
      }
    },

    // ----- Produtos -----
    getProdutos: () => visible(cache.produtos).sort((a, b) => new Date(b.criadoEm) - new Date(a.criadoEm)),
    addProduto(p) {
      p.criadoEm = new Date().toISOString();
      return fdb.collection('produtos').add(p).catch(err => reportError('salvar produto', err));
    },
    updateProduto(id, patch) {
      return fdb.collection('produtos').doc(id).update(patch).catch(err => reportError('atualizar produto', err));
    },
    deleteProdutoWithUndo(id, label) {
      pendingDelete[id] = true; notify();
      const timer = setTimeout(() => {
        fdb.collection('produtos').doc(id).delete().catch(err => reportError('excluir produto', err));
        delete pendingDelete[id];
      }, 5000);
      undoToast(`"${label}" excluído.`, () => { clearTimeout(timer); delete pendingDelete[id]; notify(); });
    },

    // ----- Vendas -----
    getVendas: () => visible(cache.vendas).sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora)),
    addVenda(v) {
      v.dataHora = new Date().toISOString();
      return fdb.collection('vendas').add(v).catch(err => reportError('registrar venda', err));
    },

    // ----- Backup / Restore -----
    exportAll() {
      return {
        exportadoEm: new Date().toISOString(),
        estoque: cache.estoque,
        produtos: cache.produtos,
        vendas: cache.vendas,
        extras: JSON.parse(localStorage.getItem('bs_extras') || '[]'),
        combos: JSON.parse(localStorage.getItem('bs_combos') || '[]')
      };
    },
    async importAll(data) {
      const batchAdd = async (colName, items) => {
        for (const item of (items || [])) {
          const clone = { ...item };
          delete clone.id;
          await fdb.collection(colName).add(clone);
        }
      };
      await batchAdd('estoque', data.estoque);
      await batchAdd('produtos', data.produtos);
      await batchAdd('vendas', data.vendas);
      if (data.extras) localStorage.setItem('bs_extras', JSON.stringify(data.extras));
      if (data.combos) localStorage.setItem('bs_combos', JSON.stringify(data.combos));
    }
  };
})();

/* ==================== NAVEGAÇÃO (com permissões por papel) ==================== */
/* ==================== MÓDULO: PRODUTOS AVULSOS (revenda direta, ex: Coca-Cola) ==================== */
const ProdutosAvulsos = (() => {
  let cache = [];

  function watch() {
    fdb.collection('produtosAvulsos').onSnapshot(snap => {
      cache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (typeof refreshCurrentScreen === 'function') refreshCurrentScreen(currentActiveTab());
    }, () => {});
  }

  function add(estoqueId, preco) {
    const item = DB.getEstoque().find(i => i.id === estoqueId);
    if (!item || !preco || preco <= 0) { toast('Escolha um item do estoque e informe o preço.'); return; }
    const custoUnit = item.quantidade > 0 ? (item.valor / item.quantidade) : 0;
    fdb.collection('produtosAvulsos').add({
      nome: item.nome, preco, estoqueId, custoUnit, criadoEm: new Date().toISOString()
    }).catch(err => toast('Erro ao adicionar produto: ' + err.message));
    toast('Produto avulso adicionado ✅');
  }

  function remove(id) {
    fdb.collection('produtosAvulsos').doc(id).delete();
    toast('Produto removido.');
  }

  return { watch, add, remove, get cache() { return cache; } };
})();

const Nav = (() => {
  function applyRole(role) {
    document.querySelectorAll('[data-role="dono"]').forEach(el => {
      el.style.display = (role === 'dono') ? '' : 'none';
    });
  }

  function goTo(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById('screen-' + tab);
    if (screen) screen.classList.add('active');
    refreshCurrentScreen(tab);
  }

  function init() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => goTo(btn.dataset.tab));
    });
    document.getElementById('settingsBtn').addEventListener('click', () => goTo('config'));
  }

  return { init, applyRole, goTo };
})();

function refreshCurrentScreen(tab) {
  if (tab === 'entrada') { Entrada.render(); Criacao.render(); }
  if (tab === 'venda') PDV.render();
  if (tab === 'estoque') Estoque.render();
  if (tab === 'financeiro') Financeiro.render();
  if (tab === 'historico') Historico.render();
  if (tab === 'config') Users.renderList ? null : null;
}

function currentActiveTab() {
  const active = document.querySelector('.tab-btn.active');
  return active ? active.dataset.tab : 'entrada';
}

/* ==================== MÓDULO 1: ENTRADA DE PRODUTOS ==================== */
const Entrada = (() => {
  function clearForm() {
    ['ent-nome','ent-marca','ent-valor','ent-qtd','ent-tipo','ent-fornecedor','ent-adicional-preco','ent-adicional-porcao'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('ent-unidade').value = 'L';
    document.getElementById('ent-is-adicional').checked = false;
    document.getElementById('ent-adicional-fields').style.display = 'none';
  }

  function add() {
    const nome = document.getElementById('ent-nome').value.trim();
    const marca = document.getElementById('ent-marca').value.trim();
    const valor = parseFloat(document.getElementById('ent-valor').value) || 0;
    const unidade = document.getElementById('ent-unidade').value;
    const qtd = parseFloat(document.getElementById('ent-qtd').value) || 0;
    const tipo = document.getElementById('ent-tipo').value.trim() || 'Matéria-prima';
    const fornecedor = document.getElementById('ent-fornecedor').value.trim();
    const isAdicional = document.getElementById('ent-is-adicional').checked;
    const precoAdicional = parseFloat(document.getElementById('ent-adicional-preco').value) || 0;
    const porcaoQtd = parseFloat(document.getElementById('ent-adicional-porcao').value) || 0;

    if (!nome || qtd <= 0) { toast('Preencha nome e quantidade.'); return; }
    if (isAdicional && (precoAdicional <= 0 || porcaoQtd <= 0)) {
      toast('Informe o preço de venda e a quantidade por porção do adicional.'); return;
    }

    DB.addEstoqueItem({
      nome, marca, valor, unidade, quantidade: qtd, tipo, fornecedor,
      estoqueMax: qtd * 2, estoqueIdeal: qtd,
      isAdicional, precoAdicional: isAdicional ? precoAdicional : 0, porcaoQtd: isAdicional ? porcaoQtd : 0
    });
    clearForm();
    toast('Produto adicionado ao estoque ✅' + (isAdicional ? ' (disponível no Criar copo)' : ''));
  }

  function render(filter = '') {
    const list = DB.getEstoque().filter(i => !filter || i.nome.toLowerCase().includes(filter.toLowerCase()));
    const container = document.getElementById('ent-list');
    container.innerHTML = '';
    if (!list.length) { container.innerHTML = '<div class="empty-note">Nenhum item cadastrado ainda.</div>'; return; }
    list.forEach(item => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `
        <div>
          <div class="li-main">${item.nome} ${item.marca ? '· ' + item.marca : ''}</div>
          <div class="li-sub">${brl(item.valor)} · ${item.quantidade}${item.unidade} · ${item.fornecedor || 'sem fornecedor'}</div>
          <div class="li-sub">${fmtDateTime(item.criadoEm)}</div>
        </div>
        <div class="li-actions">
          <button class="li-icon-btn" data-edit="${item.id}">✏️</button>
          <button class="li-icon-btn danger" data-del="${item.id}" data-label="${item.nome}">🗑️</button>
        </div>`;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      DB.deleteEstoqueItemWithUndo(b.dataset.del, b.dataset.label);
    }));
    container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editItem(b.dataset.edit)));
  }

  function editItem(id) {
    const item = DB.getEstoque().find(i => i.id === id);
    if (!item) return;
    const novoValor = prompt('Novo valor de compra (R$):', item.valor);
    const novaQtd = prompt('Nova quantidade (' + item.unidade + '):', item.quantidade);
    const patch = {};
    if (novoValor !== null) patch.valor = parseFloat(novoValor) || item.valor;
    if (novaQtd !== null) patch.quantidade = parseFloat(novaQtd) || item.quantidade;
    DB.updateEstoqueItem(id, patch);
    toast('Item atualizado.');
  }

  function init() {
    document.getElementById('ent-add').addEventListener('click', add);
    document.getElementById('ent-search').addEventListener('input', e => render(e.target.value));
    document.getElementById('ent-is-adicional').addEventListener('change', e => {
      document.getElementById('ent-adicional-fields').style.display = e.target.checked ? 'flex' : 'none';
    });
  }

  return { init, render };
})();

/* ==================== MÓDULO 2: CRIAÇÃO DE PRODUTOS ==================== */
const Criacao = (() => {
  let recipe = [];

  function refreshIngredientOptions() {
    const sel = document.getElementById('cri-ingrediente');
    const estoque = DB.getEstoque();
    sel.innerHTML = estoque.map(i => `<option value="${i.id}">${i.nome} (${i.unidade})</option>`).join('')
      || '<option value="">Cadastre itens no estoque primeiro</option>';
  }

  function addIngredient() {
    const sel = document.getElementById('cri-ingrediente');
    const qtdInput = document.getElementById('cri-ing-qtd');
    const estoqueId = sel.value;
    const qtd = parseFloat(qtdInput.value);
    if (!estoqueId || !qtd || qtd <= 0) { toast('Escolha um ingrediente e a quantidade.'); return; }
    const item = DB.getEstoque().find(i => i.id === estoqueId);
    if (!item) return;
    const custoUnit = (item.quantidade > 0) ? (item.valor / item.quantidade) : 0;
    recipe.push({ estoqueId, nome: item.nome, qtd, unidade: item.unidade, custoUnit });
    qtdInput.value = '';
    renderRecipe();
  }

  function renderRecipe() {
    const container = document.getElementById('cri-recipe-list');
    container.innerHTML = recipe.map((r, idx) => `
      <div class="recipe-row">
        <span>${r.qtd}${r.unidade} de ${r.nome}</span>
        <button data-idx="${idx}">✕</button>
      </div>`).join('') || '<div class="empty-note">Adicione ingredientes à receita.</div>';
    container.querySelectorAll('button[data-idx]').forEach(b => b.addEventListener('click', () => {
      recipe.splice(parseInt(b.dataset.idx), 1);
      renderRecipe(); updateCostSummary();
    }));
    updateCostSummary();
  }

  function updateCostSummary() {
    const custo = recipe.reduce((sum, r) => sum + (r.qtd * r.custoUnit), 0);
    const preco = parseFloat(document.getElementById('cri-preco').value) || 0;
    const lucro = preco - custo;
    const margem = preco > 0 ? (lucro / preco) * 100 : 0;
    document.getElementById('cri-custo').textContent = brl(custo);
    document.getElementById('cri-lucro').textContent = brl(lucro);
    document.getElementById('cri-margem').textContent = margem.toFixed(1) + '%';
  }

  function clearForm() {
    document.getElementById('cri-nome').value = '';
    document.getElementById('cri-preco').value = '';
    document.getElementById('cri-tamanho').value = '300ml';
    recipe = [];
    renderRecipe();
  }

  function finalize() {
    const nome = document.getElementById('cri-nome').value.trim();
    const preco = parseFloat(document.getElementById('cri-preco').value) || 0;
    const tamanho = document.getElementById('cri-tamanho').value;
    if (!nome || preco <= 0) { toast('Informe nome e preço de venda.'); return; }
    if (!recipe.length) { toast('Adicione ao menos um ingrediente.'); return; }
    const custo = recipe.reduce((sum, r) => sum + (r.qtd * r.custoUnit), 0);
    const lucro = preco - custo;
    const margem = preco > 0 ? (lucro / preco) * 100 : 0;
    DB.addProduto({ nome, preco, tamanho, receita: recipe, custo, lucro, margem, categoria: 'produto' });
    clearForm();
    toast('Produto criado e disponível no PDV ✅');
  }

  function init() {
    document.getElementById('cri-ing-add').addEventListener('click', addIngredient);
    document.getElementById('cri-preco').addEventListener('input', updateCostSummary);
    document.getElementById('cri-del').addEventListener('click', clearForm);
    document.getElementById('cri-add').addEventListener('click', finalize);
    renderRecipe();
  }

  function render() { refreshIngredientOptions(); }

  return { init, render, refreshIngredientOptions };
})();

/* ==================== MÓDULO 3: PDV (VENDA) ==================== */
/* ==================== MÓDULO 3: PDV (VENDA) — v3 ==================== */
const PDV = (() => {
  let order = [];              // lista única (antes: sacola + comanda)
  let currentCat = 'preparado'; // 'preparado' | 'criar' | 'produtos'
  let payment = 'Dinheiro';
  let selectedOrderIndex = -1;

  // builder de "Criar copo"
  let builderSize = null;
  let builderTaps = []; // array de estoqueId, na ordem em que foram tocados

  const SIZES_KEY = 'bs_tamanhos';
  function getSizes() {
    let sizes = JSON.parse(localStorage.getItem(SIZES_KEY) || 'null');
    if (!sizes) {
      sizes = [
        { key: '300ml', label: '300ml', preco: 15 },
        { key: '500ml', label: '500ml', preco: 20 },
        { key: '750ml', label: '750ml', preco: 25 }
      ];
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    }
    return sizes;
  }
  function saveSizes(sizes) { localStorage.setItem(SIZES_KEY, JSON.stringify(sizes)); }

  /* ---------- Renderização: seletor de categoria ---------- */
  function switchView() {
    document.getElementById('pdv-standard-view').style.display = (currentCat === 'criar') ? 'none' : 'block';
    document.getElementById('pdv-builder-view').style.display = (currentCat === 'criar') ? 'block' : 'none';
    const addBtn = document.getElementById('pdv-add-item');
    addBtn.textContent = (currentCat === 'criar') ? '🍇 Adicionar copo' : 'Salvar observação';
  }

  /* ---------- Grade padrão: Copo preparado / Produtos ---------- */
  function renderProductGrid() {
    const grid = document.getElementById('pdv-product-grid');
    const adminRow = document.getElementById('pdv-produtos-admin');
    grid.innerHTML = '';

    if (currentCat === 'preparado') {
      adminRow.style.display = 'none';
      const items = DB.getProdutos();
      if (!items.length) { grid.innerHTML = '<div class="empty-note">Nenhum copo preparado ainda. Crie em "Criação de produto".</div>'; return; }
      items.forEach(p => {
        const inOrder = order.find(o => o.refId === p.id && o.tipo === 'preparado');
        const btn = document.createElement('button');
        btn.className = 'pdv-prod-btn';
        btn.innerHTML = `<span>${p.nome}</span><span>${brl(p.preco)}</span>${inOrder ? `<span class="qty-badge">x${inOrder.qtd}</span>` : ''}`;
        btn.addEventListener('click', () => addPreparado(p));
        grid.appendChild(btn);
      });
      return;
    }

    // currentCat === 'produtos'
    adminRow.style.display = Auth.isDono() ? 'flex' : 'none';
    if (Auth.isDono()) renderAvulsoAdmin();
    const avulsos = ProdutosAvulsos.cache;
    if (!avulsos.length) { grid.innerHTML = '<div class="empty-note">Nenhum produto avulso cadastrado.</div>'; return; }
    avulsos.forEach(av => {
      const inOrder = order.find(o => o.refId === av.id && o.tipo === 'produto-avulso');
      const btn = document.createElement('button');
      btn.className = 'pdv-prod-btn';
      btn.innerHTML = `<span>${av.nome}</span><span>${brl(av.preco)}</span>${inOrder ? `<span class="qty-badge">x${inOrder.qtd}</span>` : ''}`;
      if (Auth.isDono()) {
        const del = document.createElement('button');
        del.className = 'pdv-prod-del';
        del.textContent = '✕';
        del.addEventListener('click', (e) => { e.stopPropagation(); ProdutosAvulsos.remove(av.id); });
        btn.appendChild(del);
      }
      btn.addEventListener('click', () => addAvulso(av));
      grid.appendChild(btn);
    });
  }

  function renderAvulsoAdmin() {
    const sel = document.getElementById('pdv-avulso-estoque');
    sel.innerHTML = DB.getEstoque().map(i => `<option value="${i.id}">${i.nome}</option>`).join('') || '<option value="">Cadastre no estoque primeiro</option>';
  }

  /* ---------- Builder "Criar copo" ---------- */
  function renderSizeToggle() {
    const container = document.getElementById('pdv-size-toggle');
    const sizes = getSizes();
    container.innerHTML = sizes.map(s => `
      <button class="chip ${builderSize === s.key ? 'active' : ''}" data-size="${s.key}">
        ${s.label} · ${brl(s.preco)}${Auth.isDono() ? ' ✏️' : ''}
      </button>`).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        if (Auth.isDono() && confirm(`Editar preço do tamanho ${btn.dataset.size}?`)) {
          const novo = prompt('Novo preço (R$):', sizes.find(s => s.key === btn.dataset.size).preco);
          if (novo !== null && !isNaN(parseFloat(novo))) {
            const idx = sizes.findIndex(s => s.key === btn.dataset.size);
            sizes[idx].preco = parseFloat(novo);
            saveSizes(sizes);
          }
        }
        builderSize = btn.dataset.size;
        renderSizeToggle();
        renderBuilderTotal();
      });
    });
  }

  function renderAdicionaisGrid() {
    const grid = document.getElementById('pdv-adicionais-grid');
    const adicionais = DB.getEstoque().filter(i => i.isAdicional);
    grid.innerHTML = '';
    if (!adicionais.length) { grid.innerHTML = '<div class="empty-note">Cadastre adicionais no Estoque (marque "É um adicional").</div>'; return; }
    adicionais.forEach(a => {
      const count = builderTaps.filter(id => id === a.id).length;
      const btn = document.createElement('button');
      btn.className = 'pdv-prod-btn pdv-adicional-btn' + (count > 0 ? ' selected' : '');
      btn.innerHTML = `<span>${a.nome}</span><span>${brl(a.precoAdicional)}</span>${count > 0 ? `<span class="qty-badge">x${count}</span>` : ''}`;
      btn.addEventListener('click', () => { builderTaps.push(a.id); renderAdicionaisGrid(); renderBuilderTotal(); });
      grid.appendChild(btn);
    });
  }

  function renderBuilderTotal() {
    const sizes = getSizes();
    const base = builderSize ? (sizes.find(s => s.key === builderSize)?.preco || 0) : 0;
    const adicionaisTotal = builderTaps.reduce((sum, id) => {
      const item = DB.getEstoque().find(i => i.id === id);
      return sum + (item ? item.precoAdicional : 0);
    }, 0);
    document.getElementById('pdv-builder-total').textContent = brl(base + adicionaisTotal);
  }

  function commitBuilderCup() {
    if (!builderSize) { toast('Escolha o tamanho do copo primeiro.'); return; }
    const sizes = getSizes();
    const sizeDef = sizes.find(s => s.key === builderSize);
    const nomesAdicionais = builderTaps.map(id => (DB.getEstoque().find(i => i.id === id) || {}).nome).filter(Boolean);
    const adicionaisTotal = builderTaps.reduce((sum, id) => {
      const item = DB.getEstoque().find(i => i.id === id);
      return sum + (item ? item.precoAdicional : 0);
    }, 0);
    const custo = builderTaps.reduce((sum, id) => {
      const item = DB.getEstoque().find(i => i.id === id);
      if (!item) return sum;
      const custoUnit = item.quantidade > 0 ? (item.valor / item.quantidade) : 0;
      return sum + custoUnit * item.porcaoQtd;
    }, 0);
    const composicao = builderTaps.map(id => {
      const item = DB.getEstoque().find(i => i.id === id);
      return { estoqueId: id, porcaoQtd: item ? item.porcaoQtd : 0 };
    });

    order.push({
      refId: 'copo-' + Date.now(), tipo: 'copo-personalizado',
      nome: `Açaí ${sizeDef.label}` + (nomesAdicionais.length ? ' + ' + nomesAdicionais.join(' + ') : ''),
      preco: sizeDef.preco + adicionaisTotal, qtd: 1, obs: '', custo, composicao
    });
    selectedOrderIndex = order.length - 1;
    builderSize = null; builderTaps = [];
    renderSizeToggle(); renderAdicionaisGrid(); renderBuilderTotal();
    syncObsBox();
    renderOrder();
    toast('Copo adicionado ao pedido 🍇');
  }

  /* ---------- Adicionar itens simples ao pedido ---------- */
  function addPreparado(p) {
    const existing = order.find(o => o.refId === p.id && o.tipo === 'preparado');
    if (existing) { existing.qtd++; selectedOrderIndex = order.indexOf(existing); }
    else {
      order.push({
        refId: p.id, tipo: 'preparado', nome: p.nome, preco: p.preco, qtd: 1, obs: '', custo: p.custo || 0,
        composicao: (p.receita || []).map(r => ({ estoqueId: r.estoqueId, porcaoQtd: r.qtd }))
      });
      selectedOrderIndex = order.length - 1;
    }
    syncObsBox();
    renderAll();
  }

  function addAvulso(av) {
    const existing = order.find(o => o.refId === av.id && o.tipo === 'produto-avulso');
    if (existing) { existing.qtd++; selectedOrderIndex = order.indexOf(existing); }
    else {
      order.push({
        refId: av.id, tipo: 'produto-avulso', nome: av.nome, preco: av.preco, qtd: 1, obs: '', custo: av.custoUnit || 0,
        composicao: [{ estoqueId: av.estoqueId, porcaoQtd: 1 }]
      });
      selectedOrderIndex = order.length - 1;
    }
    syncObsBox();
    renderAll();
  }

  function syncObsBox() {
    const box = document.getElementById('pdv-obs');
    box.value = (selectedOrderIndex >= 0 && order[selectedOrderIndex]) ? (order[selectedOrderIndex].obs || '') : '';
  }

  /* ---------- Lista única do pedido ---------- */
  function renderOrder() {
    const container = document.getElementById('pdv-order-list');
    container.innerHTML = '';
    if (!order.length) { container.innerHTML = '<div class="empty-note">Nenhum item no pedido. Toque em um produto.</div>'; return; }
    order.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `
        <div class="order-select" data-select="${idx}" style="cursor:pointer; flex:1;">
          <div class="li-main">${item.nome}</div>
          ${item.obs ? `<div class="li-sub order-item-obs">"${item.obs}"</div>` : ''}
          <div class="li-sub">${brl(item.preco)} cada</div>
        </div>
        <div class="order-stepper">
          <button class="minus" data-minus="${idx}">−</button>
          <span class="li-main">${item.qtd}</span>
          <button class="plus" data-plus="${idx}">+</button>
        </div>`;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-select]').forEach(el => el.addEventListener('click', () => {
      selectedOrderIndex = parseInt(el.dataset.select); syncObsBox();
    }));
    container.querySelectorAll('[data-plus]').forEach(b => b.addEventListener('click', () => { order[b.dataset.plus].qtd++; renderAll(); }));
    container.querySelectorAll('[data-minus]').forEach(b => b.addEventListener('click', () => {
      const i = parseInt(b.dataset.minus); order[i].qtd--;
      if (order[i].qtd <= 0) { order.splice(i, 1); if (selectedOrderIndex >= order.length) selectedOrderIndex = order.length - 1; syncObsBox(); }
      renderAll();
    }));
    renderTotal();
  }

  function getDesconto(total) {
    const tipo = document.getElementById('pdv-desc-tipo').value;
    const val = parseFloat(document.getElementById('pdv-desconto').value) || 0;
    if (val <= 0) return 0;
    return tipo === '%' ? total * (val / 100) : val;
  }

  function renderTotal() {
    const subtotal = order.reduce((s, i) => s + i.preco * i.qtd, 0);
    const desconto = getDesconto(subtotal);
    const total = Math.max(0, subtotal - desconto);
    document.getElementById('pdv-total').textContent = brl(total);
    return { subtotal, desconto, total };
  }

  function renderAll() { renderProductGrid(); renderOrder(); }

  function printReceipt(venda) {
    const area = document.getElementById('printArea');
    const itensHtml = venda.itens.map(i => `
      <div class="p-line"><span>${i.qtd}x ${i.nome}</span><span>${brl(i.preco * i.qtd)}</span></div>
      ${i.obs ? `<div class="p-obs">obs: ${i.obs}</div>` : ''}`).join('');
    area.innerHTML = `
      <h2>BS AÇAITERIA</h2>
      <div class="p-line"><span>${fmtDateTime(venda.dataHora)}</span></div>
      <hr>
      ${itensHtml}
      <hr>
      ${venda.desconto ? `<div class="p-line"><span>Subtotal</span><span>${brl(venda.subtotal)}</span></div><div class="p-line"><span>Desconto</span><span>-${brl(venda.desconto)}</span></div>` : ''}
      <div class="p-line"><b>TOTAL</b><b>${brl(venda.total)}</b></div>
      <div class="p-line"><span>Pagamento</span><span>${venda.formaPagamento}</span></div>
      <hr>
      <p style="text-align:center;">Obrigado pela preferência! 🍇</p>`;
    window.print();
  }

  function finalize() {
    if (!order.length) { toast('Adicione itens antes de finalizar.'); return; }
    const { subtotal, desconto, total } = renderTotal();
    const custoTotal = order.reduce((s, i) => s + (i.custo || 0) * i.qtd, 0);
    const venda = {
      itens: order, subtotal, desconto, total, custoTotal, lucro: total - custoTotal,
      formaPagamento: payment,
      dataHora: new Date().toISOString(),
      atendente: (Auth.getCurrentUser() || {}).nome || 'N/A'
    };
    DB.addVenda(venda);

    order.forEach(item => {
      (item.composicao || []).forEach(c => {
        if (c.estoqueId) DB.adjustEstoqueQtd(c.estoqueId, -(c.porcaoQtd * item.qtd));
      });
    });

    printReceipt(venda);
    order = [];
    selectedOrderIndex = -1;
    document.getElementById('pdv-desconto').value = '';
    document.getElementById('pdv-obs').value = '';
    renderAll();
    toast('Venda finalizada ✅ Estoque e financeiro atualizados.');
  }

  function init() {
    document.getElementById('pdv-cat-toggle').addEventListener('click', e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      document.querySelectorAll('#pdv-cat-toggle .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      currentCat = btn.dataset.cat;
      switchView();
      if (currentCat === 'criar') { renderSizeToggle(); renderAdicionaisGrid(); renderBuilderTotal(); }
      else renderProductGrid();
    });
    document.getElementById('pdv-avulso-add').addEventListener('click', () => {
      const estoqueId = document.getElementById('pdv-avulso-estoque').value;
      const preco = parseFloat(document.getElementById('pdv-avulso-preco').value);
      ProdutosAvulsos.add(estoqueId, preco);
      document.getElementById('pdv-avulso-preco').value = '';
    });
    document.getElementById('pdv-payment').addEventListener('click', e => {
      const btn = e.target.closest('.pay-chip'); if (!btn) return;
      document.querySelectorAll('.pay-chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      payment = btn.dataset.pay;
    });
    document.getElementById('pdv-desconto').addEventListener('input', renderTotal);
    document.getElementById('pdv-desc-tipo').addEventListener('change', renderTotal);
    document.getElementById('pdv-del').addEventListener('click', () => {
      if (currentCat === 'criar') { builderTaps.pop(); renderAdicionaisGrid(); renderBuilderTotal(); return; }
      order.pop(); selectedOrderIndex = order.length - 1; syncObsBox(); renderAll();
    });
    document.getElementById('pdv-add-item').addEventListener('click', () => {
      if (currentCat === 'criar') { commitBuilderCup(); return; }
      if (selectedOrderIndex < 0 || !order[selectedOrderIndex]) { toast('Toque em um item do pedido para selecioná-lo.'); return; }
      order[selectedOrderIndex].obs = document.getElementById('pdv-obs').value.trim();
      renderOrder();
      toast('Observação salva ✅');
    });
    document.getElementById('pdv-finalizar').addEventListener('click', finalize);
    switchView();
  }

  function render() { renderAll(); if (currentCat === 'criar') { renderSizeToggle(); renderAdicionaisGrid(); renderBuilderTotal(); } }

  return { init, render, printReceipt };
})();

/* ==================== MÓDULO 4: ESTOQUE (com alerta crítico) ==================== */
const Estoque = (() => {
  let currentCat = 'Condimento';
  let selectedMonthIdx = 0;
  let alertDismissed = false;

  function statusClass(item) {
    const ideal = item.estoqueIdeal || 1;
    const ratio = item.quantidade / ideal;
    if (ratio >= 0.7) return 'stock-green';
    if (ratio >= 0.3) return 'stock-yellow';
    return 'stock-red';
  }

  function checkAlert() {
    const banner = document.getElementById('alertBanner');
    const criticos = DB.getEstoque().filter(i => statusClass(i) === 'stock-red');
    if (criticos.length && !alertDismissed) {
      document.getElementById('alertText').textContent =
        `⚠️ ${criticos.length} item(ns) com estoque crítico: ${criticos.slice(0,3).map(i => i.nome).join(', ')}${criticos.length > 3 ? '...' : ''}`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  function renderList() {
    const container = document.getElementById('estoque-list');
    const list = DB.getEstoque().filter(i => (i.tipo || '').toLowerCase().includes(currentCat.toLowerCase()) ||
      (currentCat === 'Condimento' && !['matéria-prima','unidade'].includes((i.tipo||'').toLowerCase())));
    container.innerHTML = '';
    if (!list.length) { container.innerHTML = '<div class="empty-note">Nenhum item nesta categoria.</div>'; return; }
    list.forEach(item => {
      const row = document.createElement('div');
      row.className = 'list-item ' + statusClass(item);
      row.innerHTML = `
        <div>
          <div class="li-main">${item.nome}</div>
          <div class="li-sub">Atual: ${item.quantidade}${item.unidade} · Ideal: ${item.estoqueIdeal}${item.unidade} · Máx: ${item.estoqueMax}${item.unidade}</div>
        </div>
        <div class="li-actions">
          <button class="li-icon-btn" data-edit="${item.id}">✏️</button>
        </div>`;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editStock(b.dataset.edit)));
  }

  function editStock(id) {
    const item = DB.getEstoque().find(i => i.id === id);
    if (!item) return;
    const atual = prompt('Estoque atual:', item.quantidade);
    const ideal = prompt('Estoque ideal:', item.estoqueIdeal);
    const max = prompt('Estoque máximo:', item.estoqueMax);
    const patch = {};
    if (atual !== null) patch.quantidade = parseFloat(atual) || item.quantidade;
    if (ideal !== null) patch.estoqueIdeal = parseFloat(ideal) || item.estoqueIdeal;
    if (max !== null) patch.estoqueMax = parseFloat(max) || item.estoqueMax;
    DB.updateEstoqueItem(id, patch);
    toast('Estoque atualizado.');
  }

  function renderChart() {
    const canvas = document.getElementById('estoque-chart');
    const items = DB.getEstoque().slice(0, 6);
    drawBarChart(canvas, items.map(i => i.nome.slice(0, 6)), [
      { data: items.map(i => i.estoqueIdeal || 0), color: '#5b8ef2' },
      { data: items.map(i => i.quantidade || 0), color: '#b98cf2' }
    ]);
  }

  function renderMonths() {
    const container = document.getElementById('estoque-months');
    const meses = getLastMonths();
    container.innerHTML = meses.map((m, idx) =>
      `<button class="month-chip ${idx === selectedMonthIdx ? 'active' : ''}" data-idx="${idx}">${m.label}</button>`).join('');
    container.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { selectedMonthIdx = parseInt(b.dataset.idx); renderMonths(); }));
  }

  function renderCompras() {
    const container = document.getElementById('estoque-compras');
    const list = DB.getEstoque().filter(i => i.quantidade < i.estoqueIdeal);
    container.innerHTML = '';
    if (!list.length) { container.innerHTML = '<div class="empty-note">Estoque em dia — nada a comprar.</div>'; return; }
    list.forEach(item => {
      const necessario = (item.estoqueIdeal - item.quantidade).toFixed(2);
      const row = document.createElement('div');
      row.className = 'list-item ' + statusClass(item);
      row.innerHTML = `<span>${item.nome}</span><span>Atual ${item.quantidade}${item.unidade} · Ideal ${item.estoqueIdeal}${item.unidade} · Comprar ${necessario}${item.unidade}</span>`;
      container.appendChild(row);
    });
  }

  function renderAll() { renderList(); renderChart(); renderMonths(); renderCompras(); checkAlert(); }

  function init() {
    document.getElementById('estoque-cat-toggle').addEventListener('click', e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      document.querySelectorAll('#estoque-cat-toggle .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      currentCat = btn.dataset.cat;
      renderList();
    });
    document.getElementById('alertClose').addEventListener('click', () => {
      alertDismissed = true;
      document.getElementById('alertBanner').style.display = 'none';
    });
  }

  return { init, render: renderAll, checkAlert };
})();

/* ==================== MÓDULO 5: FINANCEIRO ==================== */
const Financeiro = (() => {
  let period = 'dia';
  let selectedSize = '300ml';
  let selectedMonthIdx = -1; // -1 = nenhum mês selecionado (usa período)

  function vendasNoPeriodo() {
    const vendas = DB.getVendas();
    const now = new Date();
    if (selectedMonthIdx >= 0) {
      const meses = getLastMonths();
      const m = meses[selectedMonthIdx];
      return vendas.filter(v => sameMonth(v.dataHora, m.date));
    }
    return vendas.filter(v => {
      const d = new Date(v.dataHora);
      if (period === 'dia') return d.toDateString() === now.toDateString();
      if (period === 'semana') { const diff = (now - d) / 86400000; return diff <= 7; }
      if (period === 'mes') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      return true;
    });
  }

  function renderKpis() {
    const vendas = vendasNoPeriodo();
    const bruta = vendas.reduce((s, v) => s + v.total, 0);
    const liquido = vendas.reduce((s, v) => s + v.lucro, 0);
    document.getElementById('fin-bruta').textContent = brl(bruta);
    document.getElementById('fin-liquido').textContent = brl(liquido);
  }

  function renderChart() {
    const canvas = document.getElementById('fin-chart');
    const vendas = DB.getVendas();
    const meses = getLastMonths(4);
    const labels = meses.map(m => m.label);
    const bruta = meses.map(m => vendas.filter(v => sameMonth(v.dataHora, m.date)).reduce((s, v) => s + v.total, 0));
    const liquido = meses.map(m => vendas.filter(v => sameMonth(v.dataHora, m.date)).reduce((s, v) => s + v.lucro, 0));
    drawBarChart(canvas, labels, [{ data: bruta, color: '#5b8ef2' }, { data: liquido, color: '#b98cf2' }]);
  }

  function renderSizeSummary() {
    const vendas = DB.getVendas();
    const container = document.getElementById('fin-size-summary');
    let qtd = 0, fat = 0, lucro = 0;
    vendas.forEach(v => v.itens.forEach(item => {
      const produto = DB.getProdutos().find(p => p.id === item.refId);
      if (produto && produto.tamanho === selectedSize) {
        qtd += item.qtd; fat += item.preco * item.qtd; lucro += (item.preco - (item.custo||0)) * item.qtd;
      }
    }));
    container.innerHTML = `
      <div class="size-row"><span>Quantidade vendida</span><b>${qtd}</b></div>
      <div class="size-row"><span>Faturamento</span><b>${brl(fat)}</b></div>
      <div class="size-row"><span>Lucro</span><b>${brl(lucro)}</b></div>`;
  }

  function renderMonths() {
    const container = document.getElementById('fin-months');
    const meses = getLastMonths();
    container.innerHTML = meses.map((m, idx) =>
      `<button class="month-chip ${idx === selectedMonthIdx ? 'active' : ''}" data-idx="${idx}">${m.label}</button>`).join('');
    container.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      selectedMonthIdx = (selectedMonthIdx === parseInt(b.dataset.idx)) ? -1 : parseInt(b.dataset.idx);
      renderMonths(); renderKpis();
    }));
  }

  function computeTotals() {
    const vendas = DB.getVendas();
    const totals = {};
    let grandTotal = 0;
    vendas.forEach(v => v.itens.forEach(item => {
      if (!totals[item.nome]) totals[item.nome] = { nome: item.nome, qtd: 0, fat: 0, lucro: 0 };
      totals[item.nome].qtd += item.qtd;
      totals[item.nome].fat += item.preco * item.qtd;
      totals[item.nome].lucro += (item.preco - (item.custo||0)) * item.qtd;
      grandTotal += item.preco * item.qtd;
    }));
    return { totals: Object.values(totals), grandTotal };
  }

  function renderTop() {
    const { totals, grandTotal } = computeTotals();
    const ranked = [...totals].sort((a, b) => b.fat - a.fat).slice(0, 6);
    const container = document.getElementById('fin-top');
    container.innerHTML = '';
    if (!ranked.length) { container.innerHTML = '<div class="empty-note">Nenhuma venda registrada ainda.</div>'; return; }
    ranked.forEach((r, idx) => {
      const pct = grandTotal > 0 ? ((r.fat / grandTotal) * 100).toFixed(1) : 0;
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<span>#${idx+1} ${r.nome} (${r.qtd}x)</span><span>${brl(r.fat)} · ${pct}%</span>`;
      container.appendChild(row);
    });

    const rankedLucro = [...totals].sort((a, b) => b.lucro - a.lucro).slice(0, 6);
    const containerLucro = document.getElementById('fin-top-lucro');
    containerLucro.innerHTML = '';
    if (!rankedLucro.length) { containerLucro.innerHTML = '<div class="empty-note">Sem dados ainda.</div>'; return; }
    rankedLucro.forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<span>#${idx+1} ${r.nome}</span><span>Lucro ${brl(r.lucro)}</span>`;
      containerLucro.appendChild(row);
    });
  }

  function exportPdf() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) { toast('Biblioteca de PDF não carregou. Verifique sua conexão.'); return; }
    const doc = new jsPDF();
    const vendas = vendasNoPeriodo();
    const bruta = vendas.reduce((s, v) => s + v.total, 0);
    const liquido = vendas.reduce((s, v) => s + v.lucro, 0);
    const { totals } = computeTotals();
    const ranked = [...totals].sort((a, b) => b.fat - a.fat).slice(0, 10);

    doc.setFontSize(18); doc.text('BS Açaiteria — Relatório Financeiro', 14, 18);
    doc.setFontSize(10); doc.text('Gerado em ' + fmtDateTime(new Date().toISOString()), 14, 25);
    doc.setFontSize(12);
    doc.text('Venda Bruta: ' + brl(bruta), 14, 38);
    doc.text('Lucro Líquido: ' + brl(liquido), 14, 46);
    doc.text('Total de vendas no período: ' + vendas.length, 14, 54);

    doc.setFontSize(13); doc.text('Top Vendas', 14, 68);
    doc.setFontSize(10);
    let y = 76;
    ranked.forEach((r, idx) => {
      doc.text(`${idx+1}. ${r.nome} — ${r.qtd}x — ${brl(r.fat)} (lucro ${brl(r.lucro)})`, 14, y);
      y += 7;
    });

    doc.save('relatorio-bs-acaiteria.pdf');
    toast('Relatório PDF exportado 📄');
  }

  function renderAll() { renderKpis(); renderChart(); renderSizeSummary(); renderMonths(); renderTop(); }

  function init() {
    document.getElementById('fin-period').addEventListener('click', e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      document.querySelectorAll('#fin-period .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      period = btn.dataset.period;
      selectedMonthIdx = -1;
      renderMonths(); renderKpis();
    });
    document.getElementById('fin-size-toggle').addEventListener('click', e => {
      const btn = e.target.closest('.chip'); if (!btn) return;
      document.querySelectorAll('#fin-size-toggle .chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      selectedSize = btn.dataset.size;
      renderSizeSummary();
    });
    document.getElementById('fin-export-pdf').addEventListener('click', exportPdf);
  }

  return { init, render: renderAll };
})();

/* ==================== MÓDULO 6: HISTÓRICO DE VENDAS ==================== */
const Historico = (() => {
  function renderList() {
    const de = document.getElementById('hist-de').value;
    const ate = document.getElementById('hist-ate').value;
    const pagamento = document.getElementById('hist-pagamento').value;
    let vendas = DB.getVendas();

    if (de) vendas = vendas.filter(v => new Date(v.dataHora) >= new Date(de + 'T00:00:00'));
    if (ate) vendas = vendas.filter(v => new Date(v.dataHora) <= new Date(ate + 'T23:59:59'));
    if (pagamento) vendas = vendas.filter(v => v.formaPagamento === pagamento);

    const container = document.getElementById('hist-list');
    container.innerHTML = '';
    if (!vendas.length) { container.innerHTML = '<div class="empty-note">Nenhuma venda encontrada para esse filtro.</div>'; return; }
    vendas.forEach(v => {
      const itensResumo = v.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ');
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `
        <div>
          <div class="li-main">${brl(v.total)} · ${v.formaPagamento} ${v.atendente ? '· ' + v.atendente : ''}</div>
          <div class="li-sub">${itensResumo}</div>
          <div class="li-sub">${fmtDateTime(v.dataHora)}</div>
        </div>
        <div class="li-actions">
          <button class="li-icon-btn" data-print="${v.id}">🖨️</button>
        </div>`;
      container.appendChild(row);
    });
    container.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
      const venda = DB.getVendas().find(v => v.id === b.dataset.print);
      if (venda) PDV.printReceipt(venda);
    }));
  }

  function init() {
    document.getElementById('hist-filtrar').addEventListener('click', renderList);
  }

  return { init, render: renderList };
})();

/* ==================== MÓDULO 7: CONFIGURAÇÕES (backup + usuários) ==================== */
const Config = (() => {
  function exportBackup() {
    const data = DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-bs-acaiteria-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup exportado ⬇️');
  }

  async function importBackup(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm('Isso vai adicionar os dados do backup ao banco atual (sem apagar o que já existe). Continuar?')) return;
      await DB.importAll(data);
      toast('Backup restaurado ✅');
    } catch (e) {
      toast('Arquivo inválido.');
    }
  }

  function init() {
    document.getElementById('cfg-export').addEventListener('click', exportBackup);
    document.getElementById('cfg-import').addEventListener('click', () => document.getElementById('cfg-import-file').click());
    document.getElementById('cfg-import-file').addEventListener('change', e => {
      if (e.target.files[0]) importBackup(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('cfg-user-add').addEventListener('click', () => {
      const nome = document.getElementById('cfg-user-nome').value.trim();
      const role = document.getElementById('cfg-user-role').value;
      const pin = document.getElementById('cfg-user-pin').value.trim();
      Users.add(nome, pin, role);
      document.getElementById('cfg-user-nome').value = '';
      document.getElementById('cfg-user-pin').value = '';
    });
  }

  return { init };
})();

/* ==================== HELPERS: MESES & GRÁFICO CANVAS ==================== */
function getLastMonths(n = 4) {
  const meses = [];
  const now = new Date();
  const nomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    meses.unshift({ label: nomes[d.getMonth()], date: d });
  }
  return meses.reverse().slice(0, n).reverse();
}
function sameMonth(iso, date) {
  const d = new Date(iso);
  return d.getMonth() === date.getMonth() && d.getFullYear() === date.getFullYear();
}

function drawBarChart(canvas, labels, series) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement.clientWidth - 36;
  const cssHeight = 180;
  canvas.width = cssWidth * dpr; canvas.height = cssHeight * dpr;
  canvas.style.width = cssWidth + 'px'; canvas.style.height = cssHeight + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const allVals = series.flatMap(s => s.data);
  const max = Math.max(1, ...allVals) * 1.15;
  const padding = { top: 10, bottom: 24, left: 6, right: 6 };
  const chartH = cssHeight - padding.top - padding.bottom;
  const groupW = (cssWidth - padding.left - padding.right) / Math.max(1, labels.length);
  const barW = Math.min(18, groupW / (series.length + 1.5));

  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  for (let g = 0; g <= 3; g++) {
    const y = padding.top + chartH - (g / 3) * chartH;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(cssWidth - padding.right, y); ctx.stroke();
  }

  labels.forEach((label, i) => {
    const groupX = padding.left + i * groupW + groupW / 2;
    series.forEach((s, si) => {
      const val = s.data[i] || 0;
      const h = (val / max) * chartH;
      const x = groupX + (si - series.length / 2) * (barW + 4);
      const y = padding.top + chartH - h;
      ctx.fillStyle = s.color;
      roundRect(ctx, x, y, barW, h, 4);
    });
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, groupX, cssHeight - 6);
  });
}
function roundRect(ctx, x, y, w, h, r) {
  if (h <= 0) return;
  r = Math.min(r, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
}

/* ==================== INICIALIZAÇÃO GERAL ==================== */
document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
  Nav.init();
  Entrada.init();
  Criacao.init();
  PDV.init();
  Estoque.init();
  Financeiro.init();
  Historico.init();
  Config.init();

  Users.watch();
  ProdutosAvulsos.watch();

  DB.init();
  DB.onChange(() => {
    Criacao.refreshIngredientOptions();
    refreshCurrentScreen(currentActiveTab());
  });

  // status de sincronização na tela de login
  fdb.collection('estoque').limit(1).get()
    .then(() => { document.getElementById('syncStatus').textContent = '✅ Conectado à nuvem'; })
    .catch((err) => {
      const msg = err.code === 'permission-denied'
        ? '🚫 Sem permissão (publique as Regras do Firestore)'
        : '⚠️ Offline — dados salvos localmente';
      document.getElementById('syncStatus').textContent = msg;
    });

  window.addEventListener('resize', () => {
    if (document.getElementById('mainApp').style.display !== 'none') {
      Estoque.render(); Financeiro.render();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
});

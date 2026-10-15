(function () {
  'use strict';

  const api = window.RshoesApi;
  const esc = window.RshoesAdmin.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : null);

  let coupons = [];
  let products = [];
  let categories = [];
  let deleteTargetId = null;

  const STATUS = {
    active: ['Ativo', 'pill-on'], scheduled: ['Agendado', 'pill-warn'], expired: ['Expirado', 'pill-bad'],
    exhausted: ['Esgotado', 'pill-bad'], paused: ['Pausado', 'pill-off'],
  };

  // datetime-local <-> ISO (horário do navegador do admin)
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  function discountLabel(c) {
    const base = c.discountType === 'percent' ? `${c.discountValue}%` : money(c.discountValue);
    const extra = [];
    if (c.maxDiscount != null) extra.push(`máx. ${money(c.maxDiscount)}`);
    if (c.minOrder > 0) extra.push(`mín. ${money(c.minOrder)}`);
    return `<strong>${base}</strong>${extra.length ? `<div class="muted-sm">${extra.join(' · ')}</div>` : ''}`;
  }
  function validityLabel(c) {
    const a = fmtDate(c.startsAt), b = fmtDate(c.endsAt);
    if (!a && !b) return '<span class="muted-sm">Sem prazo</span>';
    return `<div class="muted-sm">${a ? 'de ' + a : 'desde já'}<br>${b ? 'até ' + b : 'sem fim'}</div>`;
  }
  function scopeLabel(c) {
    if (c.appliesTo === 'products') return `${c.productIds.length} produto(s)`;
    if (c.appliesTo === 'categories') return `${c.categorySlugs.length} categoria(s)`;
    return '';
  }

  function renderSummary(s) {
    $('st-active').textContent = s.active;
    $('st-uses').textContent = s.paidUses;
    $('st-discount').textContent = money(s.discountGiven);
    $('st-revenue').textContent = money(s.revenue);
  }

  function renderRows() {
    const q = $('searchInput').value.trim().toUpperCase();
    const st = $('statusFilter').value;
    const list = coupons.filter((c) => (!q || c.code.includes(q)) && (!st || c.status === st));
    const body = $('couponsBody');
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="6">${coupons.length ? 'Nenhum cupom com esse filtro.' : 'Nenhum cupom criado ainda. Clique em "+ Novo cupom".'}</td></tr>`;
      return;
    }
    body.innerHTML = list.map((c) => {
      const [label, cls] = STATUS[c.status] || ['—', 'pill-off'];
      const uses = `${c.usedCount}${c.usageLimit != null ? ' / ' + c.usageLimit : ''}`;
      return `
      <tr>
        <td><span class="coupon-code">${esc(c.code)}</span>${c.description ? `<div class="muted-sm">${esc(c.description)}</div>` : ''}${scopeLabel(c) ? `<div class="muted-sm">${scopeLabel(c)}</div>` : ''}</td>
        <td>${discountLabel(c)}</td>
        <td>${validityLabel(c)}</td>
        <td>${uses}<div class="muted-sm">${c.paidUses} pago(s) · ${money(c.discountGiven)}</div></td>
        <td><span class="pill ${cls}">${label}</span></td>
        <td class="row-actions">
          <button class="icon-btn" data-edit="${c.id}" title="Editar">✎</button>
          <button class="icon-btn" data-dup="${c.id}" title="Duplicar">⧉</button>
          <button class="icon-btn" data-uses="${c.id}" title="Ver usos">☰</button>
          <button class="icon-btn" data-toggle="${c.id}" title="${c.active ? 'Pausar' : 'Ativar'}">${c.active ? '⏸' : '▶'}</button>
          <button class="icon-btn danger" data-delete="${c.id}" title="Excluir">🗑</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function load() {
    try {
      const data = await api.get('/admin/coupons');
      coupons = data.coupons;
      renderSummary(data.summary);
      renderRows();
    } catch (err) {
      window.RshoesAdmin.toast(err.message, true);
    }
  }

  // ---------- formulário ----------
  function renderPickers(selectedProducts, selectedCats) {
    const sp = new Set(selectedProducts), sc = new Set(selectedCats);
    $('cp-products').innerHTML = products.map((p) =>
      `<label data-name="${esc(p.name.toLowerCase())}"><input type="checkbox" value="${p.id}" ${sp.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<span class="muted-sm">Nenhum produto cadastrado.</span>';
    $('cp-categories').innerHTML = categories.map((c) =>
      `<label><input type="checkbox" value="${esc(c.slug)}" ${sc.has(c.slug) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="muted-sm">Nenhuma categoria cadastrada.</span>';
  }
  function syncForm() {
    const pct = $('cp-type').value === 'percent';
    $('cp-value-label').textContent = pct ? 'Valor do desconto (%)' : 'Valor do desconto (R$)';
    $('cp-max-wrap').style.display = pct ? '' : 'none';
    const ap = $('cp-applies').value;
    $('cp-products-wrap').style.display = ap === 'products' ? '' : 'none';
    $('cp-categories-wrap').style.display = ap === 'categories' ? '' : 'none';
  }
  function randomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint32Array(8);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  }

  function openModal(c, { duplicate = false } = {}) {
    $('couponModalTitle').textContent = c && !duplicate ? 'Editar cupom' : (duplicate ? 'Duplicar cupom' : 'Novo cupom');
    $('cp-id').value = c && !duplicate ? c.id : '';
    $('cp-code').value = c && !duplicate ? c.code : '';
    $('cp-description').value = c ? c.description : '';
    $('cp-type').value = c ? c.discountType : 'percent';
    $('cp-value').value = c ? c.discountValue : '';
    $('cp-max').value = c && c.maxDiscount != null ? c.maxDiscount : '';
    $('cp-min').value = c && c.minOrder ? c.minOrder : '';
    $('cp-start').value = c ? toLocalInput(c.startsAt) : '';
    $('cp-end').value = c ? toLocalInput(c.endsAt) : '';
    $('cp-duration').value = '';
    $('cp-usage').value = c && c.usageLimit != null ? c.usageLimit : '';
    $('cp-per').value = c && c.perCustomerLimit != null ? c.perCustomerLimit : '';
    $('cp-applies').value = c ? c.appliesTo : 'all';
    $('cp-first').checked = c ? c.firstPurchaseOnly : false;
    $('cp-promo').checked = c ? c.allowOnPromo : true;
    $('cp-active').checked = c ? c.active : true;
    $('cp-products-search').value = '';
    renderPickers(c ? c.productIds : [], c ? c.categorySlugs : []);
    syncForm();
    $('couponModalBackdrop').classList.add('open');
    setTimeout(() => $('cp-code').focus(), 50);
  }
  const closeModal = () => $('couponModalBackdrop').classList.remove('open');

  function collect() {
    const checked = (id) => Array.from($(id).querySelectorAll('input:checked')).map((i) => i.value);
    return {
      code: $('cp-code').value.trim(),
      description: $('cp-description').value.trim(),
      discountType: $('cp-type').value,
      discountValue: $('cp-value').value,
      maxDiscount: $('cp-max').value,
      minOrder: $('cp-min').value,
      startsAt: fromLocalInput($('cp-start').value),
      endsAt: fromLocalInput($('cp-end').value),
      usageLimit: $('cp-usage').value,
      perCustomerLimit: $('cp-per').value,
      appliesTo: $('cp-applies').value,
      productIds: checked('cp-products').map(Number),
      categorySlugs: checked('cp-categories'),
      firstPurchaseOnly: $('cp-first').checked,
      allowOnPromo: $('cp-promo').checked,
      active: $('cp-active').checked,
    };
  }

  async function save(e) {
    e.preventDefault();
    const payload = collect();
    // Mesma regra do servidor, para avisar antes de enviar (o servidor valida de novo).
    if (!/^[A-Za-z0-9]{3,32}$/.test(payload.code)) {
      return window.RshoesAdmin.toast('O código deve ter de 3 a 32 caracteres, só letras e números.', true);
    }
    const id = $('cp-id').value;
    const btn = $('couponSaveBtn');
    btn.disabled = true;
    try {
      if (id) await api.put(`/admin/coupons/${id}`, payload);
      else await api.post('/admin/coupons', payload);
      closeModal();
      window.RshoesAdmin.toast('Cupom salvo. Já vale no site.');
      await load();
    } catch (err) {
      window.RshoesAdmin.toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function showUses(id) {
    const c = coupons.find((x) => x.id == id);
    $('usesTitle').textContent = `Usos do cupom ${c ? c.code : ''}`;
    $('usesBody').innerHTML = '<tr><td colspan="6">Carregando...</td></tr>';
    $('usesModalBackdrop').classList.add('open');
    try {
      const { redemptions } = await api.get(`/admin/coupons/${id}/redemptions`);
      const stLabel = { PAID: 'Pago', PENDING: 'Aguardando', EXPIRED: 'Expirado', FAILED: 'Não concluído', ERROR: 'Erro' };
      $('usesBody').innerHTML = redemptions.length ? redemptions.map((r) => `
        <tr>
          <td>#${esc(String(r.orderId).slice(0, 8))}</td>
          <td>${esc(r.customerName)}</td>
          <td>${money(r.discount)}</td>
          <td>${money(r.amount)}</td>
          <td>${esc(stLabel[r.orderStatus] || r.orderStatus || '—')}</td>
          <td>${fmtDate(r.createdAt) || ''}</td>
        </tr>`).join('') : '<tr><td colspan="6">Este cupom ainda não foi usado.</td></tr>';
    } catch (err) {
      $('usesBody').innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`;
    }
  }

  async function toggle(id) {
    const c = coupons.find((x) => x.id == id);
    if (!c) return;
    try {
      await api.patch(`/admin/coupons/${id}/active`, { active: !c.active });
      window.RshoesAdmin.toast(c.active ? 'Cupom pausado.' : 'Cupom ativado.');
      await load();
    } catch (err) { window.RshoesAdmin.toast(err.message, true); }
  }

  async function init() {
    const admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();

    // Produtos e categorias para o "onde o cupom vale".
    try {
      const [p, c] = await Promise.all([api.get('/admin/products'), api.get('/categories')]);
      products = (p.products || []).map((x) => ({ id: x.id, name: x.name }));
      categories = (c.categories || []).map((x) => ({ slug: x.slug, name: x.name }));
    } catch (err) { /* o formulário ainda funciona para "todos os produtos" */ }

    $('newCouponBtn').addEventListener('click', () => openModal(null));
    $('couponCancelBtn').addEventListener('click', closeModal);
    $('couponModalBackdrop').addEventListener('click', (e) => { if (e.target === $('couponModalBackdrop')) closeModal(); });
    $('couponForm').addEventListener('submit', save);
    $('cp-type').addEventListener('change', syncForm);
    $('cp-applies').addEventListener('change', syncForm);
    $('cp-gen').addEventListener('click', () => { $('cp-code').value = randomCode(); });
    $('cp-code').addEventListener('input', () => {
      const c = $('cp-code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if ($('cp-code').value !== c) $('cp-code').value = c;
    });
    $('cp-duration').addEventListener('change', () => {
      const h = Number($('cp-duration').value);
      if (!h) return;
      const start = $('cp-start').value ? new Date($('cp-start').value) : new Date();
      if (!$('cp-start').value) $('cp-start').value = toLocalInput(start.toISOString());
      $('cp-end').value = toLocalInput(new Date(start.getTime() + h * 3600 * 1000).toISOString());
    });
    $('cp-products-search').addEventListener('input', () => {
      const q = $('cp-products-search').value.trim().toLowerCase();
      $('cp-products').querySelectorAll('label').forEach((l) => { l.style.display = !q || (l.dataset.name || '').includes(q) ? '' : 'none'; });
    });

    $('searchInput').addEventListener('input', renderRows);
    $('statusFilter').addEventListener('change', renderRows);
    $('usesCloseBtn').addEventListener('click', () => $('usesModalBackdrop').classList.remove('open'));
    $('usesModalBackdrop').addEventListener('click', (e) => { if (e.target === $('usesModalBackdrop')) $('usesModalBackdrop').classList.remove('open'); });

    $('couponsBody').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-edit],button[data-dup],button[data-uses],button[data-toggle],button[data-delete]');
      if (!b) return;
      const d = b.dataset;
      if (d.edit) openModal(coupons.find((c) => c.id == d.edit));
      else if (d.dup) openModal(coupons.find((c) => c.id == d.dup), { duplicate: true });
      else if (d.uses) showUses(d.uses);
      else if (d.toggle) toggle(d.toggle);
      else if (d.delete) { deleteTargetId = d.delete; $('deleteModalBackdrop').classList.add('open'); }
    });

    $('deleteCancelBtn').addEventListener('click', () => $('deleteModalBackdrop').classList.remove('open'));
    $('deleteConfirmBtn').addEventListener('click', async () => {
      try {
        await api.del(`/admin/coupons/${deleteTargetId}`);
        $('deleteModalBackdrop').classList.remove('open');
        window.RshoesAdmin.toast('Cupom excluído.');
        await load();
      } catch (err) {
        $('deleteModalBackdrop').classList.remove('open');
        window.RshoesAdmin.toast(err.message, true);
      }
    });

    // Atualiza a lista sozinho (usos e status mudam conforme as vendas).
    await load();
    setInterval(() => { if (!document.hidden && !document.querySelector('.modal-backdrop.open')) load(); }, 30000);
  }
  init();
})();

(function () {
  'use strict';

  let products = [];
  let currentImages = [];
  let deleteTargetId = null;
  let searchTerm = '';
  let statusFilter = 'all';

  const esc = window.RshoesAdmin.escapeHtml;
  const modalBackdrop = document.getElementById('productModalBackdrop');
  const deleteBackdrop = document.getElementById('deleteModalBackdrop');

  function money(n) { return Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

  function categoryTagLabel(slug) {
    const found = window.RSHOES_CATEGORY_TAGS.find((c) => c.slug === slug);
    return found ? found.label : slug;
  }

  function renderCategoryTagCheckboxes(selected) {
    const container = document.getElementById('categoryTags');
    const sel = selected || [];
    container.innerHTML = window.RSHOES_CATEGORY_TAGS.map((c) => `
      <label>
        <input type="checkbox" value="${c.slug}" ${sel.includes(c.slug) ? 'checked' : ''}>
        ${esc(c.label)}
      </label>`).join('');
  }

  function getSelectedCategoryTags() {
    return Array.from(document.querySelectorAll('#categoryTags input:checked')).map((el) => el.value);
  }

  function renderImagePreview() {
    const row = document.getElementById('imagePreviewRow');
    row.innerHTML = currentImages.map((url, i) => `
      <div class="image-preview">
        <img src="${url}" alt="Imagem ${i + 1}">
        <button type="button" data-remove="${i}" aria-label="Remover imagem">&times;</button>
      </div>`).join('');
    row.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentImages.splice(Number(btn.dataset.remove), 1);
        renderImagePreview();
      });
    });
  }

  let pendingUploads = 0;
  let saving = false;
  const saveBtn = () => document.getElementById('productSaveBtn');

  function updateSaveBtn() {
    const btn = saveBtn();
    if (!btn) return;
    if (saving) { btn.disabled = true; btn.textContent = 'Salvando…'; }
    else if (pendingUploads > 0) { btn.disabled = true; btn.textContent = 'Enviando fotos…'; }
    else { btn.disabled = false; btn.textContent = 'Salvar produto'; }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Reduz as fotos antes de enviar (menos banda no Supabase e upload mais rápido):
  // máx. 1200px no lado maior (o site mostra no máximo 1080px de largura) e WebP 82%.
  // Se o navegador não gerar WebP, JPEG 82% (PNG com transparência fica como está).
  async function fileToDataUrl(file) {
    const type = (file.type || '').toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(type) || file.size < 150 * 1024) return blobToDataUrl(file);
    try {
      const bitmap = await createImageBitmap(file);
      const max = 1200;
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const toBlob = (t) => new Promise((res) => canvas.toBlob(res, t, 0.82));
      let blob = await toBlob('image/webp');
      if (!blob || blob.type !== 'image/webp') blob = type === 'image/png' ? null : await toBlob('image/jpeg');
      return blob && blob.size < file.size ? blobToDataUrl(blob) : blobToDataUrl(file);
    } catch (e) {
      return blobToDataUrl(file);
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    pendingUploads += files.length;
    updateSaveBtn();
    // Todas as fotos sobem ao mesmo tempo; a ordem escolhida é mantida.
    const results = await Promise.all(files.map(async (file) => {
      try {
        const dataUrl = await fileToDataUrl(file);
        const result = await window.RshoesApi.post('/admin/uploads', { image: dataUrl });
        return result.url;
      } catch (err) {
        window.RshoesAdmin.toast(`Falha ao enviar "${file.name}": ${err.message}`, true);
        return null;
      } finally {
        pendingUploads -= 1;
        updateSaveBtn();
      }
    }));
    results.filter(Boolean).forEach((url) => currentImages.push(url));
    renderImagePreview();
  }

  function openModal(product) {
    document.getElementById('productModalTitle').textContent = product ? 'Editar produto' : 'Novo produto';
    document.getElementById('p-id').value = product ? product.id : '';
    document.getElementById('p-name').value = product ? product.name : '';
    document.getElementById('p-description').value = product ? (product.description || '') : '';
    renderCategoryTagCheckboxes(product ? product.category_tags : []);
    document.getElementById('p-brand').value = product ? product.brand || '' : '';
    document.getElementById('p-price').value = product ? product.price : '';
    document.getElementById('p-promo').value = product && product.promo_price != null ? product.promo_price : '';
    document.getElementById('p-stock').value = product ? product.stock : 0;
    document.getElementById('p-sku').value = product ? product.sku || '' : '';
    document.getElementById('p-sizes').value = product ? (product.sizes || []).join(', ') : '';
    document.getElementById('p-colors').value = product ? (product.colors || []).join(', ') : '';
    document.getElementById('p-tags').value = product ? (product.tags || []).join(', ') : '';
    document.getElementById('p-featured').checked = product ? !!product.featured : false;
    document.getElementById('p-active').checked = product ? !!product.active : true;
    currentImages = product ? [...(product.images || [])] : [];
    renderImagePreview();
    updateSaveBtn();
    modalBackdrop.classList.add('open');
  }
  function closeModal() { modalBackdrop.classList.remove('open'); }

  function splitList(str) {
    return String(str || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  function stateOf(p) {
    return {
      active: !!p.active,
      out: Number(p.stock) <= 0,
      low: Number(p.stock) > 0 && Number(p.stock) <= 3,
    };
  }

  function filteredProducts() {
    let list = products;
    if (statusFilter === 'active') list = list.filter((p) => p.active);
    else if (statusFilter === 'inactive') list = list.filter((p) => !p.active);
    else if (statusFilter === 'out') list = list.filter((p) => stateOf(p).out);
    if (!searchTerm) return list;
    const t = searchTerm.toLowerCase();
    return list.filter((p) => p.name.toLowerCase().includes(t) || (p.brand || '').toLowerCase().includes(t) || (p.sku || '').toLowerCase().includes(t));
  }

  function renderStatusFilters() {
    const box = document.getElementById('statusFilters');
    if (!box) return;
    const counts = {
      all: products.length,
      active: products.filter((p) => p.active).length,
      inactive: products.filter((p) => !p.active).length,
      out: products.filter((p) => stateOf(p).out).length,
    };
    const defs = [['all', 'Todos'], ['active', 'Ativos'], ['inactive', 'Desativados'], ['out', 'Sem estoque']];
    box.innerHTML = defs.map(([k, label]) => `<button type="button" data-filter="${k}" class="${statusFilter === k ? 'on' : ''}">${label}<span class="n">${counts[k]}</span></button>`).join('');
    box.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { statusFilter = b.dataset.filter; renderRows(); }));
  }

  function statusHtml(p) {
    const st = stateOf(p);
    const main = `<button type="button" class="pill ${st.active ? 'pill-on' : 'pill-off'}" data-toggle="${p.id}" title="${st.active ? 'Clique para desativar' : 'Clique para ativar'}">${st.active ? 'Ativo' : 'Desativado'}</button>`;
    const stock = st.out ? '<span class="pill pill-out">Sem estoque</span>' : (st.low ? `<span class="pill pill-low">Restam ${Number(p.stock)}</span>` : '');
    return `<div class="status-cell">${main}${stock}</div>`;
  }

  function renderRows() {
    renderStatusFilters();
    const body = document.getElementById('productsBody');
    const list = filteredProducts();
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="7">Nenhum produto encontrado.</td></tr>';
      return;
    }
    body.innerHTML = list.map((p) => {
      const catLabel = (p.category_tags || []).map(categoryTagLabel).join(', ');
      const img = p.images && p.images[0] ? p.images[0] : '../assets/product-tenis.jpg';
      return `
        <tr class="prod-row${p.active ? '' : ' is-inactive'}">
          <td class="cell-thumb"><img class="thumb" src="${esc(window.thImg ? window.thImg(img, 256) : img)}" alt=""></td>
          <td class="cell-name">${esc(p.name)}${p.featured ? ' ⭐' : ''}</td>
          <td data-label="Categoria">${catLabel ? esc(catLabel) : '—'}</td>
          <td data-label="Preço">${money(p.promo_price != null ? p.promo_price : p.price)}${p.promo_price != null ? ` <span style="color:var(--grey); text-decoration:line-through; font-size:0.78rem;">${money(p.price)}</span>` : ''}</td>
          <td data-label="Estoque">
            <input type="number" inputmode="numeric" min="0" value="${p.stock}" data-stock="${p.id}" class="stock-input" aria-label="Estoque de ${esc(p.name)}">
          </td>
          <td data-label="Status">${statusHtml(p)}</td>
          <td class="row-actions" data-label="Ações">
            <button class="icon-btn" data-edit="${p.id}" title="Editar">✎</button>
            <button class="icon-btn" data-toggle="${p.id}" title="${p.active ? 'Desativar' : 'Ativar'}">${p.active ? '🚫' : '✅'}</button>
            <button class="icon-btn danger" data-delete="${p.id}" title="Excluir">🗑</button>
          </td>
        </tr>`;
    }).join('');

    body.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openModal(products.find((p) => p.id == btn.dataset.edit))));
    body.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => { deleteTargetId = btn.dataset.delete; deleteBackdrop.classList.add('open'); }));
    body.querySelectorAll('[data-toggle]').forEach((btn) => btn.addEventListener('click', async () => {
      const p = products.find((x) => x.id == btn.dataset.toggle);
      if (!p || btn.disabled) return;
      body.querySelectorAll(`[data-toggle="${p.id}"]`).forEach((b) => { b.disabled = true; });
      try {
        const r = await window.RshoesApi.patch(`/admin/products/${p.id}/toggle`);
        p.active = r && typeof r.active === 'boolean' ? (r.active ? 1 : 0) : (p.active ? 0 : 1);
        window.RshoesAdmin.toast(p.active ? 'Produto ativado.' : 'Produto desativado.');
      } catch (err) { window.RshoesAdmin.toast(err.message, true); }
      renderRows();
    }));
    body.querySelectorAll('[data-stock]').forEach((input) => input.addEventListener('change', async () => {
      const p = products.find((x) => x.id == input.dataset.stock);
      if (!p) return;
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < 0) { window.RshoesAdmin.toast('Estoque deve ser um número inteiro maior ou igual a zero.', true); input.value = p.stock; return; }
      try {
        await window.RshoesApi.patch(`/admin/products/${p.id}/stock`, { stock: value });
        p.stock = value;
        window.RshoesAdmin.toast(value === 0 ? 'Estoque zerado: produto marcado como sem estoque.' : 'Estoque atualizado.');
      } catch (err) { window.RshoesAdmin.toast(err.message, true); input.value = p.stock; }
      renderRows();
    }));
  }

  async function load() {
    try {
      const prodData = await window.RshoesApi.get('/admin/products');
      products = prodData.products;
      renderRows();
    } catch (err) {
      window.RshoesAdmin.toast(err.message, true);
    }
  }

  async function init() {
    const admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();

    document.getElementById('adminSearch').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); renderRows(); });
    document.getElementById('newProductBtn').addEventListener('click', () => openModal(null));
    document.getElementById('productCancelBtn').addEventListener('click', closeModal);
    modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

    const imageDrop = document.getElementById('imageDrop');
    const imageInput = document.getElementById('imageInput');
    imageDrop.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => { handleFiles(e.target.files); imageInput.value = ''; });
    imageDrop.addEventListener('dragover', (e) => { e.preventDefault(); imageDrop.style.borderColor = 'var(--gold)'; });
    imageDrop.addEventListener('dragleave', () => { imageDrop.style.borderColor = ''; });
    imageDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      imageDrop.style.borderColor = '';
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    document.getElementById('productForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving || pendingUploads > 0) return; // evita salvar 2x/3x o mesmo produto
      const id = document.getElementById('p-id').value;
      const payload = {
        name: document.getElementById('p-name').value.trim(),
        description: document.getElementById('p-description').value.trim(),
        category_tags: getSelectedCategoryTags(),
        brand: document.getElementById('p-brand').value.trim(),
        price: Number(document.getElementById('p-price').value),
        promo_price: document.getElementById('p-promo').value === '' ? null : Number(document.getElementById('p-promo').value),
        stock: Number(document.getElementById('p-stock').value) || 0,
        sku: document.getElementById('p-sku').value.trim() || null,
        sizes: splitList(document.getElementById('p-sizes').value),
        colors: splitList(document.getElementById('p-colors').value),
        tags: splitList(document.getElementById('p-tags').value),
        images: currentImages,
        featured: document.getElementById('p-featured').checked,
        active: document.getElementById('p-active').checked,
      };
      saving = true;
      updateSaveBtn();
      try {
        if (id) await window.RshoesApi.put(`/admin/products/${id}`, payload);
        else await window.RshoesApi.post('/admin/products', payload);
        closeModal();
        window.RshoesAdmin.toast('Produto salvo com sucesso.');
        load();
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      } finally {
        saving = false;
        updateSaveBtn();
      }
    });

    document.getElementById('deleteCancelBtn').addEventListener('click', () => { deleteBackdrop.classList.remove('open'); deleteTargetId = null; });
    document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
      if (!deleteTargetId) return;
      try {
        await window.RshoesApi.del(`/admin/products/${deleteTargetId}`);
        window.RshoesAdmin.toast('Produto excluído.');
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      } finally {
        deleteBackdrop.classList.remove('open');
        deleteTargetId = null;
        load();
      }
    });

    load();
  }

  init();
})();

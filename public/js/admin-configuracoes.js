(function () {
  'use strict';
  const api = window.RshoesApi;
  const $ = (id) => document.getElementById(id);

  function fill(s) {
    $('k-open').checked = !!s.checkout.salesOpen;
    $('k-closed').value = s.checkout.closedMessage || '';
    $('k-min').value = s.checkout.minOrder || '';
    $('k-max').value = s.checkout.maxQuantity;
    $('k-notice').value = s.checkout.notice || '';
    $('k-coupons').checked = !!s.checkout.couponsEnabled;
    fillCard(s.card);
    $('l-points').value = s.loyalty.pointsPerReal == null ? '' : s.loyalty.pointsPerReal;
    $('a-active').checked = !!s.announcement.active;
    $('a-text').value = s.announcement.text || '';
    $('a-link').value = s.announcement.link || '';
    $('a-bg').value = s.announcement.bgColor;
    $('a-fg').value = s.announcement.textColor;
    $('c-wa').value = s.contact.whatsapp || '';
    $('c-ig').value = s.contact.instagram ? '@' + s.contact.instagram : '';
    $('c-mail').value = s.contact.email || '';
    $('c-hours').value = s.contact.hours || '';
    $('s-name').value = s.store.name || '';
    $('s-tag').value = s.store.tagline || '';
    $('s-title').value = s.seo.homeTitle || '';
    $('s-desc').value = s.seo.homeDescription || '';
    colorHints();
  }
  function buildRates() {
    const box = $('cd-rates');
    for (let n = 1; n <= 12; n++) {
      const d = document.createElement('div');
      d.className = 'form-field';
      d.innerHTML = '<label for="cd-r' + n + '">' + n + 'x (%)</label><input type="number" id="cd-r' + n + '" min="0" max="50" step="0.01" inputmode="decimal">';
      box.appendChild(d);
    }
  }
  function fillCard(c) {
    if (!c) return;
    $('cd-enabled').checked = !!c.enabled;
    $('cd-credit').checked = !!c.credit;
    $('cd-debit').checked = !!c.debit;
    $('cd-max').value = c.maxInstallments;
    $('cd-min').value = c.minInstallment;
    $('cd-debitfee').value = c.debitFee;
    for (let n = 1; n <= 12; n++) $('cd-r' + n).value = c.rates[n - 1];
  }
  function collectCard() {
    const rates = [];
    for (let n = 1; n <= 12; n++) rates.push($('cd-r' + n).value === '' ? 0 : $('cd-r' + n).value);
    return {
      enabled: $('cd-enabled').checked, credit: $('cd-credit').checked, debit: $('cd-debit').checked,
      maxInstallments: $('cd-max').value, minInstallment: $('cd-min').value === '' ? 0 : $('cd-min').value,
      debitFee: $('cd-debitfee').value === '' ? 0 : $('cd-debitfee').value, rates,
    };
  }
  function colorHints() { $('a-bg-v').textContent = $('a-bg').value; $('a-fg-v').textContent = $('a-fg').value; }

  function collect() {
    return {
      checkout: {
        salesOpen: $('k-open').checked,
        closedMessage: $('k-closed').value,
        minOrder: $('k-min').value === '' ? 0 : $('k-min').value,
        maxQuantity: $('k-max').value,
        notice: $('k-notice').value,
        couponsEnabled: $('k-coupons').checked,
      },
      card: collectCard(),
      loyalty: { pointsPerReal: $('l-points').value === '' ? null : $('l-points').value },
      announcement: {
        active: $('a-active').checked, text: $('a-text').value, link: $('a-link').value,
        bgColor: $('a-bg').value, textColor: $('a-fg').value,
      },
      contact: { whatsapp: $('c-wa').value, instagram: $('c-ig').value, email: $('c-mail').value, hours: $('c-hours').value },
      store: { name: $('s-name').value, tagline: $('s-tag').value },
      seo: { homeTitle: $('s-title').value, homeDescription: $('s-desc').value },
    };
  }

  async function init() {
    const admin = await window.RshoesAdmin.guard();
    if (!admin) return;
    window.RshoesAdmin.bindLogout();
    buildRates();
    try {
      const { settings } = await api.get('/admin/settings/site');
      fill(settings);
    } catch (err) { window.RshoesAdmin.toast(err.message, true); }

    $('a-bg').addEventListener('input', colorHints);
    $('a-fg').addEventListener('input', colorHints);

    $('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('saveBtn');
      btn.disabled = true;
      try {
        const { settings } = await api.put('/admin/settings/site', collect());
        fill(settings); // mostra o que o servidor realmente guardou (valores inválidos são ajustados)
        window.RshoesAdmin.toast('Configurações salvas. Já valem no site.');
      } catch (err) {
        window.RshoesAdmin.toast(err.message, true);
      } finally { btn.disabled = false; }
    });
  }
  init();
})();

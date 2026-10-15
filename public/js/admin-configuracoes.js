(function () {
  'use strict';
  const api = window.RshoesApi;
  const $ = (id) => document.getElementById(id);

  function fill(s) {
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
  function colorHints() { $('a-bg-v').textContent = $('a-bg').value; $('a-fg-v').textContent = $('a-fg').value; }

  function collect() {
    return {
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

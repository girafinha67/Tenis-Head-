/* Configurações gerais da loja (editadas no painel, aba "Configurações").
   Buscadas a cada visita (sem cache) e aplicadas no site: rodapé, contato, SEO da home,
   aviso global e regras exibidas no checkout. Se a busca falhar, o site segue com o texto padrão.
   Expõe window.TNSiteReady (Promise) para o checkout. */
(function () {
  'use strict';
  var ready = fetch('/api/settings/site', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });
  window.TNSiteReady = ready;
  ready.then(function (cfg) {
    if (!cfg) return;
    try { applyFooter(cfg); } catch (e) {}
    try { applySeo(cfg); } catch (e) {}
    try { applyAnnouncement(cfg); } catch (e) {}
  });

  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function applyFooter(cfg) {
    var f = q('.site-footer');
    if (!f) return;
    var s = cfg.store || {}, c = cfg.contact || {};
    var brand = q('.f-brand p', f);
    if (brand && s.tagline) brand.textContent = s.tagline;

    var bottom = qa('.f-bottom span', f)[0];
    if (bottom && s.name) bottom.textContent = '© ' + new Date().getFullYear() + ' ' + s.name + '. Todos os direitos reservados.';

    // Instagram: troca o destino dos links existentes (ou remove se o campo ficou vazio).
    qa('a[href*="instagram.com"]:not([data-fixed-link])', f).forEach(function (a) {
      if (c.instagram) a.href = 'https://instagram.com/' + c.instagram;
      else if (a.parentNode) a.parentNode.style.display = 'none';
    });

    // Atendimento: WhatsApp, e-mail e horário, quando preenchidos.
    var heads = qa('h4', f).filter(function (h) { return /atendimento/i.test(h.textContent); });
    var ul = heads[0] && heads[0].parentNode.querySelector('ul');
    if (ul) {
      var add = function (html, isHtml) {
        var li = document.createElement('li');
        if (isHtml) li.appendChild(html); else li.textContent = html;
        ul.insertBefore(li, ul.firstChild);
      };
      var items = [];
      if (c.hours) items.push(['Horário: ' + c.hours, false]);
      if (c.email) { var m = document.createElement('a'); m.href = 'mailto:' + c.email; m.textContent = c.email; items.push([m, true]); }
      if (c.whatsapp) {
        var num = c.whatsapp.length <= 11 ? '55' + c.whatsapp : c.whatsapp;
        var zap = q('[data-whatsapp]', f);
        if (zap) zap.href = 'https://wa.me/' + num;
        else {
          var w = document.createElement('a');
          w.href = 'https://wa.me/' + num; w.target = '_blank'; w.rel = 'noopener'; w.textContent = 'WhatsApp';
          items.push([w, true]);
        }
      }
      items.reverse().forEach(function (it) { add(it[0], it[1]); });
    }
  }

  function applySeo(cfg) {
    var path = location.pathname.replace(/\/+$/, '');
    if (path !== '' && path !== 'index.html') return;
    var seo = cfg.seo || {};
    if (seo.homeTitle) document.title = seo.homeTitle;
    if (seo.homeDescription) {
      var m = q('meta[name="description"]');
      if (!m) { m = document.createElement('meta'); m.name = 'description'; document.head.appendChild(m); }
      m.setAttribute('content', seo.homeDescription);
    }
  }

  function applyAnnouncement(cfg) {
    var a = cfg.announcement;
    if (!a || !a.active || !a.text) return;
    var key = 'tenishead-ann-' + a.text.length + '-' + a.text.slice(0, 12);
    try { if (sessionStorage.getItem(key)) return; } catch (e) {}
    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:relative;z-index:60;text-align:center;font:500 .85rem Inter,sans-serif;padding:9px 40px;background:' + a.bgColor + ';color:' + a.textColor;
    var span;
    if (a.link) { span = document.createElement('a'); span.href = a.link; span.style.cssText = 'color:inherit;text-decoration:underline'; }
    else span = document.createElement('span');
    span.textContent = a.text;
    bar.appendChild(span);
    var x = document.createElement('button');
    x.type = 'button'; x.setAttribute('aria-label', 'Fechar aviso'); x.textContent = '×';
    x.style.cssText = 'position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:inherit;font-size:1.2rem;cursor:pointer;width:auto;margin:0;padding:4px 8px';
    x.addEventListener('click', function () { bar.remove(); try { sessionStorage.setItem(key, '1'); } catch (e) {} });
    bar.appendChild(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }
})();

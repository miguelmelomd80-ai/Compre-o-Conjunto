/*!
 * Compre o Conjunto — script da vitrine Nuvemshop
 * Mostra, na página do produto, as peças do conjunto com escolha de variação
 * e adiciona todas ao carrinho com um clique.
 */
(function () {
  'use strict';
  var API_BASE = '__API_BASE__';
  if (window.__compreOConjunto) return;
  window.__compreOConjunto = true;

  var LS = window.LS || {};

  function getProductId() {
    if (LS.product && LS.product.id) return LS.product.id;
    var input = document.querySelector('#product_form input[name="add_to_cart"], .js-product-form input[name="add_to_cart"]');
    return input ? input.value : null;
  }
  function getStoreId() { return LS.store && LS.store.id; }

  var currency = (LS.currency && LS.currency.code) || 'BRL';
  function money(v) {
    try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency }).format(v); }
    catch (e) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) { return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  // Converte URL absoluta do produto em caminho do domínio atual (evita CORS com domínio próprio)
  function samePath(url) {
    try { var u = new URL(url, location.origin); return u.pathname + u.search; } catch (e) { return url; }
  }

  // ---------- Estilos ----------
  function injectCss(s) {
    var css = '' +
      '.cdc{margin:24px 0;padding:16px;border:1px solid rgba(0,0,0,.12);border-radius:10px;font-family:inherit;color:inherit;text-align:left}' +
      '.cdc h3{margin:0 0 12px;font-size:1.1em;font-weight:600}' +
      '.cdc-item{display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid rgba(0,0,0,.08)}' +
      '.cdc-item:first-of-type{border-top:0}' +
      '.cdc-item.cdc-off{opacity:.5}' +
      '.cdc-item input[type=checkbox]{width:18px;height:18px;flex:none;accent-color:' + s.primary_color + '}' +
      '.cdc-img{width:64px;height:64px;flex:none;object-fit:cover;border-radius:6px;background:#f2f2f2}' +
      '.cdc-info{flex:1;min-width:0}' +
      '.cdc-name{display:block;font-size:.95em;line-height:1.3;color:inherit;text-decoration:none;margin-bottom:4px}' +
      '.cdc-price{font-weight:600;font-size:.95em}' +
      '.cdc-price s{font-weight:400;opacity:.6;margin-right:6px;font-size:.9em}' +
      '.cdc select{margin-top:6px;width:100%;max-width:260px;padding:6px 8px;border:1px solid rgba(0,0,0,.25);border-radius:6px;font:inherit;font-size:.9em;background:#fff;color:#222}' +
      '.cdc select.cdc-need{border-color:#d92d20;box-shadow:0 0 0 2px rgba(217,45,32,.15)}' +
      '.cdc-total{display:flex;justify-content:space-between;align-items:center;margin:14px 0 10px;font-size:1em}' +
      '.cdc-total strong{font-size:1.15em}' +
      '.cdc-btn{display:block;width:100%;padding:14px 16px;border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:600;font-size:1em;' +
      'background:' + s.primary_color + ';color:' + s.text_color + '}' +
      '.cdc-btn[disabled]{opacity:.6;cursor:wait}' +
      '.cdc-msg{margin-top:8px;font-size:.9em;min-height:1em}' +
      '.cdc-msg.cdc-err{color:#d92d20}' +
      '.cdc-soldout{font-size:.85em;color:#d92d20}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ---------- Renderização ----------
  function variantLabel(v) { return v.values.join(' / ') || 'Único'; }
  function hasChoice(p) { return p.variants.length > 1; }

  function renderSet(set, settings, currentId) {
    var box = document.createElement('div');
    box.className = 'cdc';
    box.setAttribute('data-cdc-set', set.id);
    var html = '<h3>' + esc(set.title) + '</h3>';
    set.products.forEach(function (p, i) {
      var available = p.variants.some(function (v) { return v.available; });
      var only = p.variants.length === 1 ? p.variants[0] : null;
      html += '<div class="cdc-item' + (available ? '' : ' cdc-off') + '" data-i="' + i + '">' +
        '<input type="checkbox" ' + (available ? 'checked' : 'disabled') + ' aria-label="Incluir ' + esc(p.name) + '">' +
        (p.image ? '<img class="cdc-img" src="' + esc(p.image) + '" alt="" loading="lazy">' : '<span class="cdc-img"></span>') +
        '<div class="cdc-info">' +
        (String(p.id) === String(currentId)
          ? '<span class="cdc-name">' + esc(p.name) + '</span>'
          : '<a class="cdc-name" href="' + esc(samePath(p.url)) + '">' + esc(p.name) + '</a>') +
        '<div class="cdc-price"></div>' +
        (!available ? '<div class="cdc-soldout">Esgotado</div>' : '') +
        (available && hasChoice(p)
          ? '<select aria-label="Escolha a variação de ' + esc(p.name) + '"><option value="">Selecione ' +
            esc((p.attributes || []).join(' / ').toLowerCase() || 'a opção') + '</option>' +
            p.variants.map(function (v) {
              return '<option value="' + v.id + '"' + (v.available ? '' : ' disabled') + '>' +
                esc(variantLabel(v)) + (v.available ? '' : ' (esgotado)') + '</option>';
            }).join('') + '</select>'
          : '') +
        '</div></div>';
      p._only = only;
    });
    html += '<div class="cdc-total"><span>Total do conjunto</span><strong></strong></div>' +
      '<button type="button" class="cdc-btn">' + esc(settings.button_text) + '</button>' +
      '<div class="cdc-msg" role="status" aria-live="polite"></div>';
    box.innerHTML = html;

    var items = box.querySelectorAll('.cdc-item');

    function chosenVariant(p, el) {
      if (p._only) return p._only.available ? p._only : null;
      var sel = el.querySelector('select');
      var id = sel && sel.value;
      return id ? p.variants.filter(function (v) { return String(v.id) === id; })[0] : null;
    }
    function priceRange(p) {
      var av = p.variants.filter(function (v) { return v.available; });
      var list = (av.length ? av : p.variants);
      return list.reduce(function (m, v) { return v.price < m.price ? v : m; }, list[0]);
    }
    function update() {
      var total = 0;
      set.products.forEach(function (p, i) {
        var el = items[i];
        var v = chosenVariant(p, el) || priceRange(p);
        el.querySelector('.cdc-price').innerHTML =
          (v.compare_at_price ? '<s>' + money(v.compare_at_price) + '</s>' : '') + money(v.price);
        if (el.querySelector('input').checked) total += v.price;
      });
      box.querySelector('.cdc-total strong').textContent = money(total);
    }
    box.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') e.target.classList.remove('cdc-need');
      update();
    });
    update();

    var btn = box.querySelector('.cdc-btn');
    var msg = box.querySelector('.cdc-msg');
    btn.addEventListener('click', function () {
      msg.className = 'cdc-msg';
      msg.textContent = '';
      var picks = [], missing = false;
      set.products.forEach(function (p, i) {
        var el = items[i];
        if (!el.querySelector('input').checked) return;
        var v = chosenVariant(p, el);
        if (!v) { missing = true; var s = el.querySelector('select'); if (s) s.classList.add('cdc-need'); return; }
        picks.push({ product: p, variant: v });
      });
      if (missing) { msg.className = 'cdc-msg cdc-err'; msg.textContent = 'Escolha a opção de cada peça marcada.'; return; }
      if (!picks.length) { msg.className = 'cdc-msg cdc-err'; msg.textContent = 'Marque pelo menos uma peça.'; return; }

      btn.disabled = true;
      var original = btn.textContent;
      btn.textContent = 'Adicionando…';
      var ok = 0, failed = [], cartUrl = null;
      picks.reduce(function (chain, pick) {
        return chain.then(function () {
          return addToCart(pick.product, pick.variant).then(function (url) { ok++; cartUrl = cartUrl || url; })
            .catch(function (err) { console.warn('[Compre o Conjunto]', err); failed.push(pick.product.name); });
        });
      }, Promise.resolve()).then(function () {
        btn.disabled = false;
        btn.textContent = original;
        if (failed.length) {
          msg.className = 'cdc-msg cdc-err';
          msg.textContent = (ok ? ok + ' peça(s) adicionada(s). ' : '') + 'Não foi possível adicionar: ' + failed.join(', ') + '.';
          if (!ok) return;
        }
        msg.textContent = msg.textContent || 'Conjunto adicionado ao carrinho!';
        setTimeout(function () {
          if (settings.after_add === 'reload') location.reload();
          else location.href = cartUrl || '/comprar/';
        }, failed.length ? 2500 : 400);
      });
    });
    return box;
  }

  // ---------- Carrinho ----------
  // Usa o mesmo formulário de compra do tema: busca a página do produto, preenche as
  // variações e envia para /comprar/. Assim funciona em qualquer tema da Nuvemshop.
  function addToCart(product, variant) {
    return fetch(samePath(product.url), { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('Página do produto indisponível'); return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var input = doc.querySelector('input[name="add_to_cart"][value="' + product.id + '"]');
        var form = input && input.closest('form');
        if (!form) throw new Error('Formulário de compra não encontrado para ' + product.name);

        var params = new URLSearchParams();
        var used = {};
        var selects = form.querySelectorAll('select[name^="variation"]');
        Array.prototype.forEach.call(form.elements, function (el) {
          if (!el.name || el.disabled) return;
          if (el.tagName === 'SELECT' && /^variation/.test(el.name)) return; // tratado abaixo
          if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
          if (el.type === 'submit' || el.type === 'button' || el.type === 'file') return;
          params.set(el.name, el.value);
        });
        // Preenche cada variação (Cor, Tamanho…) pelo nome da opção
        Array.prototype.forEach.call(selects, function (sel, idx) {
          var options = Array.prototype.slice.call(sel.options);
          var match = null;
          for (var i = 0; i < variant.values.length && !match; i++) {
            if (used[i]) continue;
            var want = norm(variant.values[i]);
            match = options.filter(function (o) { return norm(o.textContent) === want; })[0];
            if (match) used[i] = true;
          }
          if (!match && variant.values[idx] != null) { // tenta pela posição
            var w = norm(variant.values[idx]);
            match = options.filter(function (o) { return norm(o.textContent).indexOf(w) === 0; })[0];
          }
          if (!match) throw new Error('Variação "' + variant.values.join(' / ') + '" não encontrada em ' + product.name);
          params.set(sel.name, match.value);
        });
        params.set('add_to_cart', String(product.id));
        params.set('quantity', '1');
        params.set('variant_id', String(variant.id));

        var action = samePath(form.getAttribute('action') || '/comprar/');
        return fetch(action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        }).then(function (r) {
          if (!r.ok) throw new Error('Carrinho respondeu ' + r.status);
          return action;
        });
      });
  }

  // ---------- Inicialização ----------
  function mountPoint() {
    var custom = document.getElementById('compre-o-conjunto');
    if (custom) return { el: custom, mode: 'inside' };
    var form = document.querySelector('#product_form, .js-product-form, form[action*="comprar"]');
    if (form) return { el: form, mode: 'after' };
    return null;
  }

  function init() {
    var productId = getProductId();
    var storeId = getStoreId();
    if (!productId || !storeId) return;
    var mp = mountPoint();
    if (!mp) return;

    fetch(API_BASE + '/api/public/sets?store=' + encodeURIComponent(storeId) + '&product=' + encodeURIComponent(productId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.sets || !data.sets.length) return;
        var s = data.settings;
        if (s.show_on_mobile === false && window.matchMedia('(max-width: 767px)').matches) return;
        injectCss(s);
        var frag = document.createDocumentFragment();
        data.sets.forEach(function (set) { frag.appendChild(renderSet(set, s, productId)); });
        if (mp.mode === 'inside') mp.el.appendChild(frag);
        else mp.el.parentNode.insertBefore(frag, mp.el.nextSibling);
      })
      .catch(function (e) { console.warn('[Compre o Conjunto]', e); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

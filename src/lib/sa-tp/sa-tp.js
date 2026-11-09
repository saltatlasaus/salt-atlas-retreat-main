
/* Always open on the hero: stop the browser or viewer restoring an old scroll position or focus */
(function () {
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) {}
  if (location.hash && location.hash.length > 1) return;
  var start = Date.now(), moved = false;
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (t) { window.addEventListener(t, function () { moved = true; }, { once: true, passive: true }); });
  function top() {
    if (moved) return;
    var a = document.activeElement; if (a && a !== document.body && a.blur) a.blur();
    window.scrollTo(0, 0);
  }
  top();
  document.addEventListener('DOMContentLoaded', top);
  window.addEventListener('load', top);
  [100, 300, 700, 1200].forEach(function (ms) { setTimeout(top, ms); });
})();

(function () {
  // Break filter: all / paddle out / 10 min or less / 15 min+
  var root = document.getElementById('sa-tp');
  if (!root) return;
  var filters = root.querySelectorAll('.sa-tp-filter');
  var cards = root.querySelectorAll('.sa-tp-brk');
  filters.forEach(function (btn) {
    btn.addEventListener('click', function () {
      filters.forEach(function (b) { b.classList.remove('is-on'); });
      btn.classList.add('is-on');
      var f = btn.getAttribute('data-filter');
      cards.forEach(function (c) {
        var t = Number(c.getAttribute('data-time'));
        var show = f === 'all' || (f === 'paddle' && t === 0) || (f === 'near' && t > 0 && t <= 10) || (f === 'far' && t >= 15);
        c.hidden = !show;
      });
    });
  });
})();

(function () {
  // Active tab highlight and the sticky enquiry bar
  var root = document.getElementById('sa-tp');
  if (!root || !('IntersectionObserver' in window)) return;
  var tabs = root.querySelectorAll('.sa-tp-tabs a');
  var byId = {};
  tabs.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var tabList = root.querySelector('.sa-tp-tabs ul');
  var spy = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      tabs.forEach(function (a) { a.classList.remove('is-active'); });
      var a = byId[e.target.id];
      if (!a) return;
      a.classList.add('is-active');
      tabList.scrollTo({ left: a.offsetLeft - (tabList.clientWidth - a.offsetWidth) / 2, behavior: 'smooth' });
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  Object.keys(byId).forEach(function (id) {
    var s = document.getElementById(id);
    if (s) spy.observe(s);
  });

  var bar = root.querySelector('.sa-tp-bar');
  var heroGone = false, enqOn = false;
  function syncBar() { bar.classList.toggle('is-on', heroGone && !enqOn); }
  new IntersectionObserver(function (e) { heroGone = !e[0].isIntersecting; syncBar(); }).observe(root.querySelector('.sa-tp-hero'));
  new IntersectionObserver(function (e) { enqOn = e[0].isIntersecting; syncBar(); }).observe(root.querySelector('#enquire'));
})();

(function () {
  // Gallery viewer: mosaic tiles plus hidden extras (photos with an empty src are skipped)
  var root = document.getElementById('sa-tp');
  if (!root) return;
  var tiles = root.querySelectorAll('.sa-tp-mosaic .sa-tp-media');
  var imgs = Array.prototype.slice.call(root.querySelectorAll('.sa-tp-mosaic img, .sa-tp-extra img'))
    .filter(function (i) { return i.getAttribute('src'); });
  var lb = root.querySelector('.sa-tp-lb'), big = lb.querySelector('img'), count = lb.querySelector('.sa-tp-lb-count');
  var i = 0;
  function show(n) {
    i = (n + imgs.length) % imgs.length;
    big.src = imgs[i].src; big.alt = imgs[i].alt;
    count.textContent = (i + 1) + ' / ' + imgs.length;
  }
  function open(n) { if (!imgs.length) return; show(n); lb.classList.add('is-open'); document.documentElement.style.overflow = 'hidden'; }
  function close() { lb.classList.remove('is-open'); document.documentElement.style.overflow = ''; }
  tiles.forEach(function (t) {
    var img = t.querySelector('img');
    function go() { open(Math.max(0, imgs.indexOf(img))); }
    t.addEventListener('click', go);
    t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  var more = root.querySelector('[data-sa-tp-gallery]');
  if (more) more.addEventListener('click', function () { open(0); });
  lb.querySelector('.sa-tp-lb-x').addEventListener('click', close);
  lb.querySelector('.sa-tp-lb-prev').addEventListener('click', function () { show(i - 1); });
  lb.querySelector('.sa-tp-lb-next').addEventListener('click', function () { show(i + 1); });
  lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') show(i - 1);
    if (e.key === 'ArrowRight') show(i + 1);
  });
})();

(function () {
  // Enquiry form: prefill from buttons, validate, send, fall back to email
  var root = document.getElementById('sa-tp');
  if (!root) return;
  var form = root.querySelector('.sa-tp-form');
  if (!form) return;
  var thanks = root.querySelector('.sa-tp-thanks');
  var err = form.querySelector('.sa-tp-formerr');
  var btn = form.querySelector('.sa-tp-submit');

  form.elements.page.value = location.href.split('#')[0];
  var q = new URLSearchParams(location.search);
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (q.get(k)) form.elements[k].value = q.get(k); });

  root.querySelectorAll('a[href="#enquire"][data-stay], a[href="#enquire"][data-interest]').forEach(function (a) {
    a.addEventListener('click', function () {
      var stay = a.getAttribute('data-stay'), interest = a.getAttribute('data-interest');
      if (stay) form.querySelectorAll('input[name=stay]').forEach(function (r) { r.checked = (r.value === stay); });
      if (interest) form.querySelectorAll('input[name=interests]').forEach(function (c) { if (c.value === interest) c.checked = true; });
    });
  });

  var d = new Date(), arrival = form.elements.arrival;
  arrival.min = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  function summary() {
    var fd = new FormData(form), lines = [];
    ['name', 'email', 'phone', 'arrival', 'nights', 'adults', 'non_surfers', 'stay', 'surf_level', 'message'].forEach(function (k) {
      if (fd.get(k)) lines.push(k.replace('_', ' ') + ': ' + fd.get(k));
    });
    var ints = fd.getAll('interests'); if (ints.length) lines.push('interests: ' + ints.join(', '));
    return 'Enquiry for ' + fd.get('partner') + '\n\n' + lines.join('\n');
  }

  form.addEventListener('input', function (e) { e.target.classList.remove('is-invalid'); if (e.target.name === 'consent') e.target.closest('label').classList.remove('is-invalid'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.hidden = true;
    var first = null;
    form.querySelectorAll('[required]').forEach(function (f) {
      var ok = f.type === 'checkbox' ? f.checked : f.value.trim() !== '' && (f.type !== 'email' || /.+@.+\..+/.test(f.value));
      var mark = f.type === 'checkbox' ? f.closest('label') : f;
      mark.classList.toggle('is-invalid', !ok);
      if (!ok && !first) first = f;
    });
    if (first) { first.focus(); err.textContent = 'Please fill in the highlighted fields.'; err.hidden = false; return; }

    btn.disabled = true;
    var body = new URLSearchParams(new FormData(form)).toString();
    fetch(form.getAttribute('data-endpoint') || '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      form.hidden = true; thanks.hidden = false; thanks.focus();
      if (window.gtag) window.gtag('event', 'generate_lead', { partner: form.elements.partner.value });
      if (window.fbq) window.fbq('track', 'Lead');
    }).catch(function () {
      btn.disabled = false;
      var mail = 'mailto:info@saltatlas.com?subject=' + encodeURIComponent('Enquiry: ' + form.elements.partner.value) + '&body=' + encodeURIComponent(summary());
      err.innerHTML = 'Sorry, that didn\'t send. <a href="' + mail + '">Email it to us instead</a>, with your details already filled in.';
      err.hidden = false;
    });
  });
})();
</script>
</body>
</html>

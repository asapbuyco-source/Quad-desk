(function () {
  if (document.getElementById('qd-site-nav')) return;

  var links = [
    { href: '/', label: 'Terminal' },
    { href: '/platform', label: 'Platform' },
    { href: '/institutional', label: 'Institutional' },
    { href: '/api', label: 'API' },
    { href: '/blog', label: 'Blog' },
    { href: '/about', label: 'About' },
    { href: '/learn', label: 'Learn' },
    { href: '/tools/position-size', label: 'Tools' }
  ];

  var path = (location.pathname || '/').replace(/\/+$/, '') || '/';

  var style = document.createElement('style');
  style.textContent = [
    '.qd-nav{position:sticky;top:0;z-index:200;padding-top:env(safe-area-inset-top);background:rgba(5,5,7,.9);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.07)}',
    '.qd-nav-inner{max-width:980px;margin:0 auto;display:flex;align-items:center;gap:16px;padding:10px 18px}',
    '.qd-brand{font:700 11px/1 Inter,system-ui,sans-serif;letter-spacing:.18em;color:#fff;text-decoration:none;white-space:nowrap}',
    '.qd-brand:hover{text-decoration:none}',
    '.qd-links{display:flex;gap:14px;flex:1;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none;padding:2px 0}',
    '.qd-links::-webkit-scrollbar{display:none}',
    '.qd-links a{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:#a1a1aa;text-decoration:none;white-space:nowrap;padding:6px 2px;border-bottom:1px solid transparent}',
    '.qd-links a:hover{color:#fff;text-decoration:none}',
    '.qd-links a.active{color:#fff;border-bottom-color:#3b82f6}',
    '.qd-cta{flex:none;background:#3b82f6;color:#fff;text-decoration:none;font:700 11px Inter,system-ui,sans-serif;padding:8px 13px;border-radius:8px;white-space:nowrap}',
    '.qd-cta:hover{background:#2563eb;text-decoration:none}',
    '@media(max-width:680px){.qd-nav-inner{padding:8px 12px;gap:10px}.qd-cta{display:none}.qd-brand{font-size:10px}}',
    '@media(max-width:640px){.wrap{padding-left:16px;padding-right:16px}table{font-size:12px}th,td{padding:7px 6px}pre{white-space:pre-wrap}}'
  ].join('');

  var header = document.createElement('header');
  header.className = 'qd-nav';
  header.id = 'qd-site-nav';

  var inner = document.createElement('div');
  inner.className = 'qd-nav-inner';

  var brand = document.createElement('a');
  brand.className = 'qd-brand';
  brand.href = '/';
  brand.textContent = '◆ QUANT DESK';
  inner.appendChild(brand);

  var nav = document.createElement('nav');
  nav.className = 'qd-links';
  nav.setAttribute('aria-label', 'Site');
  links.forEach(function (l) {
    var a = document.createElement('a');
    a.href = l.href;
    a.textContent = l.label;
    var active = l.href === '/' ? path === '/' : (path === l.href || path.indexOf(l.href + '/') === 0);
    if (active) a.className = 'active';
    nav.appendChild(a);
  });
  inner.appendChild(nav);

  var cta = document.createElement('a');
  cta.className = 'qd-cta';
  cta.href = '/';
  cta.textContent = 'Open terminal';
  inner.appendChild(cta);

  header.appendChild(inner);
  document.head.appendChild(style);
  document.body.insertBefore(header, document.body.firstChild);

  // Keep wide data tables usable on phones: wrap each in a horizontal scroller.
  function wrapTables() {
    document.querySelectorAll('table').forEach(function (t) {
      if (t.parentElement && t.parentElement.hasAttribute('data-qd-scroll')) return;
      var w = document.createElement('div');
      w.setAttribute('data-qd-scroll', '');
      w.style.overflowX = 'auto';
      w.style.webkitOverflowScrolling = 'touch';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wrapTables);
  } else {
    wrapTables();
  }
})();

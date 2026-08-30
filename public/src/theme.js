(function () {
  var KEY = 'owdoo_theme';
  var saved = localStorage.getItem(KEY);
  var theme = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);

  window.OwdooTheme = {
    get: function () { return document.documentElement.getAttribute('data-theme'); },
    set: function (t) {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem(KEY, t);
      var btn = document.getElementById('btnThemeToggle');
      if (btn) btn.classList.toggle('is-dark', t === 'dark');
      if (typeof window.renderVendors === 'function') window.renderVendors();
    },
    toggle: function () {
      var next = this.get() === 'dark' ? 'light' : 'dark';
      this.set(next);
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btnThemeToggle');
    if (btn) {
      btn.classList.toggle('is-dark', theme === 'dark');
      btn.addEventListener('click', function () { window.OwdooTheme.toggle(); });
    }
  });
})();

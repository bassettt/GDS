// ui-dialog.js — In-app replacement for the browser dialogs.
// API : appConfirm(message, { title, okText = "OK", cancelText = "Annuler", danger = false }) => Promise<boolean>
//       appAlert(message, { title, okText = "OK" }) => Promise<void>
// Dialogs are queued: a second call waits until the first one is closed.
(function () {
  "use strict";

  const STYLE_ID = "appDialogStyle";
  const CSS = `
.ad-overlay{position:fixed;inset:0;z-index:100000;background:#000a;display:flex;align-items:center;justify-content:center;padding:10px}
.ad-box{background:var(--bg2,#fff);color:var(--text,#0F172A);border:1px solid var(--border,#E2E8F0);border-radius:14px;
  box-shadow:0 12px 40px #0006;width:min(94vw,400px);max-height:85vh;display:flex;flex-direction:column;overflow:hidden;outline:none}
.ad-header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0}
.ad-icon{display:flex;flex-shrink:0;color:var(--accent,#33c393)}
.ad-box.ad-danger .ad-icon{color:var(--red,#ef4444)}
.ad-title{font-size:14px;font-weight:700;color:var(--text,#0F172A);min-width:0;overflow-wrap:anywhere}
.ad-body{flex:1;overflow-y:auto;padding:16px;font-size:13px;line-height:1.5;color:var(--text,#0F172A);white-space:pre-line;overflow-wrap:anywhere;text-align:start;-webkit-overflow-scrolling:touch}
.ad-footer{padding:12px 16px;border-top:1px solid var(--border,#E2E8F0);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0}
.ad-btn{padding:7px 16px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:1px solid transparent;font-family:inherit}
.ad-btn:focus-visible{outline:2px solid var(--accent,#33c393);outline-offset:2px}
.ad-btn-cancel{background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);border-color:var(--border,#E2E8F0)}
.ad-btn-ok{background:var(--accent,#33c393);color:#fff}
.ad-box.ad-danger .ad-btn-ok{background:var(--red,#ef4444)}
.ad-btn:hover{opacity:.88}`;

  const ICONS = {
    info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    help: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    warn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
  };

  let chain = Promise.resolve();
  let seq = 0;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function open(kind, message, opts) {
    return new Promise((resolve) => {
      ensureStyle();
      const isConfirm = kind === "confirm";
      const danger = isConfirm && !!opts.danger;
      const title = opts.title || (danger ? "Attention" : isConfirm ? "Confirmation" : "Information");
      const okText = opts.okText || "OK";
      const cancelText = opts.cancelText || "Annuler";
      const id = "adDlg" + (++seq);
      const prevFocus = document.activeElement;

      const overlay = document.createElement("div");
      overlay.className = "ad-overlay";
      overlay.innerHTML =
        '<div class="ad-box' + (danger ? " ad-danger" : "") + '" role="alertdialog" aria-modal="true" aria-labelledby="' + id + 'T" aria-describedby="' + id + 'B" tabindex="-1">' +
          '<div class="ad-header"><span class="ad-icon"></span><span class="ad-title" id="' + id + 'T"></span></div>' +
          '<div class="ad-body" id="' + id + 'B"></div>' +
          '<div class="ad-footer"></div>' +
        '</div>';
      const box = overlay.firstChild;
      box.querySelector(".ad-icon").innerHTML = danger ? ICONS.warn : isConfirm ? ICONS.help : ICONS.info;
      box.querySelector(".ad-title").textContent = title;
      box.querySelector(".ad-body").textContent = message == null ? "" : String(message);

      const footer = box.querySelector(".ad-footer");
      let cancelBtn = null;
      if (isConfirm) {
        cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "ad-btn ad-btn-cancel";
        cancelBtn.textContent = cancelText;
        footer.appendChild(cancelBtn);
      }
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "ad-btn ad-btn-ok";
      okBtn.textContent = okText;
      footer.appendChild(okBtn);

      let done = false;
      function close(result) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); } catch (_) {}
        resolve(isConfirm ? result : undefined);
      }

      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault(); e.stopPropagation();
          close(false);
        } else if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          close(!(cancelBtn && document.activeElement === cancelBtn));
        } else if (e.key === "Tab") {
          e.stopPropagation();
          const items = cancelBtn ? [cancelBtn, okBtn] : [okBtn];
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          let n;
          if (i === -1) n = e.shiftKey ? items.length - 1 : 0;
          else n = (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
          items[n].focus();
        }
      }

      okBtn.addEventListener("click", () => close(true));
      if (cancelBtn) cancelBtn.addEventListener("click", () => close(false));
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(false); });
      overlay.addEventListener("click", (e) => e.stopPropagation());

      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  function enqueue(kind, message, opts) {
    const run = () => open(kind, message, opts || {});
    const p = chain.then(run, run);
    chain = p.then(() => {}, () => {});
    return p;
  }

  window.appConfirm = function (message, opts) { return enqueue("confirm", message, opts); };
  window.appAlert = function (message, opts) { return enqueue("alert", message, opts); };
})();

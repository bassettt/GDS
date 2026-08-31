// ============================================================
// src/renderer.js — PWA Rendering Layer
// ✅ No chrome.* calls — pure DOM + App state
// ✅ Date switcher: arrow bar + calendar picker + double-click
// ============================================================





function addNotif(msg, type="info") {
  const list = document.getElementById("notifList"); if (!list) return;
  const time  = new Date().toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const item  = document.createElement("div"); item.className = `notif-item notif-${type}`;
  item.innerHTML = `<span class="notif-dot"></span><span class="notif-msg">${escHtml(msg)}</span><span class="notif-time">${time}</span>`;
  list.insertBefore(item, list.firstChild);
  while (list.children.length > 5) list.removeChild(list.lastChild);
}

// ── Main view ─────────────────────────────────────────────────
function renderMain() {
  // GDS-only: no vendor list or date switcher
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(name === "settings" ? "viewSettings" : "viewMain").classList.add("active");
  if (name === "settings") renderSettings();
}


// ── renderSettings ────────────────────────────────────────────
function renderSettings() {
  const s = App.settings; if (!s) return;
  renderVendorsManager();
}

// ── renderVendorsManager ──────────────────────────────────────
function renderVendorsManager() {
  const container = document.getElementById("vendorsManager"); if (!container) return;
  container.innerHTML = "";
  let dragSrcIdx = null;
  let dragOverIdx = null;
  (App.settings?.vendors || []).forEach((worker, idx) => {
    const row = document.createElement("div"); row.className="vendor-row"; row.draggable=true; row.dataset.idx=idx; row.title=worker.name;
    const role = worker.role || "prevente";
    row.innerHTML = `
      <span class="vendor-drag-handle" title="Glisser"><svg width="9" height="13" viewBox="0 0 9 13" fill="none"><circle cx="2.5" cy="2" r="1.2" fill="#475569"/><circle cx="6.5" cy="2" r="1.2" fill="#475569"/><circle cx="2.5" cy="6.5" r="1.2" fill="#475569"/><circle cx="6.5" cy="6.5" r="1.2" fill="#475569"/><circle cx="2.5" cy="11" r="1.2" fill="#475569"/><circle cx="6.5" cy="11" r="1.2" fill="#475569"/></svg></span>
      <input type="checkbox" ${worker.enabled?"checked":""} data-idx="${idx}" class="vendor-toggle"/>
      <input type="text" value="${escHtml(worker.name)}" data-idx="${idx}" class="vendor-name-input" placeholder="Nom complet"/>
      <input type="text" value="${escHtml(worker.label||"")}" data-idx="${idx}" class="vendor-label-input" placeholder="Label" maxlength="12"/>
      <input type="text" inputmode="numeric" pattern="[0-9]*" value="${worker.workerId||""}" data-idx="${idx}" class="vendor-workerid-input vendor-label-input" placeholder="ID" maxlength="10"/>
      <select data-idx="${idx}" class="vendor-role-select">
        <option value="prevente"      ${role==="prevente"      ?"selected":""}>Prev.</option>
        <option value="livraison"     ${role==="livraison"     ?"selected":""}>Liv.</option>
        <option value="merchandiseur" ${role==="merchandiseur" ?"selected":""}>Merch.</option>
        <option value="recouvrement"  ${role==="recouvrement"  ?"selected":""}>Recouv.</option>
      </select>
      <button class="delete-vendor-btn" data-idx="${idx}" title="Supprimer"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    row.addEventListener("dragstart", e => {
      dragSrcIdx = idx;
      dragOverIdx = null;
      e.dataTransfer.setData("text/plain", String(idx));
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("vendor-row--dragging");
    });
    row.addEventListener("dragend", () => {
      dragSrcIdx = null;
      dragOverIdx = null;
      container.querySelectorAll(".vendor-row").forEach(r => r.classList.remove("vendor-row--dragging","vendor-row--over"));
    });
    row.addEventListener("dragover", e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      container.querySelectorAll(".vendor-row").forEach(r => r.classList.remove("vendor-row--over"));
      row.classList.add("vendor-row--over");
      dragOverIdx = idx;
    });
    row.addEventListener("drop", e => {
      e.preventDefault();
      e.stopPropagation();
      const si = parseInt(e.dataTransfer.getData("text/plain"));
      const ti = dragOverIdx;
      if (isNaN(si) || ti === null || si === ti) return;
      const vendors = App.settings.vendors;
      const tmp = vendors[si];
      vendors[si] = vendors[ti];
      vendors[ti] = tmp;
      dragSrcIdx = null;
      dragOverIdx = null;
      renderVendorsManager();
    });
    container.appendChild(row);
  });
  container.querySelectorAll(".vendor-toggle")     .forEach(cb  => cb.addEventListener("change", e  => { App.settings.vendors[+e.target.dataset.idx].enabled = e.target.checked; }));
  container.querySelectorAll(".vendor-name-input") .forEach(inp => inp.addEventListener("input",  e  => { App.settings.vendors[+e.target.dataset.idx].name  = e.target.value; }));
  container.querySelectorAll(".vendor-label-input").forEach(inp => inp.addEventListener("input",  e  => { App.settings.vendors[+e.target.dataset.idx].label = e.target.value; }));
  container.querySelectorAll(".vendor-role-select")    .forEach(sel => sel.addEventListener("change", e  => { App.settings.vendors[+e.target.dataset.idx].role     = e.target.value; }));
  container.querySelectorAll(".vendor-workerid-input").forEach(inp => inp.addEventListener("input", e => { const v=parseInt(e.target.value.replace(/\D/g,""),10); App.settings.vendors[+e.target.dataset.idx].workerId = v>0?v:null; }));
  container.querySelectorAll(".delete-vendor-btn") .forEach(btn => btn.addEventListener("click",  e  => { App.settings.vendors.splice(+e.currentTarget.dataset.idx,1); renderVendorsManager(); }));
}

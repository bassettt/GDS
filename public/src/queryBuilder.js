// ============================================================
// queryBuilder.js — Query Builder with Groups
// ============================================================

let qbGroups       = [];
let qbGroupsLogic  = [];
let qbNextId       = 1;
let qbActiveFavIndex = -1;

// ── تعريف الحقول ─────────────────────────────────────────────
const QB_FIELDS = {
  label:       { label:"Nom",              type:"text",    get:w=>(w.label||w.name||"").toLowerCase() },
  ref:         { label:"Référence",        type:"text",    get:w=>(App.allRefs[w.id]||"").toLowerCase() },
  ca:          { label:"CA",               type:"number",  get:w=>App.allStats[w.id]?.ca??null },
  visitRate:   { label:"%Visite",               type:"number",  get:w=>App.allStats[w.id]?.visitRate??null },
  successRate: { label:"%Succes",               type:"number",  get:w=>App.allStats[w.id]?.successRate??null },
  totalClients:{ label:"NCP",                type:"number",  get:w=>App.allStats[w.id]?.totalClients??null },
  dotState:    { label:"Statut", type:"select",  get:w=>_qbGetDotState(w),
    options:[
      {value:"open_day",    label:"🟢 En cours"},
      {value:"not_started", label:"🟣 Non démarré"},
      {value:"close_day",   label:"🟠 Vendeur fermé"},
      {value:"closed",      label:"⚫ Tournée fermée"},
      {value:"draft",       label:"🔵 Brouillon"},
      {value:"absent",      label:"🔴 Absent"},
    ]
  },
  horsRoute:   { label:"Hors tournée",    type:"boolean", get:w=>!!(App.allStats[w.id]?.horsRoute) },
};

const QB_OPS = {
  text:   [{value:"contains",label:"contient"},{value:"not_contains",label:"ne contient pas"},{value:"eq",label:"= (exact)"}],
  number: [{value:"eq",label:"="},{value:"neq",label:"≠"},{value:"gte",label:"≥"},{value:"lte",label:"≤"},{value:"gt",label:">"},{value:"lt",label:"<"}],
  select: [{value:"eq",label:"="},{value:"neq",label:"≠"}],
  boolean:[{value:"is_true",label:"= Oui"},{value:"is_false",label:"= Non"}],
};

// ── حالة الـ dot ──────────────────────────────────────────────
function _qbGetDotState(w) {
  const has        = !!App.allLinks[w.id];
  const odooState  = (App.allOdooState  || {})[w.id];
  const userStatus = (App.allUserStatus || {})[w.id];
  return getRoundState(has, odooState, userStatus);
}

// ── تقييم شرط واحد ───────────────────────────────────────────
function _qbEvalRule(rule, worker) {
  const def = QB_FIELDS[rule.field]; if (!def) return true;
  const val = def.get(worker);
  switch(rule.operator) {
    case "contains":     return typeof val==="string" && val.includes((rule.value||"").toLowerCase());
    case "not_contains": return typeof val==="string" && !val.includes((rule.value||"").toLowerCase());
    case "eq": {
      const rv = rule.value === "" && def.type === "select"
        ? (def.options?.[0]?.value || "") : rule.value;
      return String(val) === String(rv);
    }
    case "neq": {
      const rv = rule.value === "" && def.type === "select"
        ? (def.options?.[0]?.value || "") : rule.value;
      return String(val) !== String(rv);
    }
    case "gte":          return val!==null && val>=Number(rule.value);
    case "lte":          return val!==null && val<=Number(rule.value);
    case "gt":           return val!==null && val> Number(rule.value);
    case "lt":           return val!==null && val< Number(rule.value);
    case "is_true":      return val===true;
    case "is_false":     return val===false;
    default:             return true;
  }
}

// ── تقييم groupe واحد ────────────────────────────────────────
function _qbEvalGroup(group, worker) {
  if (!group.rules.length) return true;
  if (group.logic === "AND") return group.rules.every(r => _qbEvalRule(r, worker));
  return group.rules.some(r => _qbEvalRule(r, worker));
}

// ── تقييم كل الـ groupes على عامل ────────────────────────────
function qbMatchesWorker(worker) {
  if (!qbGroups.length) return true;
  let result = _qbEvalGroup(qbGroups[0], worker);
  for (let i = 1; i < qbGroups.length; i++) {
    const op = qbGroupsLogic[i-1] || "OR";
    const gResult = _qbEvalGroup(qbGroups[i], worker);
    result = op === "AND" ? result && gResult : result || gResult;
  }
  return result;
}

function qbIsActive() { return qbGroups.some(g => g.rules.length > 0); }

function qbReset() {
  qbGroups = []; qbGroupsLogic = []; qbNextId = 1;
  renderQb();
}

// ── Helpers ───────────────────────────────────────────────────
function _mkId() { return qbNextId++; }

function _mkRule(field) {
  const def  = QB_FIELDS[field];
  const type = def?.type || "text";
  const defaultValue = type === "select" ? (def?.options?.[0]?.value || "") : "";
  return { id:_mkId(), field, operator:QB_OPS[type][0].value, value: defaultValue };
}

function _mkGroup() {
  return { id:_mkId(), logic:"AND", rules:[_mkRule("label")] };
}

// ── Render ────────────────────────────────────────────────────
function renderQb() {
  const container = document.getElementById("qbRulesContainer");
  if (!container) return;
  container.innerHTML = "";

  qbGroups.forEach((group, gi) => {
    // separator بين الـ groupes
    if (gi > 0) {
      const sep = document.createElement("div");
      sep.style.cssText = "display:flex;align-items:center;gap:4px;margin:3px 0";
      const logic = qbGroupsLogic[gi-1] || "OR";
      sep.innerHTML = `
  <button class="qb-gl-btn ${logic==="AND"?"qb-gl-btn--on":""}"
    data-gi="${gi-1}" data-val="AND">AND</button>
  <button class="qb-gl-btn ${logic==="OR"?"qb-gl-btn--on":""}"
    data-gi="${gi-1}" data-val="OR">OR</button>
`;
      container.appendChild(sep);
    }

    // groupe box
    const box = document.createElement("div");
    box.className = "qb-group";
    box.dataset.gid = group.id;

    // groupe header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:3px";
    header.innerHTML = `
      <span style="color:var(--text3);font-size:9px">Groupe</span>
      <button class="qb-logic-btn ${group.logic==="AND"?"qb-logic-btn--on":""}"
        data-gid="${group.id}" data-val="AND">AND</button>
      <button class="qb-logic-btn ${group.logic==="OR"?"qb-logic-btn--on":""}"
        data-gid="${group.id}" data-val="OR">OR</button>
      <div style="flex:1"></div>
      <button class="qb-del-group-btn" data-gid="${group.id}" title="Supprimer groupe">✕ Groupe</button>
    `;
    box.appendChild(header);

    // rules
    group.rules.forEach(rule => {
      box.appendChild(_renderRule(rule, group.id));
    });

    // + Règle
    const addRule = document.createElement("button");
    addRule.className = "qb-add-rule-btn";
    addRule.dataset.gid = group.id;
    addRule.textContent = "+ Règle";
    box.appendChild(addRule);

    container.appendChild(box);
  });

  // + Groupe button
  const addGroup = document.createElement("button");
  addGroup.id = "qbBtnAddGroup";
  addGroup.style.cssText = "margin-top:4px;padding:1px 8px;font-size:9px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:3px;cursor:pointer;width:100%";
  addGroup.textContent = "+ Groupe";
  container.appendChild(addGroup);
}

function _renderRule(rule, gid) {
  const def   = QB_FIELDS[rule.field] || {};
  const type  = def.type || "text";
  const ops   = QB_OPS[type] || QB_OPS.text;

  const fieldOpts = Object.entries(QB_FIELDS).map(([k,v]) =>
    `<option value="${k}" ${rule.field===k?"selected":""}>${v.label}</option>`
  ).join("");

  const opOpts = ops.map(o =>
    `<option value="${o.value}" ${rule.operator===o.value?"selected":""}>${o.label}</option>`
  ).join("");

  let valueHtml = "";
  if (type === "boolean") {
    valueHtml = "";
  } else if (type === "select") {
    const opts = (def.options||[]).map(o =>
      `<option value="${o.value}" ${rule.value===o.value?"selected":""}>${o.label}</option>`
    ).join("");
    valueHtml = `<select class="qb-input" style="color:var(--text1,#e2e8f0)" data-gid="${gid}" data-rid="${rule.id}" data-part="value">${opts}</select>`;
  } else {
    valueHtml = `<input class="qb-input" type="${type==="number"?"number":"text"}"
      placeholder="valeur" value="${rule.value??""}"
      data-gid="${gid}" data-rid="${rule.id}" data-part="value"
      style="width:${type==="number"?"52px":"80px"}"/>`;
  }

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:3px;flex-wrap:wrap;margin-bottom:2px";
  row.dataset.rid = rule.id;
  row.innerHTML = `
    <select class="qb-input" data-gid="${gid}" data-rid="${rule.id}" data-part="field" style="width:105px;color:var(--text1,#e2e8f0)">${fieldOpts}</select>
<select class="qb-input" data-gid="${gid}" data-rid="${rule.id}" data-part="op"    style="width:75px;color:var(--text1,#e2e8f0)">${opOpts}</select>
    ${valueHtml}
    <button class="qb-del-btn" data-gid="${gid}" data-rid="${rule.id}" title="Supprimer">✕</button>
  `;
  return row;
}

// ── Events ────────────────────────────────────────────────────
function bindQb() {
  loadFilterFavourites();
  renderFavChips();
  _bindFavChips();
  // تطبيق الـ default عند الفتح
  const defFav = (App.filterFavourites||[]).find(f => f.isDefault);
  if (defFav) qbLoadFavourite(defFav);
  document.getElementById("qbBtnAdd")?.addEventListener("click", () => {
    if (!qbGroups.length) {
      qbGroups.push(_mkGroup());
    } else {
      qbGroups[qbGroups.length - 1].rules.push(_mkRule("label"));
    }
    renderQb();
    applySearch();
  });

  const cont = document.getElementById("qbRulesContainer");
  if (!cont) return;

  // delegation sur le container
  cont.addEventListener("click", e => {
    // + Groupe
    if (e.target.id === "qbBtnAddGroup") {
      qbGroups.push(_mkGroup());
      if (qbGroups.length > 1) qbGroupsLogic.push("OR");
      renderQb(); return;
    }

    // + Règle
    const addRuleBtn = e.target.closest(".qb-add-rule-btn");
    if (addRuleBtn) {
      const g = qbGroups.find(g => g.id === parseInt(addRuleBtn.dataset.gid));
      if (g) { g.rules.push(_mkRule("label")); renderQb(); }
      return;
    }

    // ✕ Règle
    const delBtn = e.target.closest(".qb-del-btn");
    if (delBtn) {
      const gid = parseInt(delBtn.dataset.gid), rid = parseInt(delBtn.dataset.rid);
      const g = qbGroups.find(g => g.id === gid);
      if (g) {
        g.rules = g.rules.filter(r => r.id !== rid);
        if (!g.rules.length) {
          // احذف الـ groupe إذا صار فارغاً
          const gi = qbGroups.indexOf(g);
          qbGroups.splice(gi, 1);
          if (qbGroupsLogic.length >= gi && gi > 0) qbGroupsLogic.splice(gi-1, 1);
          else if (qbGroupsLogic.length && gi === 0) qbGroupsLogic.splice(0, 1);
        }
        renderQb(); applySearch();
      }
      return;
    }

    // ✕ Groupe
    const delGroup = e.target.closest(".qb-del-group-btn");
    if (delGroup) {
      const gid = parseInt(delGroup.dataset.gid);
      const gi  = qbGroups.findIndex(g => g.id === gid);
      if (gi > -1) {
        qbGroups.splice(gi, 1);
        if (gi > 0 && qbGroupsLogic.length >= gi) qbGroupsLogic.splice(gi-1, 1);
        else if (gi === 0 && qbGroupsLogic.length) qbGroupsLogic.splice(0, 1);
        renderQb(); applySearch();
      }
      return;
    }

    // logic داخل groupe
    const logicBtn = e.target.closest(".qb-logic-btn");
    if (logicBtn) {
      const g = qbGroups.find(g => g.id === parseInt(logicBtn.dataset.gid));
      if (g) { g.logic = logicBtn.dataset.val; renderQb(); if(qbIsActive()) applySearch(); }
      return;
    }

    // logic بين groupes
    const glBtn = e.target.closest(".qb-gl-btn");
    if (glBtn) {
      const gi = parseInt(glBtn.dataset.gi);
      qbGroupsLogic[gi] = glBtn.dataset.val;
      renderQb(); if(qbIsActive()) applySearch();
      return;
    }
  });

  // field / op / value change
  cont.addEventListener("change", e => {
    const el   = e.target;
    const gid  = parseInt(el.dataset.gid);
    const rid  = parseInt(el.dataset.rid);
    const part = el.dataset.part;
    if (!part) return;
    const g = qbGroups.find(g => g.id === gid); if (!g) return;
    const rule = g.rules.find(r => r.id === rid); if (!rule) return;

    if (part === "field") {
      rule.field    = el.value;
      const newDef  = QB_FIELDS[el.value];
      const newType = newDef?.type || "text";
      rule.operator = QB_OPS[newType][0].value;
      rule.value    = newType === "select" ? (newDef?.options?.[0]?.value || "") : "";
      renderQb();
    } else if (part === "op") {
      rule.operator = el.value;
    } else if (part === "value") {
      rule.value = el.value;
    }
    applySearch();
  });

  cont.addEventListener("input", e => {
    const el = e.target; if (el.dataset.part !== "value") return;
    const g = qbGroups.find(g => g.id === parseInt(el.dataset.gid)); if (!g) return;
    const rule = g.rules.find(r => r.id === parseInt(el.dataset.rid)); if (!rule) return;
    rule.value = el.value;
    applySearch();
  });

  // Reset
  document.getElementById("btnFilterReset")?.addEventListener("click", () => {
    qbReset();
    App.searchQuery = "";
    const inp = document.getElementById("searchInput");
    if (inp) inp.value = "";
    applySearch();
  });
}
// ── Favourites ────────────────────────────────────────────────
// Stockées dans App.settings.filterFavourites[mode] → synchronisées
// avec les autres appareils via FirebaseSync (clé "shared").
function _favMode() { return App.currentMode || "prevente"; }
function _favKey()  { return "wafa_qb_favs_" + _favMode(); } // ancien stockage local (migration)

function loadFilterFavourites() {
  if (!App.settings) App.settings = {}; // قد يُستدعى قبل انتهاء App.settings = await Storage.getSettings()
  if (!App.settings.filterFavourites) App.settings.filterFavourites = {};
  const mode = _favMode();
  if (!Array.isArray(App.settings.filterFavourites[mode])) {
    // migration depuis l'ancien stockage localStorage (une seule fois)
    let migrated = null;
    try { migrated = JSON.parse(localStorage.getItem(_favKey()) || "null"); } catch (_) {}
    App.settings.filterFavourites[mode] = Array.isArray(migrated) ? migrated : [];
    if (migrated) {
      try { localStorage.removeItem(_favKey()); } catch (_) {}
      Storage.saveSettings(App.settings).catch(()=>{});
      if (typeof FirebaseSync !== "undefined") {
        FirebaseSync.pushFullUpdate(App.settings).catch(e => console.error("[FirebaseSync] pushFullUpdate (favs migration):", e));
      }
    }
  }
  App.filterFavourites = App.settings.filterFavourites[mode];
}

function saveFilterFavourites() {
  const mode = _favMode();
  if (!App.settings.filterFavourites) App.settings.filterFavourites = {};
  App.settings.filterFavourites[mode] = App.filterFavourites;
  Storage.saveSettings(App.settings).catch(()=>{});
  if (typeof FirebaseSync !== "undefined") {
    FirebaseSync.pushFullUpdate(App.settings).catch(e => console.error("[FirebaseSync] pushFullUpdate (favs):", e));
  }
}

function qbSaveFavourite() {
  if (!qbIsActive()) return;
  const label = prompt("Nom du favori:");
  if (!label?.trim()) return;
  const trimmed = label.trim();
  // منع الاسم المكرر
  if (App.filterFavourites.some(f => f.label.toLowerCase() === trimmed.toLowerCase())) {
    alert(`Un favori nommé "${trimmed}" existe déjà.`);
    return;
  }
  App.filterFavourites.push({
    label:  trimmed,
    groups: JSON.parse(JSON.stringify(qbGroups)),
    logic:  JSON.parse(JSON.stringify(qbGroupsLogic)),
  });
  saveFilterFavourites();
  renderFavChips();
}

function qbEditFavourite(idx) {
  const fav = App.filterFavourites[idx];
  if (!fav) return;
  const newLabel = prompt("Nouveau nom du favori:", fav.label);
  if (!newLabel?.trim()) return;
  const trimmed = newLabel.trim();
  if (App.filterFavourites.some((f, i) => i !== idx && f.label.toLowerCase() === trimmed.toLowerCase())) {
    alert(`Un favori nommé "${trimmed}" existe déjà.`);
    return;
  }
  // إذا الفلتر الحالي نشط → حدّث قواعده أيضاً
  const updateRules = confirm("Mettre à jour les règles du filtre avec les règles actuelles?");
  fav.label = trimmed;
  if (updateRules && qbIsActive()) {
    fav.groups = JSON.parse(JSON.stringify(qbGroups));
    fav.logic  = JSON.parse(JSON.stringify(qbGroupsLogic));
  }
  saveFilterFavourites();
  renderFavChips();
}

function qbLoadFavourite(fav) {
  qbGroups      = JSON.parse(JSON.stringify(fav.groups));
  qbGroupsLogic = JSON.parse(JSON.stringify(fav.logic || []));
  // recalc nextId
  let maxId = 0;
  qbGroups.forEach(g => {
    if (g.id > maxId) maxId = g.id;
    g.rules.forEach(r => { if (r.id > maxId) maxId = r.id; });
  });
  qbNextId = maxId + 1;
  renderQb();
  applySearch();
}

function renderFavChips() {
  const favs = App.filterFavourites || [];

  // داخل filter panel
  const inner = document.getElementById("favChips");
  if (inner) {
    inner.innerHTML = "";
    favs.forEach((fav, i) => {
      const chip = document.createElement("div");
      chip.style.cssText = "display:flex;align-items:center;gap:2px";
      chip.innerHTML = `
        <button class="qb-fav-chip ${fav.isDefault?"qb-fav-chip--default":""}" data-i="${i}">${fav.isDefault?"⭐ ":""}${fav.label}</button>
        <button class="qb-fav-star" data-i="${i}" title="${fav.isDefault?"Retirer défaut":"Mettre par défaut"}">${fav.isDefault?"★":"☆"}</button>
        <button class="qb-fav-edit" data-i="${i}" title="Modifier">✎</button>
        <button class="qb-fav-del"  data-i="${i}" title="Supprimer">✕</button>
      `;
      inner.appendChild(chip);
    });
  }

  // شريط الـ favBar — دائماً ظاهر إذا يوجد favs، مخفي إذا لا يوجد
  const bar    = document.getElementById("favBar");
  const barCnt = document.getElementById("favBarChips");
  if (bar && barCnt) {
    bar.style.display = favs.length ? "block" : "none";
    barCnt.innerHTML  = "";

    let _dragSrcIdx = -1;

    favs.forEach((fav, i) => {
      const chip = document.createElement("button");
      chip.className   = "qb-fav-chip qb-fav-chip--bar " + (fav.isDefault ? "qb-fav-chip--default" : "");
      chip.dataset.i   = String(i);
      chip.draggable   = true;
      chip.textContent = (fav.isDefault ? "⭐ " : "") + fav.label;
      if (qbActiveFavIndex === i) chip.classList.add("qb-fav-chip--active");

      // drag & drop — متابعة _isDragging لمنع تشغيل click بعد drag
      chip.addEventListener("dragstart", e => {
        _dragSrcIdx = i;
        bar.setAttribute("data-dragging", "1");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        chip.style.opacity = "0.5";
      });
      chip.addEventListener("dragend", () => {
        chip.style.opacity = "";
        setTimeout(() => { bar.removeAttribute("data-dragging"); }, 80);
      });
      chip.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
chip.addEventListener("drop", e => {
        e.preventDefault();
        const si = parseInt(e.dataTransfer.getData("text/plain"));
        const ti = i;
        if (isNaN(si) || si === ti) return;
        const f   = App.filterFavourites;
        const tmp = f[si]; f[si] = f[ti]; f[ti] = tmp;
        if      (qbActiveFavIndex === si) qbActiveFavIndex = ti;
        else if (qbActiveFavIndex === ti) qbActiveFavIndex = si;
        saveFilterFavourites();
        renderFavChips();
      });
      barCnt.appendChild(chip);
    });
  }
}

// events pour les chips — à appeler une fois dans bindQb
function _bindFavChips() {
  // داخل filter panel
  document.getElementById("favChips")?.addEventListener("click", e => {
    const chip = e.target.closest(".qb-fav-chip");
    const del  = e.target.closest(".qb-fav-del");
    const star = e.target.closest(".qb-fav-star");
    const edit = e.target.closest(".qb-fav-edit");

    if (star) {
      const i = parseInt(star.dataset.i);
      App.filterFavourites.forEach((f, j) => f.isDefault = (j === i && !f.isDefault));
      saveFilterFavourites(); renderFavChips();
      return;
    }
    if (edit) {
      qbEditFavourite(parseInt(edit.dataset.i));
      return;
    }
    if (chip) {
      const fav = App.filterFavourites[parseInt(chip.dataset.i)];
      if (fav) {
        App.searchQuery = "";
        const inp = document.getElementById("searchInput");
        if (inp) inp.value = "";
        const inpM = document.getElementById("searchInputMobile");
        if (inpM) inpM.value = "";
        const clrM = document.getElementById("searchClearMobile");
        if (clrM) clrM.style.display = "none";
        qbLoadFavourite(fav);
      }
      return;
    }
    if (del) {
      App.filterFavourites.splice(parseInt(del.dataset.i), 1);
      saveFilterFavourites(); renderFavChips();
      return;
    }
  });

  // شريط الـ favBar — event delegation على الـ parent الثابت favBar
  const favBarEl = document.getElementById("favBar");
  if (favBarEl && !favBarEl._clickBound) {
    favBarEl._clickBound = true;
    favBarEl.addEventListener("click", e => {
      if (favBarEl.hasAttribute("data-dragging")) return;
      const chip = e.target.closest(".qb-fav-chip");
      if (!chip) return;
      const i = parseInt(chip.dataset.i);
      if (isNaN(i)) return;
      if (qbActiveFavIndex === i) {
        qbActiveFavIndex = -1;
        qbReset();
        document.querySelectorAll("#favBarChips .qb-fav-chip").forEach(c => c.classList.remove("qb-fav-chip--active"));
      } else {
        qbActiveFavIndex = i;
        const fav = App.filterFavourites[i];
        if (fav) {
          App.searchQuery = "";
          const inp = document.getElementById("searchInput");
          if (inp) inp.value = "";
          const inpM = document.getElementById("searchInputMobile");
          if (inpM) inpM.value = "";
          const clrM = document.getElementById("searchClearMobile");
          if (clrM) clrM.style.display = "none";
          qbLoadFavourite(fav);
        }
        document.querySelectorAll("#favBarChips .qb-fav-chip").forEach(c => c.classList.remove("qb-fav-chip--active"));
        chip.classList.add("qb-fav-chip--active");
      }
      applySearch();
    });
  }
}

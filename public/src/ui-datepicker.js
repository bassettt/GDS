// ============================================================
// src/ui-datepicker.js — shared date picker (popover on desktop, bottom sheet on phone)
// ------------------------------------------------------------
// AppDatePicker.open(anchorEl, { mode: "day" | "range", value, min, max, withTime, onApply(value), onClose() })
//
//   mode "day"   : one day. value / min / max / onApply(value) use "YYYY-MM-DD".
//                  Clicking a day applies it immediately (no confirm button) and closes.
//   mode "range" : value = { from, to } as local "YYYY-MM-DDTHH:mm[:ss]" ("" / missing = not set yet);
//                  onApply({ from, to }) always receives full "YYYY-MM-DDTHH:mm:ss" strings.
//                  Behaviour = the original Préparation period picker:
//                    · badge « Depuis » active (default): one click on a day = that day, start = now (HH:mm:00), end = 23:59:59
//                    · badge « À » active: the click only moves the end date (23:59:59), refused before the start
//                    · time fields (typed HH:MM or ± steppers), live summary, validation « À » strictly after « Depuis »
//                  withTime (default true in range mode): false hides the time cards (start 00:00:00, end 23:59:59).
//   min / max    : "YYYY-MM-DD" bounds, days outside are disabled (both modes).
//   align        : "center" centers the popover under a wide anchor (default: left edge of the anchor, flipped to the right edge if it overflows).
//   onClose()    : called whenever the picker closes (applied or not), after onApply.
//
//   AppDatePicker.close()  — close the open picker (no apply).   AppDatePicker.isOpen()
//   Calling open() again with the same anchor while open toggles it closed.
// Escape / click outside / backdrop = close without applying. Colors only through the app CSS variables (see style.css, .adp-*).
// ============================================================
(function () {
  "use strict";
  if (window.AppDatePicker) return;

  const p2 = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const dstr = (y, m, d) => `${y}-${p2(m + 1)}-${p2(d)}`;                      // m is 0-based
  const dparse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const tmin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const tfmt = (n) => `${p2(Math.floor(n / 60))}:${p2(n % 60)}`;
  const capFirst = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const SUF = (key) => key === "ft" ? ":00" : ":59";                           // typed HH:MM → start :00, end :59
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const SVG = (inner, cls) => `<svg class="adp-ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const I_PREV = SVG('<polyline points="15 18 9 12 15 6"/>'), I_NEXT = SVG('<polyline points="9 18 15 12 9 6"/>');
  const I_UP = SVG('<polyline points="18 15 12 9 6 15"/>'), I_DOWN = SVG('<polyline points="6 9 12 15 18 9"/>');

  // Canonical local value "YYYY-MM-DDTHH:mm:ss". Missing seconds: start → :00, end → :59. Date only: start 00:00:00, end 23:59:59.
  function normIso(iso, isEnd) {
    if (!iso) return "";
    const [dp, tp = ""] = String(iso).split("T");
    if (!tp) return `${dp}T${isEnd ? "23:59:59" : "00:00:00"}`;
    const [h = "0", mi = "0", sec] = tp.split(":");
    const ss = (sec == null || sec === "") ? (isEnd ? 59 : 0) : +sec;
    return `${dp}T${p2(+h || 0)}:${p2(+mi || 0)}:${p2(ss || 0)}`;
  }
  const parseLocal = (iso) => {
    const [dp, tp = "00:00"] = String(iso).split("T"), [y, m, d] = dp.split("-"), [h, mi, sc] = tp.split(":");
    return new Date(+y, +m - 1, +d, +h || 0, +mi || 0, +sc || 0);
  };

  let cur = null;                                // the open picker: { anchor, opts, el, bd, st, handlers }
  const isPhone = () => window.matchMedia("(max-width:719px)").matches;

  // ── state ────────────────────────────────────────────────
  function initState(o) {
    const mode = o.mode === "range" ? "range" : "day";
    const withTime = mode === "range" && o.withTime !== false;
    const st = { mode, withTime, min: DAY_RE.test(o.min || "") ? o.min : "", max: DAY_RE.test(o.max || "") ? o.max : "",
                 fd: "", ft: "00:00:00", td: "", tt: "23:59:59", active: "from", note: "", dflt: false, vy: 0, vm: 0, fo: "" };
    const today = ymd(new Date());
    if (mode === "day") {
      st.fd = DAY_RE.test(o.value || "") ? o.value : "";
      st.fo = st.fd || today;
    } else {
      const v = o.value || {}, sp = (iso, dt) => iso ? [iso.slice(0, 10), iso.slice(11, 19)] : ["", dt];
      [st.fd, st.ft] = sp(normIso(v.from, false), "00:00:00"); [st.td, st.tt] = sp(normIso(v.to, true), "23:59:59");
      if (!st.fd) {                                // first use (no period yet): proposal = now → end of today (still needs « Appliquer »)
        const n = new Date(); st.fd = ymd(n); st.ft = withTime ? `${p2(n.getHours())}:${p2(n.getMinutes())}:00` : "00:00:00";
        st.td = st.fd; st.tt = "23:59:59"; st.dflt = true;
      }
      st.fo = st.fd || today;
    }
    st.fo = clampDay(st, st.fo);
    const base = dparse(st.fo); st.vy = base.getFullYear(); st.vm = base.getMonth();
    return st;
  }
  function clampDay(st, sd) { if (st.min && sd < st.min) return st.min; if (st.max && sd > st.max) return st.max; return sd; }
  const outOfBounds = (st, sd) => (st.min && sd < st.min) || (st.max && sd > st.max);

  function rangeErr(st) {
    if (!st.fd) return "Date de début obligatoire";
    if (!st.td) return "Date de fin obligatoire";
    if (`${st.td}T${st.tt}` <= `${st.fd}T${st.ft}`) return "« À » doit être strictement après « Depuis »";
    return "";
  }
  function summary(st) {
    if (!st.fd) return "Choisissez le premier jour";
    const a = parseLocal(`${st.fd}T${st.ft}`), b = parseLocal(`${st.td}T${st.tt}`);
    const sh = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    let out = `${sh(a)} → ${sh(b)}`;
    const mins = Math.round((b - a) / 60000);
    if (mins > 0) {
      const dd = Math.floor(mins / 1440), hh = Math.floor(mins % 1440 / 60), mm = mins % 60, parts = [];
      if (dd) parts.push(`${dd} j`); if (hh) parts.push(`${hh} h`); if (!dd && mm) parts.push(`${mm} min`);
      if (parts.length) out += " · " + parts.join(" ");
    }
    return out;
  }

  // ── DOM ──────────────────────────────────────────────────
  function buildHtml(st) {
    const range = st.mode === "range";
    const times = range && st.withTime ? `<div class="adp-times">
      ${["from", "to"].map(sd => `<div class="adp-t" data-side="${sd}">
        <button type="button" class="adp-bdg" data-adp="side" data-side="${sd}" aria-pressed="${sd === "from"}" title="${sd === "from" ? "Le prochain jour choisi fixe la journée entière" : "Le prochain jour choisi fixe seulement la date de fin"}"><b>${sd === "from" ? "Depuis" : "À"}</b><span class="adp-bv"></span></button>
        <div class="adp-trow">
          <div class="adp-stp" title="Heures"><button type="button" data-adp="step" data-side="${sd}" data-u="h" data-dir="1" aria-label="Heure +1">${I_UP}</button><button type="button" data-adp="step" data-side="${sd}" data-u="h" data-dir="-1" aria-label="Heure −1">${I_DOWN}</button></div>
          <input class="adp-tin" data-adp="time" data-side="${sd}" type="text" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="HH:MM" aria-label="${sd === "from" ? "Heure de début" : "Heure de fin"} (HH:MM)">
          <div class="adp-stp" title="Minutes"><button type="button" data-adp="step" data-side="${sd}" data-u="m" data-dir="1" aria-label="Minutes +5">${I_UP}</button><button type="button" data-adp="step" data-side="${sd}" data-u="m" data-dir="-1" aria-label="Minutes −5">${I_DOWN}</button></div>
        </div>
      </div>`).join("")}
    </div>` : "";
    const foot = range ? `${times}
      <div class="adp-sum" aria-live="polite"></div>
      <div class="adp-hint" hidden></div>
      <div class="adp-err" data-k="note" role="alert" hidden></div>
      <div class="adp-err" data-k="err" role="alert" hidden></div>
      <div class="adp-act"><span class="adp-sp"></span>
        <button type="button" class="adp-btn" data-adp="cancel">Annuler</button>
        <button type="button" class="adp-btn adp-apply" data-adp="apply">Appliquer</button></div>` : "";
    return `<div class="adp-head">
        <button type="button" class="adp-nav" data-adp="nav" data-dir="-1" title="Mois précédent" aria-label="Mois précédent">${I_PREV}</button>
        <span class="adp-title" aria-live="polite"></span>
        <button type="button" class="adp-nav" data-adp="nav" data-dir="1" title="Mois suivant" aria-label="Mois suivant">${I_NEXT}</button>
      </div>
      <div class="adp-wd" aria-hidden="true"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
      <div class="adp-grid" role="group" aria-label="Calendrier"></div>${foot}`;
  }

  const q = (sel) => cur && cur.el.querySelector(sel);
  const focusDay = () => { const g = q(".adp-grid"); g && g.querySelector('[tabindex="0"]') && g.querySelector('[tabindex="0"]').focus(); };

  function paint() {
    if (!cur) return;
    const st = cur.st, grid = q(".adp-grid"), range = st.mode === "range", today = ymd(new Date());
    const hadFocus = grid.contains(document.activeElement);
    q(".adp-title").textContent = capFirst(new Date(st.vy, st.vm, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" }));
    const lead = (new Date(st.vy, st.vm, 1).getDay() + 6) % 7;                 // Monday first
    const lo = st.fd, hi = range ? st.td : "";
    let h = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(st.vy, st.vm, 1 - lead + i), sd = ymd(d), cls = ["adp-d"], dis = outOfBounds(st, sd);
      if (d.getMonth() !== st.vm) cls.push("out");
      if (sd === today) cls.push("today");
      if (dis) cls.push("dis");
      let sel;
      if (range) {
        if (lo && sd >= lo && sd <= hi) { cls.push("in"); if (sd === lo) cls.push("st"); if (sd === hi) cls.push("en"); }
        sel = (lo && sd === lo) || (st.td && sd === st.td);
      } else sel = !!lo && sd === lo;
      if (sel) cls.push("sel");
      const lbl = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      h += `<button type="button" class="${cls.join(" ")}" data-adp="day" data-d="${sd}" tabindex="${sd === st.fo ? 0 : -1}" aria-label="${lbl}"${dis ? " disabled" : ""}${sel ? ' aria-pressed="true"' : ""}${sd === today ? ' aria-current="date"' : ""}><span>${d.getDate()}</span></button>`;
    }
    grid.innerHTML = h;
    // month navigation stops at the bounds
    const prevLast = ymd(new Date(st.vy, st.vm, 0)), nextFirst = ymd(new Date(st.vy, st.vm + 1, 1));
    const np = q('[data-adp="nav"][data-dir="-1"]'), nn = q('[data-adp="nav"][data-dir="1"]');
    if (np) np.disabled = !!st.min && prevLast < st.min;
    if (nn) nn.disabled = !!st.max && nextFirst > st.max;
    if (hadFocus) focusDay();
    if (!range) return;

    ["from", "to"].forEach(sd => {                 // time fields (typing in a field is never overwritten while it has focus)
      const card = cur.el.querySelector(`.adp-t[data-side="${sd}"]`); if (!card) return;
      const set = sd === "from" ? !!st.fd : !!st.td, inp = card.querySelector(".adp-tin");
      if (document.activeElement !== inp) { inp.value = set ? (sd === "from" ? st.ft : st.tt).slice(0, 5) : ""; inp.removeAttribute("aria-invalid"); }
      inp.disabled = !set;
      card.querySelectorAll(".adp-stp button").forEach(b => { b.disabled = !set; });
      card.classList.toggle("off", !set); card.classList.toggle("act", st.active === sd);
      const bd = card.querySelector(".adp-bdg");
      bd.setAttribute("aria-pressed", String(st.active === sd));
      const v = bd.querySelector(".adp-bv");
      if (v) v.textContent = set ? `${st.fd && sd === "from" ? st.fd.slice(8, 10) + "/" + st.fd.slice(5, 7) : st.td.slice(8, 10) + "/" + st.td.slice(5, 7)} ${(sd === "from" ? st.ft : st.tt).slice(0, 5)}` : "";
    });
    q(".adp-sum").textContent = summary(st);
    const hint = q(".adp-hint"); hint.hidden = st.active !== "to"; hint.textContent = "Choisissez le dernier jour";
    const note = q('[data-k="note"]'); note.hidden = !st.note; note.textContent = st.note;
    const m = rangeErr(st), err = q('[data-k="err"]'), ap = q(".adp-apply");
    err.textContent = m; err.hidden = !m; ap.disabled = !!m;
  }

  function goto(sd, focus) {                       // move the roving focus (and the visible month) to a day
    const st = cur.st, d = dparse(sd);
    st.fo = sd; st.vy = d.getFullYear(); st.vm = d.getMonth();
    paint(); if (focus) focusDay();
  }
  function nav(dir) {                              // previous / next month, keeping the same day number when possible
    const st = cur.st, c = dparse(st.fo), first = new Date(st.vy, st.vm + dir, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    st.vy = first.getFullYear(); st.vm = first.getMonth();
    st.fo = clampDay(st, dstr(st.vy, st.vm, Math.min(c.getDate(), last)));
    paint();
  }
  function pick(sd) {
    const st = cur.st; if (outOfBounds(st, sd)) return;
    if (st.mode === "day") { finish({ value: sd }); return; }
    // Badge « Depuis » active (default): one click = that whole day (start = current time HH:mm, end = 23:59:59).
    // Badge « À » active: the click only moves the end date (23:59:59), refused when before the start; then back to « Depuis ».
    st.fo = sd; st.note = "";
    if (st.active === "to" && st.fd) {
      if (sd < st.fd) { st.note = "La date « À » ne peut pas précéder « Depuis »"; paint(); focusDay(); return; }
      st.td = sd; st.tt = "23:59:59"; st.active = "from";
    } else {
      const n = new Date();
      st.fd = sd; st.ft = st.withTime ? `${p2(n.getHours())}:${p2(n.getMinutes())}:00` : "00:00:00"; st.td = sd; st.tt = "23:59:59"; st.active = "from";
    }
    const d = dparse(sd); st.vy = d.getFullYear(); st.vm = d.getMonth();
    st.note = ""; paint(); focusDay();
  }
  function setSide(side) { const st = cur.st; st.active = side === "to" ? "to" : "from"; st.note = ""; paint(); }
  function step(side, unit, dir) {                 // ± 1 h / ± 5 min, clamped inside the day
    const st = cur.st, key = side === "from" ? "ft" : "tt";
    if (side === "from" ? !st.fd : !st.td) return;
    st[key] = tfmt(Math.max(0, Math.min(1439, tmin(st[key]) + (unit === "h" ? 60 : 5) * dir))) + SUF(key);
    st.note = ""; paint();
  }
  function timeInput(inp) {                        // typed HH:MM (also accepts 930 / 0930 / 9:30); invalid → previous value kept
    const st = cur.st, key = inp.dataset.side === "from" ? "ft" : "tt";
    const v = inp.value.trim(); const m = /^(\d{1,2})[:h.](\d{1,2})$/.exec(v) || /^(\d{1,2})(\d{2})$/.exec(v);
    if (!m || +m[1] > 23 || +m[2] > 59) { inp.setAttribute("aria-invalid", "true"); inp.value = st[key].slice(0, 5); return false; }
    inp.removeAttribute("aria-invalid"); inp.value = `${p2(+m[1])}:${p2(+m[2])}`; st[key] = inp.value + SUF(key);
    st.note = ""; paint(); return true;
  }
  function gridKey(e) {                            // arrows move by day / week, PageUp/PageDown by month, Home/End = week edges
    const st = cur.st, d = dparse(st.fo), mv = (n) => ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
    const wk = (d.getDay() + 6) % 7;
    let t = null;
    if (e.key === "ArrowLeft") t = mv(-1); else if (e.key === "ArrowRight") t = mv(1);
    else if (e.key === "ArrowUp") t = mv(-7); else if (e.key === "ArrowDown") t = mv(7);
    else if (e.key === "Home") t = mv(-wk); else if (e.key === "End") t = mv(6 - wk);
    else if (e.key === "PageUp" || e.key === "PageDown") {
      const n = new Date(d.getFullYear(), d.getMonth() + (e.key === "PageUp" ? -1 : 1), 1);
      t = dstr(n.getFullYear(), n.getMonth(), Math.min(d.getDate(), new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()));
    }
    if (t) { e.preventDefault(); goto(clampDay(st, t), true); }
  }
  function timeKey(e) {                            // Enter = validate the field and apply ; ↑/↓ = ± 1 h (caret before « : ») or ± 1 min
    const inp = e.target, st = cur.st;
    if (e.key === "Enter") { e.preventDefault(); if (timeInput(inp)) apply(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault(); if (!timeInput(inp)) return;
      const hours = (inp.selectionStart ?? 0) <= 2, caret = inp.selectionStart, key = inp.dataset.side === "from" ? "ft" : "tt";
      st[key] = tfmt(Math.max(0, Math.min(1439, tmin(st[key]) + (hours ? 60 : 1) * (e.key === "ArrowUp" ? 1 : -1)))) + SUF(key);
      paint(); inp.value = st[key].slice(0, 5); try { inp.setSelectionRange(caret, caret); } catch (_) {}
    }
  }

  // ── apply / close ────────────────────────────────────────
  function apply() {
    if (!cur || cur.st.mode !== "range" || rangeErr(cur.st)) return;
    const st = cur.st;
    finish({ value: { from: `${st.fd}T${st.ft}`, to: `${st.td}T${st.tt}` } });
  }
  function finish({ value }) {                     // onApply first, then close (the host may re-render its own UI inside onApply)
    const c = cur; if (!c) return;
    try { c.opts.onApply && c.opts.onApply(value); } catch (e) { console.error("[AppDatePicker] onApply:", e); }
    if (cur === c) close();
  }
  function close(refocus) {
    const c = cur; if (!c) return;
    cur = null;
    document.removeEventListener("click", c.onDocClick, true);
    document.removeEventListener("keydown", c.onDocKey, true);
    window.removeEventListener("resize", c.onReflow);
    window.removeEventListener("scroll", c.onReflow, true);
    c.el.remove(); c.bd.remove();
    if (c.anchor.hasAttribute && c.anchor.hasAttribute("aria-haspopup")) c.anchor.setAttribute("aria-expanded", "false");
    if (refocus && c.anchor.isConnected && c.anchor.focus) { try { c.anchor.focus(); } catch (_) {} }
    try { c.opts.onClose && c.opts.onClose(); } catch (e) { console.error("[AppDatePicker] onClose:", e); }
  }

  function place() {                               // desktop: under the anchor (flips up / to the right edge when needed); phone: CSS bottom sheet
    if (!cur) return;
    const el = cur.el;
    if (!cur.anchor.isConnected) { close(); return; }
    if (isPhone()) { el.style.left = el.style.top = el.style.right = el.style.bottom = ""; return; }
    const r = cur.anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, M = 8;
    let left = cur.opts.align === "center" ? r.left + (r.width - w) / 2 : r.left;           // align:"center" for a wide anchor (e.g. a full-width date bar)
    if (left + w > vw - M && cur.opts.align !== "center") left = r.right - w;
    left = Math.max(M, Math.min(left, vw - w - M));
    let top = r.bottom + 6;
    if (top + h > vh - M) top = (r.top - h - 6 >= M) ? r.top - h - 6 : Math.max(M, vh - h - M);
    el.style.left = left + "px"; el.style.top = top + "px"; el.style.right = "auto"; el.style.bottom = "auto";
  }

  function open(anchor, opts) {
    if (!anchor) return;
    if (cur && cur.anchor === anchor) { close(); return; }      // toggle
    if (cur) close();
    opts = opts || {};
    const st = initState(opts);
    const el = document.createElement("div");
    el.className = "adp"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", st.mode === "range" ? "Période" : "Date");
    el.dataset.mode = st.mode; el.innerHTML = buildHtml(st);
    const bd = document.createElement("div"); bd.className = "adp-bd";
    const c = cur = { anchor, opts, el, bd, st };

    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-adp]"); if (!b || b.disabled) return;
      const a = b.dataset.adp;
      if (a === "day") pick(b.dataset.d);
      else if (a === "nav") nav(+b.dataset.dir);
      else if (a === "step") step(b.dataset.side, b.dataset.u, +b.dataset.dir);
      else if (a === "side") setSide(b.dataset.side);
      else if (a === "apply") apply();
      else if (a === "cancel") close(true);
    });
    el.addEventListener("change", (e) => { if (e.target.dataset && e.target.dataset.adp === "time") timeInput(e.target); });
    el.addEventListener("keydown", (e) => {
      if (e.target.classList && e.target.classList.contains("adp-d")) gridKey(e);
      else if (e.target.dataset && e.target.dataset.adp === "time") timeKey(e);
    });
    bd.addEventListener("click", () => close());

    // outside click = cancel. composedPath: the calendar re-renders on click, so e.target may already be detached.
    c.onDocClick = (e) => {
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.includes(el) || path.includes(c.anchor)) return;   // a click on the anchor is the caller's toggle (open() on the same anchor closes)
      close();
    };
    c.onDocKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(true); } };
    c.onReflow = () => place();
    document.addEventListener("click", c.onDocClick, true);
    document.addEventListener("keydown", c.onDocKey, true);
    window.addEventListener("resize", c.onReflow);
    window.addEventListener("scroll", c.onReflow, true);

    document.body.appendChild(bd); document.body.appendChild(el);
    if (anchor.hasAttribute && anchor.hasAttribute("aria-haspopup")) anchor.setAttribute("aria-expanded", "true");
    paint(); place(); focusDay();
  }

  window.AppDatePicker = { open, close: () => close(), isOpen: () => !!cur };
})();

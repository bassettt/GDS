/* src/clientsView.js — CLIENTS section: search + client cards (modern grid) */

window.ClientsView = (() => {
  const PARTNER_FIELDS = [
    "id", "name", "ref",
    "phone", "mobile",
    "partner_custom_attribute_1",   // Cluster
    "partner_custom_attribute_2",   // Type de POS / محل
    "partner_brand_balance_html",   // ديون الزبون (حسب الماركة)
    "property_product_pricelist",
    "credit_limit",
    "partner_latitude",
    "partner_longitude",
    "state_id",
    "state",
  ];

  let seq = 0;
  let debounceTimer = null;
  let clients = []; // { id, name, ref, phone, typePos, cluster, pricelist, solde, creditLim, lat, lng }

  // ── Libellés courts pour Liste de prix & Cluster ─────────────────
  const PRICELIST_SHORT = {
    "Liste de prix publique (DZD)": "DETAIL",
    "Liste de prix BtoB Spéciale (DZD)": "BTOB SPECIALE",
    "Liste de prix BtoB (DZD)": "BTOB",
    "Liste de prix GMS A (BtoB) (DZD)": "BTOB GMS",
    "Liste de prix GMS (DZD)": "GMS",
    "Liste de prix Gros (DZD)": "GROS",
  };
  const CLUSTER_SHORT = {
    "GMS A": "GMS",
    "GROS B": "GROS",
    "GMS B": "GMS",
    "HORECA": "HORECA",
    "DÉTAIL": "DETAIL",
    "GROS A": "GROS",
  };
  const shortPricelist = (text) => PRICELIST_SHORT[text] || text;
  const shortCluster = (text) => CLUSTER_SHORT[text] || text;

  // ── Résolution de la liste de prix ───────────────────────────────
  // Le champ réel sur res.partner est "pricelist_ids" : un one2many vers
  // res.partner.pricelist (modèle intermédiaire avec pricelist_id, company_id,
  // warehouse_id, brand_id) — PAS le property_product_pricelist standard
  // d'Odoo. Le champ n'est éditable que si le client est "vérifié"
  // (readonly tant que state != "verified").
  async function _fetchPartnerPricelist(partnerId) {
    try {
      const rows = await rpc("res.partner.pricelist", "search_read",
        [[["partner_id", "=", partnerId]]],
        { fields: ["id", "pricelist_id", "company_id", "brand_id"], limit: 10 });
      if (!rows?.length) return null;
      // Habituellement une seule ligne par client ; on prend la première.
      const row = rows[0];
      return {
        rowId: row.id,
        pricelistId: Array.isArray(row.pricelist_id) ? row.pricelist_id[0] : false,
        pricelistName: Array.isArray(row.pricelist_id) ? row.pricelist_id[1] : "",
        companyId: Array.isArray(row.company_id) ? row.company_id[0] : (row.company_id || false),
        brandId: Array.isArray(row.brand_id) ? row.brand_id[0] : (row.brand_id || false),
      };
    } catch (e) {
      return null;
    }
  }

  // ── Garantit que la ligne res.partner.pricelist du client a bien
  // Société = SARL WAFA FAILE et Brand = WAFA par défaut : crée la ligne
  // si absente, ou complète les champs manquants si la ligne existe déjà
  // sans ces valeurs. Appelée à la création ET à l'édition d'un client. ──
  async function _ensurePartnerPricelistDefaults(partnerId, existing) {
    const [defCompanyId, defBrandId] = await Promise.all([_getDefaultCompanyId(), _getDefaultBrandId()]);
    if (!existing || !existing.rowId) {
      const created = await rpc("res.partner.pricelist", "create", [{
        partner_id: partnerId,
        company_id: defCompanyId || false,
        brand_id: defBrandId || false,
        pricelist_id: false,
      }], {});
      return _fetchPartnerPricelist(partnerId) || {
        rowId: created, pricelistId: false, pricelistName: "",
        companyId: defCompanyId || false, brandId: defBrandId || false,
      };
    }
    const missing = {};
    if (!existing.companyId && defCompanyId) missing.company_id = defCompanyId;
    if (!existing.brandId && defBrandId) missing.brand_id = defBrandId;
    if (Object.keys(missing).length) {
      await rpc("res.partner.pricelist", "write", [[existing.rowId], missing], {});
      return { ...existing, companyId: existing.companyId || defCompanyId, brandId: existing.brandId || defBrandId };
    }
    return existing;
  }

  // ── Écrit la liste de prix du client sur res.partner.pricelist ────
  async function _writePartnerPricelist(partnerId, pricelistId, existing) {
    if (existing?.rowId) {
      if (!pricelistId) {
        await rpc("res.partner.pricelist", "unlink", [[existing.rowId]], {});
      } else {
        await rpc("res.partner.pricelist", "write", [[existing.rowId], { pricelist_id: pricelistId }], {});
      }
      return;
    }
    if (!pricelistId) return; // rien à faire
    let companyId = existing?.companyId || null;
    if (!companyId) {
      const companies = await rpc("res.company", "search_read", [[]], { fields: ["id"], limit: 1 });
      companyId = companies?.[0]?.id || false;
    }
    await rpc("res.partner.pricelist", "create", [{
      partner_id: partnerId,
      pricelist_id: pricelistId,
      company_id: companyId,
    }], {});
  }

  // ── Résolution des valeurs par défaut Société/Brand pour la nouvelle
  // ligne res.partner.pricelist créée à la création d'un client (cache) ──
  let _defaultCompanyIdCache = null;
  let _defaultBrandIdCache = null;
  async function _getDefaultCompanyId() {
    if (_defaultCompanyIdCache) return _defaultCompanyIdCache;
    const rows = await rpc("res.company", "search_read",
      [[["name", "=", "SARL WAFA FAILE"]]], { fields: ["id"], limit: 1 });
    _defaultCompanyIdCache = rows?.[0]?.id || null;
    return _defaultCompanyIdCache;
  }
  async function _getDefaultBrandId() {
    if (_defaultBrandIdCache) return _defaultBrandIdCache;
    const rows = await rpc("product.brand", "search_read",
      [[["name", "=", "WAFA"]]], { fields: ["id"], limit: 1 });
    _defaultBrandIdCache = rows?.[0]?.id || null;
    return _defaultBrandIdCache;
  }

  async function rpc(model, method, args, kwargs, permission) {
    // "permission" (optionnel) : nom d'une clé de card.showXxx existante (déjà
    // activée pour les rôles concernés) à envoyer via X-App-Permission, pour
    // que enforcePermission.js applique le même contrôle d'accès que les
    // fonctionnalités similaires (Liste des BLs / Liste des paiements),
    // sans créer de nouvelle clé de permission non activée pour l'admin.
    const headers = { "Content-Type": "application/json" };
    if (permission) headers["X-App-Permission"] = permission;
    const resp = await fetch("/api/web/dataset/call_kw", {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0", method: "call", id: Date.now(),
        params: { model, method, args, kwargs: kwargs || {} },
      }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const json = await resp.json().catch(() => ({}));
    if (json?.error) throw new Error(json.error?.data?.message || json.error?.message || "Odoo error");
    return json.result;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function parseSoldeMarque(html) {
    if (!html) return "";
    const container = document.createElement("div");
    container.innerHTML = html;
    const text = container.textContent.replace(/\s+/g, " ").trim();
    // Marque unique : on extrait uniquement la valeur numérique (dernier nombre trouvé après ':' s'il y en a un)
    const afterColon = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1).trim() : text;
    const m = afterColon.match(/-?[\d\s.,]*\d/);
    return m ? m[0].trim() : afterColon;
  }

  function formatMoney(n) {
    if (n === null || n === undefined || n === "") return "";
    const num = Number(n);
    if (isNaN(num)) return String(n);
    const parts = num.toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return parts[0] + "," + parts[1];
  }

  // ماركة واحدة فقط → قيمة رقمية بسيطة منسّقة "12 986,00"
  // يدعم أي تنسيق دخل (فاصلة/نقطة كفاصل عشري أو كفاصل آلاف) ويحوّله دائمًا
  // لصيغة: آلاف بمسافة + فاصلة عشرية.
  function formatSolde(raw) {
    if (!raw) return raw;
    let s = String(raw).trim().replace(/\s/g, "");
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    const decSep = Math.max(lastComma, lastDot);
    let intPart, decPart;
    if (decSep > -1) {
      intPart = s.slice(0, decSep).replace(/[.,]/g, "");
      decPart = s.slice(decSep + 1).replace(/\D/g, "");
    } else {
      intPart = s.replace(/[.,]/g, "");
      decPart = "";
    }
    if (!/^-?\d+$/.test(intPart)) return raw;
    const neg = intPart.startsWith("-");
    if (neg) intPart = intPart.slice(1);
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    decPart = (decPart + "00").slice(0, 2);
    return (neg ? "-" : "") + intPart + "," + decPart;
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
  }

  /* ── Icons ─────────────────────────────────────────────── */
  const ic = {
    copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    ref: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
    phone: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.32 1.85.55 2.81.68A2 2 0 0 1 22 16.92z"/></svg>`,
    cluster: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    tag: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.59 13.41 13 21l-9-9V4h8l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="8" cy="8" r="1.5"/></svg>`,
    wallet: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/><path d="M16 12h5v4h-5a2 2 0 0 1 0-4z"/></svg>`,
    card: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
    pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    link: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    close: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    open: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    selectAll: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="8 12 11 15 16 9"/></svg>`,
    selectNone: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>`,
    selectInvert: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="12" y1="3" x2="12" y2="21"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity=".35"/></svg>`,
    edit: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`,
    route: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a4 4 0 0 0 4-4v0a4 4 0 0 0-4-4H9a4 4 0 0 1-4-4v0a4 4 0 0 1 4-4h6.5"/></svg>`,
    trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
    check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  };

  /* ── Toast ─────────────────────────────────────────────── */
  function toast(msg) {
    let el = document.getElementById("clientsToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientsToast";
      el.className = "clients-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("clients-toast--show");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.remove("clients-toast--show"), 1400);
  }

  function doCopy(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => toast("Copied ✓")).catch(() => {
      prompt("Copy:", text);
    });
  }

  /* ── Search ────────────────────────────────────────────── */

  // Recherche partagée (par nom/référence) utilisée par le dropdown et le panneau "Plusieurs"
  async function searchPartnersByName(q, limit) {
    const already = new Set(clients.map(c => c.id));
    const tokens  = q.split(/\s+/).filter(Boolean);
    const domain  = [["customer_rank", ">", 0]];
    tokens.forEach(t => domain.push("|", ["name", "ilike", t], ["ref", "ilike", t]));
    const rows = await rpc("res.partner", "search_read",
      [domain],
      { fields: ["id", "name", "ref"], limit });
    return (rows || []).filter(r => !already.has(r.id));
  }

  function initInput() {
    const input = document.getElementById("clientsSearchInput");
    const box   = document.getElementById("clientsSuggestions");
    if (!input || input._clientsBound) return;
    input._clientsBound = true;

    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(debounceTimer);
      if (q.length < 2) { hideSuggestions(); return; }
      debounceTimer = setTimeout(() => runSearch(q), 300);
    });
    input.addEventListener("blur", () => setTimeout(hideSuggestions, 150));

    function hideSuggestions() { box.style.display = "none"; box.innerHTML = ""; }

    async function runSearch(q, expanded) {
      const mySeq = ++seq;
      box.style.display = "block";
      box.innerHTML = `<div class="clients-sugg-msg">Searching...</div>`;
      try {
        const matches = await searchPartnersByName(q, expanded ? 200 : 10);
        if (mySeq !== seq) return;
        if (!matches.length) {
          box.innerHTML = `<div class="clients-sugg-msg">No results</div>`;
          return;
        }
        box.innerHTML = `
          <div class="clients-sugg-addall" style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);gap:8px;">
            <span style="font-size:11px;opacity:.7;">${matches.length}${expanded ? "" : "+"} résultat(s)</span>
            <div style="display:flex;gap:6px;">
              ${!expanded ? `<button class="ce-btn ce-btn--ghost" id="suggMoreBtn" type="button" style="padding:3px 10px;font-size:12px;">Plusieurs</button>` : ""}
              <button class="ce-btn ce-btn--ghost" id="suggAddAllBtn" type="button" style="padding:3px 10px;font-size:12px;">Tout ajouter</button>
            </div>
          </div>
        ` + `<div class="clients-sugg-list" style="${expanded ? "max-height:320px;overflow-y:auto;" : ""}">` + matches.map(r => `
          <div class="clients-suggestion-item" data-id="${r.id}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div class="clients-sugg-name">${esc(r.name || "")}</div>
              <div class="clients-sugg-ref">${esc(r.ref || "")}</div>
            </div>
            <button class="ce-btn ce-btn--ghost sugg-add-btn" data-id="${r.id}" type="button" style="padding:3px 8px;font-size:12px;flex-shrink:0;">+</button>
          </div>
        `).join("") + `</div>`;

        const moreBtn = box.querySelector("#suggMoreBtn");
        if (moreBtn) {
          moreBtn.addEventListener("mousedown", e => {
            e.preventDefault();
            e.stopPropagation();
            runSearch(q, true);
          });
        }

        box.querySelector("#suggAddAllBtn").addEventListener("mousedown", e => {
          e.preventDefault();
          matches.forEach(r => addPartner(r.id));
          input.value = "";
          hideSuggestions();
        });

        box.querySelectorAll(".clients-suggestion-item").forEach(el => {
          el.addEventListener("mousedown", e => {
            if (e.target.closest(".sugg-add-btn")) return; // géré séparément
            e.preventDefault();
            input.value = "";
            hideSuggestions();
            addPartner(+el.dataset.id);
          });
        });

        box.querySelectorAll(".sugg-add-btn").forEach(btn => {
          btn.addEventListener("mousedown", e => {
            e.preventDefault();
            e.stopPropagation();
            addPartner(+btn.dataset.id);
            btn.disabled = true;
            btn.textContent = "✓";
          });
        });
      } catch (err) {
        if (mySeq === seq) box.innerHTML = `<div class="clients-sugg-msg clients-sugg-msg--err">Error: ${esc(err.message)}</div>`;
      }
    }
  }

  /* ── Recherche par position (rayon autour de coordonnées) ────── */
  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Accepte "lat,lng" ou un lien Google Maps (place précise !3d!4d, @lat,lng, q=, etc.)
  function _parseCoordsRegex(text) {
    if (!text) return null;
    const s = String(text);

    // 1) Lien "place" Google Maps: coordonnées précises du point (!3d<lat>!4d<lng>)
    let m = s.match(/!3d(-?\d+\.\d+).*?!4d(-?\d+\.\d+)/);
    // 2) Sinon, centre de la carte "@lat,lng"
    if (!m) m = s.match(/@(-?\d{1,3}\.\d+),\+?(-?\d{1,3}\.\d+)/);
    // 3) Sinon, toute paire "lat,lng" présente dans le texte (saisie directe, ?q=lat,lng,
    //    /maps/search/lat,+lng ...). Le "+" facultatif gère l'espace encodé (%20 -> "+")
    //    que Google insère parfois entre la virgule et le signe "-" de la longitude.
    if (!m) m = s.match(/(-?\d{1,3}\.\d+)\s*,\s*\+?\s*(-?\d{1,3}\.\d+)/);

    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  }

  // Détecte les liens courts Google Maps (maps.app.goo.gl, goo.gl/maps) qui ne
  // contiennent aucune coordonnée directement dans l'URL — il faut suivre la
  // redirection côté serveur (CORS bloque un fetch direct depuis le navigateur).
  function _isShortMapsLink(text) {
    try {
      const u = new URL(String(text).trim());
      return /(^|\.)goo\.gl$/i.test(u.hostname) || /(^|\.)app\.goo\.gl$/i.test(u.hostname);
    } catch (e) { return false; }
  }

  async function _resolveShortMapsLink(url) {
    try {
      const resp = await fetch("/api/resolve-maps-url?url=" + encodeURIComponent(url), {
        method: "GET", credentials: "include",
      });
      if (!resp.ok) return null;
      const json = await resp.json().catch(() => null);
      return json?.url || null;
    } catch (e) { return null; }
  }

  // Point d'entrée utilisé partout: parse en local, et si le texte est un lien
  // court Google Maps sans coordonnées détectables, tente de le résoudre côté
  // serveur avant de réessayer le parsing.
  async function parseCoordsInput(text) {
    const direct = _parseCoordsRegex(text);
    if (direct) return direct;
    const trimmed = String(text || "").trim();
    if (_isShortMapsLink(trimmed)) {
      const resolved = await _resolveShortMapsLink(trimmed);
      if (resolved) return _parseCoordsRegex(resolved);
    }
    return null;
  }

  function initGeoSearch() {
    const toggleBtn = document.getElementById("clientsGeoToggleBtn");
    const panel = document.getElementById("clientsGeoPanel");
    if (!toggleBtn || !panel || toggleBtn._geoBound) return;
    toggleBtn._geoBound = true;

    panel.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);">
        <div class="ce-field" style="margin:0;flex:1;min-width:220px;">
          <label>Coordonnées (lat,lng) ou lien Google Maps</label>
          <input type="text" id="geoCoords" class="ce-input" placeholder="35.6971,-0.6308 ou https://maps.google.com/..."/>
        </div>
        <div class="ce-field" style="margin:0;min-width:100px;">
          <label>Rayon (m)</label>
          <input type="text" id="geoRadius" class="ce-input" value="5000"/>
        </div>
        <button class="ce-btn ce-btn--ghost" id="geoUseMyLocBtn" type="button">Ma position</button>
        <button class="ce-btn ce-btn--primary" id="geoSearchBtn" type="button">Chercher</button>
      </div>
      <div id="geoResults" style="margin-top:8px;"></div>
    `;

    const coordsInput = panel.querySelector("#geoCoords");
    const radiusInput = panel.querySelector("#geoRadius");
    const resultsBox = panel.querySelector("#geoResults");
    const useMyLocBtn = panel.querySelector("#geoUseMyLocBtn");
    const searchBtn = panel.querySelector("#geoSearchBtn");

    toggleBtn.addEventListener("click", () => {
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });

    useMyLocBtn.addEventListener("click", () => {
      if (!navigator.geolocation) { alert("Géolocalisation non disponible"); return; }
      useMyLocBtn.disabled = true;
      useMyLocBtn.textContent = "...";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          coordsInput.value = `${pos.coords.latitude.toFixed(6)},${pos.coords.longitude.toFixed(6)}`;
          useMyLocBtn.disabled = false;
          useMyLocBtn.textContent = "Ma position";
        },
        () => {
          alert("Impossible de récupérer la position");
          useMyLocBtn.disabled = false;
          useMyLocBtn.textContent = "Ma position";
        }
      );
    });

    async function runGeoSearch() {
      const coords = await parseCoordsInput(coordsInput.value);
      const radiusM = Number(String(radiusInput.value).replace(",", "."));

      if (!coords) { resultsBox.innerHTML = `<div class="clients-sugg-msg clients-sugg-msg--err">Coordonnées invalides</div>`; return; }
      if (isNaN(radiusM) || radiusM <= 0) { resultsBox.innerHTML = `<div class="clients-sugg-msg clients-sugg-msg--err">Rayon invalide</div>`; return; }

      const { lat, lng } = coords;

      searchBtn.disabled = true;
      searchBtn.textContent = "Recherche...";
      resultsBox.innerHTML = `<div class="clients-sugg-msg">Searching...</div>`;

      try {
        // Boîte englobante pour limiter la requête, puis filtrage précis via Haversine
        const latDelta = radiusM / 111000;
        const lngDelta = radiusM / (111000 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
        const domain = [
          ["customer_rank", ">", 0],
          ["partner_latitude", ">=", lat - latDelta],
          ["partner_latitude", "<=", lat + latDelta],
          ["partner_longitude", ">=", lng - lngDelta],
          ["partner_longitude", "<=", lng + lngDelta],
        ];
        const rows = await rpc("res.partner", "search_read", [domain],
          { fields: ["id", "name", "ref", "partner_latitude", "partner_longitude"], limit: 500 });

        const withDist = (rows || [])
          .filter(r => r.partner_latitude && r.partner_longitude)
          .map(r => ({ ...r, _dist: haversineM(lat, lng, r.partner_latitude, r.partner_longitude) }))
          .filter(r => r._dist <= radiusM)
          .sort((a, b) => a._dist - b._dist);

        if (!withDist.length) {
          resultsBox.innerHTML = `<div class="clients-sugg-msg">Aucun client trouvé dans ce rayon</div>`;
          return;
        }

        resultsBox.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-size:12px;opacity:.7;">${withDist.length} client(s) trouvé(s)</span>
            <button class="ce-btn ce-btn--ghost" id="geoAddAllBtn" type="button" style="padding:4px 10px;font-size:12px;">Tout ajouter</button>
          </div>
          <div style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">
            ${withDist.map(r => `
              <div class="clients-suggestion-item geo-result-item" data-id="${r.id}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                <div>
                  <div class="clients-sugg-name">${esc(r.name || "")}</div>
                  <div class="clients-sugg-ref">${esc(r.ref || "")} · ${r._dist.toFixed(0)} m</div>
                </div>
                <button class="ce-btn ce-btn--ghost geo-add-btn" data-id="${r.id}" type="button" style="padding:3px 8px;font-size:12px;">+</button>
              </div>
            `).join("")}
          </div>
        `;

        resultsBox.querySelector("#geoAddAllBtn").addEventListener("click", () => {
          withDist.forEach(r => addPartner(r.id));
        });
        resultsBox.querySelectorAll(".geo-add-btn").forEach(btn => {
          btn.addEventListener("click", () => addPartner(+btn.dataset.id));
        });
      } catch (err) {
        resultsBox.innerHTML = `<div class="clients-sugg-msg clients-sugg-msg--err">Error: ${esc(err.message)}</div>`;
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = "Chercher";
      }
    }

    searchBtn.addEventListener("click", runGeoSearch);
  }

  async function addPartner(id) {
    if (clients.find(c => c.id === id)) return;
    clients.push({ id, loading: true });
    render();

    // Timeout: si le chargement dépasse 15s, on marque le client en erreur
    const timeoutId = setTimeout(() => {
      const idx = clients.findIndex(c => c.id === id && c.loading);
      if (idx !== -1) {
        clients[idx] = { id, loadError: "Timeout — click to retry" };
        render();
      }
    }, 15000);

    try {
      const rows = await rpc("res.partner", "search_read", [[["id", "=", id]]], { fields: PARTNER_FIELDS });
      const idx = clients.findIndex(c => c.id === id);
      if (idx === -1) { clearTimeout(timeoutId); return; }
      if (!rows?.length) { clearTimeout(timeoutId); clients.splice(idx, 1); render(); return; }
      const p = rows[0];
      const partnerPricelist = await _fetchPartnerPricelist(id);
      clearTimeout(timeoutId);
      const idx2 = clients.findIndex(c => c.id === id);
      if (idx2 === -1) return;
      clients[idx2] = {
        id: p.id,
        name: p.name || "",
        ref: p.ref || "",
        phone: p.phone || "",
        typePos: p.partner_custom_attribute_2 ? p.partner_custom_attribute_2[1] : "",
        typePosId: p.partner_custom_attribute_2 ? p.partner_custom_attribute_2[0] : false,
        cluster: p.partner_custom_attribute_1 ? p.partner_custom_attribute_1[1] : "",
        clusterId: p.partner_custom_attribute_1 ? p.partner_custom_attribute_1[0] : false,
        pricelist: partnerPricelist ? partnerPricelist.pricelistName : "",
        pricelistId: partnerPricelist ? partnerPricelist.pricelistId : false,
        pricelistCompanyId: partnerPricelist ? partnerPricelist.companyId : false,
        pricelistBrandId: partnerPricelist ? partnerPricelist.brandId : false,
        pricelistRowId: partnerPricelist ? partnerPricelist.rowId : null,
        solde: formatSolde(parseSoldeMarque(p.partner_brand_balance_html)),
        creditLim: formatMoney(p.credit_limit),
        lat: p.partner_latitude || "",
        lng: p.partner_longitude || "",
        state: p.state_id ? String(p.state_id[1]).replace(/\s*\([^)]*\)\s*$/, "").trim() : "",
        verifState: p.state || "",
      };
      render();
    } catch (err) {
      clearTimeout(timeoutId);
      const idx = clients.findIndex(c => c.id === id);
      if (idx !== -1) clients[idx] = { id, loadError: err.message || "Failed to load" };
      render();
    }
  }

  function removePartner(id) {
    clients = clients.filter(c => c.id !== id);
    selected.delete(id);
    render();
  }

  /* ── Erreur de formulaire : s'affiche puis disparaît automatiquement
     (après correction/nouvelle saisie ou après quelques secondes) ────── */
  function _showFieldError(errBox, msg, ms = 4000) {
    if (!errBox) return;
    clearTimeout(errBox._hideTimer);
    errBox.textContent = msg;
    errBox.style.display = "block";
    errBox._hideTimer = setTimeout(() => { errBox.style.display = "none"; }, ms);
  }
  function _hideFieldError(errBox) {
    if (!errBox) return;
    clearTimeout(errBox._hideTimer);
    errBox.style.display = "none";
  }

  /* ── Photo : helpers partagés (fichier + coller depuis le presse-papiers) ── */

  // Applique un File image (venant d'un <input type=file> ou du presse-papiers)
  // à un aperçu + stocke le base64 en attente sur el.dataset.pendingImage.
  function _applyImageFileToPreview(file, { el, preview, removeBtn, errBox }) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      _showFieldError(errBox, "Image trop volumineuse (max 5 Mo)");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result; // "data:image/png;base64,...."
      el.dataset.pendingImage = dataUrl.split(",")[1] || "";
      preview.style.backgroundImage = `url("${dataUrl}")`;
      preview.textContent = "";
      if (removeBtn) removeBtn.style.display = "inline-flex";
      _hideFieldError(errBox);
    };
    reader.readAsDataURL(file);
  }

  // ── Formatage téléphone en direct : "0000 00 00 00" (groupes 4-2-2-2) ──
  function _formatPhoneDisplay(raw) {
    const digits = String(raw || "").replace(/\D/g, "").slice(0, 10);
    const groups = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8), digits.slice(8, 10)]
      .filter(g => g.length);
    return groups.join(" ");
  }
  function _bindPhoneFormatting(input) {
    if (!input || input._phoneFormatBound) return;
    input._phoneFormatBound = true;
    input.addEventListener("input", () => {
      const pos = input.selectionStart;
      const before = input.value.length;
      input.value = _formatPhoneDisplay(input.value);
      const after = input.value.length;
      try { input.setSelectionRange(pos + (after - before), pos + (after - before)); } catch (_) {}
    });
  }

  // Coller une image copiée (Ctrl+V) via l'API Async Clipboard, avec repli sur
  // un écouteur "paste" classique si l'accès direct au presse-papiers échoue.
  async function _pasteImageFromClipboard(opts) {
    const { errBox } = opts;
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find(t => t.startsWith("image/"));
          if (imgType) {
            const blob = await item.getType(imgType);
            _applyImageFileToPreview(blob, opts);
            return true;
          }
        }
      }
    } catch (e) { /* accès presse-papiers refusé/non supporté → repli ci-dessous */ }
    _showFieldError(errBox, "Aucune image dans le presse-papiers (essayez Ctrl+V sur la photo)", 3500);
    return false;
  }

  // ── Détection du contenu collé (URL/coords vs téléphone) ──────────
  function _pastedLooksLikeCoords(text) {
    const t = text.trim();
    if (/^https?:\/\//i.test(t)) return true;                    // tout lien http(s) (Google Maps, lien court, etc.)
    if (/google\.com\/maps|maps\.app\.goo\.gl/i.test(t)) return true;
    if (/^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(t)) return true; // "35.6971,-0.6308"
    return false;
  }
  function _pastedLooksLikePhone(text) {
    const t = text.trim();
    if (!t || _pastedLooksLikeCoords(t)) return false;
    if (!/^[0-9+\s().-]+$/.test(t)) return false;                // que des chiffres/symboles de téléphone
    return t.replace(/\D/g, "").length >= 6;                     // au moins 6 chiffres
  }
  function _setFieldValue(input, value) {
    if (!input) return false;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Écoute "paste" (Ctrl+V) au niveau du document tant que la modale (edit/create)
  // est ouverte — capte l'image collée où que le focus soit dans la modale.
  // Si ce n'est pas une image, détecte le contenu texte et le place au bon endroit :
  // lien/coordonnées → champ Coordonnées, numéro → champ Téléphone.
  function _bindPasteListener(el, opts) {
    if (el._pasteBound) return;
    el._pasteBound = true;
    document.addEventListener("paste", (e) => {
      if (!el.classList.contains("ch-modal--open")) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (const item of items) {
          if (item.type && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) { _applyImageFileToPreview(file, opts); e.preventDefault(); }
            return;
          }
        }
      }
      const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
      if (!text.trim()) return;
      const t = text.trim();
      if (_pastedLooksLikeCoords(t)) {
        const coordsField = el.querySelector("#ccCoords, #ceCoords");
        if (_setFieldValue(coordsField, t)) { e.preventDefault(); toast("📍 Coordonnées collées"); }
        return;
      }
      if (_pastedLooksLikePhone(t)) {
        const phoneField = el.querySelector("#ccPhone, #cePhone");
        if (_setFieldValue(phoneField, _formatPhoneDisplay(t))) { e.preventDefault(); toast("📞 Téléphone collé"); }
        return;
      }
      // sinon : comportement par défaut (ex: coller le nom dans le champ actif)
    });
  }

  /* ── Edit client (name / type de POS / phone / coords) ──────────── */

  // يحوّل domain من صيغة Python (tuples بأقواس + quotes مفردة) إلى مصفوفة JS قابلة للاستخدام
  function parsePyDomain(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    try {
      const jsonish = String(d).replace(/\(/g, "[").replace(/\)/g, "]").replace(/'/g, '"');
      const parsed = JSON.parse(jsonish);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  // Les deux champs (Cluster & Type de POS) partagent le même modèle
  // "model.custom.attribute.value" en base — on les distingue via
  // attribute_id.field_name. On fixe donc le domaine explicitement au
  // lieu de compter sur le domain dynamique renvoyé par fields_get.
  const CUSTOM_ATTR_MODEL = "model.custom.attribute.value";

  function customAttrDomain(fieldName) {
    return [
      ["attribute_id.field_name", "=", fieldName],
      ["attribute_id.model_id.model", "=", "res.partner"],
    ];
  }

  let _typePosComodel = null;

  async function getTypePosComodel() {
    if (_typePosComodel) return _typePosComodel;
    _typePosComodel = { model: CUSTOM_ATTR_MODEL, domain: customAttrDomain("partner_custom_attribute_2") };
    return _typePosComodel;
  }

  let _clusterComodel = null;

  async function getClusterComodel() {
    if (_clusterComodel) return _clusterComodel;
    _clusterComodel = { model: CUSTOM_ATTR_MODEL, domain: customAttrDomain("partner_custom_attribute_1") };
    return _clusterComodel;
  }

  function editModalEl() {
    let el = document.getElementById("clientEditModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientEditModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box ch-modal-box--sm">
          <div class="ch-modal-head">
            <div class="ch-modal-title">Modifier le client</div>
            <button class="ch-modal-close" title="Close">${ic.close}</button>
          </div>
          <div class="ch-modal-body">
            <div class="ce-field">
              <label>Photo</label>
              <div class="ce-photo-row">
                <div class="ce-photo-preview" id="cePhotoPreview"></div>
                <div class="ce-photo-actions">
                  <button type="button" class="ce-btn ce-btn--ghost" id="cePhotoBtn">Changer la photo</button>
                  <button type="button" class="ce-btn ce-btn--ghost" id="cePhotoPasteBtn" title="Coller une image copiée (Ctrl+V)">Coller</button>
                  <button type="button" class="ce-btn ce-btn--ghost ce-btn--danger" id="cePhotoRemoveBtn" style="display:none;">Supprimer</button>
                </div>
                <input type="file" id="cePhotoInput" accept="image/png,image/jpeg,image/webp" style="display:none;"/>
              </div>
            </div>
            <div class="ce-field">
              <label>Nom</label>
              <input type="text" id="ceName" class="ce-input"/>
            </div>
            <div class="ce-field">
              <label>Type de POS / محل</label>
              <select id="ceTypePos" class="ce-input"></select>
            </div>
            <div class="ce-field">
              <label>Cluster</label>
              <select id="ceCluster" class="ce-input"></select>
            </div>
            <div class="ce-field">
              <label>Téléphone</label>
              <input type="text" id="cePhone" class="ce-input"/>
            </div>
            <div class="ce-field">
              <label>Liste de prix</label>
              <select id="cePricelist" class="ce-input"></select>
              <div id="cePricelistHint" style="display:none;font-size:11px;color:#d97706;margin-top:4px;">
                Modifiable uniquement pour un client vérifié
              </div>
            </div>
            <div class="ce-field">
              <label>Coordonnées (lat,lng ou lien Google Maps)</label>
              <input type="text" id="ceCoords" class="ce-input" placeholder="35.6971,-0.6308 ou https://maps.google.com/..."/>
            </div>
            <div class="ce-error" id="ceError" style="display:none;"></div>
          </div>
          <div class="ch-modal-foot ch-modal-foot--right">
            <button class="ce-btn ce-btn--ghost" id="ceCancelBtn">Annuler</button>
            <button class="ce-btn ce-btn--primary" id="ceSaveBtn">Enregistrer</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeEditModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeEditModal);
      el.querySelector("#ceCancelBtn").addEventListener("click", closeEditModal);

      // ── Photo : sélection d'un fichier → aperçu immédiat (base64 en
      // attente, pas encore envoyé) ; "Supprimer" efface la photo (false) ──
      const photoInput = el.querySelector("#cePhotoInput");
      const photoBtn = el.querySelector("#cePhotoBtn");
      const photoRemoveBtn = el.querySelector("#cePhotoRemoveBtn");
      photoBtn.addEventListener("click", () => photoInput.click());
      photoInput.addEventListener("change", () => {
        const file = photoInput.files && photoInput.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          const errBox = el.querySelector("#ceError");
          _showFieldError(errBox, "Image trop volumineuse (max 5 Mo)");
          photoInput.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result; // "data:image/png;base64,...."
          el.dataset.pendingImage = dataUrl.split(",")[1] || "";
          const preview = el.querySelector("#cePhotoPreview");
          preview.style.backgroundImage = `url("${dataUrl}")`;
          preview.textContent = "";
          photoRemoveBtn.style.display = "inline-flex";
        };
        reader.readAsDataURL(file);
      });
      photoRemoveBtn.addEventListener("click", () => {
        el.dataset.pendingImage = "__REMOVE__";
        photoInput.value = "";
        const preview = el.querySelector("#cePhotoPreview");
        preview.style.backgroundImage = "";
        const c = clients.find(x => x.id === Number(el.dataset.clientId));
        preview.textContent = c ? esc(initials(c.name)) : "";
        photoRemoveBtn.style.display = "none";
      });

      // ── Coller une image copiée (bouton + Ctrl+V pendant que la modale est ouverte) ──
      const photoPasteBtn = el.querySelector("#cePhotoPasteBtn");
      const pasteOpts = () => ({
        el, preview: el.querySelector("#cePhotoPreview"),
        removeBtn: el.querySelector("#cePhotoRemoveBtn"), errBox: el.querySelector("#ceError"),
      });
      photoPasteBtn.addEventListener("click", () => _pasteImageFromClipboard(pasteOpts()));
      _bindPasteListener(el, pasteOpts());
    }
    return el;
  }

  function closeEditModal() {
    const el = document.getElementById("clientEditModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openEditModal(clientId) {
    const c = clients.find(x => x.id === clientId);
    if (!c || c.loading) return;
    const el = editModalEl();
    el.classList.add("ch-modal--open");
    el.dataset.clientId = String(clientId);
    delete el.dataset.pendingImage;
    const errBox = el.querySelector("#ceError");
    errBox.style.display = "none";

    el.querySelector("#ceName").value = c.name || "";
    const cePhoneInp = el.querySelector("#cePhone");
    _bindPhoneFormatting(cePhoneInp);
    cePhoneInp.value = _formatPhoneDisplay(c.phone || "");
    el.querySelector("#ceCoords").value = (c.lat && c.lng) ? `${c.lat},${c.lng}` : "";

    // ── Photo actuelle : chargée en petite taille (image_128) pour
    // l'aperçu ; l'image pleine résolution n'est envoyée que si l'utilisateur
    // en choisit une nouvelle (on ne réécrit pas image_1920 inutilement) ──
    const photoInput = el.querySelector("#cePhotoInput");
    const photoPreview = el.querySelector("#cePhotoPreview");
    const photoRemoveBtn = el.querySelector("#cePhotoRemoveBtn");
    photoInput.value = "";
    photoPreview.style.backgroundImage = "";
    photoPreview.textContent = esc(initials(c.name));
    photoRemoveBtn.style.display = "none";
    try {
      const rows = await rpc("res.partner", "read", [[clientId]], { fields: ["image_128"] });
      const img128 = rows?.[0]?.image_128;
      if (img128) {
        photoPreview.style.backgroundImage = `url("data:image/png;base64,${img128}")`;
        photoPreview.textContent = "";
        photoRemoveBtn.style.display = "inline-flex";
      }
    } catch (e) { /* silent — l'aperçu reste sur les initiales */ }

    const typePosSel = el.querySelector("#ceTypePos");
    typePosSel.innerHTML = `<option value="">-- Aucun --</option>`;
    const comodel = await getTypePosComodel();
    if (comodel) {
      try {
        const rows = await rpc(comodel.model, "search_read", [comodel.domain], { fields: ["id", "display_name"], limit: 200 });
        (rows || []).forEach(r => {
          typePosSel.insertAdjacentHTML("beforeend", `<option value="${r.id}">${esc(r.display_name)}</option>`);
        });
      } catch (e) { /* silent */ }
    }
    typePosSel.value = c.typePosId || "";

    const clusterSel = el.querySelector("#ceCluster");
    clusterSel.innerHTML = `<option value="">-- Aucun --</option>`;
    const clusterComodel = await getClusterComodel();
    if (clusterComodel) {
      try {
        const rows = await rpc(clusterComodel.model, "search_read", [clusterComodel.domain], { fields: ["id", "display_name"], limit: 200 });
        (rows || []).forEach(r => {
          clusterSel.insertAdjacentHTML("beforeend", `<option value="${r.id}">${esc(r.display_name)}</option>`);
        });
      } catch (e) { /* silent */ }
    }
    clusterSel.value = c.clusterId || "";

    // ── S'assure que Société/Brand par défaut sont bien renseignés sur la
    // ligne pricelist du client (même si elle existait déjà sans ces valeurs) ──
    try {
      const ensured = await _ensurePartnerPricelistDefaults(clientId, {
        rowId: c.pricelistRowId, companyId: c.pricelistCompanyId, brandId: c.pricelistBrandId,
      });
      c.pricelistRowId = ensured.rowId;
      c.pricelistCompanyId = ensured.companyId;
      c.pricelistBrandId = ensured.brandId;
    } catch (e) { /* silent */ }

    const pricelistSel = el.querySelector("#cePricelist");
    const pricelistHint = el.querySelector("#cePricelistHint");
    pricelistSel.innerHTML = `<option value="">-- Aucune --</option>`;
    try {
      const plRows = await rpc("product.pricelist", "search_read", [[]],
        { fields: ["id", "display_name"], limit: 200, context: { active_test: false } });
      (plRows || []).forEach(r => {
        pricelistSel.insertAdjacentHTML("beforeend", `<option value="${r.id}">${esc(r.display_name)}</option>`);
      });
    } catch (e) { /* silent */ }
    pricelistSel.value = c.pricelistId || "";
    const pricelistLocked = c.verifState !== "verified";
    pricelistSel.disabled = pricelistLocked;
    pricelistHint.style.display = pricelistLocked ? "block" : "none";

    const saveBtn = el.querySelector("#ceSaveBtn");
    saveBtn.onclick = async () => {
      errBox.style.display = "none";
      const name = el.querySelector("#ceName").value.trim();
      const typePosText = typePosSel.selectedOptions[0] ? typePosSel.selectedOptions[0].textContent : "";
      const clusterText = clusterSel.selectedOptions[0] ? clusterSel.selectedOptions[0].textContent : "";
      const phone = el.querySelector("#cePhone").value.trim();
      const pricelistId = pricelistSel.value ? Number(pricelistSel.value) : false;
      const pricelistText = pricelistSel.selectedOptions[0] ? pricelistSel.selectedOptions[0].textContent : "";
      const coordsRaw = el.querySelector("#ceCoords").value.trim();

      if (!name) { _showFieldError(errBox, "Le nom est requis"); return; }

      const typePosId = typePosSel.value ? Number(typePosSel.value) : false;
      const clusterId = clusterSel.value ? Number(clusterSel.value) : false;

      let lat = c.lat, lng = c.lng;
      if (coordsRaw !== "") {
        const parsed = await parseCoordsInput(coordsRaw);
        if (!parsed) {
          _showFieldError(errBox, "Coordonnées invalides");
          return;
        }
        lat = parsed.lat; lng = parsed.lng;
      } else {
        lat = 0; lng = 0;
      }

      const vals = {
        name,
        phone: phone || false,
        partner_latitude: lat,
        partner_longitude: lng,
      };
      if (comodel) vals.partner_custom_attribute_2 = typePosId;
      if (clusterComodel) vals.partner_custom_attribute_1 = clusterId;

      const pendingImage = el.dataset.pendingImage;
      if (pendingImage === "__REMOVE__") vals.image_1920 = false;
      else if (pendingImage) vals.image_1920 = pendingImage;

      saveBtn.disabled = true;
      saveBtn.textContent = "Enregistrement...";
      try {
        await rpc("res.partner", "write", [[clientId], vals], {});
        if (pricelistId !== (c.pricelistId || false)) {
          if (c.verifState !== "verified") {
            throw new Error("La liste de prix n'est modifiable que pour un client vérifié");
          }
          await _writePartnerPricelist(clientId, pricelistId, {
            rowId: c.pricelistRowId,
            companyId: c.pricelistCompanyId,
          });
          // Relit la valeur réelle pour garder l'état local synchronisé
          // avec ce qui est effectivement en base (id de ligne inclus).
          const refreshed = await _fetchPartnerPricelist(clientId);
          c.pricelistId = refreshed ? refreshed.pricelistId : false;
          c.pricelist = refreshed ? refreshed.pricelistName : "";
          c.pricelistCompanyId = refreshed ? refreshed.companyId : false;
          c.pricelistRowId = refreshed ? refreshed.rowId : null;
        }
        c.name = name;
        c.phone = phone;
        c.lat = lat || "";
        c.lng = lng || "";
        if (comodel) {
          c.typePosId = typePosId;
          c.typePos = typePosId ? typePosText : "";
        }
        if (clusterComodel) {
          c.clusterId = clusterId;
          c.cluster = clusterId ? clusterText : "";
        }
        delete el.dataset.pendingImage;
        closeEditModal();
        render();
        toast("Modifié ✓");
      } catch (err) {
        _showFieldError(errBox, "Erreur: " + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Enregistrer";
      }
    };
  }

  /* ── Create client (nouveau) — nom(MAJUSCULES)/cluster/type pos/coords requis,
     route optionnelle (même flux que "Ajouter à une route") ─────────── */
  function createModalEl() {
    let el = document.getElementById("clientCreateModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientCreateModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box ch-modal-box--sm">
          <div class="ch-modal-head">
            <div class="ch-modal-title">Nouveau client</div>
            <button class="ch-modal-close" title="Close">${ic.close}</button>
          </div>
          <div class="ch-modal-body">
            <div class="ce-field">
              <label>Photo</label>
              <div class="ce-photo-row">
                <div class="ce-photo-preview" id="ccPhotoPreview"></div>
                <div class="ce-photo-actions">
                  <button type="button" class="ce-btn ce-btn--ghost" id="ccPhotoBtn">Ajouter une photo</button>
                  <button type="button" class="ce-btn ce-btn--ghost" id="ccPhotoPasteBtn" title="Coller une image copiée (Ctrl+V)">Coller</button>
                  <button type="button" class="ce-btn ce-btn--ghost ce-btn--danger" id="ccPhotoRemoveBtn" style="display:none;">Supprimer</button>
                </div>
                <input type="file" id="ccPhotoInput" accept="image/png,image/jpeg,image/webp" style="display:none;"/>
              </div>
            </div>
            <div class="ce-field">
              <label>Nom *</label>
              <input type="text" id="ccName" class="ce-input" placeholder="NOM DU CLIENT"/>
            </div>
            <div class="ce-field">
              <label>Cluster *</label>
              <select id="ccCluster" class="ce-input"></select>
            </div>
            <div class="ce-field">
              <label>Type de POS / محل *</label>
              <select id="ccTypePos" class="ce-input"></select>
            </div>
            <div class="ce-field">
              <label>Coordonnées * (lat,lng ou lien Google Maps)</label>
              <input type="text" id="ccCoords" class="ce-input" placeholder="35.6971,-0.6308 ou https://maps.google.com/..."/>
            </div>
            <div class="ce-field">
              <label>Téléphone *</label>
              <input type="text" id="ccPhone" class="ce-input" placeholder="0555 12 34 56"/>
            </div>
            <select id="ccWarehouses" class="ce-input" multiple style="display:none;"></select>

            <div class="ce-field" style="border-top:1px solid var(--border,#333);padding-top:10px;margin-top:4px">
              <label>Route (optionnel)</label>
              <div style="position:relative">
                <input type="text" id="ccRouteInput" class="ce-input" placeholder="Nom de la route…" autocomplete="off"/>
                <div id="ccRouteDropdown" class="ap-dropdown" style="display:none"></div>
              </div>
              <div id="ccSelectedRoute" style="display:none;margin-top:6px"></div>

              <div id="ccCopyWrap" style="display:none">
                <span id="ccCopyPlanningLink"
                  style="display:inline-block;margin-top:5px;font-size:10px;color:var(--accent);cursor:pointer;text-decoration:underline">
                  Copier planning d'un client existant
                </span>
                <div id="ccCopyPanel" style="display:none;position:relative;margin-top:5px">
                  <input type="text" id="ccCopyInput" class="ce-input" placeholder="Chercher un client de cette route…" autocomplete="off"/>
                  <div id="ccCopyDropdown" class="ap-dropdown" style="display:none"></div>
                </div>
              </div>

              <div id="ccSchedule" style="display:none;margin-top:10px">
                <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Semaine(s)</div>
                <div id="ccWeeks" style="display:flex;gap:10px;margin-bottom:8px"></div>
                <div style="font-size:11px;color:var(--text2);margin-bottom:5px">Jour(s)</div>
                <div id="ccDays" style="display:flex;flex-wrap:wrap;gap:8px"></div>
              </div>
            </div>

            <div class="ce-error" id="ccError" style="display:none;"></div>
          </div>
          <div class="ch-modal-foot ch-modal-foot--right">
            <button class="ce-btn ce-btn--ghost" id="ccCancelBtn">Annuler</button>
            <button class="ce-btn ce-btn--primary" id="ccSaveBtn">Créer</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeCreateModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeCreateModal);
      el.querySelector("#ccCancelBtn").addEventListener("click", closeCreateModal);

      // اسم الزبون: تحويل تلقائي لحروف كبيرة أثناء الكتابة
      el.querySelector("#ccName").addEventListener("input", (e) => {
        const pos = e.target.selectionStart;
        e.target.value = e.target.value.toUpperCase();
        try { e.target.setSelectionRange(pos, pos); } catch (_) {}
      });

      // ── Photo : sélection d'un fichier → aperçu immédiat (base64 en attente) ──
      const ccPhotoInput = el.querySelector("#ccPhotoInput");
      const ccPhotoBtn = el.querySelector("#ccPhotoBtn");
      const ccPhotoRemoveBtn = el.querySelector("#ccPhotoRemoveBtn");
      ccPhotoBtn.addEventListener("click", () => ccPhotoInput.click());
      ccPhotoInput.addEventListener("change", () => {
        const file = ccPhotoInput.files && ccPhotoInput.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
          const errBox = el.querySelector("#ccError");
          _showFieldError(errBox, "Image trop volumineuse (max 5 Mo)");
          ccPhotoInput.value = "";
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          el.dataset.pendingImage = dataUrl.split(",")[1] || "";
          const preview = el.querySelector("#ccPhotoPreview");
          preview.style.backgroundImage = `url("${dataUrl}")`;
          preview.textContent = "";
          ccPhotoRemoveBtn.style.display = "inline-flex";
        };
        reader.readAsDataURL(file);
      });
      ccPhotoRemoveBtn.addEventListener("click", () => {
        el.dataset.pendingImage = "";
        ccPhotoInput.value = "";
        const preview = el.querySelector("#ccPhotoPreview");
        preview.style.backgroundImage = "";
        preview.textContent = "";
        ccPhotoRemoveBtn.style.display = "none";
      });

      // ── Coller une image copiée (bouton + Ctrl+V pendant que la modale est ouverte) ──
      const ccPhotoPasteBtn = el.querySelector("#ccPhotoPasteBtn");
      const ccPasteOpts = () => ({
        el, preview: el.querySelector("#ccPhotoPreview"),
        removeBtn: el.querySelector("#ccPhotoRemoveBtn"), errBox: el.querySelector("#ccError"),
      });
      ccPhotoPasteBtn.addEventListener("click", () => _pasteImageFromClipboard(ccPasteOpts()));
      _bindPasteListener(el, ccPasteOpts());
    }
    return el;
  }

  function closeCreateModal() {
    const el = document.getElementById("clientCreateModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  function openCreateClientModal() {
    const el = createModalEl();
    el.classList.add("ch-modal--open");
    const errBox = el.querySelector("#ccError");
    errBox.style.display = "none";

    const nameInp   = el.querySelector("#ccName");
    const coordsInp = el.querySelector("#ccCoords");
    const phoneInp  = el.querySelector("#ccPhone");
    _bindPhoneFormatting(phoneInp);
    const warehousesSel = el.querySelector("#ccWarehouses");
    const clusterSel  = el.querySelector("#ccCluster");
    const typePosSel  = el.querySelector("#ccTypePos");
    const routeInput  = el.querySelector("#ccRouteInput");
    const routeDropdown = el.querySelector("#ccRouteDropdown");
    const selectedRouteEl = el.querySelector("#ccSelectedRoute");
    const copyWrap   = el.querySelector("#ccCopyWrap");
    const copyLink   = el.querySelector("#ccCopyPlanningLink");
    const copyPanel  = el.querySelector("#ccCopyPanel");
    const copyInput  = el.querySelector("#ccCopyInput");
    const copyDropdown = el.querySelector("#ccCopyDropdown");
    const scheduleEl = el.querySelector("#ccSchedule");
    const weeksEl    = el.querySelector("#ccWeeks");
    const daysEl     = el.querySelector("#ccDays");
    const saveBtn    = el.querySelector("#ccSaveBtn");

    nameInp.value = "";
    coordsInp.value = "";
    phoneInp.value = "";
    routeInput.value = "";
    el.dataset.pendingImage = "";
    const ccPhotoPreviewEl = el.querySelector("#ccPhotoPreview");
    ccPhotoPreviewEl.style.backgroundImage = "";
    ccPhotoPreviewEl.textContent = "";
    el.querySelector("#ccPhotoInput").value = "";
    el.querySelector("#ccPhotoRemoveBtn").style.display = "none";
    copyInput.value = "";
    routeDropdown.style.display = "none";
    copyDropdown.style.display = "none";
    copyPanel.style.display = "none";
    copyWrap.style.display = "none";
    scheduleEl.style.display = "none";
    selectedRouteEl.style.display = "none";

    let selectedRoute = null; // { id, name }
    let selWeeks = [];
    let selDays  = [];
    let _routeRows = null;

    weeksEl.innerHTML = _ROUTE_WEEKS.map(w => `
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" class="cc-week-chk" value="${w}"/> S${w}
      </label>`).join("");
    daysEl.innerHTML = _ROUTE_DAYS.map(d => `
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" class="cc-day-chk" value="${d}"/> ${_ROUTE_DAY_LABELS_FR[d]}
      </label>`).join("");
    weeksEl.querySelectorAll(".cc-week-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        selWeeks = [...weeksEl.querySelectorAll(".cc-week-chk:checked")].map(c => parseInt(c.value, 10));
      });
    });
    daysEl.querySelectorAll(".cc-day-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        selDays = [...daysEl.querySelectorAll(".cc-day-chk:checked")].map(c => c.value);
      });
    });

    function _renderSelectedRoute() {
      if (!selectedRoute) { selectedRouteEl.style.display = "none"; return; }
      selectedRouteEl.style.display = "block";
      selectedRouteEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;
          background:#dcfce7;border:1px solid #86efac;border-radius:6px;padding:5px 8px">
          <svg viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"
            style="width:12px;height:12px;flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>
          <span style="flex:1">${esc(selectedRoute.name)}</span>
          <span id="ccRouteClear" style="cursor:pointer;font-size:14px;color:#dc2626;line-height:1">×</span>
        </div>`;
      el.querySelector("#ccRouteClear").onclick = () => {
        selectedRoute = null; _routeRows = null;
        routeInput.value = ""; selWeeks = []; selDays = [];
        weeksEl.querySelectorAll(".cc-week-chk").forEach(c => c.checked = false);
        daysEl.querySelectorAll(".cc-day-chk").forEach(c => c.checked = false);
        copyWrap.style.display = "none"; copyPanel.style.display = "none";
        copyInput.value = ""; copyDropdown.style.display = "none";
        scheduleEl.style.display = "none";
        _renderSelectedRoute();
      };
    }

    function _selectRoute(route) {
      selectedRoute = route;
      _routeRows = null;
      routeInput.value = "";
      routeDropdown.style.display = "none";
      scheduleEl.style.display = "block";
      copyWrap.style.display = "block";
      _renderSelectedRoute();
    }

    function _showRouteDropdown(items) {
      routeDropdown.innerHTML = "";
      if (!items.length) {
        routeDropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
        routeDropdown.style.display = "block"; return;
      }
      items.forEach(r => {
        const d = document.createElement("div");
        d.className = "ap-dd-item";
        d.innerHTML = esc(r.name || "");
        d.onmousedown = e => { e.preventDefault(); _selectRoute({ id: r.id, name: r.name }); };
        routeDropdown.appendChild(d);
      });
      routeDropdown.style.display = "block";
    }

    let _routeSearchTimer = null;
    routeInput.oninput = () => {
      const q = routeInput.value.trim();
      clearTimeout(_routeSearchTimer);
      if (!q) { routeDropdown.style.display = "none"; return; }
      _routeSearchTimer = setTimeout(async () => {
        try {
          const rows = await rpcController.searchRoutes(getOdooBase(), q);
          _showRouteDropdown(rows || []);
        } catch (err) {
          routeDropdown.innerHTML = `<div class="ap-dd-empty">Erreur: ${esc(err.message)}</div>`;
          routeDropdown.style.display = "block";
        }
      }, 350);
    };
    routeInput.onblur = () => setTimeout(() => { routeDropdown.style.display = "none"; }, 150);

    // ── فقاعة استنساخ جدول من زبون موجود مسبقًا داخل الـ route المختارة ──
    copyLink.onclick = async () => {
      if (!selectedRoute) return;
      const show = copyPanel.style.display === "none";
      copyPanel.style.display = show ? "block" : "none";
      if (show) {
        if (!_routeRows) {
          copyInput.disabled = true;
          copyInput.placeholder = "⏳ Chargement…";
          try {
            _routeRows = await rpcController.fetchRouteCustomers(getOdooBase(), selectedRoute.id);
          } catch (err) {
            toast("✗ " + err.message);
            _routeRows = [];
          }
          copyInput.disabled = false;
          copyInput.placeholder = "Chercher un client de cette route…";
        }
        copyInput.focus();
      } else {
        copyDropdown.style.display = "none";
        copyInput.value = "";
      }
    };

    function _applyCopiedSchedule(row) {
      const weeks = _ROUTE_WEEKS.filter(w => _ROUTE_DAYS.some(d => row[`w${w}${d}`] === true));
      const days  = _ROUTE_DAYS.filter(d => _ROUTE_WEEKS.some(w => row[`w${w}${d}`] === true));
      selWeeks = [...weeks];
      selDays  = [...days];
      weeksEl.querySelectorAll(".cc-week-chk").forEach(chk => { chk.checked = weeks.includes(parseInt(chk.value, 10)); });
      daysEl.querySelectorAll(".cc-day-chk").forEach(chk => { chk.checked = days.includes(chk.value); });
      scheduleEl.style.display = "block";
      copyPanel.style.display = "none";
      copyInput.value = "";
      copyDropdown.style.display = "none";
    }

    copyInput.oninput = () => {
      const q = copyInput.value.trim();
      if (!q || !_routeRows) { copyDropdown.style.display = "none"; return; }
      const matches = rpcController.filterRouteClients(_routeRows, q).slice(0, 12);
      copyDropdown.innerHTML = "";
      if (!matches.length) {
        copyDropdown.innerHTML = `<div class="ap-dd-empty">Aucun résultat</div>`;
        copyDropdown.style.display = "block"; return;
      }
      matches.forEach(r => {
        const partnerName = Array.isArray(r.partner_id) ? r.partner_id[1] : "—";
        const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : null;
        const ref = r._partnerRef || "—";
        const d = document.createElement("div");
        d.className = "ap-dd-item";
        d.innerHTML = `<span style="font-weight:700;color:var(--accent);margin-right:4px">${esc(String(ref))}</span>${esc(partnerName)}${_clientLinkIconHtml(partnerId, null)}`;
        d.onmousedown = e => { e.preventDefault(); _applyCopiedSchedule(r); };
        copyDropdown.appendChild(d);
      });
      copyDropdown.style.display = "block";
    };
    copyInput.onblur = () => setTimeout(() => { copyDropdown.style.display = "none"; }, 150);

    // ── Entrepôts (many2many stock.warehouse) — champ caché, "Oran" par défaut ──
    warehousesSel.innerHTML = "";
    rpc("stock.warehouse", "search_read", [[]], { fields: ["id", "name"], limit: 200 })
      .then(rows => {
        warehousesSel.innerHTML = "";
        (rows || []).forEach(r => warehousesSel.insertAdjacentHTML("beforeend",
          `<option value="${r.id}">${esc(r.name)}</option>`));
        const oranOpt = [...warehousesSel.options].find(o =>
          o.textContent.toLowerCase().includes("oran"));
        if (oranOpt) oranOpt.selected = true;
      })
      .catch(() => {});

    // ── Cluster / Type de POS (mêmes listes que la modale d'édition) ──
    clusterSel.innerHTML = `<option value="">-- Choisir --</option>`;
    typePosSel.innerHTML = `<option value="">-- Choisir --</option>`;

    // ── Auto-cluster intelligent basé sur le nom ──
    const HORECA_KEYWORDS = ["res", "rest", "rst", "ff", "boucherie", "cafe", "cafeteria", "hotel", "restaurant",
      "fast food", "complex", "resaurant", "rotesserie", "pizza", "pizzeria", "chay", "tea"];
    const GROS_KEYWORDS   = ["gros"];
    // enlève les accents pour comparer "détail" == "detail", "café" == "cafe", etc.
    function _norm(s) {
      return (s || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    }
    function _findClusterOption(keyword) {
      // égalité exacte d'abord, puis "contient" (ex: option "Grossiste" pour "gros")
      const exact = [...clusterSel.options].find(o => _norm(o.textContent) === keyword);
      if (exact) return exact;
      return [...clusterSel.options].find(o => _norm(o.textContent).includes(keyword));
    }
    function _guessClusterKeyword(name) {
      const n = _norm(name);
      if (GROS_KEYWORDS.some(k => n.includes(k))) return "gros";
      if (HORECA_KEYWORDS.some(k => n.includes(k))) return "horeca";
      return "detail";
    }
    let _clusterAutoLock = false; // se verrouille dès que l'utilisateur touche le cluster manuellement
    function _applyAutoCluster() {
      if (_clusterAutoLock) return;
      const guess = _guessClusterKeyword(nameInp.value);
      const opt = _findClusterOption(guess);
      if (opt) clusterSel.value = opt.value;
    }
    // "oninput" (et non addEventListener) pour éviter d'empiler plusieurs handlers
    // à chaque ouverture de la modale "Nouveau client"
    nameInp.oninput = () => { _applyAutoCluster(); _applyAutoTypePos(); };
    clusterSel.addEventListener("change", () => { _clusterAutoLock = true; _applyAutoTypePos(); });

    // ── Auto-type de POS intelligent basé sur le nom + le cluster ──
    const TYPEPOS_RULES = [
      { keywords: ["ag"],                                          cluster: "detail", label: "alimentation generale" },
      { keywords: ["cos", "cosmetique"],                            cluster: "detail", label: "cosmetique" },
      { keywords: ["det", "detergent"],                             cluster: "detail", label: "detaillant detergent" },
      { keywords: ["emb", "emballage"],                             cluster: "detail", label: "detaillant emballage" },
      { keywords: ["ff", "fast food"],                              cluster: "horeca", label: "fast-food" },
      { keywords: ["ag", "mini"],                                   cluster: "gros",   label: "grossiste a/g" },
      { keywords: ["cos", "cosmetique"],                            cluster: "gros",   label: "grossiste cosmetique" },
      { keywords: ["det", "detergent"],                             cluster: "gros",   label: "grossiste detergent" },
      { keywords: ["emb", "emballage"],                             cluster: "gros",   label: "grossiste emballage" },
      { keywords: ["hotel", "complex"],                             cluster: "horeca", label: "hotel" },
      { keywords: ["ph", "pharmacie"],                              cluster: "all",    label: "pharmacie" },
      { keywords: ["res", "resaurant", "rest", "rotesserie", "pizza", "pizzeria"], cluster: "all", label: "restaurant" },
      { keywords: ["sup", "superette", "market", "shop"],           cluster: "all",    label: "superette" },
      { keywords: ["cafe", "cafeteria", "chay", "tea"],             cluster: "all",    label: "cafeteria" },
    ];
    let _typePosAutoLock = false;
    function _findTypePosOption(label) {
      const exact = [...typePosSel.options].find(o => _norm(o.textContent) === label);
      if (exact) return exact;
      return [...typePosSel.options].find(o => _norm(o.textContent).includes(label));
    }
    function _guessTypePosLabel(name, clusterKeyword) {
      const n = _norm(name);
      const rule = TYPEPOS_RULES.find(r =>
        r.keywords.some(k => n.includes(_norm(k))) &&
        (r.cluster === "all" || r.cluster === clusterKeyword));
      return rule ? rule.label : null;
    }
    function _applyAutoTypePos() {
      if (_typePosAutoLock) return;
      const clusterKeyword = _guessClusterKeyword(nameInp.value);
      const label = _guessTypePosLabel(nameInp.value, clusterKeyword);
      if (!label) return;
      const opt = _findTypePosOption(label);
      if (opt) typePosSel.value = opt.value;
    }
    typePosSel.addEventListener("change", () => { _typePosAutoLock = true; });

    Promise.all([getClusterComodel(), getTypePosComodel()]).then(async ([clusterComodel, typePosComodel]) => {
      if (clusterComodel) {
        try {
          const rows = await rpc(clusterComodel.model, "search_read", [clusterComodel.domain], { fields: ["id", "display_name"], limit: 200 });
          (rows || []).forEach(r => clusterSel.insertAdjacentHTML("beforeend", `<option value="${r.id}">${esc(r.display_name)}</option>`));
        } catch (_) {}
      }
      if (typePosComodel) {
        try {
          const rows = await rpc(typePosComodel.model, "search_read", [typePosComodel.domain], { fields: ["id", "display_name"], limit: 200 });
          (rows || []).forEach(r => typePosSel.insertAdjacentHTML("beforeend", `<option value="${r.id}">${esc(r.display_name)}</option>`));
        } catch (_) {}
      }
      // Applique le cluster par défaut ("detail") + le type de POS dès que les listes sont chargées
      _applyAutoCluster();
      _applyAutoTypePos();
    });

    saveBtn.onclick = async () => {
      errBox.style.display = "none";
      const name = nameInp.value.trim().toUpperCase();
      const clusterId  = clusterSel.value ? Number(clusterSel.value) : 0;
      const typePosId  = typePosSel.value ? Number(typePosSel.value) : 0;
      const coordsRaw  = coordsInp.value.trim();
      const coords = await parseCoordsInput(coordsRaw);
      const phone = phoneInp.value.trim();
      let warehouseIds = [...warehousesSel.selectedOptions].map(o => Number(o.value));
      if (!warehouseIds.length && warehousesSel.options.length) {
        warehouseIds = [Number(warehousesSel.options[0].value)];
      }

      if (!name)       { _showFieldError(errBox, "Le nom est requis"); return; }
      if (!clusterId)  { _showFieldError(errBox, "Le cluster est requis"); return; }
      if (!typePosId)  { _showFieldError(errBox, "Le type de POS est requis"); return; }
      if (!coords)      { _showFieldError(errBox, "Coordonnées invalides ou manquantes"); return; }
      if (!phone)       { _showFieldError(errBox, "Le téléphone est requis"); return; }
      if (selectedRoute && !selDays.length) {
        _showFieldError(errBox, "Choisissez au moins un jour pour la route");
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = "Création…";
      try {
        const vals = {
          name,
          customer_rank: 1,
          partner_custom_attribute_1: clusterId,
          partner_custom_attribute_2: typePosId,
          partner_latitude: coords.lat,
          partner_longitude: coords.lng,
          phone,
          warehouse_ids: [[6, 0, warehouseIds]],
        };
        if (el.dataset.pendingImage) vals.image_1920 = el.dataset.pendingImage;
        const newId = await rpc("res.partner", "create", [vals], {});
        if (!newId) throw new Error("Échec de la création");

        try {
          await _ensurePartnerPricelistDefaults(newId, null);
        } catch (err) {
          toast("✓ Client créé, mais échec init. société/brand: " + err.message);
        }

        if (selectedRoute) {
          try {
            await rpcController.addClientToRoute(getOdooBase(), selectedRoute.id, String(newId), _effectiveWeeks(selWeeks), selDays);
          } catch (err) {
            toast("✓ Client créé, mais échec ajout à la route: " + err.message);
          }
        }

        closeCreateModal();
        toast("Client créé ✓");
        if (typeof addPartner === "function") addPartner(newId);
      } catch (err) {
        _showFieldError(errBox, "Erreur: " + err.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Créer";
      }
    };
  }

  /* ── Client history modal (ventes / livraison / encaissement) ───── */
  const HISTORY_PAGE_SIZE = 20;
  const HISTORY_CONFIG = {
    ventes: {
      label: "Ventes",
      model: "sale.order",
      domain: (id) => [["partner_id", "=", id]],
      fields: ["id", "name", "date_order", "amount_total", "state"],
      order: "date_order desc",
      row: (r) => ({
        id: r.id,
        title: r.name || "",
        date: r.date_order || "",
        amount: formatMoney(r.amount_total),
        state: r.state || "",
      }),
    },
    livraison: {
      label: "Livraison",
      model: "stock.picking",
      domain: (id) => [["partner_id", "=", id]],
      fields: ["id", "name", "scheduled_date", "date_done", "amount_total", "state"],
      order: "scheduled_date desc",
      row: (r) => ({
        id: r.id,
        title: r.name || "",
        date: r.date_done || r.scheduled_date || "",
        amount: formatMoney(r.amount_total),
        state: r.state || "",
      }),
    },
    encaissement: {
      label: "Encaissement",
      model: "account.payment",
      domain: (id) => ["&", ["partner_id", "=", id], ["state", "!=", "cancel"]],
      fields: ["id", "name", "payment_date", "amount", "payment_type", "state"],
      order: "payment_date desc",
      row: (r) => ({
        id: r.id,
        title: r.name || "",
        date: r.payment_date || "",
        amount: formatMoney(r.amount),
        state: r.state || "",
      }),
    },
  };

  function historyModalEl() {
    let el = document.getElementById("clientHistoryModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientHistoryModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <div class="ch-modal-title"></div>
            <button class="ch-modal-close" title="Close">${ic.close}</button>
          </div>
          <div class="ch-modal-body"></div>
          <div class="ch-modal-foot">
            <button class="ch-modal-more" style="display:none;">Show more</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeHistoryModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeHistoryModal);
    }
    return el;
  }

  function closeHistoryModal() {
    const el = document.getElementById("clientHistoryModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openHistoryModal(clientId, clientName, kind) {
    const cfg = HISTORY_CONFIG[kind];
    if (!cfg) return;
    const el = historyModalEl();
    el.classList.add("ch-modal--open");
    el.querySelector(".ch-modal-title").textContent = `${cfg.label} — ${clientName}`;
    const body = el.querySelector(".ch-modal-body");
    const moreBtn = el.querySelector(".ch-modal-more");
    moreBtn.style.display = "none";
    body.innerHTML = `<div class="ch-msg">Loading...</div>`;

    let offset = 0;
    let rowsAcc = [];

    async function fetchPage() {
      const rows = await rpc(cfg.model, "search_read",
        [cfg.domain(clientId)],
        { fields: cfg.fields, order: cfg.order, limit: HISTORY_PAGE_SIZE, offset });
      return rows || [];
    }

    function renderRows() {
      if (!rowsAcc.length) {
        body.innerHTML = `<div class="ch-msg">No records</div>`;
        return;
      }
      body.innerHTML = `
        <table class="ch-table">
          <thead><tr><th>Ref</th><th>Date</th><th>Amount</th><th>State</th><th></th></tr></thead>
          <tbody>
            ${rowsAcc.map(r => {
              const d = cfg.row(r);
              if (kind === "ventes") {
                return `<tr class="ch-row-clickable" data-id="${d.id}">
                  <td>${esc(d.title)}</td>
                  <td>${esc(d.date)}</td>
                  <td>${esc(d.amount)}</td>
                  <td>${esc(d.state)}</td>
                  <td><button type="button" class="ch-open-btn ch-open-sale" data-id="${d.id}" title="Ouvrir">${ic.open}</button></td>
                </tr>`;
              }
              const url = `${ODOO_BASE}/web#id=${d.id}&model=${cfg.model}&view_type=form`;
              const pdfBtn = kind === "livraison"
                ? `<a class="ch-open-btn ch-pdf-btn" href="/api/report/pdf/stock.report_deliveryslip/${d.id}"
                    download="${esc(String(d.title || "BL").replace(/[\\/]+/g, "-"))}.pdf"
                    title="Télécharger le BL en PDF">${ic.download}</a>`
                : "";
              return `<tr>
                <td>${esc(d.title)}</td>
                <td>${esc(d.date)}</td>
                <td>${esc(d.amount)}</td>
                <td>${esc(d.state)}</td>
                <td><span style="display:inline-flex;gap:2px">
                  <a class="ch-open-btn" href="${url}" target="_blank" title="Open in Odoo">${ic.open}</a>${pdfBtn}
                </span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>`;

      if (kind === "ventes") {
        body.querySelectorAll(".ch-row-clickable, .ch-open-sale").forEach(elx => {
          elx.addEventListener("click", (ev) => {
            ev.preventDefault();
            const orderId = Number(elx.dataset.id);
            if (orderId && window.SalesView?.openOrderModal) window.SalesView.openOrderModal(orderId);
          });
        });
      }
    }

    async function loadNext() {
      moreBtn.disabled = true;
      moreBtn.textContent = "Loading...";
      try {
        const rows = await fetchPage();
        rowsAcc = rowsAcc.concat(rows);
        offset += rows.length;
        renderRows();
        moreBtn.style.display = rows.length === HISTORY_PAGE_SIZE ? "block" : "none";
      } catch (err) {
        body.innerHTML = `<div class="ch-msg ch-msg--err">Error: ${esc(err.message)}</div>`;
        moreBtn.style.display = "none";
      } finally {
        moreBtn.disabled = false;
        moreBtn.textContent = "Show more";
      }
    }

    moreBtn.onclick = loadNext;
    await loadNext();
  }

  /* ── Situation Client (BL vs Encaissement, période) ─────── */
  const CS_LOGO_URL = "/assets/wafa-logo.png";
  const CS_A4_WIDTH_PX = 794; // largeur de capture (~300dpi une fois combinée à CS_PIXEL_RATIO) pour un rendu net à l'impression
                               // à la fois pour l'export PNG (l'image ne fait
                               // que la largeur A4, hauteur libre) et pour le
                               // rendu de la page PDF (A4 portrait).

  function situationModalEl() {
    let el = document.getElementById("clientSituationModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientSituationModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box" style="width:min(820px, 94vw);">
          <div class="ch-modal-head">
            <div class="ch-modal-title" id="csModalTitle">Situation</div>
            <button class="ch-modal-close" id="csModalClose">${ic.close}</button>
          </div>
          <div class="ch-modal-body">
            <div class="cs-period-row">
              <div class="ce-field" style="margin-bottom:0;">
                <label>Du</label>
                <input type="date" class="ce-input" id="csDateFrom"/>
              </div>
              <div class="ce-field" style="margin-bottom:0;">
                <label>Au</label>
                <input type="date" class="ce-input" id="csDateTo"/>
              </div>
              <button class="ce-btn ce-btn--primary" id="csGenerateBtn" style="align-self:flex-end;">Générer</button>
            </div>
            <div class="cs-mode-row" id="csModeRow" style="display:none;">
              <button class="cs-mode-btn cs-mode-btn--active" data-mode="separate" type="button">Tableaux séparés</button>
              <button class="cs-mode-btn" data-mode="matched" type="button">Jours correspondants</button>
            </div>
            <div id="csResultWrap"></div>
          </div>
          <div class="ch-modal-foot ch-modal-foot--right" id="csExportFoot" style="display:none;">
            <button class="ce-btn ce-btn--ghost" id="csCopyPngBtn">Copier (image)</button>
            <button class="ce-btn ce-btn--ghost" id="csExportPngBtn">Télécharger PNG</button>
            <button class="ce-btn ce-btn--ghost" id="csExportPdfBtn">Télécharger PDF</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeSituationModal);
      el.querySelector("#csModalClose").addEventListener("click", closeSituationModal);
    }
    return el;
  }

  function closeSituationModal() {
    const el = document.getElementById("clientSituationModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  function _csTodayStr() {
    return new Date().toISOString().slice(0, 10);
  }
  function _csSixMonthsAgoStr() {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  }

  function _csFmtDateDisplay(s) {
    // "2026-08-25" أو "2026-08-25 10:00:00" → "25/08/2026"
    if (!s) return "";
    const datePart = String(s).slice(0, 10);
    const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return datePart;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function _csGroupByDay(items) {
    // items: [{ day: "YYYY-MM-DD", amount: <signé> }] — on additionne les
    // montants signés du même jour (BL+BL, ou BL-retour, ou encaissement-
    // remboursement/paiement fournisseur), puis on trie du plus récent au
    // plus ancien.
    const map = new Map();
    for (const it of items) {
      if (!it.day) continue;
      map.set(it.day, (map.get(it.day) || 0) + it.amount);
    }
    return Array.from(map.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  async function _csFetchBLs(clientId, dateFrom, dateTo) {
    // On inclut à la fois les BL sortants ("outgoing") et les retours
    // client ("incoming", mêmes règles d'identification que le reste de
    // l'app pour un partner_id donné) — un retour est compté en négatif et
    // net avec le(s) BL du même jour (voir _csGroupByDay).
    const domain = ["&", ["partner_id", "=", clientId],
      "&", ["state", "=", "done"],
      "&", ["picking_type_code", "in", ["outgoing", "incoming"]],
      "&", ["date_done", ">=", dateFrom + " 00:00:00"],
      ["date_done", "<=", dateTo + " 23:59:59"]];
    const rows = await rpc("stock.picking", "search_read", [domain], {
      fields: ["date_done", "scheduled_date", "amount_total", "picking_type_code"],
      order: "date_done desc",
    }, "card.showBLs");
    const items = (rows || []).map(r => {
      const day = (r.date_done || r.scheduled_date || "").slice(0, 10);
      const amount = r.amount_total || 0;
      return { day, amount: r.picking_type_code === "incoming" ? -amount : amount };
    });
    return _csGroupByDay(items);
  }

  async function _csFetchEncaissements(clientId, dateFrom, dateTo) {
    const domain = ["&", ["partner_id", "=", clientId],
      "&", ["payment_date", ">=", dateFrom],
      "&", ["payment_date", "<=", dateTo],
      "|", ["verified_state", "=", true], ["verified_state", "=", "verified"]];
    const rows = await rpc("account.payment", "search_read", [domain], {
      fields: ["payment_date", "amount", "payment_type"],
      order: "payment_date desc",
    }, "card.showPayments");
    // Remboursement client / Paiement fournisseur (payment_type="outbound")
    // entrés en négatif et nets avec l'encaissement du même jour.
    const items = (rows || []).map(r => {
      const day = (r.payment_date || "").slice(0, 10);
      const amount = r.amount || 0;
      return { day, amount: r.payment_type === "outbound" ? -amount : amount };
    });
    return _csGroupByDay(items);
  }

  async function _csFetchAvoirs(clientId, dateFrom, dateTo) {
    // Avoirs client (account.move, move_type="out_refund") sur la période —
    // on exclut les avoirs annulés ("cancel") ou encore en brouillon
    // ("draft"), seuls les avoirs comptabilisés ("posted") sont pris en
    // compte.
    // NB: sur cette instance Odoo le champ s'appelle "type" (versions
    // antérieures à la fusion facture/écriture de compta où il a été
    // renommé "move_type") — mêmes valeurs ("out_refund" = avoir client).
    const domain = ["&", ["partner_id", "=", clientId],
      "&", ["type", "=", "out_refund"],
      "&", ["state", "=", "posted"],
      "&", ["invoice_date", ">=", dateFrom],
      ["invoice_date", "<=", dateTo]];
    const rows = await rpc("account.move", "search_read", [domain], {
      fields: ["invoice_date", "amount_total", "name"],
      order: "invoice_date desc",
    }, "card.showPayments");
    // On exclut les avoirs dont le numéro (champ "name") commence par
    // "RETCLI" (retours clients gérés séparément, à ne pas compter ici).
    const items = (rows || [])
      .filter(r => !String(r.name || "").trim().toUpperCase().startsWith("RETCLI"))
      .map(r => {
        const day = (r.invoice_date || "").slice(0, 10);
        const amount = r.amount_total || 0;
        return { day, amount };
      });
    return _csGroupByDay(items);
  }

  function _csRenderTable(title, rows) {
    const body = rows.length
      ? rows.map(r => `<tr><td>${esc(_csFmtDateDisplay(r.date))}</td><td class="cs-amount">${esc(formatMoney(r.amount))}</td></tr>`).join("")
      : `<tr><td colspan="2" class="ch-msg">Aucune donnée</td></tr>`;
    return `
      <table class="cs-table">
        <thead><tr><th colspan="2">${esc(title)}</th></tr><tr><th>Date</th><th>Montant</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  // Fusionne encaissements et avoirs en une seule liste triée par date
  // (desc), en marquant les lignes issues d'un avoir (isAvoir: true) afin
  // de pouvoir les distinguer visuellement dans le tableau "Encaissement".
  function _csMergeEncAvoir(encs, avoirs) {
    const merged = [
      ...(encs || []).map(r => ({ ...r, isAvoir: false })),
      ...(avoirs || []).map(r => ({ ...r, isAvoir: true })),
    ];
    merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return merged;
  }

  // Tableau "Encaissement" incluant les avoirs fusionnés : une ligne issue
  // d'un avoir affiche un petit badge "trade" à droite de la date, et la
  // date + le montant de cette ligne sont mis en gras pour la distinguer
  // des encaissements classiques.
  function _csRenderEncTable(title, rows) {
    const body = rows.length
      ? rows.map(r => `<tr class="${r.isAvoir ? "cs-row--avoir" : ""}">
          <td>${esc(_csFmtDateDisplay(r.date))}${r.isAvoir ? '<span class="cs-avoir-tag">trade</span>' : ""}</td>
          <td class="cs-amount">${esc(formatMoney(r.amount))}</td>
        </tr>`).join("")
      : `<tr><td colspan="2" class="ch-msg">Aucune donnée</td></tr>`;
    return `
      <table class="cs-table">
        <thead><tr><th colspan="2">${esc(title)}</th></tr><tr><th>Date</th><th>Montant</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  // Mode "Jours correspondants" : une seule table, une ligne par jour
  // présent dans au moins l'un des deux flux ; la colonne de l'autre flux
  // reste vide si ce jour-là il n'y a rien.
  function _csBuildMatchedRows(bls, encs, avoirs) {
    const map = new Map();
    bls.forEach(r => { map.set(r.date, { bl: r.amount, enc: null, avoir: null }); });
    encs.forEach(r => {
      const existing = map.get(r.date);
      if (existing) existing.enc = r.amount;
      else map.set(r.date, { bl: null, enc: r.amount, avoir: null });
    });
    (avoirs || []).forEach(r => {
      const existing = map.get(r.date);
      if (existing) existing.avoir = r.amount;
      else map.set(r.date, { bl: null, enc: null, avoir: r.amount });
    });
    const dates = Array.from(map.keys()).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    return { map, dates };
  }

  function _csRenderMatchedRowsHtml(dates, map) {
    const body = dates.length
      ? dates.map(d => {
          const v = map.get(d);
          return `<tr>
            <td>${esc(_csFmtDateDisplay(d))}</td>
            <td class="cs-amount">${v.bl !== null ? esc(formatMoney(v.bl)) : ""}</td>
            <td class="cs-amount">${v.enc !== null ? esc(formatMoney(v.enc)) : ""}</td>
            <td class="cs-amount">${v.avoir !== null ? esc(formatMoney(v.avoir)) : ""}</td>
          </tr>`;
        }).join("")
      : `<tr><td colspan="4" class="ch-msg">Aucune donnée</td></tr>`;
    return `
      <table class="cs-table cs-table--matched">
        <thead>
          <tr><th colspan="4">Situation</th></tr>
          <tr><th>Date</th><th>Bon de livraison</th><th>Encaissement</th><th>Trade</th></tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function _csRenderMatchedTable(bls, encs, avoirs) {
    const { map, dates } = _csBuildMatchedRows(bls, encs, avoirs);
    return _csRenderMatchedRowsHtml(dates, map);
  }

  /* ── Pagination PDF (30 dates / page) ──────────────────────
     Chaque page PDF affiche 30 dates et porte sa propre en-tête
     (nom + période). En mode "Tableaux séparés", les tables BL et
     Encaissement ne doivent jamais faire réapparaître la même date sur
     deux pages différentes : c'est le flux qui compte le plus de lignes
     (donc celui qui aura besoin du plus grand nombre de pages) qui impose
     les bornes de date de chaque page ; l'autre flux est alors découpé sur
     ces mêmes bornes, quitte à afficher moins de 30 lignes sur cette page. */
  const CS_PAGE_SIZE = 30;

  function _csPaginateSeparate(blsRows, encMergedRows) {
    const bls = blsRows || [];
    const enc = encMergedRows || [];
    if (!bls.length && !enc.length) return [];

    const leaderIsBls = bls.length >= enc.length;
    const leader = leaderIsBls ? bls : enc;
    const follower = leaderIsBls ? enc : bls;

    const pages = [];
    let li = 0, fi = 0, first = true;

    while (li < leader.length || fi < follower.length) {
      const leaderChunk = leader.slice(li, li + CS_PAGE_SIZE);
      li += leaderChunk.length;

      let followerChunk = [];
      if (leaderChunk.length) {
        const pageOldest = leaderChunk[leaderChunk.length - 1].date;
        const pageNewest = leaderChunk[0].date;
        // Sur la première page seulement : rattrape les lignes de l'autre
        // flux plus récentes que le début du leader (démarrage décalé).
        while (first && fi < follower.length && follower[fi].date > pageNewest) {
          followerChunk.push(follower[fi]); fi++;
        }
        while (fi < follower.length && follower[fi].date >= pageOldest) {
          followerChunk.push(follower[fi]); fi++;
        }
      } else {
        // Leader épuisé : le follower continue seul, par tranches de 30.
        followerChunk = follower.slice(fi, fi + CS_PAGE_SIZE);
        fi += followerChunk.length;
      }

      const allDates = [...leaderChunk, ...followerChunk].map(r => r.date);
      const dateFrom = allDates.reduce((a, b) => (b < a ? b : a));
      const dateTo = allDates.reduce((a, b) => (b > a ? b : a));

      pages.push({
        dateFrom, dateTo,
        bls: leaderIsBls ? leaderChunk : followerChunk,
        encs: leaderIsBls ? followerChunk : leaderChunk,
      });
      first = false;
    }
    return pages;
  }

  function _csPaginateMatched(bls, encs, avoirs) {
    const { map, dates } = _csBuildMatchedRows(bls, encs, avoirs);
    const pages = [];
    for (let i = 0; i < dates.length; i += CS_PAGE_SIZE) {
      const slice = dates.slice(i, i + CS_PAGE_SIZE);
      pages.push({ dateFrom: slice[slice.length - 1], dateTo: slice[0], dates: slice, map });
    }
    if (!pages.length) pages.push({ dateFrom: null, dateTo: null, dates: [], map });
    return pages;
  }

  // Précharge le logo en data URL une seule fois : évite tout risque de
  // logo manquant sur une page (à partir de la 2e) lors de la capture
  // rapide et répétée de chaque page hors-écran.
  let _csLogoDataUrlCache = null;
  async function _csGetLogoDataUrl() {
    if (_csLogoDataUrlCache) return _csLogoDataUrlCache;
    try {
      const res = await fetch(CS_LOGO_URL);
      const blob = await res.blob();
      _csLogoDataUrlCache = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (e) {
      _csLogoDataUrlCache = CS_LOGO_URL; // secours : garde l'URL normale
    }
    return _csLogoDataUrlCache;
  }

  function _csRenderCaptureAreaPaged(clientName, page, solde, mode, logoSrc) {
    const tablesHtml = mode === "matched"
      ? _csRenderMatchedRowsHtml(page.dates, page.map)
      : `<div class="cs-tables-row">
          ${_csRenderTable("Bon de livraison", page.bls || [])}
          ${_csRenderEncTable("Encaissement", page.encs || [])}
        </div>`;
    return `
      <div class="cs-capture" id="csCapturePage">
        <div class="cs-capture-head">
          <img class="cs-head-logo" src="${logoSrc || CS_LOGO_URL}" alt="Wafa"/>
          <div class="cs-head-line">
            <span>Client: ${esc(clientName)}</span>
            <span class="cs-head-sep">•</span>
            <span>Periode: ${esc(_csFmtDateDisplay(page.dateFrom))} → ${esc(_csFmtDateDisplay(page.dateTo))}</span>
            ${solde ? `<span class="cs-head-sep">•</span><span class="cs-head-solde">Solde actuel: ${esc(solde)}</span>` : ""}
          </div>
        </div>
        ${tablesHtml}
      </div>`;
  }

  // Capture hors-écran d'un HTML de page (largeur forcée A4) → canvas.
  async function _csCaptureHtmlToCanvas(html) {
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.left = "-99999px";
    container.style.top = "0";
    container.style.width = CS_A4_WIDTH_PX + "px";
    container.innerHTML = html;
    document.body.appendChild(container);
    try {
      return await htmlToImage.toCanvas(container.firstElementChild, { backgroundColor: "#ffffff", pixelRatio: CS_PIXEL_RATIO, skipFonts: true });
    } finally {
      container.remove();
    }
  }

  function _csRenderCaptureArea(clientName, dateFrom, dateTo, solde, bls, encs, avoirs, mode) {
    const tablesHtml = mode === "matched"
      ? _csRenderMatchedTable(bls, encs, avoirs)
      : `<div class="cs-tables-row">
          ${_csRenderTable("Bon de livraison", bls)}
          ${_csRenderEncTable("Encaissement", _csMergeEncAvoir(encs, avoirs))}
        </div>`;
    return `
      <div class="cs-capture" id="csCaptureArea">
        <div class="cs-capture-head">
          <img class="cs-head-logo" src="${CS_LOGO_URL}" alt="Wafa"/>
          <div class="cs-head-line">
            <span>Client: ${esc(clientName)}</span>
            <span class="cs-head-sep">•</span>
            <span>Periode: ${esc(_csFmtDateDisplay(dateFrom))} → ${esc(_csFmtDateDisplay(dateTo))}</span>
            ${solde ? `<span class="cs-head-sep">•</span><span class="cs-head-solde">Solde actuel: ${esc(solde)}</span>` : ""}
          </div>
        </div>
        ${tablesHtml}
      </div>`;
  }

  // Capture #csCaptureArea en canvas : largeur forcée à la largeur A4 (le
  // contenu s'adapte, hauteur libre) pour que l'image téléchargée/copiée
  // soit toujours calée sur le format A4 en largeur.
  // pixelRatio: PIXEL_RATIO (constant ci-dessous) pour tout le monde — on
  // retourne aussi les frontières basses de chaque ligne <tr> (en px canvas)
  // pour permettre à l'export PDF multi-page de couper entre les lignes
  // plutôt qu'en plein milieu d'une ligne.
  const CS_PIXEL_RATIO = 3;
  async function _csCaptureCanvas() {
    const node = document.getElementById("csCaptureArea");
    if (!node || typeof htmlToImage === "undefined") return null;
    const prevWidth = node.style.width;
    node.style.width = CS_A4_WIDTH_PX + "px";
    try {
      const canvas = await htmlToImage.toCanvas(node, { backgroundColor: "#ffffff", pixelRatio: CS_PIXEL_RATIO, skipFonts: true });
      const nodeTop = node.getBoundingClientRect().top;
      const rowBoundariesPx = Array.from(node.querySelectorAll("tr"))
        .map(tr => (tr.getBoundingClientRect().bottom - nodeTop) * CS_PIXEL_RATIO)
        .sort((a, b) => a - b);
      return { canvas, rowBoundariesPx };
    } finally {
      node.style.width = prevWidth;
    }
  }

  async function openSituationModal(clientId, clientName, solde) {
    const el = situationModalEl();
    el.classList.add("ch-modal--open");
    el.querySelector("#csModalTitle").textContent = `Situation — ${clientName}`;
    el.querySelector("#csResultWrap").innerHTML = "";
    el.querySelector("#csExportFoot").style.display = "none";
    const modeRow = el.querySelector("#csModeRow");
    modeRow.style.display = "none";

    const fromInput = el.querySelector("#csDateFrom");
    const toInput = el.querySelector("#csDateTo");
    if (!fromInput.value) fromInput.value = _csSixMonthsAgoStr();
    if (!toInput.value) toInput.value = _csTodayStr();

    const genBtn = el.querySelector("#csGenerateBtn");
    const resultWrap = el.querySelector("#csResultWrap");
    const exportFoot = el.querySelector("#csExportFoot");

    let lastBLs = null, lastEncs = null, lastAvoirs = null, lastFrom = null, lastTo = null;
    let mode = "separate";

    function renderResult() {
      if (!lastBLs) return;
      resultWrap.innerHTML = _csRenderCaptureArea(clientName, lastFrom, lastTo, solde, lastBLs, lastEncs, lastAvoirs, mode);
    }

    modeRow.querySelectorAll(".cs-mode-btn").forEach(btn => {
      btn.onclick = () => {
        mode = btn.dataset.mode;
        modeRow.querySelectorAll(".cs-mode-btn").forEach(b => b.classList.toggle("cs-mode-btn--active", b === btn));
        renderResult();
      };
    });

    async function generate() {
      const dateFrom = fromInput.value;
      const dateTo = toInput.value;
      if (!dateFrom || !dateTo) { toast("Choisissez une période"); return; }
      if (dateFrom > dateTo) { toast("Période invalide"); return; }

      genBtn.disabled = true;
      genBtn.textContent = "Génération…";
      resultWrap.innerHTML = `<div class="ch-msg">Loading...</div>`;
      exportFoot.style.display = "none";
      modeRow.style.display = "none";
      try {
        const [bls, encs, avoirs] = await Promise.all([
          _csFetchBLs(clientId, dateFrom, dateTo),
          _csFetchEncaissements(clientId, dateFrom, dateTo),
          _csFetchAvoirs(clientId, dateFrom, dateTo),
        ]);
        lastBLs = bls; lastEncs = encs; lastAvoirs = avoirs; lastFrom = dateFrom; lastTo = dateTo;
        renderResult();
        exportFoot.style.display = "flex";
        modeRow.style.display = "flex";
      } catch (err) {
        resultWrap.innerHTML = `<div class="ch-msg ch-msg--err">Erreur: ${esc(err.message)}</div>`;
      } finally {
        genBtn.disabled = false;
        genBtn.textContent = "Générer";
      }
    }

    genBtn.onclick = generate;

    el.querySelector("#csExportPngBtn").onclick = async () => {
      try {
        const cap = await _csCaptureCanvas();
        if (!cap) { toast("Export image indisponible"); return; }
        cap.canvas.toBlob((blob) => {
          if (!blob) { toast("Échec de l'export"); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `Situation_${clientName.replace(/[\\/:*?"<>|]/g, "_")}_${fromInput.value}_${toInput.value}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }, "image/png");
      } catch (err) {
        toast("Échec de l'export: " + err.message);
      }
    };

    el.querySelector("#csCopyPngBtn").onclick = async () => {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        toast("La copie d'image n'est pas supportée par ce navigateur, utilisez le téléchargement");
        return;
      }
      try {
        const cap = await _csCaptureCanvas();
        if (!cap) { toast("Export image indisponible"); return; }
        cap.canvas.toBlob(async (blob) => {
          if (!blob) { toast("Échec de la copie"); return; }
          try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            toast("Image copiée ✓");
          } catch (e) {
            toast("Échec de la copie: " + e.message);
          }
        }, "image/png");
      } catch (err) {
        toast("Échec de la copie: " + err.message);
      }
    };

    el.querySelector("#csExportPdfBtn").onclick = async () => {
      try {
        if (typeof htmlToImage === "undefined") { toast("Export PDF indisponible"); return; }
        if (typeof window.jspdf === "undefined") { toast("Librairie PDF indisponible"); return; }
        if (!lastBLs) { toast("Générez d'abord la situation"); return; }

        // Chaque page = 30 dates, avec sa propre en-tête (nom + période).
        const pages = mode === "matched"
          ? _csPaginateMatched(lastBLs, lastEncs, lastAvoirs)
          : _csPaginateSeparate(lastBLs, _csMergeEncAvoir(lastEncs, lastAvoirs));

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        const PAGE_W = 210, PAGE_H = 297, MARGIN = 10;
        const contentW = PAGE_W - 2 * MARGIN, contentH = PAGE_H - 2 * MARGIN;
        const logoSrc = await _csGetLogoDataUrl();

        for (let i = 0; i < pages.length; i++) {
          const html = _csRenderCaptureAreaPaged(clientName, pages[i], solde, mode, logoSrc);
          const canvas = await _csCaptureHtmlToCanvas(html);
          const imgData = canvas.toDataURL("image/png");
          // Largeur toujours égale à la largeur disponible de la page (les
          // deux tableaux occupent donc toute la largeur du papier) ; la
          // hauteur suit le ratio de l'image sans jamais être réduite —
          // avec 30 lignes par page le contenu tient normalement dans la
          // hauteur A4, un éventuel léger dépassement est simplement
          // rogné au bord de la page plutôt que de rétrécir le tableau.
          const imgWmm = contentW;
          const imgHmm = (canvas.height * imgWmm) / canvas.width;
          if (i > 0) pdf.addPage();
          pdf.addImage(imgData, "PNG", MARGIN, MARGIN, imgWmm, imgHmm);
        }

        pdf.save(`Situation_${clientName.replace(/[\\/:*?"<>|]/g, "_")}_${fromInput.value}_${toInput.value}.pdf`);
      } catch (err) {
        toast("Échec de l'export PDF: " + err.message);
      }
    };
  }

  let selected = new Set();

  const COPY_FIELDS = [
    { key: "name",      label: "Nom" },
    { key: "ref",       label: "Référence" },
    { key: "phone",     label: "Téléphone" },
    { key: "cluster",   label: "Cluster" },
    { key: "pricelist", label: "Price list" },
    { key: "solde",     label: "Balance" },
    { key: "creditLim", label: "Credit limit" },
    { key: "coords",    label: "Coordonnées" },
    { key: "mapsUrl",   label: "Lien Google Maps" },
    { key: "odooUrl",   label: "Lien Odoo" },
  ];

  function clientFieldValue(c, key) {
    const hasCoords = !!(c.lat && c.lng);
    switch (key) {
      case "name": return c.name || "";
      case "ref": return c.ref || "";
      case "phone": return c.phone || "";
      case "cluster": return c.cluster || "";
      case "pricelist": return c.pricelist || "";
      case "solde": return c.solde || "";
      case "creditLim": return c.creditLim || "";
      case "coords": return hasCoords ? `${c.lat}, ${c.lng}` : "";
      case "mapsUrl": return hasCoords ? `https://www.google.com/maps?q=${c.lat},${c.lng}` : "";
      case "odooUrl": return `${ODOO_BASE}/web#id=${c.id}&model=res.partner&view_type=form`;
      default: return "";
    }
  }

  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    render();
  }

  function selectAll() {
    clients.forEach(c => { if (!c.loading) selected.add(c.id); });
    render();
  }

  function selectNone() {
    selected.clear();
    render();
  }

  function selectInvert() {
    clients.forEach(c => {
      if (c.loading) return;
      if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
    });
    render();
  }

  function bulkCopyField(key) {
    const label = (COPY_FIELDS.find(f => f.key === key) || {}).label || key;
    const lines = clients
      .filter(c => selected.has(c.id) && !c.loading)
      .map(c => {
        const val = clientFieldValue(c, key);
        return val ? `${c.name}\t${val}` : "";
      })
      .filter(Boolean);
    if (!lines.length) { toast("Rien à copier"); return; }
    doCopy(lines.join("\n"));
    toast(`Copié : ${label} (${lines.length})`);
  }

  /* ── Confirm Delete Modal ──────────────────────────────── */
  function openDeleteConfirmModal(count) {
    let el = document.getElementById("clientsDeleteConfirmModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "clientsDeleteConfirmModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box ch-modal-box--sm" style="max-width:360px;">
          <div class="ch-modal-head">
            <div class="ch-modal-title" style="display:flex;align-items:center;gap:7px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2.2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Clear list
            </div>
            <button class="ch-modal-close" id="delConfirmClose">${ic.close}</button>
          </div>
          <div class="ch-modal-body" style="padding:18px 16px;">
            <p id="delConfirmMsg" style="margin:0;font-size:13.5px;color:var(--text);line-height:1.6;"></p>
          </div>
          <div class="ch-modal-foot ch-modal-foot--right">
            <button class="ce-btn ce-btn--ghost" id="delConfirmCancelBtn">Cancel</button>
            <button class="ce-btn" id="delConfirmOkBtn" style="background:#EF4444;color:#fff;border:none;">Clear all</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeDeleteConfirmModal);
      el.querySelector("#delConfirmClose").addEventListener("click", closeDeleteConfirmModal);
      el.querySelector("#delConfirmCancelBtn").addEventListener("click", closeDeleteConfirmModal);
      el.querySelector("#delConfirmOkBtn").addEventListener("click", () => {
        clients = [];
        selected.clear();
        closeDeleteConfirmModal();
        render();
        toast("List cleared ✓");
      });
    }
    el.querySelector("#delConfirmMsg").textContent =
      `This will remove all ${count} client${count > 1 ? "s" : ""} from the list. This action cannot be undone.`;
    el.classList.add("ch-modal--open");
  }

  function closeDeleteConfirmModal() {
    const el = document.getElementById("clientsDeleteConfirmModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  /* ── Render ────────────────────────────────────────────── */
  function infoItem(icon, label, value) {
    const hasVal = value !== undefined && value !== null && value !== "";
    return `
      <div class="ci-item ${hasVal ? "" : "ci-item--empty"}" ${hasVal ? `data-copy="${esc(value)}"` : ""}>
        <div class="ci-icon">${icon}</div>
        <div class="ci-body">
          <div class="ci-label">${esc(label)}</div>
          <div class="ci-value">${esc(hasVal ? value : "—")}</div>
        </div>
        ${hasVal ? `<button class="ci-copy" data-copy="${esc(value)}" title="Copy ${esc(label)}">${ic.copy}</button>` : ""}
      </div>`;
  }

  function render() {
    const area = document.getElementById("clientsDetailArea");
    if (!area) return;

    if (!clients.length) {
      area.innerHTML = `<div class="clients-empty">Search for a client name above — you can add more than one to the list</div>`;
      return;
    }

    area.innerHTML = `<div class="clients-toolbar">
      <button class="clients-tool-btn" id="clientsSelectAllBtn" title="Tout sélectionner">${ic.selectAll}</button>
      <button class="clients-tool-btn" id="clientsSelectNoneBtn" title="Tout désélectionner">${ic.selectNone}</button>
      <button class="clients-tool-btn" id="clientsSelectInvertBtn" title="Inverser la sélection">${ic.selectInvert}</button>
      <button class="clients-tool-btn clients-tool-btn--danger" id="clientsDeleteSelectedBtn" title="Supprimer les sélectionnés" style="margin-left:4px;">${ic.trash}</button>
    </div><div class="clients-grid">${clients.map(c => {
      if (c.loading) {
        return `<div class="client-card client-card--loading"><div class="client-skel-avatar"></div><div class="client-skel-lines"><div></div><div></div></div></div>`;
      }
      if (c.loadError) {
        return `<div class="client-card" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;min-height:100px;opacity:.85;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div style="font-size:11.5px;color:var(--text2);text-align:center;">${esc(c.loadError)}</div>
          <div style="display:flex;gap:6px;">
            <button class="ce-btn ce-btn--ghost" data-retry="${c.id}" style="padding:4px 12px;font-size:12px;">Retry</button>
            <button class="ce-btn ce-btn--ghost" data-remove="${c.id}" style="padding:4px 10px;font-size:12px;color:#EF4444;">✕</button>
          </div>
        </div>`;
      }
      const hasCoords = c.lat && c.lng;
      const coordsText = hasCoords ? `${c.lat}, ${c.lng}` : "";
      const coordsDisplay = hasCoords ? `${Number(c.lat).toFixed(5)}, ${Number(c.lng).toFixed(5)}` : "";
      const mapsUrl = hasCoords ? `https://www.google.com/maps?q=${c.lat},${c.lng}` : "";
      const odooUrl = `${ODOO_BASE}/web#id=${c.id}&model=res.partner&view_type=form`;

      return `
      <div class="client-card ${selected.has(c.id) ? "client-card--selected" : ""}" data-id="${c.id}">
        <div class="client-card-head">
          <input type="checkbox" class="client-select-cb" data-select="${c.id}" ${selected.has(c.id) ? "checked" : ""} title="Sélectionner"/>
          <div class="client-avatar">${esc(initials(c.name))}</div>
          <div class="client-head-text">
            <div class="client-name" data-copy="${esc(c.name)}" title="Click to copy name">${esc(c.name)}</div>
            <div class="client-ref-row">
              <span class="client-ref">${esc(c.ref || "—")}</span>
              ${c.ref ? `<button class="client-ref-copy" data-copy="${esc(c.ref)}" title="Copy ref">${ic.copy}</button>` : ""}
            </div>
          </div>
          <a href="${odooUrl}" target="_blank" class="client-head-btn" title="Open in Odoo">${ic.open}</a>
          <button class="client-head-btn client-edit-btn" data-edit="${c.id}" title="Modifier">${ic.edit}</button>
          ${c.verifState && c.verifState !== "verified" ? `<button class="client-head-btn client-verify-btn" data-verify="${c.id}" title="Vérifier" style="color:#059669;border-color:rgba(5,150,105,.4);">${ic.check || "✓"}</button>` : ""}
          <button class="client-head-btn client-addroute-btn" data-addroute="${c.id}" title="Ajouter à une route">${ic.route}</button>
          <button class="client-head-btn client-remove-btn" data-remove="${c.id}" title="Remove">${ic.close}</button>
        </div>

        ${(c.typePos || c.state) ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:2px;">
          ${c.typePos ? `<div class="client-tag">${esc(c.typePos)}</div>` : ""}
          ${c.state ? `<div class="client-tag" style="background:rgba(16,185,129,.12);color:#059669;border-color:rgba(16,185,129,.25);">${esc(c.state)}</div>` : ""}
        </div>` : ""}

        <div class="client-info-grid">
          ${infoItem(ic.phone, "Phone", c.phone)}
          ${infoItem(ic.cluster, "Cluster", shortCluster(c.cluster))}
          ${infoItem(ic.tag, "Price list", shortPricelist(c.pricelist))}
          ${infoItem(ic.wallet, "Balance", c.solde)}
          ${infoItem(ic.card, "Credit limit", c.creditLim)}
        </div>

        <div class="client-coords-row ${hasCoords ? "" : "client-coords-row--empty"}">
          <div class="client-coords-label" ${hasCoords ? `data-copy="${esc(coordsText)}"` : ""} title="${esc(coordsText)}">${ic.pin} ${hasCoords ? esc(coordsDisplay) : "No coordinates"}</div>
          ${hasCoords ? `
            <button class="client-coords-btn" data-copy="${esc(coordsText)}" title="Copy coordinates">${ic.copy} Coords</button>
            <button class="client-coords-btn" data-copy="${esc(mapsUrl)}" title="Copy Maps link">${ic.link} Link</button>
            <a href="${mapsUrl}" target="_blank" class="client-coords-btn client-coords-btn--primary" title="Open in Google Maps">${ic.pin} Open</a>
          ` : ""}
        </div>

        <div class="client-hist-row">
          <button class="client-hist-btn" data-hist="ventes" data-id="${c.id}">Ventes</button>
          <button class="client-hist-btn" data-hist="livraison" data-id="${c.id}">Livraison</button>
          <button class="client-hist-btn" data-hist="encaissement" data-id="${c.id}">Encaissement</button>
          <button class="client-hist-btn" data-situation="${c.id}">Situation</button>
        </div>
      </div>`;
    }).join("")}</div>`;

    renderBulkBar();

    area.querySelectorAll(".client-name, .client-ref-copy, .ci-copy, .client-coords-btn[data-copy]").forEach(el => {
      el.addEventListener("click", () => doCopy(el.dataset.copy));
    });
    area.querySelectorAll(".client-card").forEach(card => {
      card.addEventListener("dblclick", e => {
        const t = e.target.closest("[data-copy]");
        if (t) doCopy(t.dataset.copy);
      });
    });
    area.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => removePartner(+btn.dataset.remove));
    });
    area.querySelectorAll("[data-hist]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = +btn.dataset.id;
        const c = clients.find(x => x.id === id);
        if (c) openHistoryModal(id, c.name, btn.dataset.hist);
      });
    });
    area.querySelectorAll("[data-situation]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = +btn.dataset.situation;
        const c = clients.find(x => x.id === id);
        if (c) openSituationModal(id, c.name, c.solde);
      });
    });
    area.querySelectorAll("[data-select]").forEach(cb => {
      cb.addEventListener("change", () => toggleSelect(+cb.dataset.select));
    });
    document.getElementById("clientsSelectAllBtn")?.addEventListener("click", selectAll);
    document.getElementById("clientsSelectNoneBtn")?.addEventListener("click", selectNone);
    document.getElementById("clientsSelectInvertBtn")?.addEventListener("click", selectInvert);
    document.getElementById("clientsDeleteSelectedBtn")?.addEventListener("click", () => {
      if (!clients.length) return;
      openDeleteConfirmModal(clients.length);
    });
    area.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        openEditModal(+btn.dataset.edit);
      });
    });
    area.querySelectorAll("[data-verify]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const id = +btn.dataset.verify;
        const c = clients.find(x => x.id === id);
        if (!c) return;
        btn.disabled = true;
        try {
          await rpc("res.partner", "write", [[id], { state: "verified" }], {});
          c.verifState = "verified";
          toast("Client vérifié ✓");
          render();
        } catch (err) {
          btn.disabled = false;
          toast("✗ " + err.message);
        }
      });
    });
    area.querySelectorAll("[data-addroute]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = +btn.dataset.addroute;
        const c = clients.find(x => x.id === id);
        if (c && typeof window.openAddClientToRouteFromClientModal === "function") {
          window.openAddClientToRouteFromClientModal(c);
        }
      });
    });
    area.querySelectorAll("[data-retry]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = +btn.dataset.retry;
        clients = clients.filter(c => c.id !== id);
        addPartner(id);
      });
    });
  }

  function renderBulkBar() {
    let bar = document.getElementById("clientsBulkBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "clientsBulkBar";
      bar.className = "clients-bulk-bar";
      document.body.appendChild(bar);
    }
    const n = selected.size;
    if (!n) { bar.classList.remove("clients-bulk-bar--show"); bar.innerHTML = ""; return; }
    bar.classList.add("clients-bulk-bar--show");
    bar.innerHTML = `
      <span class="clients-bulk-count">${n} sélectionné${n > 1 ? "s" : ""}</span>
      <select id="clientsBulkField" class="clients-bulk-select">
        ${COPY_FIELDS.map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join("")}
      </select>
      <button id="clientsBulkCopyBtn" class="clients-bulk-copy">${ic.copy} Copier</button>
      <button id="clientsBulkClearBtn" class="clients-bulk-clear" title="Tout désélectionner">${ic.close}</button>
    `;
    bar.querySelector("#clientsBulkCopyBtn").addEventListener("click", () => {
      const key = bar.querySelector("#clientsBulkField").value;
      bulkCopyField(key);
    });
    bar.querySelector("#clientsBulkClearBtn").addEventListener("click", () => {
      selected.clear();
      render();
    });
  }

  function injectStyles() {
    if (document.getElementById("clientsViewStyles")) return;
    const style = document.createElement("style");
    style.id = "clientsViewStyles";
    style.textContent = `
      .clients-sugg-msg { padding: 10px; color: var(--text2,#64748B); font-size: 12px; }
      .clients-sugg-msg--err { color: #EF4444; }
      .clients-suggestion-item { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 13px; }
      .clients-suggestion-item:hover { background: rgba(37,99,235,.06); }
      .clients-sugg-name { font-weight: 600; color: var(--text); }
      .clients-sugg-ref { font-size: 11px; color: var(--text2,#64748B); }

      .clients-empty { padding: 40px 20px; text-align: center; color: var(--text2,#64748B); font-size: 13px; }

      .clients-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
        gap: 14px; align-items: start;
      }

      .client-card {
        background: var(--bg2); border: 1px solid var(--border); border-radius: 14px;
        padding: 14px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
      }
      .client-card--loading { display: flex; align-items: center; gap: 10px; min-height: 64px; }
      .client-skel-avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--border); animation: clientsPulse 1.2s infinite ease-in-out; }
      .client-skel-lines { flex: 1; display: flex; flex-direction: column; gap: 6px; }
      .client-skel-lines div { height: 9px; border-radius: 4px; background: var(--border); animation: clientsPulse 1.2s infinite ease-in-out; }
      .client-skel-lines div:last-child { width: 60%; }
      @keyframes clientsPulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }

      .client-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .client-avatar {
        flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%;
        background: linear-gradient(135deg, var(--accent,#2563EB), #60A5FA);
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 13px;
      }
      .client-head-text { flex: 1; min-width: 0; }
      .client-name {
        font-size: 14.5px; font-weight: 700; color: var(--text); cursor: pointer;
        overflow-wrap: anywhere;
      }
      .client-name:hover { color: var(--accent,#2563EB); }
      .client-ref-row { display: flex; align-items: center; gap: 5px; }
      .client-ref { font-size: 11px; color: var(--text2,#64748B); }
      .client-ref-copy {
        border: none; background: transparent; color: var(--text2,#64748B); opacity: .5;
        cursor: pointer; display: flex; align-items: center; padding: 2px; border-radius: 4px;
      }
      .client-ref-copy:hover { opacity: 1; color: var(--accent,#2563EB); background: rgba(37,99,235,.08); }
      .client-head-btn {
        flex-shrink: 0; width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text2,#64748B); display: flex; align-items: center; justify-content: center;
        cursor: pointer; text-decoration: none;
      }
      .client-head-btn:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .client-remove-btn:hover { color: #EF4444; border-color: #EF4444; }

      .client-tag {
        display: inline-block; background: rgba(37,99,235,.1); color: var(--accent,#2563EB);
        font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 20px; margin-bottom: 10px;
      }

      .client-info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
      .ci-item {
        display: flex; align-items: center; gap: 8px; background: var(--bg); border: 1px solid var(--border);
        border-radius: 9px; padding: 7px 8px; position: relative; cursor: pointer;
      }
      .ci-item--empty { opacity: .45; }
      .ci-icon { flex-shrink: 0; color: var(--text2,#64748B); display: flex; }
      .ci-body { min-width: 0; flex: 1; }
      .ci-label { font-size: 10px; color: var(--text2,#64748B); line-height: 1.2; }
      .ci-value { font-size: 12.5px; font-weight: 700; color: var(--text); overflow-wrap: anywhere; }
      .ci-copy {
        flex-shrink: 0; border: none; background: transparent; color: var(--text2,#64748B); opacity: .35;
        cursor: pointer; display: flex; align-items: center; padding: 3px; border-radius: 5px;
      }
      .ci-item:hover .ci-copy { opacity: 1; }
      .ci-copy:hover { color: var(--accent,#2563EB); background: rgba(37,99,235,.08); }

      .client-coords-row {
        display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
        border-top: 1px dashed var(--border); padding-top: 10px;
      }
      .client-coords-row--empty { opacity: .45; }
      .client-coords-label {
        display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text); font-weight: 600;
        margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto;
      }
      .client-coords-btn {
        display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); background: var(--bg);
        color: var(--text2,#64748B); font-size: 11px; font-weight: 600; padding: 5px 8px; border-radius: 7px;
        cursor: pointer; text-decoration: none; flex-shrink: 0; white-space: nowrap;
      }
      .client-coords-btn:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .client-coords-btn--primary { background: var(--accent,#2563EB); color: #fff; border-color: var(--accent,#2563EB); }
      .client-coords-btn--primary:hover { opacity: .9; color: #fff; }

      .clients-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
        background: #111827; color: #fff; font-size: 12.5px; font-weight: 600; padding: 9px 16px;
        border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: 0; pointer-events: none;
        transition: opacity .18s ease, transform .18s ease; z-index: 999;
      }
      .clients-toast--show { opacity: 1; transform: translateX(-50%) translateY(0); }

      .client-hist-row {
        display: flex; gap: 6px; border-top: 1px dashed var(--border); padding-top: 10px; margin-top: 10px;
      }
      .client-hist-btn {
        flex: 1; border: 1px solid var(--border); background: var(--bg); color: var(--text2,#64748B);
        font-size: 11.5px; font-weight: 700; padding: 7px 6px; border-radius: 8px; cursor: pointer;
      }
      .client-hist-btn:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }

      .ch-modal {
        position: fixed; inset: 0; z-index: 1000; display: none;
      }
      .ch-modal--open { display: block; }
      .ch-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
      .ch-modal-box {
        position: relative; margin: 5vh auto; width: min(680px, 92vw); max-height: 88vh;
        background: var(--bg2); border: 1px solid var(--border); border-radius: 14px;
        display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.25);
      }
      .ch-modal-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 14px 16px; border-bottom: 1px solid var(--border);
      }
      .ch-modal-title { font-size: 14px; font-weight: 700; color: var(--text); }
      .ch-modal-close {
        border: none; background: transparent; color: var(--text2,#64748B); cursor: pointer;
        display: flex; align-items: center; padding: 4px; border-radius: 6px;
      }
      .ch-modal-close:hover { color: #EF4444; }
      .ch-modal-body { overflow-y: auto; padding: 10px 16px; flex: 1; }
      .ch-modal-foot { padding: 10px 16px; border-top: 1px solid var(--border); text-align: center; }
      .ch-modal-more {
        border: 1px solid var(--border); background: var(--bg); color: var(--text);
        font-size: 12.5px; font-weight: 700; padding: 8px 16px; border-radius: 8px; cursor: pointer;
      }
      .ch-modal-more:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .ch-msg { padding: 20px; text-align: center; color: var(--text2,#64748B); font-size: 13px; }
      .ch-msg--err { color: #EF4444; }
      .ch-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .ch-table th {
        text-align: left; color: var(--text2,#64748B); font-weight: 600; font-size: 11px;
        padding: 6px 8px; border-bottom: 1px solid var(--border);
      }
      .ch-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
      .ch-table tr:hover td { background: rgba(37,99,235,.05); }
      .ch-open-btn {
        display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
        border-radius: 6px; color: var(--text2,#64748B); text-decoration: none;
      }
      .ch-open-btn:hover { color: var(--accent,#2563EB); background: rgba(37,99,235,.08); }
      .ch-pdf-btn:hover { color: #DC2626; background: rgba(220,38,38,.08); }

      .client-card--selected { outline: 2px solid var(--accent,#2563EB); outline-offset: -1px; }
      .client-select-cb { flex-shrink: 0; width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent,#2563EB); }

      .clients-bulk-bar {
        position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%) translateY(20px);
        display: none; align-items: center; gap: 8px; background: var(--bg2); border: 1px solid var(--border);
        border-radius: 12px; padding: 8px 10px; box-shadow: 0 8px 28px rgba(0,0,0,.25); z-index: 900;
        opacity: 0; transition: opacity .15s ease, transform .15s ease;
      }
      .clients-bulk-bar--show { display: flex; opacity: 1; transform: translateX(-50%) translateY(0); }
      .clients-bulk-count { font-size: 12px; font-weight: 700; color: var(--text); white-space: nowrap; padding: 0 4px; }
      .clients-bulk-select {
        font-size: 12px; padding: 7px 8px; border-radius: 8px; border: 1px solid var(--border);
        background: var(--bg); color: var(--text);
      }
      .clients-bulk-copy {
        display: inline-flex; align-items: center; gap: 5px; border: none; background: var(--accent,#2563EB);
        color: #fff; font-size: 12.5px; font-weight: 700; padding: 8px 12px; border-radius: 8px; cursor: pointer;
      }
      .clients-bulk-copy:hover { opacity: .9; }
      .clients-bulk-clear {
        border: 1px solid var(--border); background: var(--bg); color: var(--text2,#64748B);
        display: flex; align-items: center; padding: 7px; border-radius: 8px; cursor: pointer;
      }
      .clients-bulk-clear:hover { color: #EF4444; border-color: #EF4444; }

      .clients-toolbar { display: flex; gap: 6px; margin-bottom: 12px; }
      .clients-tool-btn {
        display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
        border: 1px solid var(--border); background: var(--bg2); color: var(--text2,#64748B);
        border-radius: 8px; cursor: pointer;
      }
      .clients-tool-btn:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .clients-tool-btn--danger:hover { color: #EF4444 !important; border-color: #EF4444 !important; }

      .ch-modal-box--sm { width: min(420px, 92vw); }
      .ce-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
      .ce-field label { font-size: 11px; font-weight: 700; color: var(--text2,#64748B); }
      .ce-photo-row { display: flex; align-items: center; gap: 12px; }
      .ce-photo-preview {
        flex-shrink: 0; width: 56px; height: 56px; border-radius: 50%;
        background: linear-gradient(135deg, var(--accent,#2563EB), #60A5FA);
        background-size: cover; background-position: center;
        color: #fff; display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 16px; border: 1px solid var(--border,#E2E8F0);
      }
      .ce-photo-actions { display: flex; flex-direction: column; gap: 6px; }
      .ce-btn--danger { color: #EF4444 !important; border-color: #FCA5A5 !important; }
      .ce-btn--danger:hover { color: #DC2626 !important; border-color: #EF4444 !important; }
      .ce-input {
        border: 1px solid var(--border); background: var(--bg); color: var(--text); border-radius: 8px;
        padding: 8px 10px; font-size: 13px; width: 100%; box-sizing: border-box;
      }
      .ce-input:focus { outline: none; border-color: var(--accent,#2563EB); }
      .ce-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .ce-error { color: #EF4444; font-size: 12px; margin-top: 4px; }
      .ch-modal-foot--right { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .ce-btn { border-radius: 8px; padding: 8px 14px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
      .ce-btn--ghost { border: 1px solid var(--border); background: var(--bg); color: var(--text); }
      .ce-coords-mode-btn[data-active="1"] { border-color: var(--accent,#2563EB); color: var(--accent,#2563EB); background: color-mix(in srgb, var(--accent,#2563EB) 10%, var(--bg)); }
      .ce-btn--ghost:hover { border-color: var(--accent,#2563EB); color: var(--accent,#2563EB); }
      .ce-btn--primary { border: none; background: var(--accent,#2563EB); color: #fff; }
      .ce-btn--primary:hover { opacity: .9; }
      .ce-btn--primary:disabled { opacity: .6; cursor: default; }

      .cs-period-row { display: flex; gap: 10px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
      .cs-mode-row { display: flex; gap: 6px; margin-bottom: 14px; }
      .cs-mode-btn {
        border: 1px solid var(--border); background: var(--bg); color: var(--text2,#64748B);
        font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 8px; cursor: pointer;
      }
      .cs-mode-btn:hover { color: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .cs-mode-btn--active { color: #fff; background: var(--accent,#2563EB); border-color: var(--accent,#2563EB); }
      .ch-modal-foot--right { flex-wrap: wrap; row-gap: 8px; }
      .cs-capture { position: relative; background: #fff; color: #000; padding: 12px; border-radius: 8px; }
      .cs-capture-head {
        display: flex; flex-direction: row; align-items: center; gap: 10px;
        margin-bottom: 14px; font-size: 12px; color: #000; text-align: left; flex-wrap: nowrap;
      }
      .cs-head-line { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
      .cs-head-sep { color: #94A3B8; margin: 0 6px; font-weight: 400; }
      .cs-head-logo { height: 36px; width: auto; margin: 0; flex: 0 0 auto; }
      .cs-head-solde { color: #B91C1C; }
      .cs-tables-row { display: flex; gap: 6px; align-items: flex-start; width: 100%; }
      .cs-table { flex: 1 1 0; width: 50%; box-sizing: border-box; border-collapse: collapse; table-layout: fixed; font-size: 16px; }
      .cs-table--matched { width: 100%; }
      .cs-table th {
        text-align: left; color: #111827; font-weight: 700; background: #f1f5f9;
        padding: 3px 5px; border: 1px solid #cbd5e1;
      }
      .cs-table thead tr:first-child th { text-align: center; }
      .cs-table td {
        height: 24px; box-sizing: border-box; padding: 5px 6px; border: 1px solid #cbd5e1;
        color: #111827; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        vertical-align: middle;
      }
      .cs-table tbody tr:nth-child(even) td { background: #f8fafc; }
      .cs-table .cs-amount { text-align: right; font-variant-numeric: tabular-nums; }
      .cs-row--avoir td { font-weight: 700; }
      .cs-avoir-tag {
        display: inline;
        margin-left: 6px;
        font-size: 9px;
        font-weight: 500;
        line-height: 1;
        color: var(--text2,#64748B);
      }
    `;
    document.head.appendChild(style);
  }

  function initCreateBtn() {
    const btn = document.getElementById("clientsCreateBtn");
    if (!btn || btn._createBound) return;
    btn._createBound = true;
    btn.addEventListener("click", () => openCreateClientModal());
  }

  function activate() {
    injectStyles();
    initInput();
    initGeoSearch();
    initCreateBtn();
    render();
  }

  function deactivate() {
    const bar = document.getElementById("clientsBulkBar");
    if (bar) bar.classList.remove("clients-bulk-bar--show");
  }

  // ينتقل لقسم Clients: يمسح اللائحة الحالية بالكامل ويضيف هذا الزبون فقط —
  // بدون فتح أي نافذة/مودال، فقط عرضه كبطاقة ضمن القسم.
  async function openProfileById(clientId, clientRef) {
    let id = clientId != null ? +clientId : null;
    if ((!id || id <= 0) && clientRef) {
      try {
        const rows = await rpc("res.partner", "search_read", [[["ref", "=", clientRef]]], { fields: ["id"], limit: 1 });
        id = rows?.[0]?.id || null;
      } catch (e) { id = null; }
    }
    if (!id || id <= 0) return;
    clients = [];
    await addPartner(id);
  }

  return { activate, deactivate, openProfileById };
})();
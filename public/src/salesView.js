/* src/salesView.js — SALES section: sale.order search + filter + list + détail */

window.SalesView = (() => {
  const PAGE_SIZE = 40;

  const STATE_LABELS = {
    draft: "Devis", sent: "Devis envoyé", sale: "Confirmée",
    done: "Verrouillée", cancel: "Annulée",
  };
  const STATE_COLORS = {
    draft: "#94A3B8", sent: "#5AA6FF", sale: "#16A34A",
    done: "#0D9488", cancel: "#DC2626",
  };
  const STATE_ORDER = ["draft", "sent", "sale", "done", "cancel"];

  // Comptoir & Acile: correspondent à deux actions Odoo (ir.actions.act_window)
  // dont on récupère dynamiquement le domain réel (au lieu de deviner un champ).
  const WAREHOUSES = [
    { id: 484, label: "Comptoir" },
    { id: 661, label: "Acile" },
    { id: 485, label: "Devis", color: "#8B5CF6" },
  ];
  let warehouseDomains = {}; // { actionId: domain (array) } — rempli au chargement

  let orders = [];      // lignes chargées (accumulées au fil des pages)
  let offset = 0;
  let total = 0;
  let loading = false;
  let searchQuery = "";
  let activeStates = new Set(); // vide = tous les états
  let activeWarehouses = new Set(WAREHOUSES.filter(w => w.id !== 485).map(w => w.id)); // Comptoir & Acile actifs par défaut, Devis désactivé

  /* ── Ligne de commande : choix du champ qty envoyé à Odoo ───────────
     Selon la valeur saisie dans le champ CDN :
       - nombre décimal  → écrit dans product_uom_qty (Champ : product_uom_qty)
       - nombre entier (naturel) → écrit dans packaging_quantity (Champ : packaging_quantity)
     Odoo se charge de recalculer l'autre champ à partir de celui fourni. ── */
  function _lineQtyVals(l) {
    const cdn = l.cdn || 0;
    if (l.packagingQty > 0 && Number.isInteger(cdn)) {
      return { packaging_quantity: cdn };
    }
    return { product_uom_qty: l.qty };
  }

  /* ── RPC minimal (même schéma que clientsView.js) ─────────── */
  async function rpc(model, method, args, kwargs) {
    const resp = await fetch("/api/web/dataset/call_kw", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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

  /* ── Libellés des promotions (product.promotion) ──────────────
     Le texte de l'offre (ex: "5+1") doit venir d'Odoo lui-même,
     jamais être recalculé depuis les quantités livrées/vendues.
     On découvre dynamiquement les champs texte disponibles sur
     product.promotion via fields_get (une seule fois, mis en cache),
     puis on lit les enregistrements demandés. ────────────────── */
  let _promotionFieldNamesPromise = null;
  const PROMOTION_FIELD_CANDIDATES = [
    "name", "display_name", "label", "description",
    "promo_text", "promo_label", "text", "code", "rule_name",
  ];
  async function getPromotionFieldNames() {
    if (_promotionFieldNamesPromise) return _promotionFieldNamesPromise;
    _promotionFieldNamesPromise = (async () => {
      try {
        const fieldsInfo = await rpc("product.promotion", "fields_get", [], {
          attributes: ["string", "type"],
        });
        const available = Object.keys(fieldsInfo || {});
        const picked = PROMOTION_FIELD_CANDIDATES.filter(f => available.includes(f));
        // fallback: n'importe quel champ char/text si aucun candidat connu n'existe
        if (!picked.length) {
          Object.entries(fieldsInfo || {}).forEach(([fname, finfo]) => {
            if ((finfo.type === "char" || finfo.type === "text") && fname !== "id") picked.push(fname);
          });
        }
        return picked.length ? picked : ["name"];
      } catch (e) {
        // fields_get indisponible ou modèle inaccessible: on tente "name" par défaut
        return ["name"];
      }
    })();
    return _promotionFieldNamesPromise;
  }
  const _promotionLabelCache = {}; // { id: labelText }
  async function fetchPromotionLabels(ids) {
    const list = Array.from(new Set((ids || []).filter(Boolean)));
    if (!list.length) return {};
    const missing = list.filter(id => !(id in _promotionLabelCache));
    if (missing.length) {
      const fieldNames = await getPromotionFieldNames();
      try {
        const recs = await rpc("product.promotion", "read", [missing], {
          fields: Array.from(new Set(["id", ...fieldNames])),
        });
        recs.forEach(r => {
          let label = "";
          for (const f of fieldNames) {
            const v = r[f];
            if (v && typeof v === "string" && v.trim()) { label = v.trim(); break; }
          }
          _promotionLabelCache[r.id] = label || "Offre promotionnelle";
        });
      } catch (e) {
        missing.forEach(id => { _promotionLabelCache[id] = "Offre promotionnelle"; });
      }
    }
    const map = {};
    list.forEach(id => { map[id] = _promotionLabelCache[id] || "Offre promotionnelle"; });
    return map;
  }
  function joinPromotionLabels(map, ids) {
    const labels = Array.from(new Set((ids || []).map(id => map[id]).filter(Boolean)));
    return labels.join(" · ");
  }

  /* ── Libellé de la remise (sale.order.line) ────────────────────
     Le pourcentage de remise (`discount`) vient déjà directement
     d'Odoo (pas de calcul). Ce qu'on ajoute ici, comme pour les
     promotions, c'est le MOTIF/LIBELLÉ textuel de la remise s'il
     existe dans Odoo (ex: champ many2one "discount_reason_id" ou
     un champ texte) — découvert dynamiquement via fields_get sur
     sale.order.line, jamais déduit ou inventé côté client. ────── */
  let _discountReasonFieldPromise = null;
  const DISCOUNT_REASON_FIELD_CANDIDATES = [
    "discount_reason_id", "discount_reason", "remise_reason_id", "motif_remise_id",
    "discount_id", "discount_label", "discount_note", "discount_comment",
  ];
  async function getDiscountReasonFieldName() {
    if (_discountReasonFieldPromise) return _discountReasonFieldPromise;
    _discountReasonFieldPromise = (async () => {
      try {
        const fieldsInfo = await rpc("sale.order.line", "fields_get", [], {
          attributes: ["string", "type"],
        });
        const available = Object.keys(fieldsInfo || {});
        const known = DISCOUNT_REASON_FIELD_CANDIDATES.find(f => available.includes(f));
        if (known) return known;
        // fallback: tout champ contenant "discount"/"remise" (hors le % et le montant
        // déjà utilisés ailleurs: "discount", "discount_amount") de type many2one/char/text
        const guess = Object.entries(fieldsInfo || {}).find(([fname, finfo]) => {
          if (fname === "discount" || fname === "discount_amount") return false;
          const isTextual = ["many2one", "char", "text"].includes(finfo.type);
          return isTextual && /discount|remise/i.test(fname);
        });
        return guess ? guess[0] : null;
      } catch (e) {
        return null;
      }
    })();
    return _discountReasonFieldPromise;
  }
  function discountReasonLabel(rec, fieldName) {
    if (!fieldName || !rec) return "";
    const v = rec[fieldName];
    if (Array.isArray(v)) return v[1] || ""; // many2one -> [id, name]
    if (typeof v === "string") return v.trim();
    return "";
  }

  /* ── Détection automatique des promotions actives ──────────────
     product.promotion n'a en réalité que id/name/state : ce n'est pas
     un moteur de règles, juste une étiquette. Au lieu de laisser le
     staff chercher/choisir manuellement dans une liste, on détecte
     automatiquement les promotions actuellement "actives" (via le
     champ state, découvert dynamiquement) et on les attache toutes
     pour traçabilité via order.promotion_ids (si ce champ existe). ── */
  const PROMO_ACTIVE_KEYWORDS = ["active", "actif", "en_cours", "encours", "running", "valid", "confirm", "open", "progress", "cours", "publi", "started", "current"];
  const PROMO_INACTIVE_KEYWORDS = ["draft", "brouillon", "cancel", "annul", "clos", "closed", "done", "termine", "terminé", "expir", "archiv", "inactive", "stop", "end"];
  let _promoStateDomainPromise = null;
  async function _getActivePromotionDomain() {
    if (_promoStateDomainPromise) return _promoStateDomainPromise;
    _promoStateDomainPromise = (async () => {
      try {
        const info = await rpc("product.promotion", "fields_get", ["state"], { attributes: ["selection"] });
        const options = info?.state?.selection;
        if (Array.isArray(options) && options.length) {
          const activeValues = options
            .map(([val]) => val)
            .filter(val => {
              const v = String(val).toLowerCase();
              if (PROMO_INACTIVE_KEYWORDS.some(k => v.includes(k))) return false;
              return PROMO_ACTIVE_KEYWORDS.some(k => v.includes(k));
            });
          if (activeValues.length) return [["state", "in", activeValues]];
        }
      } catch (e) {
        console.warn("[Vente] détection état product.promotion échouée:", e.message);
      }
      return []; // pas de filtre fiable trouvé: on prend toutes les promotions
    })();
    return _promoStateDomainPromise;
  }
  /* ── Découverte dynamique des champs "règle" sur product.promotion ──
     On ne suppose plus que id/name/state: on cherche en plus, parmi
     les champs réellement présents (fields_get), de quoi déterminer:
     - à quel produit/catégorie l'offre s'applique (product_id /
       product_tmpl_id / categ_id),
     - si c'est une remise % (discount_percent/remise/percent/...),
     - ou une offre palier "achetés+offerts" du type 10+2
       (buy_qty + free_qty, sous des noms variables). ─────────────── */
  const PROMO_PRODUCT_FIELD_CANDIDATES = ["product_id"];
  const PROMO_TMPL_FIELD_CANDIDATES = ["product_tmpl_id"];
  const PROMO_CATEG_FIELD_CANDIDATES = ["categ_id", "category_id", "product_categ_id", "product_category_id"];
  const PROMO_DISCOUNT_FIELD_CANDIDATES = ["discount_percent", "remise", "remise_percent", "percentage", "percent", "discount"];
  const PROMO_BUYQTY_FIELD_CANDIDATES = ["buy_qty", "qty_buy", "quantite_achat", "achat_qty", "qty_condition", "x_qty"];
  const PROMO_FREEQTY_FIELD_CANDIDATES = ["free_qty", "qty_free", "qty_offerte", "quantite_offerte", "offered_qty", "gift_qty", "y_qty"];
  // Quantité minimale requise pour qu'une remise % s'applique (distinct de buy_qty,
  // qui sert au ratio "achetés/offerts"). Ex: "remise 10% à partir de 5 unités".
  const PROMO_MINQTY_FIELD_CANDIDATES = ["min_qty_promo", "min_quantity", "min_qty", "minimum_qty", "qty_min", "seuil_qty"];
  // Dates de validité de l'offre.
  const PROMO_DATE_FROM_FIELD_CANDIDATES = ["date_from", "date_start", "validity_date_start", "start_date", "x_date_from"];
  const PROMO_DATE_TO_FIELD_CANDIDATES   = ["date_to",   "date_end",   "validity_date_end",   "end_date",   "x_date_to"];

  // Extrait le cluster cible depuis le libellé de l'offre.
  // Les noms d'offre contiennent souvent "GMS A", "GMS B", "GROS A", "HORECA", "DETAIL"...
  // On retourne le label tel qu'écrit dans le nom (ex: "GMS A", "GROS B") pour l'afficher.
  const PROMO_CLUSTER_PATTERNS = [
    { re: /\bGMS\s*[AB]?\b/i,    label: m => m[0].trim().toUpperCase() },
    { re: /\bGROS\s*[AB]?\b/i,   label: m => m[0].trim().toUpperCase() },
    { re: /\bHORECA\b/i,         label: () => "HORECA" },
    { re: /\bD[EÉ]TAIL\b/i,      label: () => "DÉTAIL" },
  ];
  function _extractClusterFromText(name) {
    const s = String(name || "");
    for (const { re, label } of PROMO_CLUSTER_PATTERNS) {
      const m = s.match(re);
      if (m) return label(m);
    }
    return null;
  }

  let _promoRuleFieldsPromise = null;
  async function _getPromotionRuleFields() {
    if (_promoRuleFieldsPromise) return _promoRuleFieldsPromise;
    _promoRuleFieldsPromise = (async () => {
      try {
        const info = await rpc("product.promotion", "fields_get", [], { attributes: ["string", "type"] });
        const available = new Set(Object.keys(info || {}));
        const pick = (candidates) => candidates.find(f => available.has(f)) || null;
        const result = {
          productField: pick(PROMO_PRODUCT_FIELD_CANDIDATES),
          tmplField: pick(PROMO_TMPL_FIELD_CANDIDATES),
          categField: pick(PROMO_CATEG_FIELD_CANDIDATES),
          discountField: pick(PROMO_DISCOUNT_FIELD_CANDIDATES),
          buyQtyField: pick(PROMO_BUYQTY_FIELD_CANDIDATES),
          freeQtyField: pick(PROMO_FREEQTY_FIELD_CANDIDATES),
          minQtyField: pick(PROMO_MINQTY_FIELD_CANDIDATES),
          dateFromField: pick(PROMO_DATE_FROM_FIELD_CANDIDATES),
          dateToField: pick(PROMO_DATE_TO_FIELD_CANDIDATES),
        };
        // Diagnostic: si rien n'a été détecté, on affiche la liste complète des
        // champs réels du modèle pour identifier les bons noms à ajouter aux
        // *_FIELD_CANDIDATES ci-dessus.
        if (!result.productField && !result.tmplField && !result.categField && !result.discountField && !result.buyQtyField && !result.freeQtyField && !result.minQtyField) {
          console.warn("[Vente] Aucun champ de règle reconnu sur product.promotion. Champs réels disponibles:", info);
        } else {
          console.info("[Vente] Champs de règle product.promotion détectés:", result);
        }
        return result;
      } catch (e) {
        console.warn("[Vente] fields_get règles product.promotion échoué:", e.message);
        return { productField: null, tmplField: null, categField: null, discountField: null, buyQtyField: null, freeQtyField: null, minQtyField: null, dateFromField: null, dateToField: null };
      }
    })();
    return _promoRuleFieldsPromise;
  }

  function _num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /* ── Analyse du texte de `name` quand product.promotion n'a pas de
     champs structurés (cas confirmé ici: seulement id/name/state).
     Le % de remise et le produit visé sont écrits dans le libellé,
     ex: "PROMO SERVIETTE 40X40/50 PALACE IMPRIME 10% - AOUT 2026".
     On extrait le %, et on matche le produit par recouvrement de
     "tokens" distinctifs (dimensions, références, mots du nom du
     produit) entre le libellé de la promo et le nom du produit. ── */
  const PROMO_TEXT_STOPWORDS = new Set([
    "PROMO", "PROMOTION", "ACTION", "PALIER", "SPECIAL", "REMISE", "OFFRE",
    "JANVIER", "FEVRIER", "MARS", "AVRIL", "MAI", "JUIN", "JUILLET", "AOUT",
    "SEPTEMBRE", "OCTOBRE", "NOVEMBRE", "DECEMBRE", "2024", "2025", "2026", "2027",
  ]);
  function _extractDiscountPercentFromText(name) {
    const m = String(name || "").match(/(\d+(?:[.,]\d+)?)\s*%/);
    return m ? parseFloat(m[1].replace(",", ".")) : 0;
  }
  // 2+ signes "+" ⇒ combo multi-produits (ex: "ALUM 5 + FILM 10 + CUISSON 5"),
  // trop ambigu pour matcher un seul produit automatiquement.
  function _isBundlePromoText(name) {
    return ((String(name || "").match(/\+/g)) || []).length >= 2;
  }
  // Quantité minimale écrite dans le libellé d'une remise %, ex:
  // "REMISE 10% À PARTIR DE 5", "10% DÈS 5 UNITÉS", "10% MIN 5 PCS".
  function _extractMinQtyFromText(name) {
    const s = String(name || "");
    // Patterns explicites: "à partir de N", "dès N", "min N", "à compter de N"
    let m = s.match(/(?:à\s*partir\s*de|a\s*partir\s*de|d[eè]s|min(?:imum)?|à\s*compter\s*de)\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    // "PALIER N" ou "PALIER: N"
    m = s.match(/\bPALIER\s*:?\s*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    // "N CS" ou "NCS" (colis/cartons) ou "N PCE" ou "N UNITES"
    m = s.match(/\b(\d+)\s*(?:CS|PCE|PCS|UNITES?|UNI|CARTONS?|COLIS)\b/i);
    if (m) return parseInt(m[1], 10);
    // "X N" ou "×N" (multiplicateur)
    m = s.match(/\bX\s*(\d+)\b/i);
    if (m) return parseInt(m[1], 10);
    return 0;
  }
  // Offre "achetés + offerts" écrite dans le libellé avec un seul "+"
  // (2+ "+" = bundle, déjà géré par _isBundlePromoText), ex: "10+2", "10 + 2 GRATUIT".
  // Retourne { buyQty, freeQty } ou null si aucun motif fiable trouvé.
  function _extractBuyGetFromText(name) {
    const s = String(name || "");
    const m = s.match(/(\d+)\s*\+\s*(\d+)\b/);
    if (!m) return null;
    const buyQty = parseInt(m[1], 10);
    const freeQty = parseInt(m[2], 10);
    if (!(buyQty > 0) || !(freeQty > 0)) return null;
    return { buyQty, freeQty };
  }
  function _tokenizePromoText(name) {
    return String(name || "")
      .toUpperCase()
      .replace(/\[.*?\]/g, " ")
      .replace(/=>.*$/, " ")
      .replace(/[^A-Z0-9]+/g, " ")
      .split(" ")
      .filter(t => t.length >= 2 && !PROMO_TEXT_STOPWORDS.has(t));
  }
  const PROMO_TEXT_MATCH_THRESHOLD = 0.5; // part des tokens distinctifs du produit devant se retrouver dans le libellé promo
  function _productMatchesPromoText(promoTokens, productName) {
    const prodTokens = _tokenizePromoText(productName);
    if (!prodTokens.length) return 0;
    const promoSet = new Set(promoTokens);
    const hits = prodTokens.filter(t => promoSet.has(t)).length;
    return hits / prodTokens.length;
  }

  // Retourne les promotions actives, normalisées: { id, name, productId, tmplId, categId,
  // discountPercent, buyQty, freeQty, kind: 'remise' | 'buyget' | 'text-remise' | 'bundle' | 'tag',
  // tokens (pour kind='text-remise') }
  // ── Diagnostic ponctuel: dump TOUS les champs réels de product.promotion
  // (pas seulement nos candidats) + la valeur brute complète d'un enregistrement,
  // pour repérer le vrai nom du champ "quantité minimale" côté Odoo.
  // Ne s'exécute qu'une fois par session (voir _diagPromoFieldsDone).
  let _diagPromoFieldsDone = false;
  async function _diagDumpPromotionFields(sampleId) {
    if (_diagPromoFieldsDone) return;
    _diagPromoFieldsDone = true;
    try {
      const allFields = await rpc("product.promotion", "fields_get", [], { attributes: ["string", "type"] });
      console.info("[Vente][DIAG] TOUS les champs de product.promotion:", allFields);
      if (sampleId) {
        const [full] = await rpc("product.promotion", "read", [[sampleId]], {});
        console.info(`[Vente][DIAG] Valeurs complètes de product.promotion id=${sampleId}:`, full);
      }
    } catch (e) {
      console.warn("[Vente][DIAG] échec dump product.promotion:", e.message);
    }
  }

  async function _fetchAutoPromotions() {
    console.log("[Vente] _fetchAutoPromotions: appel...");
    try {
      const domain = await _getActivePromotionDomain();
      const rf = await _getPromotionRuleFields();
      const fields = Array.from(new Set(["id", "name",
        rf.productField, rf.tmplField, rf.categField, rf.discountField, rf.buyQtyField, rf.freeQtyField, rf.minQtyField,
        rf.dateFromField, rf.dateToField,
      ].filter(Boolean)));
      const rows = await rpc("product.promotion", "search_read", [domain], { fields, limit: 50 });
      if (rows.length) _diagDumpPromotionFields(rows[0].id);
      const result = rows.map(r => {
        const productId = rf.productField && Array.isArray(r[rf.productField]) ? r[rf.productField][0] : (rf.productField ? r[rf.productField] : null);
        const tmplId = rf.tmplField && Array.isArray(r[rf.tmplField]) ? r[rf.tmplField][0] : (rf.tmplField ? r[rf.tmplField] : null);
        const categId = rf.categField && Array.isArray(r[rf.categField]) ? r[rf.categField][0] : (rf.categField ? r[rf.categField] : null);
        const discountPercent = rf.discountField ? _num(r[rf.discountField]) : 0;
        const buyQty = rf.buyQtyField ? _num(r[rf.buyQtyField]) : 0;
        const freeQty = rf.freeQtyField ? _num(r[rf.freeQtyField]) : 0;
        const minQtyField = rf.minQtyField ? _num(r[rf.minQtyField]) : 0;
        const dateFrom = rf.dateFromField ? (r[rf.dateFromField] || null) : null;
        const dateTo   = rf.dateToField   ? (r[rf.dateToField]   || null) : null;
        // Cluster extrait du libellé de l'offre (GMS A, GROS B, HORECA, DÉTAIL…).
        const cluster = _extractClusterFromText(r.name);

        // 1) Champs structurés s'ils existent (peu probable ici, mais on garde
        //    la voie au cas où un autre déploiement Odoo en dispose).
        // Objet de conditions communes à tous les types d'offre.
        const _cond = { cluster, dateFrom: dateFrom || null, dateTo: dateTo || null };
        if (discountPercent > 0) {
          const minQty = minQtyField || _extractMinQtyFromText(r.name);
          return { id: r.id, name: r.name, productId: productId || null, tmplId: tmplId || null, categId: categId || null, discountPercent, minQty, buyQty: 0, freeQty: 0, kind: "remise", ..._cond };
        }
        if (buyQty > 0 && freeQty > 0) {
          return { id: r.id, name: r.name, productId: productId || null, tmplId: tmplId || null, categId: categId || null, discountPercent: 0, buyQty, freeQty, kind: "buyget", ..._cond };
        }
        // 2) Sinon, on parse le texte du libellé (cas confirmé sur ce déploiement).
        if (_isBundlePromoText(r.name)) {
          return { id: r.id, name: r.name, kind: "bundle", ..._cond }; // combo multi-produits: pas d'auto-application, juste tag
        }
        const textPercent = _extractDiscountPercentFromText(r.name);
        if (textPercent > 0) {
          const minQty = minQtyField || _extractMinQtyFromText(r.name);
          return { id: r.id, name: r.name, discountPercent: textPercent, minQty, kind: "text-remise", tokens: _tokenizePromoText(r.name), ..._cond };
        }
        // 3) Offre "achetés + offerts" écrite en texte (ex: "10+2"), non détectée
        //    par les champs structurés ni par le % ⇒ jusqu'ici classée "tag" et
        //    jamais appliquée. On tente de l'extraire du libellé.
        const buyGet = _extractBuyGetFromText(r.name);
        if (buyGet) {
          return { id: r.id, name: r.name, discountPercent: 0, buyQty: buyGet.buyQty, freeQty: buyGet.freeQty, kind: "buyget-text", tokens: _tokenizePromoText(r.name), ..._cond };
        }
        return { id: r.id, name: r.name, kind: "tag", ..._cond };
      });
      console.info("[Vente] Promotions actives normalisées:", result);
      return result;
    } catch (e) {
      console.warn("[Vente] recherche automatique product.promotion échouée:", e.message);
      return [];
    }
  }

  // Trouve, parmi les promotions actives, celles applicables à un produit donné.
  // - Liaison structurée (variant > modèle > catégorie) si les champs existent.
  // - Sinon, correspondance texte: tokens distinctifs du nom du produit
  //   retrouvés dans le libellé de la promo (voir _fetchAutoPromotions).
  function _promotionsForProduct(promotions, meta, productId, productName) {
    return promotions.filter(p => {
      if (p.kind === "tag" || p.kind === "bundle") return false;
      if (p.kind === "text-remise" || p.kind === "buyget-text") {
        return _productMatchesPromoText(p.tokens, productName) >= PROMO_TEXT_MATCH_THRESHOLD;
      }
      if (p.productId) return p.productId === productId;
      if (p.tmplId) return meta && p.tmplId === meta.tmplId;
      if (p.categId) return meta && meta.categParents.includes(p.categId);
      return false; // aucun champ de liaison détecté: on n'applique pas à l'aveugle
    });
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  /* ── Liens Odoo (ouvrir la vente / le BL dans Odoo) ───────── */
  function _odooBase() {
    try { return (typeof getOdooBase === "function" ? getOdooBase() : ODOO_BASE) || ""; }
    catch (e) { return ""; }
  }
  function _odooOrderUrl(orderId) {
    return `${_odooBase()}/web#id=${orderId}&model=sale.order&view_type=form&cids=1`;
  }
  function _odooPickingUrl(pickingId) {
    return `${_odooBase()}/web#id=${pickingId}&action=547&active_id=${pickingId}&model=stock.picking&view_type=form&cids=1&menu_id=336`;
  }
  function _odooLinkBtn(url, title) {
    return `<a href="${url}" target="_blank" rel="noopener" class="sales-odoo-link" title="${esc(title || "Ouvrir dans Odoo")}">↗</a>`;
  }
  function _pdfPickingUrl(pickingId) {
    return `/api/report/pdf/stock.report_deliveryslip/${pickingId}`;
  }
  function _pdfLinkBtn(pickingId, filename) {
    const fname = esc(String(filename || `BL-${pickingId}`).replace(/[\\/]+/g, "-")) + ".pdf";
    return `<a href="${_pdfPickingUrl(pickingId)}" download="${fname}" rel="noopener" class="sales-pdf-link" title="Télécharger le BL en PDF">⬇</a>`;
  }
  function formatMoney(n) {
    if (n === null || n === undefined || n === "") return "";
    const num = Number(n);
    if (isNaN(num)) return String(n);
    const parts = num.toFixed(2).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return parts[0] + "," + parts[1];
  }
  function formatDate(d) {
    if (!d) return "";
    const dt = new Date(String(d).replace(" ", "T"));
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString("fr-FR") + " " + dt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  // Combine une liste de leaves (tuples simples, pas d'opérateur imbriqué) en un seul
  // opérande valide pour la notation préfixe Odoo, afin de pouvoir l'OR avec un autre domain.
  function _prefixAnd(domain) {
    if (!Array.isArray(domain) || domain.length <= 1) return domain || [];
    return Array(domain.length - 1).fill("&").concat(domain);
  }

  // Convertit la chaîne "domain" retournée par ir.actions.act_window (syntaxe Python)
  // en tableau JS. Gère les cas simples: tuples, quotes simples, True/False/None.
  function _parseOdooDomain(str) {
    if (!str) return [];
    if (Array.isArray(str)) return str;
    try {
      let s = String(str).trim();
      if (!s || s === "[]") return [];
      s = s.replace(/\(/g, "[").replace(/\)/g, "]");
      s = s.replace(/'/g, '"');
      s = s.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
      return JSON.parse(s);
    } catch (e) {
      console.warn("[SalesView] domain parse error:", str, e);
      return [];
    }
  }

  async function _loadWarehouseDomains() {
    if (warehouseDomains._loaded) return;
    try {
      const acts = await rpc("ir.actions.act_window", "read", [WAREHOUSES.map(w => w.id)], {
        fields: ["id", "domain", "name"],
      });
      (acts || []).forEach(a => { warehouseDomains[a.id] = _parseOdooDomain(a.domain); });
      warehouseDomains._loaded = true;
    } catch (e) {
      toast("✗ Filtres Comptoir/Acile indisponibles: " + e.message);
    }
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("salesToast");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesToast";
      el.className = "sales-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("sales-toast--show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("sales-toast--show"), 1400);
  }

  /* ── Chargement (recherche + filtres + pagination) ───────── */
  function _buildDomain() {
    const domain = [];
    // Comptoir & Acile: on utilise le vrai domain des actions Odoo (484 / 661),
    // pas un champ deviné. Si un seul est actif on prend son domain, sinon on OR les deux.
    const activeIds = [...activeWarehouses];
    const activeDoms = activeIds.map(id => warehouseDomains[id]).filter(d => Array.isArray(d));
    if (activeDoms.length === 1) {
      domain.push(...activeDoms[0]);
    } else if (activeDoms.length > 1) {
      for (let i = 0; i < activeDoms.length - 1; i++) domain.push("|");
      activeDoms.forEach(d => domain.push(..._prefixAnd(d)));
    }
    if (activeStates.size) {
      domain.push(["state", "in", [...activeStates]]);
    }
    const q = searchQuery.trim();
    if (q) {
      domain.push("|", ["name", "ilike", q], ["partner_id.name", "ilike", q]);
    }
    return domain;
  }

  async function _fetchPage(reset) {
    if (loading) return;
    loading = true;
    if (reset) { offset = 0; orders = []; total = 0; }
    _renderList(); // affiche l'état "loading" sur le bouton/zone
    try {
      const domain = _buildDomain();
      const [rows, count] = await Promise.all([
        rpc("sale.order", "search_read", [domain], {
          fields: ["id", "name", "partner_id", "date_order", "commitment_date", "amount_total", "state", "user_id"],
          order: "date_order desc", limit: PAGE_SIZE, offset,
        }),
        offset === 0 ? rpc("sale.order", "search_count", [domain], {}) : Promise.resolve(total),
      ]);
      orders = orset(orders, rows);
      total = count;
      offset += rows.length;
    } catch (e) {
      toast("✗ " + e.message);
    } finally {
      loading = false;
      _renderList();
    }
  }
  // évite les doublons si _fetchPage(reset) est rappelé pendant un chargement en cours
  function orset(existing, rows) {
    const seen = new Set(existing.map(r => r.id));
    return [...existing, ...rows.filter(r => !seen.has(r.id))];
  }

  /* ── Filtres (chips entrepôt: Comptoir / Acile) ────────── */
  function _renderWarehouseBar() {
    const bar = document.getElementById("salesWarehouseBar");
    if (!bar) return;
    bar.innerHTML = WAREHOUSES.map(w => {
      const active = activeWarehouses.has(w.id);
      const clr = w.color || "#F59E0B";
      return `<button type="button" class="sales-filter-chip${active ? " sales-filter-chip--active" : ""}"
        data-wh="${w.id}" style="--chipclr:${clr}">
        <span class="sales-filter-dot"></span>${esc(w.label)}
      </button>`;
    }).join("");

    bar.querySelectorAll(".sales-filter-chip[data-wh]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.wh);
        if (activeWarehouses.has(id)) {
          // ne pas permettre de tout désactiver: garder au moins un actif
          if (activeWarehouses.size > 1) activeWarehouses.delete(id);
        } else {
          activeWarehouses.add(id);
        }
        _renderWarehouseBar();
        _fetchPage(true);
      });
    });
  }

  /* ── Filtres (chips état) ──────────────────────────────── */
  function _renderFilterBar() {
    const bar = document.getElementById("salesFilterBar");
    if (!bar) return;
    bar.innerHTML = STATE_ORDER.map(s => {
      const active = activeStates.has(s);
      return `<button type="button" class="sales-filter-chip${active ? " sales-filter-chip--active" : ""}"
        data-state="${s}" style="--chipclr:${STATE_COLORS[s]}">
        <span class="sales-filter-dot"></span>${STATE_LABELS[s]}
      </button>`;
    }).join("") + (activeStates.size ? `<button type="button" class="sales-filter-clear" id="salesFilterClear">Réinitialiser</button>` : "");

    bar.querySelectorAll(".sales-filter-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.state;
        if (activeStates.has(s)) activeStates.delete(s); else activeStates.add(s);
        _renderFilterBar();
        _fetchPage(true);
      });
    });
    bar.querySelector("#salesFilterClear")?.addEventListener("click", () => {
      activeStates.clear();
      _renderFilterBar();
      _fetchPage(true);
    });
  }

  /* ── Liste ─────────────────────────────────────────────── */
  function _stateBadge(state) {
    const clr = STATE_COLORS[state] || "#94A3B8";
    const label = STATE_LABELS[state] || state || "—";
    return `<span class="sales-state-badge" style="--badgeclr:${clr}">${esc(label)}</span>`;
  }

  // Gabarit de colonnes commun à l'en-tête et à chaque ligne, pour un alignement
  // strictement identique. Colonnes en "fr" pour que le tableau occupe toute la largeur
  // disponible (dynamique), avec des minimums pour rester lisible.
  const TABLE_COLS = "minmax(110px,1fr) minmax(140px,1.3fr) minmax(110px,1fr) minmax(110px,1fr) minmax(100px,0.9fr) minmax(90px,0.8fr) minmax(100px,0.9fr)";

  function _renderList() {
    const area = document.getElementById("salesListArea");
    if (!area) return;

    if (!orders.length && loading) {
      area.innerHTML = `<div class="sales-msg">Chargement...</div>`;
      return;
    }
    if (!orders.length) {
      area.innerHTML = `<div class="sales-msg">Aucune commande trouvée</div>`;
      return;
    }

    const rowsHtml = orders.map(o => {
      const partnerName = Array.isArray(o.partner_id) ? o.partner_id[1] : "—";
      const userName = Array.isArray(o.user_id) ? o.user_id[1] : "—";
      return `<div class="sales-row" data-id="${o.id}" style="grid-template-columns:${TABLE_COLS}">
        <div class="sales-cell sales-cell-name sales-cell-wrap">${esc(o.name || "—")}</div>
        <div class="sales-cell sales-cell-partner sales-cell-wrap">${esc(partnerName)}</div>
        <div class="sales-cell sales-cell-wrap">${esc(formatDate(o.date_order))}</div>
        <div class="sales-cell sales-cell-wrap">${esc(o.commitment_date ? formatDate(o.commitment_date) : "—")}</div>
        <div class="sales-cell sales-cell-wrap">${esc(userName)}</div>
        <div class="sales-cell">${_stateBadge(o.state)}</div>
        <div class="sales-cell sales-cell-amount">${formatMoney(o.amount_total)} DA</div>
      </div>`;
    }).join("");

    const hasMore = orders.length < total;
    area.innerHTML = `
      <div class="sales-count">${total} commande(s)</div>
      <div class="sales-table">
        <div class="sales-table-head" style="grid-template-columns:${TABLE_COLS}">
          <div class="sales-cell">N° commande</div>
          <div class="sales-cell">Client</div>
          <div class="sales-cell">Date commande</div>
          <div class="sales-cell">Date de distribution</div>
          <div class="sales-cell">Vendeur</div>
          <div class="sales-cell">État</div>
          <div class="sales-cell sales-cell-amount">Montant</div>
        </div>
        <div class="sales-list">${rowsHtml}</div>
      </div>
      ${hasMore ? `<button type="button" id="salesLoadMore" class="sales-loadmore" ${loading ? "disabled" : ""}>
        ${loading ? "Chargement..." : "Afficher plus"}
      </button>` : ""}
    `;

    area.querySelectorAll(".sales-row").forEach(row => {
      row.addEventListener("click", () => openChooseModal(Number(row.dataset.id)));
    });
    area.querySelector("#salesLoadMore")?.addEventListener("click", () => _fetchPage(false));
  }

  /* ── Détail d'une commande (modal + lignes) ───────────────── */
  function orderModalEl() {
    let el = document.getElementById("salesOrderModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesOrderModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <button class="ch-modal-back" id="salesOrderBackBtn" title="Retour" style="display:none">← Retour</button>
            <div class="ch-modal-title" id="salesOrderTitle"></div>
            <div class="ch-modal-head-actions">
              <a href="#" target="_blank" rel="noopener" class="sales-odoo-link" id="salesOrderOdooLink" title="Ouvrir la vente dans Odoo">↗ Odoo</a>
              <button class="ch-modal-close" title="Close">×</button>
            </div>
          </div>
          <div class="ch-modal-body" id="salesOrderBody"></div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeOrderModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeOrderModal);
    }
    return el;
  }
  function closeOrderModal() {
    const el = document.getElementById("salesOrderModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openOrderModal(orderId) {
    const o = orders.find(x => x.id === orderId);
    const el = orderModalEl();
    el.classList.add("ch-modal--open");
    const partnerName = o && Array.isArray(o.partner_id) ? o.partner_id[1] : "—";
    el.querySelector("#salesOrderTitle").textContent = `${o?.name || "—"} — ${partnerName}`;
    const odooLinkEl = el.querySelector("#salesOrderOdooLink");
    if (odooLinkEl) odooLinkEl.href = _odooOrderUrl(orderId);
    const backBtn = el.querySelector("#salesOrderBackBtn");
    if (backBtn) {
      backBtn.style.display = "";
      backBtn.onclick = () => { closeOrderModal(); openChooseModal(orderId); };
    }
    const body = el.querySelector("#salesOrderBody");
    body.innerHTML = `<div class="sales-msg">Chargement...</div>`;
    try {
      // On tente de récupérer promotion_ids sur sale.order (peut ne pas exister
      // selon la version/module Odoo). En cas d'échec, on refait un read simple
      // sans ce champ et le texte d'offre n'est pas disponible sur ce modal.
      let order;
      let orderHasPromotionField = true;
      try {
        [order] = await rpc("sale.order", "read", [[orderId]], {
          fields: ["id", "name", "partner_id", "date_order", "amount_untaxed", "amount_tax", "amount_total", "state", "user_id", "order_line", "picking_ids", "promotion_ids", "dont_apply_promo"],
        });
      } catch (e) {
        orderHasPromotionField = false;
        try {
          [order] = await rpc("sale.order", "read", [[orderId]], {
            fields: ["id", "name", "partner_id", "date_order", "amount_untaxed", "amount_tax", "amount_total", "state", "user_id", "order_line", "picking_ids", "dont_apply_promo"],
          });
        } catch (e2) {
          [order] = await rpc("sale.order", "read", [[orderId]], {
            fields: ["id", "name", "partner_id", "date_order", "amount_untaxed", "amount_tax", "amount_total", "state", "user_id", "order_line", "picking_ids"],
          });
        }
      }
      // dont_apply_promo peut ne pas exister sur toutes les instances Odoo.
      const orderHasPromoToggleField = Object.prototype.hasOwnProperty.call(order, "dont_apply_promo");
      const orderDontApplyPromo = orderHasPromoToggleField ? !!order.dont_apply_promo : false;
      const discountReasonField = await getDiscountReasonFieldName();
      const lines = order.order_line?.length
        ? await rpc("sale.order.line", "read", [order.order_line], {
            fields: Array.from(new Set(["product_id", "name", "product_uom_qty", "price_unit", "price_subtotal", "discount", discountReasonField].filter(Boolean))),
          })
        : [];

      // promotion_ids: uniquement si le champ existe réellement sur sale.order.
      const orderPromotionIds = orderHasPromotionField ? (order.promotion_ids || []) : [];
      const promotionLabelMap = orderPromotionIds.length ? await fetchPromotionLabels(orderPromotionIds) : {};
      const promotionText = joinPromotionLabels(promotionLabelMap, orderPromotionIds);

      // On garde uniquement isFree pour savoir quelles lignes/produits sont
      // concernés par une offre (usage visuel), sans jamais recalculer "X+Y".
      const promoProductIds = new Set();
      lines.forEach(l => {
        const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        const free = (l.price_unit === 0 || l.price_unit === false) && (l.product_uom_qty || 0) > 0;
        if (pid && free) promoProductIds.add(pid);
      });

      // Filtre les promotions par produit: on ne montre dans l'infobulle que
      // les offres réellement applicables à CE produit (pas toutes celles de
      // la commande). Repose sur les mêmes règles de correspondance que
      // l'application automatique des promos à la création.
      const autoPromotions = orderPromotionIds.length ? await _fetchAutoPromotions() : [];
      const perProductPromoText = {};
      const perProductMinQty = {};
      if (autoPromotions.length) {
        for (const l of lines) {
          const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
          if (!pid || perProductPromoText[pid] !== undefined) continue;
          let meta = null;
          try { meta = await _fetchProductMeta(pid); } catch (e) { meta = null; }
          const name = Array.isArray(l.product_id) ? l.product_id[1] : (l.name || "");
          const matches = _promotionsForProduct(autoPromotions, meta, pid, name);
          perProductPromoText[pid] = matches.length
            ? Array.from(new Set(matches.map(m => m.name))).join(" · ")
            : "";
          // Quantité minimale de la remise % applicable à ce produit.
          const remiseMatches = matches.filter(p => (p.kind === "remise" || p.kind === "text-remise") && p.minQty > 0);
          perProductMinQty[pid] = remiseMatches.length
            ? Math.min(...remiseMatches.map(p => p.minQty))
            : 0;
        }
      }

      const linesHtml = lines.map(l => {
        const discount = l.discount || 0;
        const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        const isFree = (l.price_unit === 0 || l.price_unit === false) && (l.product_uom_qty || 0) > 0;
        const isPromo = isFree || (pid && promoProductIds.has(pid));
        const discountReasonText = discountReasonField ? discountReasonLabel(l, discountReasonField) : "";
        const promoMinQty = pid ? (perProductMinQty[pid] || 0) : 0;
        const discountIcon = discount > 0 ? `
          <span class="sales-line-discount" tabindex="0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="#F59E0B" stroke-width="2"/>
              <path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="sales-line-discount-tip">Remise: ${discount}%${discountReasonText ? ` — ${esc(discountReasonText)}` : ""}${promoMinQty > 0 ? ` · 🛒 Qté min: ${promoMinQty}` : ""}</span>
          </span>` : "";
        // Le texte d'offre vient exclusivement de product.promotion (Odoo),
        // filtré pour ne montrer que ce qui s'applique à CE produit.
        const productPromoText = pid ? (perProductPromoText[pid] || "") : "";
        const promoTip = productPromoText
          ? (isFree ? `Gratuit (offert) — ${productPromoText}` : productPromoText)
          : (isFree ? "Gratuit (offert)" : "Offre promotionnelle");
        const promoIcon = isPromo ? `
          <span class="sales-line-promo" tabindex="0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="#10B981" stroke-width="2"/>
              <path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01" stroke="#10B981" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="sales-line-promo-tip">${promoTip}</span>
          </span>` : "";
        return `
        <div class="sales-line${isFree ? " sales-line--free" : ""}">
          <div class="sales-line-name">${discountIcon}${promoIcon}${esc(productLabel(Array.isArray(l.product_id) ? l.product_id[1] : (l.name || "—")))}${isFree ? `<span class="sales-line-free-badge">GRATUIT</span>` : ""}</div>
          <div class="sales-line-qty">${l.product_uom_qty} ×</div>
          <div class="sales-line-price">${formatMoney(l.price_unit)} DA</div>
          <div class="sales-line-subtotal">${formatMoney(l.price_subtotal)} DA</div>
        </div>`;
      }).join("") || `<div class="sales-msg">Aucune ligne</div>`;

      body.innerHTML = `
        <div class="sales-order-summary">
          <div>${_stateBadge(order.state)}</div>
          <div class="sales-order-summary-date">${esc(formatDate(order.date_order))}</div>
          ${Array.isArray(order.user_id) ? `<div class="sales-order-summary-user">${esc(order.user_id[1])}</div>` : ""}
        </div>
        <div class="sales-lines-head">
          <div>Produit</div><div>Qté</div><div>PU</div><div>Sous-total</div>
        </div>
        <div class="sales-lines">${linesHtml}</div>
        <div class="sales-order-totals">
          <div>HT: ${formatMoney(order.amount_untaxed)} DA</div>
          <div>Taxe: ${formatMoney(order.amount_tax)} DA</div>
          <div class="sales-order-total-ttc">TTC: ${formatMoney(order.amount_total)} DA</div>
        </div>
      `;
      const promoToggleBtns = orderHasPromoToggleField
        ? `<button type="button" id="salesDefNoPromoBtn" class="sales-promo-toggle-btn${orderDontApplyPromo ? " sales-promo-toggle-btn--active" : ""}">Définir sans promo</button>
           <button type="button" id="salesDefWithPromoBtn" class="sales-promo-toggle-btn${!orderDontApplyPromo ? " sales-promo-toggle-btn--active" : ""}">Définir avec promo</button>`
        : "";
      const confirmBar = (order.state === "draft" || order.state === "sent" || orderHasPromoToggleField)
        ? `<div class="sales-confirm-bar">
            ${promoToggleBtns}
            ${order.state === "draft" || order.state === "sent" ? `<button type="button" id="salesEditOrderBtn" class="sales-edit-btn">Modifier le devis</button>
            <button type="button" id="salesConfirmOrderBtn" class="sales-confirm-btn">Confirmer la commande</button>` : ""}
          </div>`
        : "";
      body.insertAdjacentHTML("beforeend", confirmBar);
      async function _setDontApplyPromo(value) {
        const btnNo = body.querySelector("#salesDefNoPromoBtn");
        const btnYes = body.querySelector("#salesDefWithPromoBtn");
        if (btnNo) btnNo.disabled = true;
        if (btnYes) btnYes.disabled = true;
        try {
          await rpc("sale.order", "write", [[orderId], { dont_apply_promo: value }], {});
          toast(value ? "✓ Devis défini sans promo" : "✓ Devis défini avec promo");
          btnNo?.classList.toggle("sales-promo-toggle-btn--active", value);
          btnYes?.classList.toggle("sales-promo-toggle-btn--active", !value);
        } catch (e) {
          toast("✗ " + e.message);
        } finally {
          if (btnNo) btnNo.disabled = false;
          if (btnYes) btnYes.disabled = false;
        }
      }
      body.querySelector("#salesDefNoPromoBtn")?.addEventListener("click", () => _setDontApplyPromo(true));
      body.querySelector("#salesDefWithPromoBtn")?.addEventListener("click", () => _setDontApplyPromo(false));
      body.querySelector("#salesEditOrderBtn")?.addEventListener("click", () => {
        closeOrderModal();
        openEditOrderModal(orderId);
      });
      body.querySelector("#salesConfirmOrderBtn")?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = "Confirmation...";
        try {
          await rpc("sale.order", "action_confirm", [[orderId]], {});
          await _forceOriginLocation(orderId);
          toast("✓ Commande confirmée");
          const idx = orders.findIndex(x => x.id === orderId);
          if (idx !== -1) orders[idx].state = "sale";
          _renderList();
          openOrderModal(orderId);
        } catch (e) {
          toast("✗ " + e.message);
          btn.disabled = false;
          btn.textContent = "Confirmer la commande";
        }
      });
    } catch (e) {
      body.innerHTML = `<div class="sales-msg sales-msg--err">Erreur: ${esc(e.message)}</div>`;
    }
  }

  /* ── Création d'un devis (nouvelle commande) ──────────────── */
  let newOrderLines = []; // { lineId?, productId, name, qty, priceUnit, discount, isGift }
  let newOrderPartner = null; // { id, name, pricelistId }
  let newOrderPromotionIds = []; // [{ id, name }] — attaché pour traçabilité seulement
  let newOrderAutoPromotions = []; // promotions actives normalisées (voir _fetchAutoPromotions)
  let editingOrderId = null; // id du devis en cours d'édition (null = création)
  let deletedLineIds = []; // ids des sale.order.line supprimées pendant l'édition

  // Ré-applique les promotions actives sur les lignes actuelles:
  // - remise: déduit le % de remise directement sur la ligne du produit concerné.
  // - buyget (ex: 10+2): ajoute/actualise une ligne "Offert" séparée pour ce
  //   produit, calculée par palier (qty=20 avec 10+2 → 4 offerts).
  // Les lignes "Offert" auto-générées sont recalculées à chaque appel (on les
  // retire puis on les recrée), pour rester cohérentes avec la quantité actuelle.
  async function _applyAutoPromotionsToLines() {
    newOrderLines = newOrderLines.filter(l => !l.autoGift);
    if (!newOrderAutoPromotions.length) return;
    const giftLines = [];
    for (const l of newOrderLines) {
      let meta = null;
      try { meta = await _fetchProductMeta(l.productId); } catch (e) { meta = null; }
      const matches = _promotionsForProduct(newOrderAutoPromotions, meta, l.productId, l.name);
      if (!matches.length) { l.autoDiscountFrom = null; continue; }

      // Remise %: on ne retient que les offres dont la quantité minimale
      // requise (minQty) est atteinte par la ligne actuelle. Si une remise
      // était appliquée automatiquement mais que la qty est repassée sous le
      // seuil, on la retire (sans toucher à une remise saisie manuellement).
      const remisePromos = matches.filter(p => p.kind === "remise" || p.kind === "text-remise");
      const remiseEligible = remisePromos.filter(p => (p.minQty || 0) <= (l.qty || 0));
      if (remiseEligible.length) {
        const best = remiseEligible.reduce((a, b) => (b.discountPercent > a.discountPercent ? b : a));
        l.discount = best.discountPercent;
        l.autoDiscountFrom = best.name;
      } else {
        if (l.autoDiscountFrom) l.discount = 0;
        l.autoDiscountFrom = null;
      }

      const buygetPromos = matches.filter(p => p.kind === "buyget" || p.kind === "buyget-text");
      for (const promo of buygetPromos) {
        const freeUnits = Math.floor((l.qty || 0) / promo.buyQty) * promo.freeQty;
        if (freeUnits > 0) {
          giftLines.push({
            productId: l.productId, name: `${l.name} (Offert — ${promo.name})`,
            qty: freeUnits, priceUnit: 0, discount: 0,
            isGift: true, autoGift: true, autoGiftFor: l.productId,
          });
        }
      }
    }
    newOrderLines = newOrderLines.concat(giftLines);
    console.info("[Vente] _applyAutoPromotionsToLines: lignes après application =", newOrderLines);
  }
  let productSearchTimer = null;
  let partnerSearchTimer = null;
  function _wireSuggestKeyboardNav(inputEl, boxEl) {
    let activeIdx = -1;
    const highlight = (idx) => {
      const items = boxEl.querySelectorAll(".sales-suggest-item");
      items.forEach(el => el.classList.remove("sales-suggest-item--active"));
      if (idx >= 0 && idx < items.length) {
        activeIdx = idx;
        items[idx].classList.add("sales-suggest-item--active");
        items[idx].scrollIntoView({ block: "nearest" });
      } else {
        activeIdx = -1;
      }
    };
    inputEl.addEventListener("input", () => { activeIdx = -1; });
    inputEl.addEventListener("keydown", (e) => {
      const items = boxEl.querySelectorAll(".sales-suggest-item");
      if (e.key === "Escape") {
        if (items.length) { e.stopPropagation(); boxEl.innerHTML = ""; activeIdx = -1; }
        return;
      }
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault(); e.stopPropagation();
        highlight(Math.min(activeIdx + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        highlight(Math.max(activeIdx - 1, 0));
      } else if (e.key === "Enter") {
        if (activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault(); e.stopPropagation();
          items[activeIdx].click();
        }
      }
    });
  }
  const _packagingQtyCache = {};
  const _warehouseStockLocationCache = {};
  async function _getWarehouseStockLocationId(warehouseId) {
    if (!warehouseId) return null;
    if (warehouseId in _warehouseStockLocationCache) return _warehouseStockLocationCache[warehouseId];
    try {
      const [wh] = await rpc("stock.warehouse", "read", [[warehouseId]], { fields: ["id", "lot_stock_id"] });
      const locId = Array.isArray(wh?.lot_stock_id) ? wh.lot_stock_id[0] : (wh?.lot_stock_id || null);
      _warehouseStockLocationCache[warehouseId] = locId;
      return locId;
    } catch (e) {
      console.error("[Vente] échec lecture lot_stock_id entrepôt:", e);
      return null;
    }
  }

  async function _forceOriginLocation(orderId) {
    try {
      const [order] = await rpc("sale.order", "read", [[orderId]], { fields: ["warehouse_id", "location_id"] });
      const warehouseId = Array.isArray(order?.warehouse_id) ? order.warehouse_id[0] : order?.warehouse_id;
      const stockLocationId = await _getWarehouseStockLocationId(warehouseId);
      if (!stockLocationId) { console.warn("[Vente] lot_stock_id introuvable pour l'entrepôt", warehouseId); return; }
      console.info("[Vente][debug] écriture location_id sur sale.order", orderId, "->", stockLocationId);
      await rpc("sale.order", "write", [[orderId], { location_id: stockLocationId }], {});
      const [check] = await rpc("sale.order", "read", [[orderId]], { fields: ["id", "location_id"] });
      console.info("[Vente][debug] vérification location_id après write:", check);
    } catch (e) {
      console.error("[Vente] échec réglage emplacement de livraison:", e);
    }
  }

  async function _fetchPackagingQty(productId) {
    if (productId in _packagingQtyCache) return _packagingQtyCache[productId];
    try {
      const rows = await rpc("product.packaging", "search_read", [[["product_id", "=", productId]]], {
        fields: ["qty"], limit: 1,
      });
      const qty = (rows && rows[0] && rows[0].qty) || 0;
      _packagingQtyCache[productId] = qty;
      return qty;
    } catch (e) {
      _packagingQtyCache[productId] = 0;
      return 0;
    }
  }

  // Résout la liste de prix du client (même modèle que clientsView: res.partner.pricelist,
  // avec repli sur le champ standard property_product_pricelist si aucune ligne custom).
  async function _fetchPartnerPricelistId(partnerId) {
    try {
      const rows = await rpc("res.partner.pricelist", "search_read",
        [[["partner_id", "=", partnerId]]],
        { fields: ["pricelist_id"], limit: 1 });
      const row = rows?.[0];
      const fromCustom = row && Array.isArray(row.pricelist_id) ? row.pricelist_id[0] : null;
      if (fromCustom) return fromCustom;
    } catch (e) {
      console.warn("[Vente] res.partner.pricelist indisponible:", e.message);
    }
    try {
      const [p] = await rpc("res.partner", "read", [[partnerId]], { fields: ["property_product_pricelist"] });
      const fromProperty = Array.isArray(p?.property_product_pricelist) ? p.property_product_pricelist[0] : null;
      if (fromProperty) return fromProperty;
    } catch (e) {
      console.warn("[Vente] property_product_pricelist indisponible:", e.message);
    }
    console.warn("[Vente] Aucune liste de prix trouvée pour le client", partnerId, "— prix catalogue utilisé.");
    return null;
  }

  // Calcule le prix d'un produit selon la liste de prix du client, en lisant
  // directement les règles product.pricelist.item (plus fiable que les
  // méthodes RPC get_product_price/price_rule_get, dont la signature varie
  // selon la version d'Odoo et qui échouent silencieusement sur certains setups).
  let _pricelistItemsCache = {}; // { pricelistId: items[] }
  let _pricelistItemFieldsPromise = null;
  const PRICELIST_ITEM_FIELD_CANDIDATES = [
    "applied_on", "product_tmpl_id", "product_id", "categ_id",
    "min_quantity", "compute_price", "fixed_price", "percent_price",
    "price_discount", "price_surcharge", "price_round",
    "price_min_margin", "price_max_margin", "base", "base_pricelist_id",
    "date_start", "date_end", "sequence",
  ];
  // Découvre dynamiquement les champs réellement présents sur product.pricelist.item
  // (variable selon la version/config Odoo — ex: 'sequence' peut être absent).
  async function _getPricelistItemFields() {
    if (_pricelistItemFieldsPromise) return _pricelistItemFieldsPromise;
    _pricelistItemFieldsPromise = (async () => {
      try {
        const info = await rpc("product.pricelist.item", "fields_get", [], { attributes: ["type"] });
        const available = new Set(Object.keys(info || {}));
        return PRICELIST_ITEM_FIELD_CANDIDATES.filter(f => available.has(f));
      } catch (e) {
        console.warn("[Vente] fields_get product.pricelist.item échoué:", e.message);
        return PRICELIST_ITEM_FIELD_CANDIDATES.filter(f => f !== "sequence");
      }
    })();
    return _pricelistItemFieldsPromise;
  }
  async function _fetchPricelistItems(pricelistId) {
    if (_pricelistItemsCache[pricelistId]) return _pricelistItemsCache[pricelistId];
    const fields = await _getPricelistItemFields();
    const items = await rpc("product.pricelist.item", "search_read",
      [[["pricelist_id", "=", pricelistId]]],
      { fields, order: fields.includes("sequence") ? "sequence asc" : undefined });
    _pricelistItemsCache[pricelistId] = items || [];
    return _pricelistItemsCache[pricelistId];
  }

  let _productMetaCache = {}; // { productId: { tmplId, categId, categParents:[ids], listPrice } }
  async function _fetchProductMeta(productId) {
    if (_productMetaCache[productId]) return _productMetaCache[productId];
    const [p] = await rpc("product.product", "read", [[productId]], {
      fields: ["id", "product_tmpl_id", "categ_id", "lst_price", "list_price"],
    });
    const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
    const categId = Array.isArray(p.categ_id) ? p.categ_id[0] : p.categ_id;
    let categParents = [];
    if (categId) {
      try {
        const [c] = await rpc("product.category", "read", [[categId]], { fields: ["parent_path"] });
        categParents = (c?.parent_path || "").split("/").filter(Boolean).map(Number);
      } catch (e) { categParents = categId ? [categId] : []; }
    }
    _productMetaCache[productId] = {
      tmplId, categId, categParents,
      listPrice: (typeof p.lst_price === "number" ? p.lst_price : p.list_price) || 0,
    };
    return _productMetaCache[productId];
  }

  function _itemMatches(item, meta, productId, qty) {
    if ((item.min_quantity || 0) > qty) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (item.date_start && String(item.date_start).slice(0, 10) > today) return false;
    if (item.date_end && String(item.date_end).slice(0, 10) < today) return false;
    switch (item.applied_on) {
      case "0_product_variant":
        return Array.isArray(item.product_id) ? item.product_id[0] === productId : item.product_id === productId;
      case "1_product":
        return Array.isArray(item.product_tmpl_id) ? item.product_tmpl_id[0] === meta.tmplId : item.product_tmpl_id === meta.tmplId;
      case "2_product_category": {
        const cid = Array.isArray(item.categ_id) ? item.categ_id[0] : item.categ_id;
        return cid && meta.categParents.includes(cid);
      }
      case "3_global":
        return true;
      default:
        return false;
    }
  }
  const _SPECIFICITY = { "0_product_variant": 4, "1_product": 3, "2_product_category": 2, "3_global": 1 };

  async function _computeFromItem(item, meta, qty, pricelistId, partnerId, visited) {
    let base;
    if (item.base === "standard_price") {
      const [p] = await rpc("product.product", "read", [[meta.__productId]], { fields: ["standard_price"] });
      base = p.standard_price || 0;
    } else if (item.base === "pricelist" && item.base_pricelist_id) {
      const basePlId = Array.isArray(item.base_pricelist_id) ? item.base_pricelist_id[0] : item.base_pricelist_id;
      if (visited.has(basePlId)) base = meta.listPrice;
      else base = await _resolvePrice(meta.__productId, qty, basePlId, partnerId, meta.listPrice, new Set([...visited, basePlId]));
    } else {
      base = meta.listPrice;
    }
    let price;
    if (item.compute_price === "fixed") {
      price = item.fixed_price;
    } else if (item.compute_price === "percentage") {
      price = base * (1 - (item.percent_price || 0) / 100);
    } else { // formula
      price = base * (1 - (item.price_discount || 0) / 100) + (item.price_surcharge || 0);
      if (item.price_round) price = Math.round(price / item.price_round) * item.price_round;
      if (item.price_min_margin) price = Math.max(price, base + item.price_min_margin);
      if (item.price_max_margin) price = Math.min(price, base + item.price_max_margin);
    }
    return price;
  }

  async function _resolvePrice(productId, qty, pricelistId, partnerId, fallbackListPrice, visited) {
    const meta = await _fetchProductMeta(productId);
    meta.__productId = productId;
    const items = await _fetchPricelistItems(pricelistId);
    const matching = items.filter(it => _itemMatches(it, meta, productId, qty));
    if (!matching.length) return fallbackListPrice ?? meta.listPrice;
    matching.sort((a, b) => {
      const s = _SPECIFICITY[b.applied_on] - _SPECIFICITY[a.applied_on];
      return s !== 0 ? s : (a.sequence || 0) - (b.sequence || 0);
    });
    return _computeFromItem(matching[0], meta, qty, pricelistId, partnerId, visited || new Set([pricelistId]));
  }

  async function _priceForProduct(productId, qty, pricelistId, partnerId, fallbackListPrice) {
    if (!pricelistId) return fallbackListPrice;
    try {
      const price = await _resolvePrice(productId, qty, pricelistId, partnerId, fallbackListPrice, new Set([pricelistId]));
      console.log(`[Vente] prix produit ${productId} via pricelist ${pricelistId}:`, price);
      return price;
    } catch (e) {
      console.warn("[Vente] échec calcul prix pricelist:", e.message);
      return fallbackListPrice;
    }
  }

  /* ── Stock disponible (même logique que "Ajouter produit") ── */
  const STOCK_LOCATION_ID = 213;
  async function _fetchProductsStock(productIds) {
    if (!productIds || !productIds.length) return {};
    const [quants, packagings] = await Promise.all([
      rpc("stock.quant", "search_read",
        [[["location_id", "=", STOCK_LOCATION_ID], ["product_id", "in", productIds]]],
        { fields: ["product_id", "quantity", "reserved_quantity"], limit: 500 }),
      rpc("product.packaging", "search_read",
        [[["product_id", "in", productIds]]],
        { fields: ["product_id", "name", "qty"], limit: 500 }),
    ]);
    const packMap = {};
    (packagings || []).forEach(pk => {
      const pid = Array.isArray(pk.product_id) ? pk.product_id[0] : pk.product_id;
      if (!packMap[pid]) packMap[pid] = [];
      packMap[pid].push({ name: pk.name, qty: pk.qty });
    });
    const result = {};
    (quants || []).forEach(q => {
      const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
      const free = Math.max(0, (q.quantity || 0) - (q.reserved_quantity || 0));
      const mainPack = (packMap[pid] || []).sort((a, b) => b.qty - a.qty)[0];
      result[pid] = {
        free,
        packName: mainPack?.name || null,
        packQty: mainPack?.qty || 0,
        cartons: mainPack?.qty > 0 ? Math.floor(free / mainPack.qty) : 0,
        units: mainPack?.qty > 0 ? Math.round(free % mainPack.qty) : free,
      };
    });
    productIds.forEach(pid => {
      if (!result[pid]) {
        const mainPack = (packMap[pid] || []).sort((a, b) => b.qty - a.qty)[0];
        result[pid] = { free: 0, packName: mainPack?.name || null, packQty: mainPack?.qty || 0, cartons: 0, units: 0 };
      }
    });
    return result;
  }
  function _fmtStock(s) {
    if (!s) return { text: "0", color: "#b91c1c" };
    const { free, packName, cartons, units } = s;
    const color = free > 0 ? "#15803d" : "#b91c1c";
    if (!packName || (cartons === 0 && units === 0)) return { text: `${units} U`, color };
    const abbr = packName.toLowerCase().startsWith("f") ? "F" : "C";
    if (cartons > 0 && units > 0) return { text: `${cartons} ${abbr} | ${units} U`, color };
    if (cartons > 0) return { text: `${cartons} ${abbr}`, color };
    return { text: `${units} U`, color };
  }

  const _newOrderStockCache = {};

  function createOrderModalEl() {
    let el = document.getElementById("salesCreateModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesCreateModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <button class="ch-modal-back" id="salesCreateBackBtn" title="Retour" style="display:none">← Retour</button>
            <div class="ch-modal-title" id="salesCreateTitle">Nouveau devis</div>
            <button class="ch-modal-close" title="Close">×</button>
          </div>
          <div class="ch-modal-body" id="salesCreateBody"></div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeCreateOrderModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeCreateOrderModal);
      // Escape يغلق المودل، Enter يفعّل زر التأكيد (إلا إذا كانت القائمة المنسدلة للبحث مفتوحة)
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { closeCreateOrderModal(); return; }
        if (e.key === "Enter") {
          const submitBtn = document.getElementById("salesCreateSubmit");
          if (submitBtn && !submitBtn.disabled) { e.preventDefault(); submitBtn.click(); }
        }
      });
    }
    return el;
  }
  function closeCreateOrderModal() {
    const el = document.getElementById("salesCreateModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  function _renderCreateBody() {
    const body = document.getElementById("salesCreateBody");
    if (!body) return;
    const titleEl = document.getElementById("salesCreateTitle");
    if (titleEl) titleEl.textContent = editingOrderId ? "Modifier le devis" : "Nouveau devis";
    const linesHtml = newOrderLines.length
      ? newOrderLines.map((l, i) => {
          const st = _newOrderStockCache[l.productId];
          const over = st && l.qty > st.free;
          const stockInfo = st ? (() => { const s = _fmtStock(st); return `<div class="sales-newline-stock" style="font-size:10px;font-weight:700;color:${over ? "#b91c1c" : s.color}">${over ? "⚠ " : ""}Dispo: ${s.text}</div>`; })() : "";
          const lineTotal = (l.qty || 0) * (l.priceUnit || 0);
          return `
        <div class="sales-newline${l.isGift ? " sales-newline--free" : ""}">
          <div class="sales-newline-name">${esc(productLabel(l.name))}${l.isGift ? `<span class="sales-newline-gift-badge">GRATUIT</span>` : ""}${stockInfo}</div>
          <input type="number" min="0" step="1" class="sales-newline-cdn" data-i="${i}" value="${l.cdn || 0}" placeholder="CDN" title="Quantité en CDN (cartons)" ${l.packagingQty ? "" : "disabled"}>
          <input type="number" min="0.01" step="0.01" class="sales-newline-qty" data-i="${i}" value="${l.qty}" style="${over ? "border-color:#b91c1c;color:#b91c1c;" : ""}">
          <input type="number" min="0" step="0.01" class="sales-newline-price" data-i="${i}" value="${l.priceUnit}">
          <div class="sales-newline-total">${formatMoney(lineTotal)}</div>
          <button type="button" class="sales-newline-del" data-i="${i}" title="Retirer">×</button>
        </div>`;
        }).join("")
      : `<div class="sales-msg" style="padding:8px 0;">Aucun produit ajouté</div>`;

    const grandTotal = newOrderLines.reduce((sum, l) => sum + (l.qty || 0) * (l.priceUnit || 0), 0);

    body.innerHTML = `
      <div class="sales-create-field">
        <label>Client</label>
        <div class="sales-create-partner" id="salesCreatePartnerBox">
          ${newOrderPartner ? `<span class="sales-create-partner-chip">${esc(newOrderPartner.name)}
              <button type="button" id="salesCreatePartnerClear">×</button></span>`
            : `<input type="text" id="salesCreatePartnerInput" placeholder="Rechercher un client..." autocomplete="off">
               <div class="sales-create-suggest" id="salesCreatePartnerSuggest"></div>`}
        </div>
      </div>
      <div class="sales-create-field">
        <label>Produits</label>
        <input type="text" id="salesCreateProductInput" placeholder="Rechercher un produit..." autocomplete="off">
        <div class="sales-create-suggest" id="salesCreateProductSuggest"></div>
      </div>
      <div class="sales-newlines-head">
        <div>Produit</div><div>CDN</div><div>Qté</div><div>PU</div><div>Total</div><div></div>
      </div>
      <div class="sales-newlines">${linesHtml}</div>
      <div class="sales-create-actions">
        <div class="sales-create-grandtotal">Total : <span>${formatMoney(grandTotal)} DA</span></div>
        <button type="button" id="salesCreateSubmit" class="sales-create-submit">${editingOrderId ? "Enregistrer les modifications" : "Créer le devis"}</button>
      </div>
    `;


    if (!newOrderPartner) {
      const inp = body.querySelector("#salesCreatePartnerInput");
      const suggestBox = body.querySelector("#salesCreatePartnerSuggest");
      if (inp && suggestBox) _wireSuggestKeyboardNav(inp, suggestBox);
      inp?.addEventListener("input", () => {
        clearTimeout(partnerSearchTimer);
        const q = inp.value.trim();
        const box = body.querySelector("#salesCreatePartnerSuggest");
        if (!q) { box.innerHTML = ""; return; }
        partnerSearchTimer = setTimeout(async () => {
          try {
            const tokens = q.split(/\s+/).filter(Boolean);
            const domain = [];
            tokens.forEach(t => domain.push(["name", "ilike", t]));
            const rows = await rpc("res.partner", "search_read", [domain], {
              fields: ["id", "name"], limit: 8,
            });
            box.innerHTML = rows.map(r => `<div class="sales-suggest-item" data-id="${r.id}" data-name="${esc(r.name)}">${esc(r.name)}</div>`).join("")
              || `<div class="sales-suggest-empty">Aucun résultat</div>`;
            box.querySelectorAll(".sales-suggest-item").forEach(item => {
              item.addEventListener("click", async () => {
                const pid = Number(item.dataset.id);
                newOrderPartner = { id: pid, name: item.dataset.name, pricelistId: null };
                _renderCreateBody();
                const plId = await _fetchPartnerPricelistId(pid);
                if (newOrderPartner && newOrderPartner.id === pid) {
                  newOrderPartner.pricelistId = plId;
                  if (plId && newOrderLines.length) {
                    for (const l of newOrderLines) {
                      l.priceUnit = await _priceForProduct(l.productId, l.qty, plId, pid, l.priceUnit);
                    }
                    _renderCreateBody();
                  }
                }
              });
            });
          } catch (e) {
            box.innerHTML = `<div class="sales-suggest-empty">Erreur: ${esc(e.message)}</div>`;
          }
        }, 300);
      });
    } else {
      body.querySelector("#salesCreatePartnerClear")?.addEventListener("click", () => {
        newOrderPartner = null;
        _renderCreateBody();
      });
    }

    const prodInp = body.querySelector("#salesCreateProductInput");
    const prodSuggestBox = body.querySelector("#salesCreateProductSuggest");
    if (prodInp && prodSuggestBox) _wireSuggestKeyboardNav(prodInp, prodSuggestBox);
    prodInp?.addEventListener("input", () => {
      clearTimeout(productSearchTimer);
      const q = prodInp.value.trim();
      const box = body.querySelector("#salesCreateProductSuggest");
      if (!q) { box.innerHTML = ""; return; }
      productSearchTimer = setTimeout(async () => {
        try {
          const tokens = q.split(/\s+/).filter(Boolean);
          const domain = [];
          tokens.forEach(t => domain.push(["name", "ilike", t]));
          const rows = await rpc("product.product", "search_read", [domain], {
            fields: ["id", "name", "list_price"], limit: 8,
          });
          const ids = rows.map(r => r.id);
          let stockMap = {};
          try { stockMap = await _fetchProductsStock(ids); Object.assign(_newOrderStockCache, stockMap); } catch (_) {}
          box.innerHTML = rows.map(r => {
            const st = stockMap[r.id];
            const badge = st ? (() => { const s = _fmtStock(st); return `<span style="font-size:10px;font-weight:700;white-space:nowrap;color:${s.color};margin-left:6px">${s.text}</span>`; })() : "";
            return `<div class="sales-suggest-item" data-id="${r.id}" data-name="${esc(r.name)}" data-price="${r.list_price || 0}" style="display:flex;justify-content:space-between;align-items:center;gap:8px;${st?.free === 0 ? "background:#fef2f2;" : ""}">
              <span>${esc(productLabel(r.name))} — ${formatMoney(r.list_price)} DA</span>${badge}</div>`;
          }).join("")
            || `<div class="sales-suggest-empty">Aucun résultat</div>`;
          box.querySelectorAll(".sales-suggest-item").forEach(item => {
            item.addEventListener("click", async () => {
              const pid = Number(item.dataset.id);
              const listPrice = Number(item.dataset.price) || 0;
              const existing = newOrderLines.find(l => l.productId === pid);
              if (existing) {
                existing.qty += 1;
                if (existing.packagingQty > 0) existing.cdn = +(existing.qty / existing.packagingQty).toFixed(2);
              } else {
                const packagingQty = await _fetchPackagingQty(pid);
                newOrderLines.push({
                  productId: pid, name: item.dataset.name,
                  qty: 1, priceUnit: listPrice,
                  packagingQty, cdn: packagingQty > 0 ? +(1 / packagingQty).toFixed(2) : 0,
                });
              }
              prodInp.value = "";
              box.innerHTML = "";
              _renderCreateBody();
              if (newOrderPartner?.pricelistId) {
                const line = newOrderLines.find(l => l.productId === pid);
                const price = await _priceForProduct(pid, line.qty, newOrderPartner.pricelistId, newOrderPartner.id, listPrice);
                const stillThere = newOrderLines.find(l => l.productId === pid);
                if (stillThere) stillThere.priceUnit = price;
              }
              _renderCreateBody();
            });
          });
        } catch (e) {
          box.innerHTML = `<div class="sales-suggest-empty">Erreur: ${esc(e.message)}</div>`;
        }
      }, 300);
    });

    body.querySelectorAll(".sales-newline-cdn").forEach(inp => {
      inp.addEventListener("change", async () => {
        const i = Number(inp.dataset.i);
        const l = newOrderLines[i];
        const cdn = Math.max(0, Number(inp.value) || 0);
        l.cdn = cdn;
        if (l.packagingQty > 0) {
          l.qty = Math.max(0.01, cdn * l.packagingQty);
          if (newOrderPartner?.pricelistId) {
            l.priceUnit = await _priceForProduct(l.productId, l.qty, newOrderPartner.pricelistId, newOrderPartner.id, l.priceUnit);
          }
        }
        _renderCreateBody();
      });
    });
    body.querySelectorAll(".sales-newline-qty").forEach(inp => {
      inp.addEventListener("change", async () => {
        const i = Number(inp.dataset.i);
        const l = newOrderLines[i];
        l.qty = Math.max(0.01, Number(inp.value) || 1);
        if (l.packagingQty > 0) l.cdn = +(l.qty / l.packagingQty).toFixed(2);
        if (newOrderPartner?.pricelistId) {
          l.priceUnit = await _priceForProduct(l.productId, l.qty, newOrderPartner.pricelistId, newOrderPartner.id, l.priceUnit);
        }
        _renderCreateBody();
      });
    });
    body.querySelectorAll(".sales-newline-price").forEach(inp => {
      inp.addEventListener("change", () => {
        const i = Number(inp.dataset.i);
        newOrderLines[i].priceUnit = Math.max(0, Number(inp.value) || 0);
        _renderCreateBody();
      });
    });
    body.querySelectorAll(".sales-newline-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.i);
        const removed = newOrderLines[i];
        if (removed?.lineId) deletedLineIds.push(removed.lineId);
        newOrderLines.splice(i, 1);
        _renderCreateBody();
      });
    });

    body.querySelector("#salesCreateSubmit")?.addEventListener("click", async (ev) => {
      if (!newOrderPartner) { toast("✗ Choisissez un client"); return; }
      if (!newOrderLines.length) { toast("✗ Ajoutez au moins un produit"); return; }
      const overStock = newOrderLines.filter(l => {
        const st = _newOrderStockCache[l.productId];
        return st && l.qty > st.free;
      });
      if (overStock.length) {
        const ok = window.confirm(
          "Stock insuffisant pour: " + overStock.map(l => l.name).join(", ") + "\nContinuer quand même ?"
        );
        if (!ok) return;
      }
      const btn = ev.currentTarget;
      btn.disabled = true;
      const isEdit = !!editingOrderId;
      btn.textContent = isEdit ? "Enregistrement..." : "Création...";
      try {
        if (isEdit) {
          const lineCommands = [
            ...newOrderLines.map(l => l.lineId
              ? [1, l.lineId, { ..._lineQtyVals(l), price_unit: l.priceUnit }]
              : [0, 0, { product_id: l.productId, ..._lineQtyVals(l), price_unit: l.priceUnit }]),
            ...deletedLineIds.map(id => [2, id, 0]),
          ];
          const orderVals = { partner_id: newOrderPartner.id, order_line: lineCommands };
          if (newOrderPartner.pricelistId) orderVals.pricelist_id = newOrderPartner.pricelistId;
          await rpc("sale.order", "write", [[editingOrderId], orderVals], {});
          await _forceOriginLocation(editingOrderId);
          toast("✓ Devis modifié");
          const savedId = editingOrderId;
          closeCreateOrderModal();
          newOrderLines = [];
          newOrderPartner = null;
          editingOrderId = null;
          deletedLineIds = [];
          _fetchPage(true);
          openOrderModal(savedId);
        } else {
          const orderVals = {
            partner_id: newOrderPartner.id,
            order_line: newOrderLines.map(l => [0, 0, {
              product_id: l.productId,
              ..._lineQtyVals(l),
              price_unit: l.priceUnit,
            }]),
          };
          if (newOrderPartner.pricelistId) orderVals.pricelist_id = newOrderPartner.pricelistId;
          const newId = await rpc("sale.order", "create", [orderVals], {});
          await _forceOriginLocation(newId);
          toast("✓ Devis créé");
          closeCreateOrderModal();
          newOrderLines = [];
          newOrderPartner = null;
          _fetchPage(true);
          openOrderModal(newId);
        }
      } catch (e) {
        toast("✗ " + e.message);
        btn.disabled = false;
        btn.textContent = isEdit ? "Enregistrer les modifications" : "Créer le devis";
      }
    });
  }

  async function openEditOrderModal(orderId) {
    editingOrderId = orderId;
    deletedLineIds = [];
    newOrderLines = [];
    newOrderPartner = null;
    Object.keys(_newOrderStockCache).forEach(k => delete _newOrderStockCache[k]);
    const el = createOrderModalEl();
    el.classList.add("ch-modal--open");
    const backBtn = el.querySelector("#salesCreateBackBtn");
    if (backBtn) {
      backBtn.style.display = "";
      backBtn.onclick = () => { closeCreateOrderModal(); openOrderModal(orderId); };
    }
    const body = document.getElementById("salesCreateBody");
    body.innerHTML = `<div class="sales-msg">Chargement...</div>`;
    try {
      const [order] = await rpc("sale.order", "read", [[orderId]], {
        fields: ["id", "partner_id", "pricelist_id", "order_line"],
      });
      const partnerId = Array.isArray(order.partner_id) ? order.partner_id[0] : order.partner_id;
      const partnerName = Array.isArray(order.partner_id) ? order.partner_id[1] : "";
      const pricelistId = Array.isArray(order.pricelist_id) ? order.pricelist_id[0] : order.pricelist_id;
      newOrderPartner = { id: partnerId, name: partnerName, pricelistId: pricelistId || null };
      const lineIds = order.order_line || [];
      const lines = lineIds.length
        ? await rpc("sale.order.line", "read", [lineIds], {
            fields: ["id", "product_id", "name", "product_uom_qty", "price_unit"],
          })
        : [];
      newOrderLines = [];
      for (const l of lines) {
        const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        const name = Array.isArray(l.product_id) ? l.product_id[1] : (l.name || "—");
        const packagingQty = pid ? await _fetchPackagingQty(pid) : 0;
        newOrderLines.push({
          lineId: l.id, productId: pid, name,
          qty: l.product_uom_qty, priceUnit: l.price_unit,
          packagingQty, cdn: packagingQty > 0 ? +((l.product_uom_qty || 0) / packagingQty).toFixed(2) : 0,
        });
      }
      const ids = newOrderLines.map(l => l.productId).filter(Boolean);
      try { Object.assign(_newOrderStockCache, await _fetchProductsStock(ids)); } catch (_) {}
      _renderCreateBody();
    } catch (e) {
      body.innerHTML = `<div class="sales-msg sales-msg--err">Erreur: ${esc(e.message)}</div>`;
    }
  }

  async function openCreateOrderModal() {
    newOrderLines = [];
    newOrderPartner = null;
    editingOrderId = null;
    deletedLineIds = [];
    Object.keys(_newOrderStockCache).forEach(k => delete _newOrderStockCache[k]);
    const el = createOrderModalEl();
    el.classList.add("ch-modal--open");
    const backBtn = el.querySelector("#salesCreateBackBtn");
    if (backBtn) {
      backBtn.style.display = "";
      backBtn.onclick = () => { closeCreateOrderModal(); openPromotionsModal(); };
    }
    _renderCreateBody();
  }

  /* ── Détail d'un BL (livraison) ───────────────────────────── */
  function deliveryModalEl() {
    let el = document.getElementById("salesDeliveryModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesDeliveryModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <button class="ch-modal-back" id="salesDeliveryBackBtn" title="Retour" style="display:none">← Retour</button>
            <div class="ch-modal-title" id="salesDeliveryTitle"></div>
            <div class="ch-modal-head-actions">
              <a href="#" target="_blank" rel="noopener" class="sales-odoo-link" id="salesDeliveryOdooLink" title="Ouvrir le BL dans Odoo">↗ Odoo</a>
              <a href="#" download rel="noopener" class="sales-pdf-link" id="salesDeliveryPdfLink" title="Télécharger le BL en PDF">⬇ PDF</a>
              <button class="ch-modal-close" title="Close">×</button>
            </div>
          </div>
          <div class="ch-modal-body" id="salesDeliveryBody"></div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeDeliveryModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeDeliveryModal);
    }
    return el;
  }
  function closeDeliveryModal() {
    const el = document.getElementById("salesDeliveryModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openDeliveryModal(pickingId, originOrderId) {
    const el = deliveryModalEl();
    el.classList.add("ch-modal--open");
    el.querySelector("#salesDeliveryTitle").textContent = "Chargement...";
    const backBtn = el.querySelector("#salesDeliveryBackBtn");
    if (backBtn) {
      if (originOrderId) {
        backBtn.style.display = "";
        backBtn.onclick = () => { closeDeliveryModal(); openChooseModal(originOrderId); };
      } else {
        backBtn.style.display = "none";
        backBtn.onclick = null;
      }
    }
    const odooLinkEl = el.querySelector("#salesDeliveryOdooLink");
    if (odooLinkEl) odooLinkEl.href = _odooPickingUrl(pickingId);
    const pdfLinkEl = el.querySelector("#salesDeliveryPdfLink");
    if (pdfLinkEl) {
      pdfLinkEl.href = _pdfPickingUrl(pickingId);
      pdfLinkEl.download = `BL-${pickingId}.pdf`;
    }
    const body = el.querySelector("#salesDeliveryBody");
    body.innerHTML = `<div class="sales-msg">Chargement...</div>`;
    try {
      const [picking] = await rpc("stock.picking", "read", [[pickingId]], {
        fields: ["id", "name", "scheduled_date", "date_done", "state", "move_ids_without_package", "promotion_ids"],
      });
      el.querySelector("#salesDeliveryTitle").textContent = picking?.name || "—";
      if (pdfLinkEl && picking?.name) {
        pdfLinkEl.download = String(picking.name).replace(/[\\/]+/g, "-") + ".pdf";
      }

      const moveIds = picking.move_ids_without_package || [];
      const moves = moveIds.length
        ? await rpc("stock.move", "read", [moveIds], {
            fields: ["product_id", "product_uom_qty", "quantity_done", "product_uom", "sale_line_id"],
          })
        : [];

      const discountReasonField = await getDiscountReasonFieldName();
      const saleLineIds = [...new Set(moves.map(m => Array.isArray(m.sale_line_id) ? m.sale_line_id[0] : m.sale_line_id).filter(Boolean))];
      const saleLines = saleLineIds.length
        ? await rpc("sale.order.line", "read", [saleLineIds], {
            fields: Array.from(new Set(["id", "price_unit", "price_subtotal", "price_total", "discount", discountReasonField].filter(Boolean))),
          })
        : [];
      const saleLineMap = {};
      saleLines.forEach(sl => { saleLineMap[sl.id] = sl; });

      // Texte de l'offre: lu directement depuis product.promotion (champ
      // promotion_ids du BL), jamais recalculé à partir des quantités livrées.
      const pickingPromotionIds = picking.promotion_ids || [];
      const promotionLabelMap = pickingPromotionIds.length ? await fetchPromotionLabels(pickingPromotionIds) : {};
      const promotionText = joinPromotionLabels(promotionLabelMap, pickingPromotionIds);

      // Filtre par produit: n'affiche dans l'infobulle que les offres
      // applicables à CE produit, pas toutes celles du BL.
      const autoPromotions = pickingPromotionIds.length ? await _fetchAutoPromotions() : [];
      const perProductPromoText = {};
      const perProductMinQty = {};
      if (autoPromotions.length) {
        const uniqPids = [...new Set(moves.map(m => Array.isArray(m.product_id) ? m.product_id[0] : m.product_id).filter(Boolean))];
        for (const pid of uniqPids) {
          let meta = null;
          try { meta = await _fetchProductMeta(pid); } catch (e) { meta = null; }
          const move = moves.find(m => (Array.isArray(m.product_id) ? m.product_id[0] : m.product_id) === pid);
          const name = Array.isArray(move?.product_id) ? move.product_id[1] : "";
          const matches = _promotionsForProduct(autoPromotions, meta, pid, name);
          perProductPromoText[pid] = matches.length
            ? Array.from(new Set(matches.map(m => m.name))).join(" · ")
            : "";
          const remiseMatches = matches.filter(p => (p.kind === "remise" || p.kind === "text-remise") && p.minQty > 0);
          perProductMinQty[pid] = remiseMatches.length ? Math.min(...remiseMatches.map(p => p.minQty)) : 0;
        }
      }

      // isFree reste utilisé uniquement pour déterminer visuellement quelles
      // lignes/produits sont concernés par une offre (pas pour construire "X+Y").
      const promoProductIds = new Set();
      moves.forEach(m => {
        const pid = Array.isArray(m.product_id) ? m.product_id[0] : m.product_id;
        const slId = Array.isArray(m.sale_line_id) ? m.sale_line_id[0] : m.sale_line_id;
        const sl = slId ? saleLineMap[slId] : null;
        const qty = m.quantity_done || m.product_uom_qty || 0;
        const free = sl && sl.price_unit === 0 && qty > 0;
        if (pid && free) promoProductIds.add(pid);
      });

      const linesHtml = moves.map(l => {
        const qty = l.quantity_done || l.product_uom_qty || 0;
        const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        const slId = Array.isArray(l.sale_line_id) ? l.sale_line_id[0] : l.sale_line_id;
        const sl = slId ? saleLineMap[slId] : null;
        const priceUnit = sl ? sl.price_unit : null;
        const total = sl ? (sl.price_total ?? sl.price_subtotal) : null;
        const discount = sl?.discount || 0;
        const isFree = priceUnit === 0 && qty > 0;
        // La ligne est marquée "promo" soit parce qu'elle est gratuite, soit
        // parce qu'elle porte le même produit qu'une ligne gratuite de ce BL
        // (même offre) — le lien exact stock.move -> promotion n'existe pas
        // toujours, on se rabat donc sur le produit pour l'affichage seulement.
        const isPromo = isFree || (pid && promoProductIds.has(pid));
        const discountReasonText = discountReasonField ? discountReasonLabel(sl, discountReasonField) : "";
        const promoMinQty = pid ? (perProductMinQty[pid] || 0) : 0;
        const discountIcon = discount > 0 ? `
          <span class="sales-line-discount" tabindex="0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="#F59E0B" stroke-width="2"/>
              <path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="sales-line-discount-tip">Remise: ${discount}%${priceUnit != null ? ` · PU brut: ${formatMoney(priceUnit) + " DA"}` : ""}${discountReasonText ? ` — ${esc(discountReasonText)}` : ""}${promoMinQty > 0 ? ` · 🛒 Qté min: ${promoMinQty}` : ""}</span>
          </span>` : "";
        const productPromoText = pid ? (perProductPromoText[pid] || "") : "";
        const promoTip = productPromoText
          ? (isFree ? `Gratuit (offert) — ${productPromoText}` : productPromoText)
          : (isFree ? "Gratuit (offert)" : "Offre promotionnelle");
        const promoIcon = isPromo ? `
          <span class="sales-line-promo" tabindex="0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="#10B981" stroke-width="2"/>
              <path d="M9 15l6-6M9.5 9.5h.01M14.5 14.5h.01" stroke="#10B981" stroke-width="2" stroke-linecap="round"/>
            </svg>
            <span class="sales-line-promo-tip">${promoTip}</span>
          </span>` : "";
        return `
        <div class="sales-line${isFree ? " sales-line--free" : ""}">
          <div class="sales-line-name">${discountIcon}${promoIcon}${esc(productLabel(Array.isArray(l.product_id) ? l.product_id[1] : "—"))}${isFree ? `<span class="sales-line-free-badge">GRATUIT</span>` : ""}</div>
          <div class="sales-line-qty">${qty} ×</div>
          <div class="sales-line-pu">${priceUnit != null ? formatMoney(priceUnit) + " DA" : "—"}</div>
          <div class="sales-line-total">${total != null ? formatMoney(total) + " DA" : "—"}</div>
        </div>`;
      }).join("") || `<div class="sales-msg">Aucune ligne</div>`;

      body.innerHTML = `
        <div class="sales-order-summary">
          <div>${_stateBadge(picking.state)}</div>
          <div class="sales-order-summary-date">${esc(formatDate(picking.date_done || picking.scheduled_date))}</div>
        </div>
        <div class="sales-lines-head">
          <div>Produit</div><div>Qté</div><div>P.U.</div><div>Total</div>
        </div>
        <div class="sales-lines">${linesHtml}</div>
      `;
    } catch (e) {
      body.innerHTML = `<div class="sales-msg sales-msg--err">Erreur: ${esc(e.message)}</div>`;
    }
  }

  /* ── Choix Vente / BL (petit modal de sélection) ──────────── */
  function chooseModalEl() {
    let el = document.getElementById("salesChooseModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesChooseModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <div class="ch-modal-title">Ouvrir</div>
            <button class="ch-modal-close" title="Close">×</button>
          </div>
          <div class="ch-modal-body" id="salesChooseBody"></div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closeChooseModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closeChooseModal);
    }
    return el;
  }
  function closeChooseModal() {
    const el = document.getElementById("salesChooseModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openChooseModal(orderId) {
    const o = orders.find(x => x.id === orderId);
    let order = o;
    if (!order || !("picking_ids" in order)) {
      try {
        const [full] = await rpc("sale.order", "read", [[orderId]], { fields: ["id", "picking_ids"] });
        order = { ...o, ...full };
      } catch (e) {
        toast("✗ " + e.message);
        return;
      }
    }
    const el = chooseModalEl();
    el.classList.add("ch-modal--open");
    const body = el.querySelector("#salesChooseBody");
    const pickingIds = order.picking_ids || [];
    body.innerHTML = `
      <div class="sales-choose-actions">
        <span class="sales-choose-group">
          <button type="button" class="sales-choose-btn" id="salesChooseVente">Vente</button>
          ${_odooLinkBtn(_odooOrderUrl(orderId), "Ouvrir la vente dans Odoo")}
        </span>
        <span class="sales-choose-group">
          <button type="button" class="sales-choose-btn" id="salesChooseBL">BL</button>
          ${pickingIds.length === 1 ? _odooLinkBtn(_odooPickingUrl(pickingIds[0]), "Ouvrir le BL dans Odoo") + _pdfLinkBtn(pickingIds[0]) : ""}
        </span>
      </div>
      <div id="salesChoosePickings"></div>
    `;
    body.querySelector("#salesChooseVente").addEventListener("click", () => {
      closeChooseModal();
      openOrderModal(orderId);
    });
    body.querySelector("#salesChooseBL").addEventListener("click", () => {
      if (!pickingIds.length) {
        toast("Aucun BL");
        return;
      }
      if (pickingIds.length === 1) {
        closeChooseModal();
        openDeliveryModal(pickingIds[0], orderId);
        return;
      }
      const list = body.querySelector("#salesChoosePickings");
      list.innerHTML = pickingIds.map(pid => `
        <span class="sales-choose-group">
          <button type="button" class="sales-choose-picking" data-pid="${pid}">BL #${pid}</button>
          ${_odooLinkBtn(_odooPickingUrl(pid), "Ouvrir le BL dans Odoo")}${_pdfLinkBtn(pid)}
        </span>
      `).join("");
      list.querySelectorAll(".sales-choose-picking").forEach(btn => {
        btn.addEventListener("click", () => {
          closeChooseModal();
          openDeliveryModal(Number(btn.dataset.pid), orderId);
        });
      });
    });
  }

  /* ── Recherche ─────────────────────────────────────────── */
  let searchTimer = null;
  function initSearchInput() {
    const inp = document.getElementById("salesSearchInput");
    if (!inp || inp._bound) return;
    inp._bound = true;
    inp.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = inp.value;
        _fetchPage(true);
      }, 350);
    });
  }

  /* ── Styles ────────────────────────────────────────────── */
  function _injectSharedModalStyles() {
    if (document.getElementById("chModalSharedStyle")) return;
    const style = document.createElement("style");
    style.id = "chModalSharedStyle";
    style.textContent = `
      .ch-modal {
        position: fixed; inset: 0; z-index: 1000; display: none;
      }
      .ch-modal--open { display: block; }
      .ch-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
      .ch-modal-box {
        position: relative; margin: 5vh auto; width: min(680px, 92vw); max-height: 88vh;
        background: var(--bg2,#fff); border: 1px solid var(--border,#E2E8F0); border-radius: 14px;
        display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.25);
      }
      .ch-modal-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 14px 16px; border-bottom: 1px solid var(--border,#E2E8F0);
      }
      .ch-modal-title { font-size: 14px; font-weight: 700; color: var(--text,#0F172A); }
      .ch-modal-back {
        border: none; background: none; cursor: pointer; font-size: 13px; font-weight: 700;
        color: var(--text2,#475569); padding: 4px 8px 4px 0; margin-right: 4px; display: flex; align-items: center; gap: 4px;
      }
      .ch-modal-back:hover { color: var(--accent,#2563EB); }
      .ch-modal-close {
        border: none; background: transparent; color: var(--text2,#64748B); cursor: pointer;
        display: flex; align-items: center; padding: 4px; border-radius: 6px; font-size: 18px; line-height: 1;
      }
      .ch-modal-close:hover { color: #EF4444; }
      .ch-modal-body { overflow-y: auto; padding: 10px 16px; flex: 1; }
      .ch-modal-foot { padding: 10px 16px; border-top: 1px solid var(--border,#E2E8F0); text-align: center; }
      .ch-modal-head-actions { display: flex; align-items: center; gap: 10px; }
      .sales-odoo-link {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 11.5px; font-weight: 700; text-decoration: none;
        color: var(--accent,#2563EB); border: 1px solid var(--border,#E2E8F0);
        border-radius: 6px; padding: 3px 8px; line-height: 1.3; white-space: nowrap;
        transition: background .15s ease, border-color .15s ease;
      }
      .sales-odoo-link:hover { background: var(--bg3,#F1F5F9); border-color: var(--accent,#2563EB); }
      .sales-pdf-link {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 11.5px; font-weight: 700; text-decoration: none;
        color: #DC2626; border: 1px solid #FECACA; background: #FEF2F2;
        border-radius: 6px; padding: 3px 8px; line-height: 1.3; white-space: nowrap;
        transition: background .15s ease, border-color .15s ease;
      }
      .sales-pdf-link:hover { background: #FEE2E2; border-color: #DC2626; }
    `;
    document.head.appendChild(style);
  }

  function injectStyles() {
    _injectSharedModalStyles();
    if (document.getElementById("salesViewStyle")) return;
    const style = document.createElement("style");
    style.id = "salesViewStyle";
    style.textContent = `
      .sales-msg { padding: 24px; text-align: center; color: var(--text3,#94A3B8); font-size: 13px; }
      .sales-msg--err { color: #EF4444; }
      .sales-count { font-size: 11px; font-weight: 700; color: var(--text3,#94A3B8); margin-bottom: 8px; text-transform: uppercase; letter-spacing: .04em; }
      .sales-list { display: flex; flex-direction: column; gap: 0; }
      .sales-table { border: 1px solid var(--border,#E2E8F0); border-radius: 10px; overflow: hidden; background: var(--bg2,#fff); width: 100%; }
      .sales-table-head {
        display: grid; gap: 4px; align-items: center; padding: 9px 10px;
        background: var(--bg3,#F1F5F9); border-bottom: 1px solid var(--border,#E2E8F0);
        font-size: 10.5px; font-weight: 700; color: var(--text3,#94A3B8); text-transform: uppercase; letter-spacing: .03em;
      }
      .sales-row {
        display: grid; gap: 4px; align-items: center;
        padding: 8px 10px; border-bottom: 1px solid var(--border,#E2E8F0); min-height: 52px;
        background: var(--bg2,#fff); cursor: pointer; transition: background .15s ease;
      }
      .sales-row:last-child { border-bottom: none; }
      .sales-row:hover { background: var(--bg3,#F8FAFC); }
      .sales-cell {
        min-width: 0;
        font-size: 12.5px; color: var(--text2,#475569);
      }
      .sales-cell-wrap {
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
        overflow: hidden; line-height: 1.3; word-break: break-word;
      }
      .sales-cell-name { font-weight: 700; color: var(--text,#0F172A); }
      .sales-cell-partner { color: var(--text,#0F172A); }
      .sales-cell-amount { text-align: right; font-weight: 800; color: var(--text,#0F172A); }
      .sales-state-badge {
        display: inline-flex; align-items: center; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
        border-radius: 999px; padding: 3px 9px;
        font-size: 10.5px; font-weight: 700; background: color-mix(in srgb, var(--badgeclr) 14%, #fff);
        color: var(--badgeclr); border: 1px solid color-mix(in srgb, var(--badgeclr) 40%, #fff);
      }
      .sales-loadmore {
        display: block; margin: 14px auto 0; padding: 8px 18px; border-radius: 8px;
        border: 1px solid var(--border,#E2E8F0); background: var(--bg,#F8FAFC); color: var(--text,#0F172A);
        font-size: 12.5px; font-weight: 700; cursor: pointer;
      }
      .sales-loadmore:hover { border-color: var(--accent,#2563EB); color: var(--accent,#2563EB); }
      .sales-loadmore:disabled { opacity: .6; cursor: default; }

      .sales-filter-chip {
        display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; border: 1.5px solid transparent;
        padding: 4px 10px; font-size: 11.5px; font-weight: 700; cursor: pointer; background: var(--bg3,#F1F5F9);
        color: var(--text2,#475569); font-family: inherit;
      }
      .sales-filter-chip--active { border-color: var(--chipclr,#3B82F6); background: color-mix(in srgb, var(--chipclr,#3B82F6) 14%, #fff); color: #0F172A; }
      .sales-filter-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chipclr,#94A3B8); flex-shrink: 0; }
      .sales-filter-clear { font-size: 11px; font-weight: 700; color: var(--accent,#2563EB); background: none; border: none; cursor: pointer; }

      .sales-order-summary { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 12px; color: var(--text2,#475569); flex-wrap: wrap; }
      .sales-lines-head, .sales-line {
        display: grid; grid-template-columns: 1fr 60px 90px 100px; gap: 8px; align-items: center;
      }
      .sales-lines-head { font-size: 10.5px; font-weight: 700; color: var(--text3,#94A3B8); text-transform: uppercase; padding: 4px 6px; }
      .sales-lines { display: flex; flex-direction: column; gap: 2px; }
      .sales-line { padding: 7px 6px; border-radius: 6px; font-size: 12.5px; }
      .sales-line:nth-child(odd) { background: var(--bg3,#F8FAFC); }
      .sales-line--free {
        background: #ECFDF5 !important; border: 1px solid #A7F3D0;
      }
      .sales-line--free .sales-line-price, .sales-line--free .sales-line-pu,
      .sales-line--free .sales-line-subtotal, .sales-line--free .sales-line-total { color: #059669; font-weight: 700; }
      .sales-line-free-badge {
        background: #10B981; color: #fff; font-size: 9px; font-weight: 800; letter-spacing: .03em;
        padding: 2px 6px; border-radius: 4px; margin-left: 4px;
      }
      .sales-line-qty, .sales-line-price, .sales-line-subtotal, .sales-line-pu, .sales-line-total { text-align: right; color: var(--text2,#475569); }
      .sales-line-name { display: flex; align-items: center; gap: 5px; }
      .sales-line-discount { position: relative; display: inline-flex; cursor: help; outline: none; }
      .sales-line-discount-tip {
        position: absolute; bottom: calc(100% + 6px); left: 0; white-space: normal;
        width: max-content; max-width: 240px; background: #0F172A; color: #fff; font-size: 11px; font-weight: 600; padding: 6px 9px;
        border-radius: 6px; opacity: 0; pointer-events: none; transform: translateY(4px);
        transition: opacity .15s ease, transform .15s ease; z-index: 20; line-height: 1.4;
      }
      .sales-line-discount:hover .sales-line-discount-tip,
      .sales-line-discount:focus .sales-line-discount-tip { opacity: 1; transform: translateY(0); }
      .sales-line-promo { position: relative; display: inline-flex; cursor: help; outline: none; }
      .sales-line-promo-tip {
        position: absolute; bottom: calc(100% + 6px); left: 0; white-space: normal;
        width: max-content; max-width: 240px; background: #065F46; color: #fff; font-size: 11px; font-weight: 600; padding: 6px 9px;
        border-radius: 6px; opacity: 0; pointer-events: none; transform: translateY(4px);
        transition: opacity .15s ease, transform .15s ease; z-index: 20; line-height: 1.4;
      }
      .sales-line-promo:hover .sales-line-promo-tip,
      .sales-line-promo:focus .sales-line-promo-tip { opacity: 1; transform: translateY(0); }
      .sales-order-totals { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border,#E2E8F0); display: flex; justify-content: flex-end; gap: 16px; font-size: 12.5px; color: var(--text2,#475569); }
      .sales-order-total-ttc { font-weight: 800; color: var(--text,#0F172A); }

      .sales-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(8px);
        background: #0F172A; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 12.5px;
        opacity: 0; pointer-events: none; transition: all .2s ease; z-index: 12000;
      }
      .sales-toast--show { opacity: 1; transform: translateX(-50%) translateY(0); }

      .sales-choose-actions { display: flex; gap: 10px; padding: 6px 0 4px; }
      .sales-choose-group { display: inline-flex; align-items: center; gap: 6px; }
      .sales-choose-btn {
        flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border,#E2E8F0);
        background: var(--bg,#F8FAFC); color: var(--text,#0F172A); font-size: 13px; font-weight: 700; cursor: pointer;
      }
      .sales-choose-btn:hover { border-color: var(--accent,#2563EB); color: var(--accent,#2563EB); }
      .sales-choose-picking {
        display: block; width: 100%; padding: 8px 10px; border-radius: 8px;
        border: 1px solid var(--border,#E2E8F0); background: var(--bg2,#fff); color: var(--text,#0F172A);
        font-size: 12.5px; font-weight: 700; cursor: pointer; text-align: left;
      }
      #salesChoosePickings .sales-choose-group { display: flex; width: 100%; margin-top: 6px; gap: 6px; }
      #salesChoosePickings .sales-choose-group .sales-choose-picking { flex: 1; }
      .sales-choose-picking:hover { border-color: var(--accent,#2563EB); color: var(--accent,#2563EB); }

      .sales-confirm-bar { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border,#E2E8F0); display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
      .sales-confirm-btn {
        padding: 9px 16px; border-radius: 8px; border: 1px solid #16A34A; background: #16A34A; color: #fff;
        font-size: 13px; font-weight: 700; cursor: pointer;
      }
      .sales-confirm-btn:hover { background: #15803D; }
      .sales-confirm-btn:disabled { opacity: .6; cursor: default; }
      .sales-edit-btn {
        padding: 9px 16px; border-radius: 8px; border: 1px solid var(--accent,#2563EB); background: #fff; color: var(--accent,#2563EB);
        font-size: 13px; font-weight: 700; cursor: pointer;
      }
      .sales-edit-btn:hover { background: #EFF6FF; }

      .sales-promo-toggle-btn {
        padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border,#E2E8F0); background: #fff; color: var(--text2,#475569);
        font-size: 13px; font-weight: 700; cursor: pointer;
      }
      .sales-promo-toggle-btn:hover { background: #F8FAFC; }
      .sales-promo-toggle-btn:disabled { opacity: .6; cursor: default; }
      .sales-promo-toggle-btn--active {
        border-color: #F59E0B; background: #FFFBEB; color: #B45309;
      }

      .sales-create-field { margin-bottom: 12px; }
      .sales-create-field label { display: block; font-size: 11px; font-weight: 700; color: var(--text3,#94A3B8); text-transform: uppercase; margin-bottom: 5px; }
      .sales-create-field input[type="text"] {
        width: 100%; padding: 8px 10px; border: 1px solid var(--border,#E2E8F0); border-radius: 8px;
        background: var(--bg,#F8FAFC); color: var(--text,#0F172A); font-size: 13px;
      }
      .sales-create-partner-chip {
        display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px;
        background: var(--bg,#F8FAFC); border: 1px solid var(--border,#E2E8F0); font-size: 13px; font-weight: 600;
      }
      .sales-create-partner-chip button { border: none; background: none; cursor: pointer; font-size: 15px; color: var(--text3,#94A3B8); }
      .sales-create-suggest { margin-top: 4px; max-height: 160px; overflow-y: auto; border-radius: 8px; }
      .sales-suggest-item { padding: 7px 10px; font-size: 12.5px; cursor: pointer; border-radius: 6px; }
      .sales-suggest-item:hover, .sales-suggest-item--active { background: var(--bg3,#F1F5F9); }
      .sales-suggest-empty { padding: 7px 10px; font-size: 12.5px; color: var(--text3,#94A3B8); }
      .sales-newlines-head {
        display: grid; grid-template-columns: 1fr 50px 55px 75px 75px 26px; gap: 6px; font-size: 10.5px;
        font-weight: 700; color: var(--text3,#94A3B8); text-transform: uppercase; padding: 4px 2px; margin-top: 6px;
      }
      .sales-newlines { display: flex; flex-direction: column; gap: 4px; }
      .sales-newline { display: grid; grid-template-columns: 1fr 50px 55px 75px 75px 26px; gap: 6px; align-items: center; padding: 4px 2px; }
      .sales-newline-name { font-size: 12.5px; }
      .sales-newline-cdn, .sales-newline-qty, .sales-newline-price, .sales-newline-disc {
        width: 100%; padding: 5px 6px; border: 1px solid var(--border,#E2E8F0); border-radius: 6px; font-size: 12px;
      }
      .sales-newline-total { font-size: 12.5px; font-weight: 700; text-align: right; color: var(--text,#0F172A); }
      .sales-newline-del { border: none; background: none; color: #DC2626; font-size: 16px; cursor: pointer; }
      .sales-create-actions {
        margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border,#E2E8F0);
        display: flex; justify-content: space-between; align-items: center;
      }
      .sales-create-grandtotal { font-size: 14px; font-weight: 800; color: var(--text,#0F172A); }
      .sales-create-grandtotal span { color: var(--accent,#2563EB); }
      .sales-create-submit {
        padding: 9px 18px; border-radius: 8px; border: 1px solid var(--accent,#2563EB); background: var(--accent,#2563EB);
        color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
      }
      .sales-create-submit:disabled { opacity: .6; cursor: default; }
      .sales-newline-gift-badge { color: #10B981; font-weight: 700; font-size: 11px; }
      .sales-newline--free {
        background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 6px;
      }
      .sales-newline--free .sales-newline-gift-badge {
        background: #10B981; color: #fff; font-size: 9px; font-weight: 800; letter-spacing: .03em;
        padding: 2px 6px; border-radius: 4px; margin-left: 4px;
      }
      .sales-promo-chip-remove { border: none; background: none; cursor: pointer; font-size: 15px; color: var(--text3,#94A3B8); }
      .sales-promo-list { display: flex; flex-direction: column; gap: 8px; }
      .sales-promo-group-label {
        font-size: 11px; font-weight: 700; color: var(--text3,#94A3B8);
        text-transform: uppercase; letter-spacing: .03em;
        margin: 10px 0 2px; padding-top: 8px; border-top: 1px solid var(--border,#E2E8F0);
      }
      .sales-promo-card {
        border: 1px solid var(--border,#E2E8F0); border-radius: 8px; padding: 10px 12px;
        background: var(--bg3,#F8FAFC);
      }
      .sales-promo-card-name { font-size: 12.5px; font-weight: 700; color: var(--text,#0F172A); }
      .sales-promo-card-desc { font-size: 11.5px; color: #8B5CF6; font-weight: 600; margin-top: 2px; }
      .sales-promo-card-conds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
      .sales-promo-tag {
        display: inline-flex; align-items: center; gap: 3px;
        font-size: 10.5px; font-weight: 600; padding: 2px 7px; border-radius: 20px;
      }
      .sales-promo-tag--cluster { background: #EDE9FE; color: #6D28D9; }
      .sales-promo-tag--date    { background: #DBEAFE; color: #1D4ED8; }
      .sales-promo-filters {
        display: flex; flex-wrap: wrap; gap: 6px;
        padding: 0 0 12px 0; margin-bottom: 4px;
        border-bottom: 1px solid var(--border,#E2E8F0);
      }
      .sales-promo-filter-btn {
        border: 1.5px solid var(--border,#E2E8F0);
        background: var(--bg3,#F8FAFC); color: var(--text2,#475569);
        border-radius: 20px; padding: 4px 12px; font-size: 11.5px; font-weight: 600;
        cursor: pointer; transition: background .15s, color .15s, border-color .15s;
        white-space: nowrap;
      }
      .sales-promo-filter-btn:hover { background: #EDE9FE; color: #6D28D9; border-color: #C4B5FD; }
      .sales-promo-filter-btn.active { background: #7C3AED; color: #fff; border-color: #7C3AED; }
    `;
    document.head.appendChild(style);
  }

  /* ── Offres en cours (product.promotion actives) ──────────── */

  // Formate une date Odoo "YYYY-MM-DD" ou "YYYY-MM-DD HH:MM:SS" en "DD/MM/YYYY".
  function _fmtPromoDate(d) {
    if (!d) return null;
    const s = String(d).slice(0, 10);
    const [y, m, dd] = s.split("-");
    return `${dd}/${m}/${y}`;
  }

  // Génère le HTML des tags cluster + dates d'une promo.
  function _promoConditionsHtml(p) {
    const parts = [];
    if (p.cluster) {
      parts.push(`<span class="sales-promo-tag sales-promo-tag--cluster">👥 ${esc(p.cluster)}</span>`);
    }
    const from = _fmtPromoDate(p.dateFrom);
    const to   = _fmtPromoDate(p.dateTo);
    if (from && to)  parts.push(`<span class="sales-promo-tag sales-promo-tag--date">📅 ${from} → ${to}</span>`);
    else if (from)   parts.push(`<span class="sales-promo-tag sales-promo-tag--date">📅 Dès ${from}</span>`);
    else if (to)     parts.push(`<span class="sales-promo-tag sales-promo-tag--date">📅 Jusqu'au ${to}</span>`);
    if (!parts.length) return "";
    return `<div class="sales-promo-card-conds">${parts.join("")}</div>`;
  }

  function _describePromotion(p) {
    switch (p.kind) {
      case "remise":
      case "text-remise":
        return `Remise ${p.discountPercent}%${p.minQty > 0 ? ` · à partir de ${p.minQty} unité(s)` : ""}`;
      case "buyget":
      case "buyget-text":
        return `${p.buyQty} acheté(s) → ${p.freeQty} offert(s)`;
      case "bundle":
        return "Offre combinée (plusieurs produits)";
      default:
        return "Offre promotionnelle";
    }
  }

  function promotionsModalEl() {
    let el = document.getElementById("salesPromotionsModal");
    if (!el) {
      el = document.createElement("div");
      el.id = "salesPromotionsModal";
      el.className = "ch-modal";
      el.innerHTML = `
        <div class="ch-modal-backdrop"></div>
        <div class="ch-modal-box">
          <div class="ch-modal-head">
            <div class="ch-modal-title">Offres en cours</div>
            <button class="ch-modal-close" title="Close">×</button>
          </div>
          <div class="ch-modal-body" id="salesPromotionsBody"></div>
        </div>`;
      document.body.appendChild(el);
      el.querySelector(".ch-modal-backdrop").addEventListener("click", closePromotionsModal);
      el.querySelector(".ch-modal-close").addEventListener("click", closePromotionsModal);
    }
    return el;
  }
  function closePromotionsModal() {
    const el = document.getElementById("salesPromotionsModal");
    if (el) el.classList.remove("ch-modal--open");
  }

  async function openPromotionsModal() {
    const el = promotionsModalEl();
    el.classList.add("ch-modal--open");
    const body = document.getElementById("salesPromotionsBody");
    body.innerHTML = `<div class="sales-msg">Chargement...</div>`;
    try {
      const promos = await _fetchAutoPromotions();
      const usable = promos.filter(p => p.kind !== "tag");
      if (!usable.length) {
        body.innerHTML = `<div class="sales-msg">Aucune offre active pour le moment.</div>`;
      } else {
        // Collecte les clusters présents (+ "Tous")
        const clusters = ["Tous", ...Array.from(new Set(usable.map(p => p.cluster).filter(Boolean)))];
        let activeCluster = "Tous";

        function renderPromos() {
          let filtered;
          if (activeCluster === "Tous") {
            filtered = usable;
          } else {
            // D'abord les offres ciblées sur ce cluster, puis en dessous
            // les offres générales (sans cluster précis = pour tout le monde)
            const specific = usable.filter(p => p.cluster === activeCluster);
            const general  = usable.filter(p => !p.cluster);
            filtered = [...specific, ...general];
          }

          if (!filtered.length) {
            body.querySelector("#salesPromosCards").innerHTML = `<div class="sales-msg">Aucune offre pour ce cluster.</div>`;
            return;
          }

          if (activeCluster === "Tous") {
            body.querySelector("#salesPromosCards").innerHTML = filtered.map(p => `
              <div class="sales-promo-card">
                <div class="sales-promo-card-name">${esc(p.name)}</div>
                <div class="sales-promo-card-desc">${esc(_describePromotion(p))}</div>
                ${_promoConditionsHtml(p)}
              </div>`).join("");
          } else {
            const specific = usable.filter(p => p.cluster === activeCluster);
            const general  = usable.filter(p => !p.cluster);
            const cardHtml = p => `
              <div class="sales-promo-card">
                <div class="sales-promo-card-name">${esc(p.name)}</div>
                <div class="sales-promo-card-desc">${esc(_describePromotion(p))}</div>
                ${_promoConditionsHtml(p)}
              </div>`;
            body.querySelector("#salesPromosCards").innerHTML =
              (specific.length ? specific.map(cardHtml).join("") : `<div class="sales-msg">Aucune offre spécifique pour ce cluster.</div>`)
              + (general.length ? `<div class="sales-promo-group-label">Offres pour tous</div>${general.map(cardHtml).join("")}` : "");
          }
        }

        body.innerHTML = `
          <div class="sales-promo-filters" id="salesPromoFilters">
            ${clusters.map(c => `
              <button type="button" class="sales-promo-filter-btn${c === "Tous" ? " active" : ""}" data-cluster="${esc(c)}">
                ${c === "Tous" ? "Tous" : `👥 ${esc(c)}`}
              </button>`).join("")}
          </div>
          <div class="sales-promo-list" id="salesPromosCards"></div>
          <div class="sales-create-actions" style="justify-content:flex-end;">
            <button type="button" id="salesPromotionsUseBtn" class="sales-create-submit">Utiliser dans un devis</button>
          </div>
        `;

        renderPromos();

        body.querySelector("#salesPromoFilters").addEventListener("click", e => {
          const btn = e.target.closest(".sales-promo-filter-btn");
          if (!btn) return;
          activeCluster = btn.dataset.cluster;
          body.querySelectorAll(".sales-promo-filter-btn").forEach(b => b.classList.toggle("active", b === btn));
          renderPromos();
        });

        body.querySelector("#salesPromotionsUseBtn")?.addEventListener("click", () => {
          closePromotionsModal();
          openCreateOrderModal();
        });
      }
    } catch (e) {
      body.innerHTML = `<div class="sales-msg sales-msg--err">Erreur: ${esc(e.message)}</div>`;
    }
  }


  let activated = false;
  let newDevisWired = false;
  async function activate() {
    injectStyles();
    initSearchInput();
    _renderWarehouseBar();
    _renderFilterBar();
    if (!newDevisWired) {
      newDevisWired = true;
      document.getElementById("salesNewDevisBtn")?.addEventListener("click", openCreateOrderModal);
      document.getElementById("salesPromotionsBtn")?.addEventListener("click", openPromotionsModal);
    }
    if (!activated) {
      activated = true;
      await _loadWarehouseDomains();
      _fetchPage(true);
    } else {
      _renderList();
    }
  }
  function deactivate() { /* rien à nettoyer pour l'instant */ }

  return { activate, deactivate, openOrderModal, openDeliveryModal, openEditOrderModal, openPromotionsModal };
})();

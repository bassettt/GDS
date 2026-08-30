// ============================================================
// src/deliveryPlanner.js — "Dispatch Planning" (Delivery Map)
// Uses /api/delivery-map/* endpoints via odooProxy
// Completely rewritten — no call_kw, no sale.order, no Leaflet
// ============================================================

const DeliveryPlanner = (() => {

  // ── LocalStorage cache helpers (TTL-based) ─────────────────
  const _LS_PREFIX = 'dp_cache_';
  const _LS_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

  function _lsGet(key) {
    try {
      const raw = localStorage.getItem(_LS_PREFIX + key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > _LS_TTL_MS) { localStorage.removeItem(_LS_PREFIX + key); return null; }
      return data;
    } catch (_) { return null; }
  }

  function _lsSet(key, data) {
    try { localStorage.setItem(_LS_PREFIX + key, JSON.stringify({ ts: Date.now(), data })); } catch (_) {}
  }

  // Restore a Map from localStorage (key -> value pairs stored as [[k,v],...])
  function _lsRestoreMap(mapRef, lsKey) {
    const saved = _lsGet(lsKey);
    if (saved && Array.isArray(saved)) { saved.forEach(([k, v]) => mapRef.set(k, v)); }
  }

  // Persist a Map to localStorage
  function _lsPersistMap(mapRef, lsKey) {
    if (mapRef.size > 0) _lsSet(lsKey, [...mapRef.entries()]);
  }

  // ── State ──────────────────────────────────────────────────
  let _map = null;
  let _googleMapsLoaded = false;
  let _googleMapsApiKey = null;
  let _actors = [];              // [{id, name, planning_id, warehouse_id, ...}]
  let _selectedActorId = null;
  let _unassignedBLs = new Map();  // id -> BL data (global pool, not in any tournée)
  let _assignedBLs = new Map();    // id -> BL data (scoped to the currently SELECTED actor only)
  let _routeAssignedBLs = new Map(); // id -> BL data — GLOBAL: every BL assigned to ANY tournée
                                      // (all actors combined). Drives the Affectés/Non affectés
                                      // filter tabs and default marker coloring, independent of
                                      // which actor (if any) is currently selected.

  // ── Verrou global d'opération ─────────────────────────────
  // Empêche tout chevauchement entre affectation / désaffectation / apply
  // draft / actualisation lorsqu'une opération réseau est déjà en cours.
  let _busy = false;
  let _busyLabel = '';

  function _setBusy(on, label) {
    _busy = on;
    _busyLabel = on ? (label || 'Opération en cours…') : '';
    const root = document.getElementById('dmRoot');
    if (!root) return;
    let overlay = root.querySelector('#dmBusyOverlay');
    if (on) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dmBusyOverlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:500;background:rgba(255,255,255,.55);display:flex;align-items:center;justify-content:center;cursor:wait';
        overlay.innerHTML = `<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1.5px solid var(--border,#E2E8F0);border-radius:20px;padding:7px 14px;box-shadow:0 4px 14px rgba(0,0,0,.12)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2.6" class="dm-spin"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span id="dmBusyLabel" style="font-size:11.5px;font-weight:700;color:var(--text,#0F172A)"></span>
        </div>`;
        root.appendChild(overlay);
      }
      overlay.querySelector('#dmBusyLabel').textContent = _busyLabel;
      overlay.style.display = 'flex';
      root.classList.add('dm-frozen');
    } else if (overlay) {
      overlay.style.display = 'none';
      root.classList.remove('dm-frozen');
    }
  }

  // À appeler au début de toute opération réseau qui modifie l'affectation
  // des BL. Retourne false (et prévient l'utilisateur) si une autre
  // opération est déjà en cours — l'appelant doit alors abandonner.
  function _acquireBusy(label) {
    if (_busy) {
      addNotif?.('Une autre opération est en cours, veuillez patienter…', 'warning');
      return false;
    }
    _setBusy(true, label);
    return true;
  }

  function _releaseBusy() {
    _setBusy(false);
  }

  // Un BL n'est réellement "dans la tournée" que si planning_delivery_id
  // porte un id. Les BLs retournés par get-deliveries sans planning_delivery_id
  // sont juste "à proximité" (pool), pas affectés à un tour réel.
  function _isInTournee(bl) {
    return bl?.planning_delivery_id?.id != null;
  }

  // Un BL annulé ou déjà livré ne doit plus jamais apparaître nulle part
  // (ni sur la carte, ni dans les compteurs, ni dans "BL(s) dans la tournée").
  function _isActiveBL(bl) {
    const st = bl?.planning_state;
    return st !== 'canceled' && st !== 'cancel' && st !== 'done';
  }
  let _selectedBLIds = new Set();  // IDs currently ticked in the consolidé panel
  let _markers = new Map();        // bl_id -> google.maps.Marker
  let _infoWindow = null;
  let _actorInfoWindow = null;
  let _drawingManager = null;
  let _pixelHelperOv = null; // OverlayView مساعد لتحويل latLng إلى بكسل (للتحديد بالمربع)
  let _selectionPolygon = null;
  let _currentDates = new Set(); // فارغة = كل التواريخ (الافتراضي)
  let _creationFilters = new Set(); // فارغة = كل التواريخ (all)، وإلا مجموعة من: 'today','yesterday','week','older'
  let _originCache = new Map(); // bl_id -> origin (Document d'origine), pour badge ACILE
  let _filterTab = 'all';          // 'all' | 'assigned' | 'unassigned'  (global, top toolbar)
  let _actorFilterTab = 'all';     // 'all' | 'assigned' | 'unassigned'  (scoped to the selected actor, inside the consolide modal)
  let _undoStack = [];             // [{type:'assign'|'unassign', payload, reversePayload}]
  let _undoTimer = null;
  let _loading = false;

  // ── Barre de progression fine au-dessus du bandeau de logs ──
  // Suit les chargements secondaires (arrière-plan) après l'affichage initial.
  let _progressTotal = 0;
  let _progressDone = 0;

  function _progressStart(totalSteps) {
    _progressTotal = totalSteps;
    _progressDone = 0;
    const bar = document.getElementById('dmProgressBar');
    const fill = document.getElementById('dmProgressBarFill');
    if (!bar || !fill || totalSteps <= 0) return;
    fill.style.width = '0%';
    bar.style.display = 'block';
  }

  function _progressStep() {
    if (_progressTotal <= 0) return;
    _progressDone = Math.min(_progressDone + 1, _progressTotal);
    const fill = document.getElementById('dmProgressBarFill');
    if (fill) fill.style.width = Math.round((_progressDone / _progressTotal) * 100) + '%';
    if (_progressDone >= _progressTotal) {
      const bar = document.getElementById('dmProgressBar');
      // على السرعة نتركها تصل 100% بصريا قبل الإخفاء
      setTimeout(() => { if (bar) bar.style.display = 'none'; }, 200);
    }
  }

  // ── Draft mode (تطبيق مؤجل) ───────────────────────────────
  // بدل تنفيذ كل affectation/désaffectation فوريًا على الخادم، يمكن تسجيلها محليًا
  // كـ "معلّقة" وتطبيقها دفعة واحدة عبر زر، أو إلغاؤها بالكامل. الوضع الافتراضي = مسودة.
  const _DRAFT_MODE_KEY = 'dm_draft_mode';
  let _draftMode = (() => {
    try {
      const saved = localStorage.getItem(_DRAFT_MODE_KEY);
      return saved === null ? true : saved === '1';
    } catch (e) { return true; }
  })();
  let _pendingOps = []; // [{type:'assign', blId, actorId, rotation, fromPlanningId}, {type:'unassign', blId, planningId}]

  // ── Helpers ────────────────────────────────────────────────
  function _todayStr() {
    return new Date().toISOString().split('T')[0];
  }

  function _fmtDate(d) {
    if (!d) return '';
    const dt = new Date(String(d).replace(' ', 'T'));
    if (isNaN(dt)) return String(d);
    return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function _fmtNum(n, dec = 2) {
    if (n == null || n === '') return '—';
    return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: dec });
  }

  function _planningIsNew(actor) {
    return !actor?.planning_id || actor.planning_id.id === 0 || actor.planning_id.new === true;
  }

  // ── API helpers ────────────────────────────────────────────
  async function _api(method, path, body) {
    const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json().catch(() => ({}));
    if (json?.error) {
      const msg = json.error?.data?.message || json.error?.message || JSON.stringify(json.error);
      throw new Error(msg);
    }
    return json.result;
  }

  async function _getActors() {
    return await _api('GET', '/delivery-map/get-actors-delivery');
  }

  async function _getActor(id) {
    return await _api('GET', `/delivery-map/actor/${id}`);
  }

  async function _getDeliveries(actorId) {
    const qs = actorId != null ? `?actor_id=${actorId}` : '';
    return await _api('GET', `/delivery-map/get-deliveries${qs}`);
  }

  // Fetches EVERY BL assigned to ANY actor's tournée (not just the selected one)
  // by querying each actor in parallel and merging the results. Used to keep
  // _routeAssignedBLs — the global affecté/non-affecté source of truth — up to date.
  async function _loadAllRouteAssignedBLs(onActorDone) {
    const lists = await Promise.all(
      _actors.map(a => _getDeliveries(a.id).catch(() => []).finally(() => onActorDone?.()))
    );
    const map = new Map();
    lists.forEach(list => (list || []).filter(_isActiveBL).forEach(bl => map.set(bl.id, bl)));
    _routeAssignedBLs = map;
  }

  // نفس فكرة _loadAllRouteAssignedBLs لكن مقيّدة بمجموعة ليفروريين محدّدة فقط —
  // تُستخدم بعد عمليات تمس ليفروريين معروفين مسبقاً (تطبيق/إلغاء برنامج تجميعي)
  // بدل إعادة استعلام كل ليفرور في التطبيق (السبب الرئيسي في بطء هذه العمليات).
  async function _loadRouteAssignedBLsForActors(actorIds) {
    const ids = [...new Set(actorIds)].filter(id => id != null);
    if (!ids.length) return;
    const lists = await Promise.all(ids.map(id => _getDeliveries(id).catch(() => [])));
    // نزيل أولاً أي BL كانت في _routeAssignedBLs معزوّة لأحد هؤلاء الليفروريين،
    // كي لا تبقى بيانات قديمة إن أصبح BL غير مُسند بعد العملية.
    for (const [blId, bl] of _routeAssignedBLs) {
      if (ids.includes(bl?.delivery_user_id?.id)) _routeAssignedBLs.delete(blId);
    }
    lists.forEach(list => (list || []).filter(_isActiveBL).forEach(bl => _routeAssignedBLs.set(bl.id, bl)));
  }

  async function _assignDeliveries(planningId, deliveriesToAdd, actorId) {
    return await _api('POST', '/delivery-map/assign-deliveries', {
      planning_id: planningId,
      deliveries_to_add_ids: deliveriesToAdd,
      delivery_user_id: actorId,
    });
  }

  async function _unassignDeliveries(planningId, deliveryIds) {
    return await _api('POST', '/delivery-map/unassign-deliveries', {
      planning_id: planningId,
      deliveries_to_delete_ids: deliveryIds,
    });
  }

  async function _getGoogleMapKey() {
    if (_googleMapsApiKey) return _googleMapsApiKey;
    // Try localStorage first (avoids a round-trip on every open)
    const cached = _lsGet('gmaps_api_key');
    if (cached) { _googleMapsApiKey = cached; return _googleMapsApiKey; }
    try {
      const res = await _api('GET', '/google-map/get_config_param');
      _googleMapsApiKey = res?.key || res?.api_key || res?.google_maps_api_key || res;
      if (_googleMapsApiKey) _lsSet('gmaps_api_key', _googleMapsApiKey);
    } catch (_) {
      _googleMapsApiKey = null;
    }
    return _googleMapsApiKey;
  }

  // ── Google Maps loader ─────────────────────────────────────
  async function _loadGoogleMaps() {
    if (_googleMapsLoaded && window.google?.maps) return;
    const key = await _getGoogleMapKey();
    await new Promise((resolve, reject) => {
      if (window.google?.maps) { _googleMapsLoaded = true; resolve(); return; }
      const existing = document.getElementById('_dpGmapsScript');
      if (existing) {
        existing.addEventListener('load', () => { _googleMapsLoaded = true; resolve(); });
        existing.addEventListener('error', reject);
        return;
      }
      const cb = '_dpGmapsReady' + Date.now();
      window[cb] = () => { _googleMapsLoaded = true; resolve(); delete window[cb]; };
      const s = document.createElement('script');
      s.id = '_dpGmapsScript';
      s.async = true;
      s.defer = true;
      const keyParam = key ? `&key=${encodeURIComponent(key)}` : '';
      s.src = `https://maps.googleapis.com/maps/api/js?libraries=drawing${keyParam}&callback=${cb}`;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ── ألوان ثابتة حسب الفئة (Détail/GMS/Gros/Horeca) ──────────
  const _CATEGORY_COLORS = {
    'detail': '#D62728',
    'gms': '#1F5FA8',
    'gros': '#2E8B3D',
    'horeca': '#B8860B',
  };
  // حرف مخصّص لكل فئة (Gros = R كي لا يتداخل مع حرف GMS = G)
  const _CATEGORY_LETTERS = {
    'detail': 'D',
    'gms': 'G',
    'gros': 'R',
    'horeca': 'H',
  };
  // ترتيب المطابقة مهم: نتحقق من "gms" قبل "gros" لتفادي أي تداخل نصي محتمل.
  // نطابق عبر substring (وليس تطابق تام) لأن الاسم القادم من Odoo قد يكون
  // "GROS A"، "GROS B"، "GMS A (BtoB)"، "DÉTAIL"... وليس بالضرورة الكلمة وحدها.
  const _CATEGORY_MATCH_ORDER = ['gms', 'gros', 'horeca', 'detail'];
  // يزيل التشكيل (é → e) لمطابقة "détail" == "detail"
  function _normalizeCategText(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }
  function _matchCategoryKey(categName) {
    const norm = _normalizeCategText(categName);
    if (!norm) return null;
    return _CATEGORY_MATCH_ORDER.find(key => norm.includes(key)) || null;
  }
  function _categoryColor(categName) {
    const key = _matchCategoryKey(categName);
    return key ? _CATEGORY_COLORS[key] : null;
  }
  function _categoryLetter(categName) {
    const key = _matchCategoryKey(categName);
    if (key) return _CATEGORY_LETTERS[key];
    return categName ? String(categName).charAt(0).toUpperCase() : null;
  }

  // ── BL color from partner_custom_attribute_1 ────────────────
  // اللون يعكس الفئة (Détail/GMS/Gros/Horeca) دائماً، بغض النظر عن كون الـ BL
  // مُسنَداً لجولة أم لا — حالة الإسناد تُعرَض عبر شارة منفصلة (انظر badgeAssigned).
  function _blColor(bl) {
    const attr = bl?.partner_shipping_id?.partner_custom_attribute_1;
    const categName = Array.isArray(attr) ? attr[0] : null;
    const fixedColor = _categoryColor(categName);
    if (fixedColor) return fixedColor;
    if (Array.isArray(attr) && attr[1]) return attr[1];
    return '#3B82F6';
  }


  function _blCategory(bl) {
    const attr = bl?.partner_shipping_id?.partner_custom_attribute_1;
    return Array.isArray(attr) ? attr[0] : null;
  }

  // ── Badge "ACILE" (Document d'origine) ─────────────────────
  // origin = "Document d'origine" (champ standard stock.picking). Renvoyé
  // directement par certaines réponses de /delivery-map/*, sinon complété
  // via _originCache (rempli par un read groupé, voir _loadOrigins).
  function _blOrigin(bl) {
    return bl?.origin || _originCache.get(bl?.id) || '';
  }

  function _hasAcileBadge(bl) {
    return /ACILE/i.test(_blOrigin(bl));
  }

  // ── Badge "B" (Liste de prix BtoB) ──────────────────────────
  // Même logique que clientsView.js : la vraie liste de prix du client est
  // sur res.partner.pricelist (one2many, PAS property_product_pricelist),
  // liée par partner_id. On la résout via le partenaire de livraison du BL
  // (partner_shipping_id.id) et on met en cache par partner_id.
  let _pricelistCache = new Map(); // partner_id -> pricelistName

  function _blPricelistName(bl) {
    const pid = bl?.partner_shipping_id?.id;
    return pid != null ? (_pricelistCache.get(pid) || '') : '';
  }

  function _hasBtoBBadge(bl) {
    return /BtoB/i.test(_blPricelistName(bl));
  }

  // ── Badge "Reporté" (Date de livraison reportée) ────────────
  function _hasReportedBadge(bl) {
    return !!_reportDateCache.get(bl?.id);
  }

  // Icône SVG "sablier" (hourglass) réutilisable pour les listes (hors dubbin de carte)
  function _hourglassIconSvg(strokeColor) {
    return `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${strokeColor || '#fff'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14M5 21h14M5 3c0 5 4 6 7 9-3 3-7 4-7 9M19 3c0 5-4 6-7 9 3 3 7 4 7 9"/></svg>`;
  }

  async function _loadPricelists(partnerIds) {
    const missing = [...new Set(partnerIds)].filter(id => id != null && !_pricelistCache.has(id));
    if (!missing.length) return;
    try {
      const resp = await fetch('/api/web/dataset/call_kw', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call', id: Date.now(),
          params: {
            model: 'res.partner.pricelist', method: 'search_read',
            args: [[['partner_id', 'in', missing]]],
            kwargs: { fields: ['partner_id', 'pricelist_id'], limit: missing.length },
          },
        }),
      });
      const json = await resp.json().catch(() => ({}));
      missing.forEach(id => { if (!_pricelistCache.has(id)) _pricelistCache.set(id, ''); }); // évite de refaire une requête sans résultat
      (json?.result || []).forEach(r => {
        const partnerId = Array.isArray(r.partner_id) ? r.partner_id[0] : r.partner_id;
        const plName = Array.isArray(r.pricelist_id) ? r.pricelist_id[1] : '';
        if (partnerId != null) _pricelistCache.set(partnerId, plName || '');
      });
    } catch (e) {
      console.warn('[DeliveryPlanner] _loadPricelists failed:', e);
    }
  }

  // Batch-fetch "origin" pour une liste d'ids stock.picking, et remplit
  // _originCache. Utilise directement call_kw (pas besoin de vrai baseUrl :
  // le proxy /api ignore ce paramètre et route toujours vers TARGET_HOST).
  async function _loadOrigins(ids) {
    const missing = [...new Set(ids)].filter(id => !_originCache.has(id));
    if (!missing.length) return;
    try {
      const resp = await fetch('/api/web/dataset/call_kw', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call', id: Date.now(),
          params: {
            model: 'stock.picking', method: 'read',
            args: [missing, ['id', 'origin']], kwargs: {},
          },
        }),
      });
      const json = await resp.json().catch(() => ({}));
      (json?.result || []).forEach(r => _originCache.set(r.id, r.origin || ''));
    } catch (e) {
      console.warn('[DeliveryPlanner] _loadOrigins failed:', e);
    }
  }

  // Batch-fetch "create_date" (تاريخ الإنشاء) pour une liste d'ids stock.picking —
  // ce champ n'est pas inclus par défaut dans get-deliveries, donc on le charge à
  // part (même schéma que _loadOrigins) et on le met en cache par id.

  // تطبيع نص للمقارنة الذكية: يحذف التشكيل، يوحّد الحالة، ويطبّع المسافات المتعددة.
  function _normalizeSearchText(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // إزالة التشكيل/الأكسنتات
      .toLowerCase()
      .trim();
  }

  // بحث ذكي متعدد البائعين:
  // - الفاصل "+" أو "&" بين اسمين = OR (يكفي تطابق أحدهما)
  // - الكلمات داخل كل اسم = AND (كل كلمة يجب أن تكون موجودة)
  // - الترتيب والمسافات لا يهمان
  function _matchesVendeurQuery(name, query) {
    // تقسيم على + أو & للحصول على مجموعات OR
    const groups = query.split(/[+&]/).map(s => s.trim()).filter(Boolean);
    if (!groups.length) return true;
    const normName = _normalizeSearchText(name);
    if (!normName) return false;
    // يكفي تطابق مجموعة واحدة (OR بين المجموعات)
    return groups.some(group => {
      const tokens = _normalizeSearchText(group).split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      // داخل المجموعة: كل الكلمات يجب أن تكون موجودة (AND)
      return tokens.every(tok => normName.includes(tok));
    });
  }

  let _createDateCache = new Map(); // bl_id -> create_date string
  let _vendeurCache = new Map();    // bl_id -> nom du vendeur (البائع، غير الموزّع/الليفرور)
  let _packagingQtyCache = new Map(); // key -> [{qty,name}] ; key = product_id(int) أو اسم المنتج (string, trimmed) عندما لا يتوفر ID
  let _pkgNameToIdCache = new Map();  // اسم المنتج (trimmed) -> product_id(int) ، لِربط أسطر move_lines التي تصل كـ string فقط
  let _productCategCache = new Map(); // key (نفس مفتاح _packagingQtyCache: id أو اسم) -> اسم Catégorie Article (product.category)
  let _vendeurSearchQuery = '';     // نص بحث "البائع" الحالي (فلترة ذكية تتجاهل الترتيب/المسافات)
  let _clientSearchTags = [];       // قائمة أسماء الزبائن المضافة عبر Enter (فلترة ذكية OR بينها، تتجاهل الترتيب/المسافات)
  let _clientSearchQuery = '';      // نص البحث الحالي أثناء الكتابة (فلترة فورية، قبل تثبيته كـ tag بـ Enter)
  let _reportDateCache = new Map(); // bl_id -> date de livraison reportée (string) | '' si absente
  // فقاعة "Reporté" المستقلة: 0 = بدون فلتر، 1 = عرض فقط المؤجَّلة، 2 = إخفاء المؤجَّلة
  let _reportedOnly = 0;
  async function _loadCreateDates(ids) {
    const missing = [...new Set(ids)].filter(id => !_createDateCache.has(id));
    if (!missing.length) return;
    try {
      const resp = await fetch('/api/web/dataset/call_kw', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call', id: Date.now(),
          params: {
            model: 'stock.picking', method: 'read',
            args: [missing, ['id', 'create_date']], kwargs: {},
          },
        }),
      });
      const json = await resp.json().catch(() => ({}));
      (json?.result || []).forEach(r => _createDateCache.set(r.id, r.create_date || ''));
    } catch (e) {
      console.warn('[DeliveryPlanner] _loadCreateDates failed:', e);
    }
  }

  // Batch-fetch "vendeur" (البائع — من أنشأ الطلبية، ليس الموزّع/الليفرور) pour une
  // liste d'ids stock.picking. Essaie plusieurs noms de champ possibles (le nom réel
  // dépend de la config Odoo) et s'arrête au premier qui renvoie des données réelles.
  const _VENDEUR_FIELDS = ['user_id', 'prevendeur_id', 'vendeur_id'];
  async function _loadVendeurs(ids) {
    const missing = [...new Set(ids)].filter(id => !_vendeurCache.has(id));
    if (!missing.length) return;
    for (const field of _VENDEUR_FIELDS) {
      try {
        const resp = await fetch('/api/web/dataset/call_kw', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: Date.now(),
            params: {
              model: 'stock.picking', method: 'read',
              args: [missing, ['id', field]], kwargs: {},
            },
          }),
        });
        const json = await resp.json().catch(() => ({}));
        const rows = json?.result || [];
        let found = false;
        rows.forEach(r => {
          const v = r[field];
          if (Array.isArray(v) && v[0]) { _vendeurCache.set(r.id, v[1] || ''); found = true; }
        });
        if (found) return; // أول حقل ينجح فعليًا نتوقف عنده
      } catch (e) {
        console.warn('[DeliveryPlanner] _loadVendeurs failed on field ' + field + ':', e);
      }
    }
  }

  // Batch-fetch "Date de livraison reportée" pour une liste d'ids stock.picking —
  // champ non inclus par défaut dans get-deliveries. Le nom exact du champ dépend
  // de la config Odoo ; on essaie plusieurs candidats et on s'arrête au premier
  // qui renvoie des données réelles (même schéma que _loadVendeurs).
  const _REPORT_DATE_FIELDS = ['delayed_date'];
  async function _loadReportDates(ids) {
    const missing = [...new Set(ids)].filter(id => !_reportDateCache.has(id));
    if (!missing.length) return;
    for (const field of _REPORT_DATE_FIELDS) {
      try {
        const resp = await fetch('/api/web/dataset/call_kw', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: Date.now(),
            params: {
              model: 'stock.picking', method: 'read',
              args: [missing, ['id', field]], kwargs: {},
            },
          }),
        });
        const json = await resp.json().catch(() => ({}));
        const rows = json?.result || [];
        let found = false;
        rows.forEach(r => {
          const v = r[field];
          if (v) { _reportDateCache.set(r.id, v); found = true; }
        });
        if (found) {
          // نضبط أيضًا '' لأي id لم يُعثر له على قيمة (حتى لا يُعاد جلبه لاحقًا)
          missing.forEach(id => { if (!_reportDateCache.has(id)) _reportDateCache.set(id, ''); });
          return; // أول حقل ينجح فعليًا نتوقف عنده
        }
      } catch (e) {
        console.warn('[DeliveryPlanner] _loadReportDates failed on field ' + field + ':', e);
      }
    }
    // لم يُعثر على أي حقل صالح: نضبط '' للجميع لتفادي إعادة المحاولة المستمرة
    missing.forEach(id => { if (!_reportDateCache.has(id)) _reportDateCache.set(id, ''); });
  }

  // جلب عدد القطع في الحزمة (CDN) واسمها + Catégorie Article لكل منتج من product.product / product.packaging
  // الكاش يخزّن: Map<key, { qty, name }[]> حيث key = product_id(int) أو اسم المنتج (string trimmed)
  // يستخرج الكود المرجعي (default_code) من بداية النص إن وُجد بصيغة "[CODE] Nom du produit".
  // يُستعمل كمفتاح مطابقة موثوق بدل الاسم الكامل (الذي قد يختلف بتفاصيل بسيطة: صفر بادئة، مسافة، قوس...).
  function _extractDefaultCode(s) {
    const m = String(s || '').match(/^\[([^\]]+)\]/);
    return m ? m[1].trim() : null;
  }

  // productIdsOrNames: مصفوفة قد تحتوي أرقام (id) و/أو strings (اسم المنتج كما يصل من move_lines)
  async function _loadPackagingQtys(productIdsOrNames) {
    const intIds = new Set();
    const names = new Set();
    [...new Set(productIdsOrNames)].forEach(v => {
      if (v === null || v === undefined || v === '') return;
      const s = String(v).trim();
      if (/^\d+$/.test(s) && parseInt(s, 10) > 0) {
        intIds.add(parseInt(s, 10));
      } else if (s) {
        names.add(s);
      }
    });

    const missingIds = [...intIds].filter(id => !_packagingQtyCache.has(id));
    const missingNames = [...names].filter(nm => !_packagingQtyCache.has(nm));
    // ناقص من كاش الفئة (قد يختلف عن ناقص كاش الحزم إن استُدعيت الدالة سابقاً بدون فئة)
    const missingCategIds = [...intIds].filter(id => !_productCategCache.has(id));
    const missingCategNames = [...names].filter(nm => !_productCategCache.has(nm));

    // 1) نحل الأسماء الناقصة إلى product_id حقيقي + نجلب Catégorie Article لكل id/اسم ناقصين.
    //    نعتمد بالأساس على default_code (الكود بين قوسين [XXX]) لأنه تطابق دقيق وموثوق،
    //    ونستعمل display_name كخطة احتياطية فقط للأسماء التي لا تحمل كوداً بين قوسين.
    const needIdsForCateg = [...new Set(missingCategIds)];
    const needNamesForResolve = [...new Set([...missingNames, ...missingCategNames])];
    // خريطة: الكود المستخرج -> مجموعة الأسماء الخام الأصلية التي أنتجت هذا الكود (قد يكون أكثر من صياغة لنفس الكود)
    const codeToRawNames = new Map();
    const namesWithoutCode = [];
    needNamesForResolve.forEach(nm => {
      const code = _extractDefaultCode(nm);
      if (code) {
        if (!codeToRawNames.has(code)) codeToRawNames.set(code, []);
        codeToRawNames.get(code).push(nm);
      } else {
        namesWithoutCode.push(nm);
      }
    });
    const needCodesForResolve = [...codeToRawNames.keys()];

    if (needIdsForCateg.length || needCodesForResolve.length || namesWithoutCode.length) {
      try {
        const domainParts = [];
        if (needIdsForCateg.length) domainParts.push(['id', 'in', needIdsForCateg]);
        if (needCodesForResolve.length) domainParts.push(['default_code', 'in', needCodesForResolve]);
        if (namesWithoutCode.length) domainParts.push(['display_name', 'in', namesWithoutCode]);
        let domain;
        if (domainParts.length === 1) domain = domainParts;
        else domain = [...Array(domainParts.length - 1).fill('|'), ...domainParts];
        const respName = await fetch('/api/web/dataset/call_kw', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: Date.now(),
            params: {
              model: 'product.product', method: 'search_read',
              args: [domain],
              kwargs: { fields: ['id', 'display_name', 'default_code', 'categ_id'], limit: 1000 },
            },
          }),
        });
        const dataName = await respName.json().catch(() => ({}));
        (dataName?.result || []).forEach(r => {
          if (r.id > 0) {
            const categName = Array.isArray(r.categ_id) ? (r.categ_id[1] || '') : '';
            _productCategCache.set(r.id, categName);
            if (!_packagingQtyCache.has(r.id)) missingIds.push(r.id);
            // مطابقة عبر default_code: نربط كل الأسماء الخام (بأي صياغة) التي تحمل نفس الكود بهذا الـ id
            const code = r.default_code ? String(r.default_code).trim() : null;
            if (code && codeToRawNames.has(code)) {
              codeToRawNames.get(code).forEach(rawNm => {
                _pkgNameToIdCache.set(rawNm, r.id);
                _productCategCache.set(rawNm, categName);
              });
            }
            // مطابقة احتياطية عبر display_name (للأسماء بدون كود بين قوسين)
            if (r.display_name) {
              const nm = r.display_name.trim();
              _pkgNameToIdCache.set(nm, r.id);
              _productCategCache.set(nm, categName);
            }
          }
        });
      } catch (e) {
        console.warn('[DeliveryPlanner] _loadPackagingQtys: échec résolution nom/catégorie:', e);
      }
    }
    // أي id/اسم ما زال بدون فئة (منتج غير موجود أو خطأ) → نضبط '' لتفادي إعادة المحاولة المستمرة
    missingCategIds.forEach(id => { if (!_productCategCache.has(id)) _productCategCache.set(id, ''); });
    missingCategNames.forEach(nm => { if (!_productCategCache.has(nm)) _productCategCache.set(nm, ''); });

    const uniqMissingIds = [...new Set(missingIds)].filter(id => id > 0);
    let byProduct = {};
    if (uniqMissingIds.length) {
      try {
        const resp = await fetch('/api/web/dataset/call_kw', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', method: 'call', id: Date.now(),
            params: {
              model: 'product.packaging', method: 'search_read',
              args: [[ ['product_id', 'in', uniqMissingIds] ]],
              kwargs: { fields: ['product_id', 'qty', 'name'], limit: 1000 },
            },
          }),
        });
        const data = await resp.json().catch(() => ({}));
        const rows = data?.result || [];
        // لكل منتج نجمع كل حزمه (قد يكون له carton وfardeau معاً)
        rows.forEach(r => {
          const pid = parseInt(Array.isArray(r.product_id) ? r.product_id[0] : r.product_id, 10);
          if (pid > 0 && r.qty > 0) {
            if (!byProduct[pid]) byProduct[pid] = [];
            byProduct[pid].push({ qty: r.qty, name: (r.name || '').toUpperCase() });
          }
        });
      } catch (e) {
        console.warn('[DeliveryPlanner] _loadPackagingQtys failed:', e);
      }
      uniqMissingIds.forEach(id => {
        if (!_packagingQtyCache.has(id)) _packagingQtyCache.set(id, byProduct[id] || []);
      });
    }

    // 2) نربط كل اسم بمصفوفة حزمه (عبر id الذي حصلنا عليه، أو مصفوفة فارغة إن تعذّر)
    missingNames.forEach(nm => {
      const id = _pkgNameToIdCache.get(nm);
      const arr = (id != null && _packagingQtyCache.get(id)) || [];
      _packagingQtyCache.set(nm, arr);
    });
  }

  // إرجاع اسم Catégorie Article لمفتاح كاش معطى (id رقمي أو اسم منتج)، أو '' إن غير معروفة بعد
  function _productCategName(pkgCacheKey) {
    if (pkgCacheKey === null || pkgCacheKey === undefined) return '';
    return _productCategCache.get(pkgCacheKey) || '';
  }

  // ── Map Marker SVG pin ─────────────────────────────────────
  // Logo "colibri" (hummingbird) utilisé pour la شارة ACILE — remplace l'ancien émoji 🐦.
  const _ACILE_LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAASFElEQVR42t1baZhdVZVd+5w7vPlVqlKVpDKRAIFUAIFAhCYhVR0CSPAjKK8kzeCAgkyNpttu4dN+eY60Yosf2ALabYOCUiUqEWzbqVKINEgwEEwlhMxJDam53nzvPefs/vFeJfloZgMZ9t93h7fX2Xutvfc5F3iFpdpYAsAF6/LLLtvp//bqXd6KC58eTIz/vriDLTATjhJ7FUeYkAY1pWBN4+DFmsn2HLuotjDwI50NvvvwyZHdAJBilu1E+igEYL9zzc+Vllgx97chEGrrAZVXY8bg27ndPXc8vmjmSIpZtgMGRIyjzcZToWVt6bElm5mXrPPKqa2Grxpk/tB2tS21uXzZ+LVpZnGk+vmaf7wpBQYzBdpfqUvKCyCtwbHA5PoDRULOkjG3/YOb/e9evLo7kiEyKa4AdtQAkCEyKUA8+d7k5iCvbrejUgYBzEgBViEXmCAbaCdhf9ydN+mJ5WtHj20n0os72DoqOGA/HzKl2iHWxV62Jk045s8ybDWpom+EECIZBRxhlIy5lvFVnxorLl99RvKZxR1sdbaQOuIjoAJPhdy2XDTHM776hFaGWUijNfNwDigrYfk5TzNZkykR+c25TxYXdbaQOpIi4Q3Jq721Etr/uzjyVJALviYjlmU0a6OBkSzDD4RUJV97vojLqP34os7RBZ0tpMZJ9MhOgVekwrbZECLvPS0j7um66GmAJBFQmyD4gdFaOhJGDQTZ4tlPLanZmmYWGSJz5ANQAUGAyJz26+xcKxReywyXlRYMIksArguwNlrGQtKUvA26P3f20ksmFjIAH851wpvXbyKzuKPDWnd+YmOQ924g15LGQMMwAsUYGGYYFjLIeUpE3Xmoif1nhsgsXgN5dETAAb1AZwup9zye/3erNnp9MFpSUgprLMeQEqivFTDGKDsZsryh/M1/Oi9+9+FcNr/1pqbKB/0b1tDIgrN+L2KhRSZf0iVfyEKRUZMAElEwC2lIIuBS+fRnzk9sPFz5QLyeo4s72Frc0WGl2lgizQJgAhG3bwB3Zpo1yuoyVfB2wglJgtGCgGyWUSwRsdKAsEMa8rtgpq520FERAePy1l8P6mwhNeeh4VPsROwPzIjnxnxmCEEETKwVkMRKJkJWMFq87s8XRe87HFOBXm3lQcQLnxibYznRpaXBoV5h06Ax9q4ZuZrd7a37HTjul+xuuYi8OT8aWSJj0V+VCiwCTwFEwraA2glkyLJglB62LO/EZ59MjGDV4aUKrw7AKtDi5lwtW84jziT33NKeIrTvedC8gyGeZkGPe+WR37xw6azR8dtO+PFoStuxtlI+MDCKDATFIoRYBErEw1Ywmrtz/fLEp1NtLA8E8fBMgWoUAMDfdJYfsmLuCn+kaIikAFkwSkOXiz2G+cfsBd9Z1zppCwDM/sHYhwMZ/S/t+QZGE0hQTYLYCUk2zD5Kpab1qZodWAVC5vAgRPGaPQAzgZmeWhz6O3+k9B0ZjwhtKFCeF6hyURuNRunGVpa1/Xz93QPfaLhz66RtVyXv17nsR0g6AiSZleFcDqQ8ZUTIDRlh3QoiTs17twix4sPbU4FqBKSZxdPnRW7whku3wXJsFrbN0gULh/1cTsEPopYTW0kysbb+33Zf1XNd7f2mkL8SMiSIpAk8zcUCS53zmMm+cu5PijPbW2EqqvIOWZpF5fn0hnzzht1ghsCpNpZr3xf5apDLXaYNxmCFK1WgHbFkKMRcGFYc6GnSST5Qf0fvD3qvr3nQFHJXww1LkNDFAsMrKS3Cbpg9dTNAvLgZBx+ANpZgrqRXhkzjT8fqpv98Z2NTus35q2VwvAKc+9DQPDsavV+E3PlqrGhIEHJZFoWRvIFfYhGplcYvrC/1bloSmz3/gyIZv0dni4Fts4zX2GQCNeyMDR7/4g0zRw7kmrcf5UxYA4kDZhAzVudPJ1JzpNG7hc0vbnlfXe613vOWcnEchJnp7aHYSZO+RlboZtYGfrGksmNkceDDFLKKnKjFRg94vZvOic4543KKR7+gx3IqEgFFJsalPzJ2/ZaP1tzzpoYn6bQAmqvR0gwABhlipJkwD4RxRWljOSvsXQpjFhF4kxRY/fL7o93vRCksUC1pT/xBfhlL+04Zdo7L9eVRKrIWBKlzI5ogJAuZVwO7msNzTr4R4chHUcx5ifqoa4r557Z8NHHmgVzzGlWXRHvr60rmcW3Z+iDiXEOgJazNOpa4Z9fF4W2vVLODA0CaRWoeqL8e1F2C3HIReY137amLxGv/BRA3FkquDPJZAxC4mGUEShoSOZMfusSdfeIXYIUWupxTbsyVpphdsO2T9WvRxhKvVhekWSBDJnlT2yw7MeUSGYtNk9FYH4M6em857rkZD47ORzjy9yS4GWTWIAi+uvOyxKZ9XJB6c+P6gyZHx39/5FSv7N5e9sMXGMNgL6+5nGP4gWW06hMSN8jJ0+8i1lPidWGh87lv7vhkYuXiNFudmVekQXXlkx+5/2OypuFbVu2UmIjGISIxgH0j4hO6ybGmwaLHTRB8rvvy2Atv1fG3CgDNv7c7TDbXqcDMVmxNZyPjQaACNjScHaU9e9dsWo/OlnLjXcWzyyV8WVjhFlYaJjvgQweOKWY3yNoJ94nkxG+EHJIWSjsiexMndmUQVF/BBzof/8DdF1kTpzxOoTBEKKooGmc5YSLZU6ZbJIPf+P35L/V9svaJt+v4mwcgzQJd7XTm8uZb2Ip+BU7EDQoBVDmADgx0oJDtzyE/7A8JIf6sy/7DtvY75JxZ85nlKuGEm/Rwn0HgC50b/LU9c9YOKzbh2pDlweji4j031T5xQBoQwMBZK0OJ2adskMn6Y0QsYWTNRLIapglyXG3Xymt2fLFrEI7VjGPDn8cxxyhk3v4U+o21OEMGbSnz7Ob6O1nReX6+3K485RkRgVIM5Rvfch0lrFAdRHipjNR8T0n7L+WXdp3nbd/1j6ZY/ApF6jyEJkC4yfPV9i2uzueeMa4L0uJiAMCG6kKkWQLEk6/43MXRlhWz3HnnGOe402FNmyuYRb8UYwt23PbCCCbPeQxR+yXcP6uMNWvehZEYESND5rkrIk+uvyrcGpTLC1SxdKdWopvtWkfGJllOvAYGdmAMlyGcEIWS18ILHit1bZzk92z/LJzwM5ScBmOsq/yenc97Y35JB3wx0mmBVaiQYBcYAIyRV0O4zAbK+EYGfT271bb15+z6+mCeZk59lPy+Mrj8PxVlXPNX9RT0liWwOh8EgNn/PJwsJ8QFrMUHjOLmsheapI0DGAP2cmAvDzYMk+vrZ1V+OHzCKQ0gO6V2r++zpk1fF26YvEyUhk7oua1h83gaNNy6fpJ2I1sICMGyLWh/l5fPnZf7+ukvi2Wbfg+noQXewA5T6JmLzpYywLSPP96GvbUNjPGRVlUO21tpDEAbgLZp6dFaBf/UoFw622icAea5sGIziZyQcOoauDR6c2n9c8/aU6c9KBpOuDTYtWmSHYsPSbIuBLB55oYd9k6wUfqFi0mLCEMLqNJuUmNLc19/78tOanOT8WghKM9sIVtx/gDyfFcAOIAX2sfZt6rhezI1w8zoOL71ly/mvdjPgnC4wViJKYETnx3I8ElsJ07ihlPP9Pp3NlnZ7NMympzr9XSPhaZOPxMAdjYeowFiDtZeTdGY4HzfX1Q5uzx718KtSLMwG3c0U9ixocuAxWpft3dIABi3VtKn3vpEvXZntCrD7z/x1uA9qj5oUENGSF1mxx/MxXLd/SLwewBs9Nya9YXI1Oklr3xsMFLodWIiofLZqVPu5UjvdVSsueHJS+DUnqtH9nyfR3auzN5/6Shu3uwiQ564cs9ZYAOQAWk+aBOltwdAtZVtivZc48voHYgkE8oDghKgIwaIaOSzhlhTgiASks1xMijBLvYjNry1FBNyqMzWjGKJy54lZjj1Uxqilz9a0gpXWOXeC0cf8v+IgeWFSjUIHwCEYzVxUKz+gcAcWgAyZAAmfMPq8IR7iRoea1Q+ZhiFBu3pJFi4tq2051Mu8DFgQHsNOWNwGwzc+nC4OJCM+0PxCeVSfbG7fFzRLzaGIvzi0H0LW7Gkt1mcWbrUPI4fonmNAFrUhGu3JstCHkNaAYIAoFRZCBAyOFQpQNz1D9gCYMtbvbO0z4OKDDEAzF9r0+W5jCwMXqkCdRoIQKqZAcCzYrOk69aZwCiCtJj13qps0qGJgAN78XaIfYXMPqsWJ2uaKx3seK1yysuVbbK75njjV4av6J/i29YHyVg3SyXmQI0uVL86LYtUm0RTigAmERo4Q0Tj4CIrAlus9ToAQNOaQwxApfZ+/Qlv53hnJww6K+wdv3FPHctEszb8AePrpQ7F60VhFCa7/erify/4I1Is0U4aqUplKOz+ZcJmsGTJ3hiT4F9U5wPm0ALw5nZSJDIVqUzc8vIFHGq4ilksgZaT7YAhoMDZrd26lLux+NiCR/c5n2aBVTB1qwYaNZylpPNauK6tS4OrC98/9y8HPvfwBaDa2dXctHYRu8kvU2TiIhIRUD4LUcyDC/lho/mHHo/+a+nnC3v2OQ8Avc9J0BkBrxr8tIwlolwY0ewN5STo0wATmsCHTgXe7ICylXTNzU/fCDd8pxWKWZbywSMbA1a8zhjRbgQeHnng5N37wao6n2YLGQpqvtx3CjmRG4h8cJCVnO+5MvvA8m2V1W/Vhy8AqTaJVtKJm363QkZid1v5PESpvA2wHjSq/HD/9967Yf+1LNEO8wrnVTK9rsYOxx4U8XBEj46W9dDWq3MPLF/9mhOkw8bSaQEwhT/zZGPdTb8LJn949diUFY/cVveZjfFx3XMv71qK89YmK6Xs+MYFE6qHq5Kf3Tmh4e78nxp/xDzp28Xna7+0dUHl2R0HfcEOfgR0zSOATHTw4XtsnzbwyMCK3l/euBFIi5rbcjf5ewev93qHxjBh2yJgfqWZqc7/0AI15d7sQlj2I5BWwozm0qJ/8x3DmTOK1ZU/zI/fpdMCABquuO+sSal72qdNS4UBoOHzfUtr08X10eu2DVjL/hSIC55fWZ2z71uAyf+RrZ/6QOGOqT8s72x8oPTNqd/aPe2Vpfc7YQc3AjKrGMgQF4rWRHvkiq497f7U20e+6Ivk5/zdu17w+wb6QXZATmRzRcabUZ/aG3Pj7jnG4H0g7CCnfFp3a83wfiKFeSc3Ug9yChAjnRYDmU89OXAt2zO/tbItcBMpb8dQR7BzR0LEGkN6dFSLmqm9VRYzMqzDrGlbz8cSn9q/4h0WsMa8G2R3cAGolMaEdLN1bGPuZ4GVWFbsLmxTW9dvEBPn3GRyg+2w3OUUiuTHb+m7pnEAwMA+x1c1a9C7l+sHNbdS7RBoJX3CjNO+Q5H4ssKAz1wcbmNjXYJQeIQLgyURabA58CMHoLZ/CzvTot7t0yMHDYDxkx8nPTh6hV2T/Hh+yNdsvK5g19asmNw0nSz3JSifEJ4AmNLx1Z7pTW1hH/4AMFN7CubMn+6pc8LON4sjJa3IkUKaNmhxlojWMREPGGKfhA1An3O4CNdBAWDxGkgQsR1K3iJj4fr8WAAERc+MDD+NUPgsEIjBOQJGwGUQeBGQFuiEPvIBYKbOFlJNbXtj0pafyA95bJyYJKGfUgO7R2Uk2VCJclOyKdgIlYdhzMX7V8zcVwQdyQCkqs+YVBf7WycRnlwsBL5wBciSD4ctEZHRRGXsY4yJ2/0dITkEJxYLOdFk08Ga6hxSAPrXVBywHLrQAAyQxaWikm7kERGPJt2IBAgg0t7eX1y73bHzzyWnuSY52Z5dmeoc4QB0NlfyWNp0einPFKqJStfyf917HQ0Kx1KOaxCJEwSZboBJmvLtjsXCjlpTj3wSrJ7ASD21Kwyi6UHZQJJGNIo7AMCxg92CAu2GGbGk6AKI+7537k+Q2/JsKKSajhoVQKI2CUYUIQmhyh0vfWRCB9IsDLKbpY0+i8oQKHWNFz4uylfbVNxTbYXNkQvAqkr+OpospdmGNpDSfB4AmubB2plpKdsW1krhj+zpmr59/LbNXz1lkwyy/wQGDvWJ0b8yAlYBAEIxE8AORUyx+OgLlyX+mGpjWb+hsm0tbFptO3ot2klXTppXTqF2ZU7KH/mf3FZr+BXdPLH5D+U9p/5k7PjqEVsxPumZf2/3xJPv6Tn3//f1R8UX6BUnzn9qtLa5M/ehykzkyPqO+P8AoYd8e4ia2DMAAAAASUVORK5CYII=';

  // يولّد لون أفتح وأغمق من اللون الأساسي لبناء تدرّج (gradient) بسيط للدبوس.
  function _shadeColor(hex, percent) {
    const c = String(hex || '#3B82F6').replace('#', '');
    const num = parseInt(c.length === 3 ? c.split('').map(ch => ch + ch).join('') : c, 16);
    let r = (num >> 16) + Math.round(255 * percent);
    let g = ((num >> 8) & 0x00FF) + Math.round(255 * percent);
    let b = (num & 0x0000FF) + Math.round(255 * percent);
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  // مسار الدبوس (نمط مسطّح ذو نصفين: يمين فاتح / يسار داكن) + دائرة بيضاء تحمل المحتوى + ظل بيضاوي أسفله.
  const _PIN_PATH = 'M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50s19-16 19-29.5C43 10.5 35 2 24 2z';
  const _PIN_PATH_LEFT_HALF = 'M24 2C13 2 5 10.5 5 20.5 5 34 24 50 24 50V2z';

  function _pinSvg(color, selected, letter, badgeAcile, badgeBtoB, badgeReported, badgeAssigned) {
    const lightColor = _shadeColor(color, 0.24);
    const inner = selected
      ? `<path d="M18.5 20.5l3.5 3.5 7-7" stroke="${color}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      : letter
        ? `<text x="24" y="20" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="14" font-weight="700" font-family="sans-serif">${letter}</text>`
        : '';
    // قناع (mask) يقصّ شريطاً قطرياً (45°) من الدائرة البيضاء الداخلية فقط (وليس من الحرف)
    // عندما لا يكون الدبوس مُسنَداً لأي جولة — يُظهر لون الدبوس عبر الفتحة القطرية بدل رسم خط أحمر.
    // الحرف (inner) يُرسم لاحقاً فوق الدائرة فلا يتأثر بالقص ويبقى ظاهراً بالكامل.
    const notAssignedMaskId = 'noAssignCut' + Math.random().toString(36).slice(2, 9);
    const notAssignedMaskDef = (!badgeAssigned && !selected)
      ? `<mask id="${notAssignedMaskId}">
           <rect x="0" y="0" width="48" height="56" fill="#fff"/>
           <rect x="8" y="18.8" width="32" height="2.4" fill="#000" transform="rotate(-45 24 20)"/>
         </mask>`
      : '';
    const circleMaskAttr = (!badgeAssigned && !selected) ? ` mask="url(#${notAssignedMaskId})"` : '';
    // كل الأوسمة (ACILE / BtoB / Reporté) أصبحت بنفس الحجم (r=8) وتظهر جميعها في يمين الدبوس
    // (نفس موضع ACILE سابقاً). عند تكرار أكثر من وسم على نفس الدبوس، يتم إزاحة كل وسم لاحق
    // للأسفل (بمسافة 17) ليظهر الجميع معاً دون تداخل.
    const _badgeSlots = [badgeAcile, badgeBtoB, badgeReported];
    let _badgeSlotIdx = 0;
    const _nextBadgeCy = () => 12 + (_badgeSlotIdx++) * 17;

    // شارة عند وجود "ACILE" في Document d'origine (شعار الطائر الطنّان).
    let acileSvg = '';
    if (badgeAcile) {
      const cy = _nextBadgeCy();
      acileSvg = `<circle cx="38" cy="${cy}" r="8" fill="${color}" stroke="#fff" stroke-width="1.5"/>
         <clipPath id="acileClip"><circle cx="38" cy="${cy}" r="6.5"/></clipPath>
         <image href="data:image/png;base64,${_ACILE_LOGO_B64}" x="31.5" y="${cy - 6.5}" width="13" height="13" clip-path="url(#acileClip)" preserveAspectRatio="xMidYMid meet"/>`;
    }
    // شارة عند وجود "BtoB" في Liste de prix (حرف B)
    let btobSvg = '';
    if (badgeBtoB) {
      const cy = _nextBadgeCy();
      btobSvg = `<circle cx="38" cy="${cy}" r="8" fill="${color}" stroke="#fff" stroke-width="1.5"/>
         <text x="38" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="11" font-weight="800" font-family="sans-serif">B</text>`;
    }
    // شارة عند وجود "Date de livraison reportée" (ساعة رملية SVG)
    let reportedSvg = '';
    if (badgeReported) {
      const cy = _nextBadgeCy();
      reportedSvg = `<circle cx="38" cy="${cy}" r="8" fill="${color}" stroke="#fff" stroke-width="1.5"/>
         <path d="M34.5 ${cy - 2.5}h7M34.5 ${cy + 2.5}h7M34.5 ${cy - 2.5}c0 1.7 1.1 2.2 2.5 3-1.4 0.8-2.5 1.3-2.5 3M41.5 ${cy - 2.5}c0 1.7-1.1 2.2-2.5 3 1.4 0.8 2.5 1.3 2.5 3"
           stroke="#fff" stroke-width="0.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    // شارة الإسناد (✓ الخضراء) أُزيلت — حالة الإسناد تُعرَض الآن فقط عبر قصّ الدائرة الداخلية أعلاه.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 56" width="48" height="56">
      <defs>${notAssignedMaskDef}</defs>
      <ellipse cx="24" cy="52" rx="10" ry="3" fill="#000" opacity="0.15"/>
      <path d="${_PIN_PATH}" fill="${color}" stroke="${selected ? '#fff' : 'none'}" stroke-width="${selected ? 2 : 0}"/>
      <path d="${_PIN_PATH_LEFT_HALF}" fill="${lightColor}"/>
      <circle cx="24" cy="20" r="12" fill="#fff"${circleMaskAttr}/>
      ${inner}
      ${acileSvg}
      ${btobSvg}
      ${reportedSvg}
    </svg>`;
  }

  function _makeMarkerIcon(color, selected, letter, badgeAcile, badgeBtoB, badgeReported, badgeAssigned) {
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(_pinSvg(color, selected, letter, badgeAcile, badgeBtoB, badgeReported, badgeAssigned)),
      scaledSize: new google.maps.Size(48, 56),
      anchor: new google.maps.Point(24, 50),
    };
  }

  // ── Map: add or refresh a marker ──────────────────────────
  function _upsertMarker(bl, isAssigned) {
    if (!_map) return;
    const lat = bl?.partner_shipping_id?.latitude;
    const lng = bl?.partner_shipping_id?.longitude;
    if (!lat || !lng) return;

    const color = _blColor(bl);
    const selected = _selectedBLIds.has(bl.id);
    const cat = _blCategory(bl);
    const letter = _categoryLetter(cat);
    const badge = _hasAcileBadge(bl);
    const badgeB = _hasBtoBBadge(bl);
    const badgeR = _hasReportedBadge(bl);

    if (_markers.has(bl.id)) {
      const m = _markers.get(bl.id);
      m.setIcon(_makeMarkerIcon(color, selected, letter, badge, badgeB, badgeR, isAssigned));
      m.setPosition({ lat, lng });
      m._isAssigned = isAssigned;
      return;
    }

    const marker = new google.maps.Marker({
      position: { lat, lng },
      map: _map,
      icon: _makeMarkerIcon(color, selected, letter, badge, badgeB, badgeR, isAssigned),
      title: bl.partner_shipping_id?.name || bl.name,
      zIndex: selected ? 10 : (isAssigned ? 5 : 1),
    });
    marker._blId = bl.id;
    marker._isAssigned = isAssigned;

    marker.addListener('click', (e) => {
      // نقرة عادية على أي BL = تبديل تحديده (يُضاف/يُزال من التحديد الحالي)
      _toggleBLSelection(bl.id);

      if (_infoWindow) _infoWindow.close();
      const iw = new google.maps.InfoWindow({ content: _buildInfoWindowContent(bl, isAssigned) });
      iw.open(_map, marker);
      _infoWindow = iw;
    });

    _markers.set(bl.id, marker);
  }

  function _removeMarker(blId) {
    if (_markers.has(blId)) {
      _markers.get(blId).setMap(null);
      _markers.delete(blId);
    }
  }

  function _refreshMarkerIcon(blId) {
    const m = _markers.get(blId);
    if (!m) return;
    const bl = _unassignedBLs.get(blId) || _assignedBLs.get(blId) || _routeAssignedBLs.get(blId);
    if (!bl) return;
    const isAssigned = _isInTournee(bl);
    const color = _blColor(bl);
    const selected = _selectedBLIds.has(blId);
    const cat = _blCategory(bl);
    const letter = _categoryLetter(cat);
    m.setIcon(_makeMarkerIcon(color, selected, letter, _hasAcileBadge(bl), _hasBtoBBadge(bl), _hasReportedBadge(bl), isAssigned));
    m.setZIndex(selected ? 10 : (isAssigned ? 5 : 1));
  }

  function _buildInfoWindowContent(bl, isAssigned) {
    const ship = bl.partner_shipping_id || {};
    const cat = _blCategory(bl);
    const catColor = (bl?.partner_shipping_id?.partner_custom_attribute_1 || [])[1] || '#94A3B8';
    return `<div style="font-family:sans-serif;font-size:12px;min-width:180px;max-width:240px">
      <div style="font-weight:700;color:#0F172A;margin-bottom:4px">${escHtml(bl.name || '—')}</div>
      <div style="color:#475569;margin-bottom:2px">${escHtml(ship.name || '—')}</div>
      ${ship.street ? `<div style="color:#94A3B8;font-size:11px">${escHtml(ship.street)}</div>` : ''}
      ${ship.city ? `<div style="color:#94A3B8;font-size:11px">${escHtml(ship.city)}</div>` : ''}
      ${cat ? `<span style="display:inline-block;margin-top:4px;padding:2px 6px;border-radius:9px;font-size:10px;font-weight:700;background:${catColor}22;color:${catColor};border:1px solid ${catColor}44">${escHtml(cat)}</span>` : ''}
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid #E2E8F0">
        <span style="color:#475569">Total:</span> <b>${_fmtNum(bl.amount_total, 2)} DA</b>
      </div>
      ${bl.scheduled_date ? `<div style="color:#94A3B8;font-size:11px;margin-top:2px">Prévu: ${_fmtDate(bl.scheduled_date)}</div>` : ''}
      ${isAssigned ? '<div style="margin-top:4px;color:#16A34A;font-size:11px;font-weight:600">✓ Affecté</div>' : ''}
    </div>`;
  }

  // ── Main: open the delivery map view ──────────────────────
  async function show() {
    const viewEl = document.getElementById('deliveryMapView');
    if (!viewEl) return;
    // Preserve the map instance across opens to avoid reloading tiles
    const _savedMap = _map;
    // Clear and reset
    _selectedActorId = null;
    _selectedBLIds = new Set();
    _unassignedBLs = new Map();
    _assignedBLs = new Map();
    _markers = new Map();
    _actors = [];
    _filterTab = 'all';
    _creationFilters = new Set();
    // Restore stable caches from localStorage (skips re-fetching on reopen)
    _createDateCache = new Map();    _lsRestoreMap(_createDateCache,    'createDateCache');
    _packagingQtyCache = new Map();  _lsRestoreMap(_packagingQtyCache,  'packagingQtyCache');
    _pkgNameToIdCache = new Map();   _lsRestoreMap(_pkgNameToIdCache,   'pkgNameToIdCache');
    _productCategCache = new Map();  _lsRestoreMap(_productCategCache,  'productCategCache');
    _vendeurCache = new Map();       _lsRestoreMap(_vendeurCache,       'vendeurCache');
    _vendeurSearchQuery = '';
    _clientSearchTags = [];
    _clientSearchQuery = '';
    _reportDateCache = new Map();    _lsRestoreMap(_reportDateCache,    'reportDateCache');
    _lsRestoreMap(_pricelistCache,  'pricelistCache');
    _reportedOnly = 0;
    _actorFilterTab = 'all';
    _actorSearchQuery = '';
    // Restore map instance (don't null it — keeps tiles alive)
    _map = _savedMap;
    _infoWindow = null;
    _drawingManager = null;
    _pixelHelperOv = null;
    _selectionPolygon = null;

    viewEl.innerHTML = _buildLayout();
    _attachHeaderEvents(viewEl);
    await _initialize(viewEl);
  }

  function _buildLayout() {
    return `
<div id="dmRoot" style="display:flex;flex-direction:column;height:100%;background:var(--bg,#F8FAFC);font-family:sans-serif">

  <!-- Top toolbar -->
  <div id="dmToolbar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--bg2,#fff);border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0;flex-wrap:wrap">
    <div style="font-size:13px;font-weight:800;color:var(--text,#0F172A);letter-spacing:-.02em;flex-shrink:0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="vertical-align:-2px;margin-right:4px"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
      Dispatch Planning
    </div>
    <div class="dm-fgroup" id="dmDateGroup">
      <button class="dm-fgroup-trigger" id="dmDateTrigger" type="button">📅 Date</button>
      <div id="dmDateTabs" class="dm-fgroup-pop"></div>
    </div>
    <div class="dm-fgroup" id="dmCreationGroup">
      <button class="dm-fgroup-trigger" id="dmCreationTrigger" type="button">🕒 Création</button>
      <div id="dmCreationTabs" class="dm-fgroup-pop">
        <button class="dm-ctab dm-ftab--active" data-creation="all" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);cursor:pointer;transition:all .15s">Tous</button>
        <button class="dm-ctab" data-creation="today" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer;transition:all .15s">Aujourd'hui</button>
        <button class="dm-ctab" data-creation="yesterday" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer;transition:all .15s">Hier</button>
        <button class="dm-ctab" data-creation="week" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer;transition:all .15s">Cette semaine</button>
        <button class="dm-ctab" data-creation="older" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer;transition:all .15s">Plus ancien</button>
      </div>
    </div>
    <button class="dm-fgroup-trigger" id="dmReportedTrigger" type="button" title="Date de livraison reportée">⏳ Reporté</button>
    <div style="flex:1"></div>

    <!-- Draft mode switch + apply/cancel -->
    <div id="dmDraftBar" style="display:flex;align-items:center;gap:8px">
      <div id="dmPendingBadge" style="display:none;align-items:center;gap:6px">
        <span id="dmPendingCount" style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#FFF7ED;color:#C2410C;border:1px solid #FED7AA"></span>
        <button id="dmBtnCancelDraft" title="Annuler les modifications en attente" style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">Annuler</button>
        <button id="dmBtnApplyDraft" title="Appliquer les modifications en attente" style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;border:none;background:#16A34A;color:#fff;cursor:pointer">Appliquer</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;background:var(--bg3,#F1F5F9);border-radius:20px;padding:3px 8px">
        <span style="font-size:10.5px;font-weight:700;color:var(--text2,#475569)">Instantané</span>
        <label style="position:relative;display:inline-block;width:32px;height:18px;cursor:pointer">
          <input type="checkbox" id="dmDraftSwitch" ${_draftMode ? 'checked' : ''} style="opacity:0;width:0;height:0">
          <span id="dmDraftTrack" style="position:absolute;inset:0;background:${_draftMode ? '#3B82F6' : '#CBD5E1'};border-radius:20px;transition:.15s"></span>
          <span id="dmDraftKnob" style="position:absolute;height:14px;width:14px;left:${_draftMode ? '16px' : '2px'};top:2px;background:#fff;border-radius:50%;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.25)"></span>
        </label>
        <span style="font-size:10.5px;font-weight:700;color:var(--text2,#475569)">Brouillon</span>
      </div>
    </div>

    <div style="display:flex;gap:6px;align-items:center">
      <input id="dmVendeurSearch" type="text" placeholder="🔍 Vendeur…" title="Séparez plusieurs vendeurs par + ou &amp; (ex: ali + omar)" value="${escHtml(_vendeurSearchQuery)}"
        style="width:130px;font-size:10.5px;padding:4px 9px;border-radius:20px;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);outline:none">
      <div style="position:relative;display:inline-flex;align-items:center">
        <input id="dmClientSearch" type="text" placeholder="Client…" title="La recherche filtre instantanément. Appuyez sur Entrée pour épingler un nom (plusieurs noms possibles, double-clic sur le badge pour réinitialiser)"
          style="width:130px;font-size:10.5px;padding:4px 9px 4px 24px;border-radius:20px;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);outline:none">
        <div class="dm-fgroup" id="dmClientGroup" style="position:absolute;left:7px;top:50%;transform:translateY(-50%);line-height:0;display:flex;align-items:center;z-index:20">
          <span id="dmClientIcon" style="font-size:11px;pointer-events:none">🔍</span>
          <button class="dm-fgroup-trigger" id="dmClientTrigger" type="button" title="Double-clic pour réinitialiser" style="display:none;padding:1px 6px;font-size:9px;border-radius:10px;line-height:1.4;white-space:nowrap">👥 0</button>
          <div id="dmClientTags" class="dm-fgroup-pop" style="left:0;top:100%;margin-top:8px"></div>
        </div>
      </div>
      <div class="dm-fgroup" id="dmFilterGroup">
        <button class="dm-fgroup-trigger dm-fgroup-trigger--active" id="dmFilterTrigger" type="button">Tous</button>
        <div id="dmFilterTabs" class="dm-fgroup-pop">
          <button class="dm-ftab dm-ftab--active" data-tab="all" style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);cursor:pointer">Tous</button>
          <button class="dm-ftab" data-tab="unassigned" style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">Non affectés</button>
          <button class="dm-ftab" data-tab="assigned" style="padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">Affectés</button>
        </div>
      </div>
      <span id="dmBLCount" style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;background:#EFF6FF;color:#3B82F6;border:1px solid #BFDBFE"></span>
      <button id="dmBtnRefresh" type="button" title="Actualiser les BL" style="background:var(--bg3,#F1F5F9);border:1.5px solid var(--border,#E2E8F0);border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2,#475569);flex-shrink:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      </button>
      <button id="dmBtnFullscreen" type="button" title="Plein écran" style="background:var(--bg3,#F1F5F9);border:1.5px solid var(--border,#E2E8F0);border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2,#475569);flex-shrink:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <button id="dmBtnMaximize" type="button" title="Agrandir dans la fenêtre" style="background:var(--bg3,#F1F5F9);border:1.5px solid var(--border,#E2E8F0);border-radius:6px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text2,#475569);flex-shrink:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>
      </button>
    </div>
  </div>

  <!-- Body: sidebar + map -->
  <div id="dmBody" style="display:flex;flex:1;min-height:0;position:relative">

    <!-- Left sidebar: livreurs -->
    <div id="dmSidebar" style="width:112px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--border,#E2E8F0);background:var(--bg2,#fff)">
      <div style="padding:4px 6px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--border,#E2E8F0)">
        <input id="dmActorSearch" type="text" placeholder="Rechercher…" value="${escHtml(_actorSearchQuery)}"
          style="width:100%;min-width:0;font-size:10px;padding:3px 7px;border-radius:12px;border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);outline:none;box-sizing:border-box">
      </div>
      <div id="dmActorsList" style="flex:1;overflow-y:auto;padding:4px 6px;display:flex;flex-direction:column;align-items:center;gap:4px"></div>
    </div>

    <!-- Map area -->
    <div style="flex:1;position:relative;min-width:0">
      <div id="dmProgressBar" class="dm-progress-bar" style="display:none">
        <div id="dmProgressBarFill" class="dm-progress-bar-fill"></div>
      </div>
      <div id="dmMapLoading" style="position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:var(--bg,#F8FAFC)">
        <div style="text-align:center;color:var(--text3,#94A3B8)">
          <div class="spinner" style="margin:0 auto 8px"></div>
          <div style="font-size:12px">Chargement de la carte…</div>
        </div>
      </div>
      <div id="dmMapEl" style="width:100%;height:100%"></div>
      <div id="dmSelectRect" style="display:none;position:absolute;z-index:6;border:2px solid #3B82F6;background:rgba(59,130,246,.15);pointer-events:none"></div>

      <!-- Map controls overlay -->
      <div id="dmMapControls" style="position:absolute;top:10px;right:10px;z-index:4;display:flex;flex-direction:column;gap:6px">
        <button id="dmBtnTouchSelect" title="Mode sélection multiple (tactile) — activer/désactiver" style="${_btnStyle('#fff')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
        </button>
        <button id="dmBtnDraw" title="Sélection par zone" style="${_btnStyle('#fff')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 12 3 21 12 21 21 21 21 12 12 3 3 12"/></svg>
        </button>
        <button id="dmBtnClearSel" title="Effacer la sélection" style="${_btnStyle('#fff')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button id="dmBtnFitMap" title="Centrer la carte" style="${_btnStyle('#fff')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        </button>
      </div>

      <!-- Undo toast -->
      <div id="dmUndoToast" style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%);z-index:10;display:none;align-items:center;gap:10px;background:#1E293B;color:#fff;border-radius:8px;padding:10px 16px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.3)">
        <span id="dmUndoMsg"></span>
        <button id="dmUndoBtn" style="background:#3B82F6;border:none;color:#fff;border-radius:5px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">Annuler</button>
        <button id="dmUndoDismiss" style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">×</button>
      </div>
    </div>

    <!-- Floating actor modal (shown when actor selected), draggable + resizable, constrained to the whole app area -->
    <div id="dmConsolide" style="position:absolute;width:340px;display:none;flex-direction:column;background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);z-index:7;overflow:hidden">
      <div id="dmConsolideInner" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0"></div>
      ${_resizeHandleHtml('dmConsolideResize')}
    </div>

    <!-- Floating selection modal — only visible when 1+ BL is selected, lists only the selected BLs -->
    <div id="dmSelModal" style="position:absolute;width:360px;display:none;flex-direction:column;background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);z-index:8;overflow:hidden">
      <div id="dmSelModalInner" style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0"></div>
      ${_resizeHandleHtml('dmSelModalResize')}
    </div>
  </div>
</div>
<style>
#dmRoot .dm-actor-bubble { width:92px;min-height:52px;padding:5px 6px;border-radius:14px;cursor:pointer;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);transition:all .15s;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;box-sizing:border-box;gap:2px }
#dmRoot .dm-actor-bubble:hover { background:var(--bg,#F8FAFC);border-color:#CBD5E1 }
#dmRoot .dm-actor-bubble--active { background:#EFF6FF !important;border-color:#3B82F6 !important }
#dmRoot #dmBtnFullscreen:hover, #dmRoot #dmBtnMaximize:hover, #dmRoot #dmBtnRefresh:hover { background:var(--bg,#F8FAFC);border-color:#CBD5E1 }
#dmRoot #dmBtnRefresh:disabled { opacity:.6;cursor:default }
#dmRoot .dm-spin svg, #dmRoot svg.dm-spin { animation: dm-spin-rotate .8s linear infinite }
#dmRoot { position:relative }
#dmRoot.dm-frozen #dmToolbar, #dmRoot.dm-frozen #dmSidebar, #dmRoot.dm-frozen .dm-actor-bubble, #dmRoot.dm-frozen #dmConsolide { pointer-events:none;opacity:.75 }
#dmBusyOverlay { pointer-events:auto }
@keyframes dm-spin-rotate { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
#dmRoot:fullscreen { width:100%;height:100% }
#dmRoot.dm-app-maximized { position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;z-index:99999 !important }
#dmRoot .dm-actor-bubble-name { font-size:12px;font-weight:700;color:var(--text,#0F172A);line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word }
#dmRoot .dm-actor-bubble-freq { width:100%;height:13px;font-size:10px;font-weight:700;color:#16A34A;white-space:nowrap;overflow:hidden }
#dmRoot .dm-ftab { transition:all .15s }
#dmRoot .dm-ftab--active { background:#EFF6FF !important;border-color:#3B82F6 !important;color:#1D4ED8 !important }
#dmRoot .dm-fgroup { position:relative }
#dmRoot .dm-fgroup-trigger { display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text,#0F172A);cursor:pointer;white-space:nowrap;transition:all .15s }
#dmRoot .dm-fgroup-trigger--active { background:#EFF6FF;border-color:#3B82F6;color:#1D4ED8 }
    #dmRoot .dm-fgroup-trigger--exclude { background:#FEF2F2;border-color:#EF4444;color:#B91C1C }
#dmRoot .dm-fgroup-pop { display:none;position:absolute;top:100%;left:0;margin-top:4px;padding:6px;background:var(--bg2,#fff);border:1px solid var(--border,#E2E8F0);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.12);gap:4px;flex-wrap:wrap;z-index:9999;min-width:max-content;max-width:calc(100vw - 24px) }
#dmRoot .dm-fgroup-pop.dm-open { display:flex }
/* pont invisible entre la bulle et le popup pour agrandir la zone de survol et éviter la fermeture accidentelle */
#dmRoot .dm-fgroup-pop::before { content:'';position:absolute;left:-12px;right:-12px;top:-14px;height:14px }
#dmRoot .dm-fgroup-pop { padding-top:10px }
#dmRoot .dm-table { width:100%;border-collapse:collapse;font-size:11px }
#dmRoot .dm-table th { padding:5px 6px;text-align:left;font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border,#E2E8F0);white-space:nowrap }
#dmRoot .dm-table td { padding:5px 6px;border-bottom:1px solid var(--border,#E2E8F0);vertical-align:middle;color:var(--text,#0F172A) }
#dmRoot .dm-table tr:last-child td { border-bottom:none }
#dmRoot .dm-table tr:hover td { background:var(--bg3,#F1F5F9) }
#dmRoot .dm-summary-table { width:100%;border-collapse:collapse;font-size:10px }
#dmRoot .dm-summary-table th, #dmRoot .dm-summary-table td { padding:4px 6px;border:1px solid var(--border,#E2E8F0);text-align:center;white-space:nowrap }
#dmRoot .dm-summary-table th { background:var(--bg3,#F1F5F9);font-weight:700;font-size:9px;color:#94A3B8;text-transform:uppercase }
#dmRoot .dm-summary-table td.dm-cur { color:#3B82F6;font-weight:700 }
#dmRoot .dm-summary-table td.dm-sel { color:#16A34A;font-weight:700 }
#dmRoot .dm-summary-table td.dm-rem { color:#DC2626;font-weight:700 }
#dmRoot .dm-chip { display:inline-block;padding:1px 6px;border-radius:9px;font-size:9.5px;font-weight:700 }
#dmRoot .dm-rotation-sel { border:1px solid var(--border,#E2E8F0);border-radius:4px;font-size:11px;padding:2px 4px;background:var(--bg,#F8FAFC);color:var(--text,#0F172A);cursor:pointer }
#dmRoot .dm-btn-assign { padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none;background:#16A34A;color:#fff;transition:opacity .15s }
#dmRoot .dm-btn-assign:disabled { opacity:.4;cursor:default }
#dmRoot .dm-btn-unassign { padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;border:none;background:var(--bg3,#E2E8F0);color:var(--text,#0F172A);transition:opacity .15s }
#dmRoot .dm-btn-unassign:disabled { opacity:.4;cursor:default }
#dmRoot .dm-modal-header { cursor:move; user-select:none }
#dmRoot .dm-modal-header:active { cursor:grabbing }
#dmRoot .dm-pkg-row { display:flex;justify-content:space-between;gap:8px;padding:3px 0;font-size:11px;border-bottom:1px dashed var(--border,#E2E8F0) }
#dmRoot .dm-pkg-row:last-child { border-bottom:none }
#dmRoot .dm-pkg-total { font-size:16px;font-weight:800;color:#0F172A }
#dmRoot .dm-collapse-toggle { cursor:pointer;user-select:none;display:flex;align-items:center;justify-content:space-between }
</style>`;
  }

  function _btnStyle(bg) {
    return `background:${bg};border:1px solid var(--border,#E2E8F0);border-radius:6px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.1);color:var(--text,#0F172A)`;
  }

  // ── فقاعات الفلتر: فتح/إغلاق مع مهلة سماحية + تثبيت الـpopup داخل حدود الشاشة + دبل-كليك للرجوع للافتراضي ──
  function _attachFilterBubbles(viewEl) {
    viewEl.querySelectorAll('.dm-fgroup').forEach(group => {
      const pop = group.querySelector('.dm-fgroup-pop');
      const trigger = group.querySelector('.dm-fgroup-trigger');
      if (!pop || !trigger) return;
      let closeTimer = null;

      function clampPop() {
        // إعادة التموضع الافتراضية قبل القياس
        pop.style.transform = '';
        pop.style.top = '';
        pop.style.bottom = '';
        pop.style.left = '0';
        pop.style.right = 'auto';
        const margin = 8;
        const r = pop.getBoundingClientRect();
        let shiftX = 0;
        if (r.right > window.innerWidth - margin) shiftX -= (r.right - (window.innerWidth - margin));
        if (r.left + shiftX < margin) shiftX += (margin - (r.left + shiftX));
        if (shiftX) pop.style.transform = `translateX(${shiftX}px)`;
        if (r.bottom > window.innerHeight - margin) {
          pop.style.top = 'auto';
          pop.style.bottom = '100%';
        }
      }

      function openPop() {
        clearTimeout(closeTimer);
        pop.classList.add('dm-open');
        requestAnimationFrame(clampPop);
      }
      function scheduleClose() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => pop.classList.remove('dm-open'), 450);
      }

      group.addEventListener('mouseenter', openPop);
      group.addEventListener('mouseleave', scheduleClose);
      pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
      pop.addEventListener('mouseleave', scheduleClose);
      trigger.addEventListener('click', () => {
        if (pop.classList.contains('dm-open')) scheduleClose(); else openPop();
      });

      trigger.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(closeTimer);
        if (group.id === 'dmFilterGroup') {
          const allTab = pop.querySelector('[data-tab="all"]');
          if (allTab) allTab.click();
        } else if (group.id === 'dmDateGroup') {
          _currentDates.clear();
          pop.querySelectorAll('.dm-datetab').forEach(b => b.classList.remove('dm-ftab--active'));
          _updateDateTrigger();
          _applyFilterTab();
        } else if (group.id === 'dmCreationGroup') {
          const allTab = pop.querySelector('[data-creation="all"]');
          if (allTab) allTab.click();
        } else if (group.id === 'dmClientGroup') {
          _clientSearchTags = [];
          _clientSearchQuery = '';
          const input = viewEl.querySelector('#dmClientSearch');
          if (input) input.value = '';
          _renderClientTagsPop(viewEl);
          _applyFilterTab();
        }
        pop.classList.remove('dm-open');
      });
    });
  }

  // يعيد رسم فقاعة "أسماء الزبائن" المضافة (badge يحل محل أيقونة 🔍 داخل شريط البحث + قائمة تحت الـ badge).
  function _renderClientTagsPop(viewEl) {
    const trigger = viewEl.querySelector('#dmClientTrigger');
    const icon = viewEl.querySelector('#dmClientIcon');
    const pop = viewEl.querySelector('#dmClientTags');
    if (!trigger || !pop) return;
    const n = _clientSearchTags.length;
    if (icon) icon.style.display = n ? 'none' : 'inline';
    trigger.style.display = n ? 'inline-flex' : 'none';
    trigger.textContent = `👥 ${n}`;
    trigger.classList.toggle('dm-fgroup-trigger--active', n > 0);
    pop.innerHTML = n
      ? _clientSearchTags.map((t, i) => `
        <span class="dm-ctab dm-ftab--active" data-client-idx="${i}" style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid #3B82F6;background:#EFF6FF;color:#1D4ED8;display:inline-flex;align-items:center;gap:5px;white-space:nowrap">
          ${escHtml(t)}
          <span class="dm-client-tag-remove" data-client-idx="${i}" title="Retirer" style="cursor:pointer;font-weight:900;line-height:1">×</span>
        </span>`).join('')
      : '';
  }

  function _attachHeaderEvents(viewEl) {
    _attachFilterBubbles(viewEl);
    _attachDraftBarEvents(viewEl);
    const refreshBtn = viewEl.querySelector('#dmBtnRefresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => _refreshAllBLs(refreshBtn));
    }
    const fsBtn = viewEl.querySelector('#dmBtnFullscreen');
    if (fsBtn) {
      const rootEl = viewEl.querySelector('#dmRoot') || viewEl;
      const ICON_EXPAND = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
      const ICON_COLLAPSE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M9 3v3a2 2 0 0 1-2 2H4"/><path d="M15 3v3a2 2 0 0 0 2 2h3"/><path d="M9 21v-3a2 2 0 0 0-2-2H4"/><path d="M15 21v-3a2 2 0 0 1 2-2h3"/></svg>';
      const syncIcon = () => {
        const isFs = document.fullscreenElement === rootEl;
        fsBtn.innerHTML = isFs ? ICON_COLLAPSE : ICON_EXPAND;
        fsBtn.title = isFs ? 'Quitter le plein écran' : 'Plein écran';
      };
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen?.();
        } else {
          rootEl.requestFullscreen?.();
        }
      });
      document.addEventListener('fullscreenchange', syncIcon);
      syncIcon();
    }
    const maxBtn = viewEl.querySelector('#dmBtnMaximize');
    if (maxBtn) {
      const rootEl = viewEl.querySelector('#dmRoot') || viewEl;
      const ICON_MAX = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="4" y="4" width="16" height="16" rx="1.5"/></svg>';
      const ICON_RESTORE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><rect x="6" y="6" width="12" height="12" rx="1.2"/><path d="M9 3h9a2 2 0 0 1 2 2v9"/></svg>';
      const syncMaxIcon = () => {
        const isMax = rootEl.classList.contains('dm-app-maximized');
        maxBtn.innerHTML = isMax ? ICON_RESTORE : ICON_MAX;
        maxBtn.title = isMax ? 'Réduire' : 'Agrandir dans la fenêtre';
      };
      maxBtn.addEventListener('click', () => {
        rootEl.classList.toggle('dm-app-maximized');
        syncMaxIcon();
      });
      syncMaxIcon();
    }
    const searchInput = viewEl.querySelector('#dmActorSearch');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        _actorSearchQuery = searchInput.value;
        _renderActorsList();
      });
    }
    const vendeurInput = viewEl.querySelector('#dmVendeurSearch');
    if (vendeurInput) {
      vendeurInput.addEventListener('input', () => {
        _vendeurSearchQuery = vendeurInput.value;
        _applyFilterTab();
      });
    }
    const clientInput = viewEl.querySelector('#dmClientSearch');
    if (clientInput) {
      clientInput.addEventListener('input', () => {
        _clientSearchQuery = clientInput.value;
        _applyFilterTab();
      });
      clientInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const val = clientInput.value.trim();
        if (!val) return;
        if (!_clientSearchTags.some(t => _normalizeSearchText(t) === _normalizeSearchText(val))) {
          _clientSearchTags.push(val);
          _renderClientTagsPop(viewEl);
        }
        clientInput.value = '';
        _clientSearchQuery = '';
        _applyFilterTab();
      });
    }
    _renderClientTagsPop(viewEl);
    viewEl.addEventListener('click', e => {
      // إزالة اسم زبون واحد من الفقاعة
      const clientRemove = e.target.closest('.dm-client-tag-remove');
      if (clientRemove) {
        const idx = parseInt(clientRemove.dataset.clientIdx, 10);
        if (!isNaN(idx)) {
          _clientSearchTags.splice(idx, 1);
          _renderClientTagsPop(viewEl);
          _applyFilterTab();
        }
        return;
      }
      // Filter tabs
      const ftab = e.target.closest('.dm-ftab');
      if (ftab) {
        const prevTab = _filterTab;
        const prevActorTab = _actorFilterTab;
        _filterTab = ftab.dataset.tab;
        // "Affectés" à l'échelle de l'acteur n'a de sens que si le filtre global
        // peut inclure des BLs affectés (donc pas quand le global = "Non affectés").
        if (_filterTab === 'unassigned' && _actorFilterTab === 'assigned') {
          _actorFilterTab = 'all';
        }
        const count = _applyFilterTab();
        if (count === 0 && _filterTab !== 'all') {
          // Aucun résultat : on gèle ce filtre et on revient à l'état précédent.
          _filterTab = prevTab;
          _actorFilterTab = prevActorTab;
          _applyFilterTab();
          addNotif?.('Aucun BL ne correspond à ce filtre', 'warning');
          return;
        }
        viewEl.querySelectorAll('.dm-ftab').forEach(t => t.classList.toggle('dm-ftab--active', t.dataset.tab === _filterTab));
        const trigger = document.getElementById('dmFilterTrigger');
        if (trigger) {
          trigger.textContent = ftab.textContent;
          trigger.classList.toggle('dm-fgroup-trigger--active', _filterTab !== 'all');
        }
        // Toujours re-render le modal acteur : le bouton "Affectés" dépend de
        // _filterTab pour son état gelé/actif, il doit rester synchronisé à
        // chaque changement du filtre global (pas seulement en cas de reset).
        if (_selectedActorId) _renderConsolide();
        return;
      }

      // Creation-date tabs — Ctrl+click لتحديد أكثر من فلتر، كليك عادي = فلتر وحيد، كليك على "Tous" = إلغاء
      const ctab = e.target.closest('.dm-ctab');
      if (ctab) {
        const val = ctab.dataset.creation;
        const prevFilters = new Set(_creationFilters);

        if (val === 'all') {
          // "Tous" يلغي كل الفلاتر دائماً
          _creationFilters.clear();
        } else if (e.ctrlKey || e.metaKey) {
          // Ctrl+click: تبديل هذا الفلتر ضمن التحديد المتعدد
          if (_creationFilters.has(val)) {
            _creationFilters.delete(val);
          } else {
            _creationFilters.add(val);
          }
        } else {
          // كليك عادي: إذا كان هو الوحيد المحدد → إلغاء الفلتر، وإلا → فلتر وحيد
          if (_creationFilters.size === 1 && _creationFilters.has(val)) {
            _creationFilters.clear();
          } else {
            _creationFilters.clear();
            _creationFilters.add(val);
          }
        }

        const count = _applyFilterTab();
        if (count === 0 && _creationFilters.size) {
          _creationFilters = prevFilters;
          _applyFilterTab();
          addNotif?.('Aucun BL ne correspond à ce filtre', 'warning');
          return;
        }

        // تحديث مظهر الأزرار
        viewEl.querySelectorAll('.dm-ctab').forEach(t => {
          const isAll = t.dataset.creation === 'all';
          const active = isAll ? _creationFilters.size === 0 : _creationFilters.has(t.dataset.creation);
          t.classList.toggle('dm-ftab--active', active);
        });

        // تحديث نص زر التفعيل
        const cTrigger = document.getElementById('dmCreationTrigger');
        if (cTrigger) {
          if (_creationFilters.size === 0) {
            cTrigger.textContent = '🕒 Création';
          } else if (_creationFilters.size === 1) {
            const label = ctab.dataset.creation === [..._creationFilters][0] ? ctab.textContent
              : viewEl.querySelector(`.dm-ctab[data-creation="${[..._creationFilters][0]}"]`)?.textContent || [..._creationFilters][0];
            cTrigger.textContent = '🕒 ' + label;
          } else {
            cTrigger.textContent = `🕒 ${_creationFilters.size} filtres`;
          }
          cTrigger.classList.toggle('dm-fgroup-trigger--active', _creationFilters.size > 0);
        }
        return;
      }

      // فقاعة "Reporté" المستقلة (3 حالات: 0=بدون فلتر، 1=إظهار فقط، 2=إخفاء)
      // كليك عادي → الحالة 1 (إظهار فقط المؤجَّلة)
      // Ctrl+كليك  → الحالة 2 (إخفاء المؤجَّلة)
      // دبل-كليك  → الحالة 0 (إلغاء الفلتر) — معالَج في dblclick أدناه
      const reportedBtn = e.target.closest('#dmReportedTrigger');
      if (reportedBtn) {
        const prev = _reportedOnly;
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+click: تبديل بين إخفاء (2) وإلغاء (0)
          _reportedOnly = _reportedOnly === 2 ? 0 : 2;
        } else {
          // كليك عادي: تبديل بين إظهار فقط (1) وإلغاء (0)
          _reportedOnly = _reportedOnly === 1 ? 0 : 1;
        }
        const count = _applyFilterTab();
        if (count === 0 && _reportedOnly !== 0) {
          _reportedOnly = prev;
          _applyFilterTab();
          addNotif?.('Aucun BL ne correspond à ce filtre', 'warning');
          return;
        }
        // تحديث مظهر الزر حسب الحالة
        reportedBtn.classList.remove('dm-fgroup-trigger--active', 'dm-fgroup-trigger--exclude');
        if (_reportedOnly === 1) {
          reportedBtn.classList.add('dm-fgroup-trigger--active');
          reportedBtn.title = 'Reporté : affichage uniquement (double-clic pour annuler)';
        } else if (_reportedOnly === 2) {
          reportedBtn.classList.add('dm-fgroup-trigger--exclude');
          reportedBtn.title = 'Reporté : masqués (double-clic pour annuler)';
        } else {
          reportedBtn.title = 'Date de livraison reportée';
        }
        return;
      }
    });

    // دبل-كليك على أي زر فلتر داخل الـpopup (وليس فقط على فقاعة العنوان) يعيده للافتراضي
    viewEl.addEventListener('dblclick', e => {
      // دبل-كليك على زر Reporté → إلغاء الفلتر (الحالة 0)
      const reportedBtnDbl = e.target.closest('#dmReportedTrigger');
      if (reportedBtnDbl) {
        e.preventDefault();
        _reportedOnly = 0;
        reportedBtnDbl.classList.remove('dm-fgroup-trigger--active', 'dm-fgroup-trigger--exclude');
        reportedBtnDbl.title = 'Date de livraison reportée';
        _applyFilterTab();
        return;
      }
      const ftab = e.target.closest('.dm-ftab');
      if (ftab) {
        e.preventDefault();
        const allTab = ftab.closest('.dm-fgroup-pop')?.querySelector('[data-tab="all"]');
        if (allTab) allTab.click();
        return;
      }
      const ctab = e.target.closest('.dm-ctab');
      if (ctab) {
        e.preventDefault();
        const allTab = ctab.closest('.dm-fgroup-pop')?.querySelector('[data-creation="all"]');
        if (allTab) allTab.click();
        return;
      }
      const dtab = e.target.closest('.dm-datetab');
      if (dtab) {
        e.preventDefault();
        _currentDates.clear();
        viewEl.querySelectorAll('.dm-datetab').forEach(b => b.classList.remove('dm-ftab--active'));
        _updateDateTrigger();
        _applyFilterTab();
        return;
      }
    });
  }

  async function _initBootstrap() {
    // ⚠️ خطوة إلزامية قبل أي نداء آخر لـ /delivery-map/*: تُهيّئ سياق
    // الجلسة الخاص بالقسم على Odoo (مشاهَدة في نداء POST /api/delivery-map/
    // بدون مسار إضافي ضمن التسجيل الأصلي). بدونها، Odoo يرجع 404 على
    // get-actors-delivery/get-deliveries/... رغم وجود جلسة مستخدم صالحة.
    try {
      await _api('POST', '/delivery-map/', {});
    } catch (e) {
      // لا نوقف التنفيذ إن فشلت (قد ترجع 404/405 حسب إصدار Odoo)، لكن
      // نسجلها بالكونسول للتشخيص إن استمرت مشاكل 404 على النداءات التالية.
      console.warn('[DeliveryPlanner] bootstrap call failed:', e);
    }
  }

  async function _initialize(viewEl) {
    try {
      await _initBootstrap();
      await _loadGoogleMaps();
      const [actors, unassigned] = await Promise.all([_getActors(), _getDeliveries()]);
      _actors = actors || [];
      (unassigned || []).filter(_isActiveBL).forEach(bl => _unassignedBLs.set(bl.id, bl));
      // ⚡ عرض الواجهة فوراً بعد توفر البيانات الأساسية (الموزعون + BLs غير
      // المسندة)، دون انتظار _loadAllRouteAssignedBLs التي تستدعي كل ليفرور
      // على حدة وقد تكون بطيئة. تُجلب لاحقاً في الخلفية (غير حاجبة).
      _renderActorsList();
      _initMap();
      _renderAllMarkers();
      _updateBLCount();
      _buildDateTabs();
      // شريط تقدّم رفيع أعلى الخريطة يعكس تقدّم التحميلات الثانوية بالخلفية بدقة:
      // كل ليفرور (route-assigned) يُحتسب كخطوة منفردة + 6 تحميلات ثانوية أخرى.
      const _bgProductIdsForPkg = [...new Map([..._unassignedBLs, ..._routeAssignedBLs]).values()]
        .flatMap(bl => (bl.move_lines || []).map(l => l.product_id)).filter(Boolean);
      _progressStart(_actors.length + 5 + (_bgProductIdsForPkg.length ? 1 : 0));
      // تحميل غير حاجب لِـ "BL(s) في الجولات" (كل ليفرور) لتحديد المُسند/غير
      // المُسند بشكل نهائي دون تعطيل ظهور المحتوى الأساسي. تقدّم كل ليفرور
      // يُحتسب فور اكتماله (وليس دفعة واحدة بعد اكتمال الجميع).
      _loadAllRouteAssignedBLs(_progressStep).then(() => {
        _renderAllMarkers();
        _updateBLCount();
        _renderConsolide();
        _applyFilterTab();
      }).catch(e => console.warn('[DeliveryPlanner] _loadAllRouteAssignedBLs failed:', e));
      // تحميل غير حاجب لحقل "origin" (Document d'origine) لعرض شارة ACILE فور توفرها
      _loadOrigins([..._unassignedBLs.keys(), ..._routeAssignedBLs.keys()]).then(() => {
        _renderAllMarkers();
        _renderConsolide();
      }).finally(_progressStep);
      // تحميل غير حاجب لتاريخ الإنشاء (create_date) لدعم فلتر "Création"
      _loadCreateDates([..._unassignedBLs.keys(), ..._routeAssignedBLs.keys()]).then(() => {
        _applyFilterTab();
        _lsPersistMap(_createDateCache, 'createDateCache');
      }).finally(_progressStep);
      // تحميل غير حاجب لاسم البائع لدعم بحث "Vendeur"
      _loadVendeurs([..._unassignedBLs.keys(), ..._routeAssignedBLs.keys()]).then(() => {
        _applyFilterTab();
        _lsPersistMap(_vendeurCache, 'vendeurCache');
      }).finally(_progressStep);
      // تحميل غير حاجب لتاريخ التسليم المؤجَّل لدعم فلتر "Reporté"
      _loadReportDates([..._unassignedBLs.keys(), ..._routeAssignedBLs.keys()]).then(() => {
        _markers.forEach((m, blId) => _refreshMarkerIcon(blId));
        _applyFilterTab();
        _lsPersistMap(_reportDateCache, 'reportDateCache');
      }).finally(_progressStep);
      // تحميل غير حاجب لعدد القطع في الحزمة (CDN) لدعم حساب Carton/Fardeau العشري
      const _allBlsForPkg = [...new Map([..._unassignedBLs, ..._routeAssignedBLs]).values()];
      const _productIdsForPkg = [...new Set(
        _allBlsForPkg.flatMap(bl => (bl.move_lines || []).map(l => {
          const raw = l.product_id;
          // product_id peut être: int, [int, name], ou string name
          if (Array.isArray(raw)) return parseInt(raw[0], 10);
          if (typeof raw === 'number') return raw;
          if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
          if (typeof raw === 'string' && raw.trim()) return raw.trim(); // string nom → résolu via product.product
          return null;
        }).filter(id => id !== null && id !== '' && !(typeof id === 'number' && id <= 0)))
      )];
      if (_productIdsForPkg.length) {
        _loadPackagingQtys(_productIdsForPkg).then(() => {
          _renderConsolide();
          _lsPersistMap(_packagingQtyCache, 'packagingQtyCache');
          _lsPersistMap(_pkgNameToIdCache,  'pkgNameToIdCache');
          _lsPersistMap(_productCategCache, 'productCategCache');
        }).finally(_progressStep);
      }
      // تحميل غير حاجب لِـ Liste de prix (via partner_shipping_id) لعرض شارة B (BtoB)
      const _allBlsForPl = [...new Map([..._unassignedBLs, ..._routeAssignedBLs]).values()];
      _loadPricelists(_allBlsForPl.map(bl => bl?.partner_shipping_id?.id)).then(() => {
        _renderAllMarkers();
        _renderConsolide();
        _lsPersistMap(_pricelistCache, 'pricelistCache');
      }).finally(_progressStep);
    } catch (e) {
      console.error('[DeliveryPlanner] _initialize failed with:', e); // الخطأ الحقيقي الكامل
      const loadingEl = document.getElementById('dmMapLoading');
      if (loadingEl) {
        loadingEl.innerHTML =
          `<div style="color:#DC2626;text-align:center;padding:20px;font-size:12px">Erreur: ${escHtml(String(e.message || e))}</div>`;
      } else {
        addNotif?.('Erreur: ' + (e.message || String(e)), 'error');
      }
    }
  }

  function _initMap() {
    const el = document.getElementById('dmMapEl');
    if (!el || !window.google?.maps) return;
    if (_map) {
      // Reuse existing map instance — avoids reloading tiles on reopen
      _map.setDiv(el);
      google.maps.event.trigger(_map, 'resize');
      document.getElementById('dmMapLoading')?.remove();
    } else {
      _map = new google.maps.Map(el, {
        center: { lat: 35.697, lng: -0.633 },
        zoom: 11,
        mapTypeControl: false,
        fullscreenControl: false,
        streetViewControl: false,
        styles: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }],
      });
      document.getElementById('dmMapLoading')?.remove();
    }

    // Drawing manager for polygon selection
    // ⚠️ مكتبة "drawing" أصبحت مهجورة بإصدارات حديثة من Maps JS API (v3.65+)
    // وقد يرمي المُنشئ خطأ حتى لو كان google.maps.drawing موجودًا كـ namespace.
    // نغلّفها بـ try/catch حتى لا تُسقط init الخريطة بالكامل (ميزة التحديد
    // بالمربع عبر Shift+Drag مستقلة تمامًا عن هذه المكتبة، لا تتأثر).
    try {
      if (window.google?.maps?.drawing) {
        _drawingManager = new google.maps.drawing.DrawingManager({
          drawingMode: null,
          drawingControl: false,
          polygonOptions: { fillColor: '#3B82F6', fillOpacity: 0.15, strokeColor: '#3B82F6', strokeWeight: 2, clickable: false, editable: false },
        });
        _drawingManager.setMap(_map);
        _drawingManager.addListener('polygoncomplete', poly => {
          if (_selectionPolygon) _selectionPolygon.setMap(null);
          _selectionPolygon = poly;
          _drawingManager.setDrawingMode(null);
          document.getElementById('dmBtnDraw')?.classList.remove('dm-drawing-active');
          _selectMarkersInPolygon(poly);
        });
      }
    } catch (drawErr) {
      console.warn('[DeliveryPlanner] DrawingManager (polygone) indisponible sur cette version de Maps API:', drawErr);
      _drawingManager = null;
      const btn = document.getElementById('dmBtnDraw');
      if (btn) {
        btn.disabled = true;
        btn.title = 'Sélection par zone (polygone) indisponible sur cette version de Maps API — utilisez Shift+glisser';
        btn.style.opacity = '.4';
        btn.style.cursor = 'not-allowed';
      }
    }

    // Overlay buttons
    document.getElementById('dmBtnDraw')?.addEventListener('click', () => {
      if (!_drawingManager) return;
      const active = _drawingManager.getDrawingMode() === google.maps.drawing.OverlayType.POLYGON;
      _drawingManager.setDrawingMode(active ? null : google.maps.drawing.OverlayType.POLYGON);
      document.getElementById('dmBtnDraw')?.classList.toggle('dm-drawing-active', !active);
    });

    document.getElementById('dmBtnClearSel')?.addEventListener('click', _clearBLSelection);

    document.getElementById('dmBtnFitMap')?.addEventListener('click', _fitMapToMarkers);

    // ── مفتاح Escape يلغي تحديد الـ BLs الحالي (بديل سريع لزر "Effacer la sélection") ──
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _selectedBLIds.size > 0) _clearBLSelection();
    });

    // ── تحديد متعدد بالسحب مع الضغط على Shift (Shift + drag) ──
    _initShiftDragSelection();

    // Undo
    document.getElementById('dmUndoBtn')?.addEventListener('click', _doUndo);
    document.getElementById('dmUndoDismiss')?.addEventListener('click', _hideUndo);
  }

  // نقرة عادية على أي BL بالخريطة أو بالجدول = تبديل تحديده
  function _toggleBLSelection(blId) {
    if (_selectedBLIds.has(blId)) _selectedBLIds.delete(blId);
    else _selectedBLIds.add(blId);
    _refreshMarkerIcon(blId);
    _renderConsolide();
  }

  // يلغي تحديد كل الـ BLs الحالية (يُستخدم من زر "Effacer la sélection" وأيضًا من مفتاح Escape)
  function _clearBLSelection() {
    // ⚠️ يجب تفريغ _selectedBLIds أولاً قبل تحديث أيقونات الماركرز، لأن
    // _refreshMarkerIcon يعتمد على _selectedBLIds.has(id) لتحديد ما إذا كان
    // يرسم علامة الصح الخاصة بالتحديد. لو استدعينا التحديث قبل التفريغ (كما
    // كان سابقًا) تبقى الأيقونات القديمة تعتبر نفسها "محددة" ولا تُزال علامة
    // الصح رغم إفراغ التحديد لاحقًا.
    const idsToRefresh = [..._selectedBLIds];
    _selectedBLIds = new Set();
    idsToRefresh.forEach(id => _refreshMarkerIcon(id));
    if (_selectionPolygon) { _selectionPolygon.setMap(null); _selectionPolygon = null; }
    _renderConsolide();
  }

  // ── تحديد بالمربع عبر Shift + سحب الماوس على الخريطة ───────
  // نفس نمط قسم "route map" الموجود مسبقًا (renderer.js): مستطيل DOM
  // بسيط يُرسم بالبكسل فوق حاوية الخريطة، مع تعطيل سحب الخريطة أثناء
  // السحب، ثم اختبار كل ماركر بإحداثياته بالبكسل (container point) ضمن
  // حدود المستطيل. هذا أدق وأسرع من الاعتماد على DrawingManager.
  function _initShiftDragSelection() {
    const mapContainer = document.getElementById('dmMapEl')?.parentElement; // الحاوية الأب النسبية (position:relative)
    const rectEl = document.getElementById('dmSelectRect');
    const mapEl = document.getElementById('dmMapEl');
    const touchBtn = document.getElementById('dmBtnTouchSelect');
    if (!_map || !mapContainer || !rectEl) return;

    let dragStart = null; // {x,y} نسبة لحاوية الخريطة
    let dragMode = null;  // 'select' (Shift) | 'deselect' (Ctrl)

    // ── مفتاح تبديل (switcher) للهاتف: لا يوجد مفتاح Shift على اللمس، لذا
    // نضيف زرًا يبدّل بين وضعين: "تحديد" (سحب الإصبع يرسم مستطيل تحديد،
    // تمامًا كـ Shift+drag) و"تنقّل عادي" (سحب الإصبع يحرّك الخريطة كالمعتاد).
    let _touchSelectOn = false;
    function _setTouchSelectButton(on) {
      _touchSelectOn = on;
      if (!touchBtn) return;
      touchBtn.style.background = on ? '#3B82F6' : '#fff';
      touchBtn.style.color = on ? '#fff' : 'var(--text,#0F172A)';
      touchBtn.title = on
        ? 'Mode sélection multiple activé — glissez pour sélectionner les BL (touchez à nouveau pour revenir au déplacement)'
        : 'Mode sélection multiple (tactile) — activer/désactiver';
    }
    touchBtn?.addEventListener('click', () => {
      _setTouchSelectButton(!_touchSelectOn);
      // نطبّق/نلغي تعطيل تفاعلات الخريطة فورًا (بدون انتظار سحب) حتى لا
      // يحرّك أول لمس/سحب الخريطة قبل رسم المستطيل.
      if (_touchSelectOn) {
        _map.setOptions({ gestureHandling: 'none' });
        if (mapEl) mapEl.style.cursor = 'crosshair';
      } else if (!dragStart) {
        _map.setOptions({ gestureHandling: 'greedy' });
        if (mapEl) mapEl.style.cursor = '';
      }
    });

    // ⚠️ محاولات سابقة اعتمدت على preventDefault/stopPropagation لمنع سحب
    // الخريطة الداخلي بالتوقيت الصحيح، لكن تبيّن بالتشخيص أن هذا غير موثوق
    // إطلاقًا (Google Maps يتعامل مع الأحداث بمستوى أعمق من DOM listeners
    // العادية). الحل الجذري: تعطيل كل تفاعلات الخريطة (سحب/تكبير باللمس..)
    // عبر خيار الخريطة الرسمي gestureHandling:'none' طالما Shift أو Ctrl
    // مضغوط — هذا مضمون 100% لأنه إعداد يُطبَّق على مستوى Maps API نفسه.
    function _setMode(mode) {
      // mode: 'select' | 'deselect' | null
      if (mode === activeModeKey) return;
      activeModeKey = mode;
      if (mode) {
        _map.setOptions({ gestureHandling: 'none' });
        if (mapEl) mapEl.style.cursor = 'crosshair';
      } else if (!dragStart && !_touchSelectOn) {
        _map.setOptions({ gestureHandling: 'greedy' });
        if (mapEl) mapEl.style.cursor = '';
      }
    }
    let activeModeKey = null; // 'select' | 'deselect' | null — يعكس حالة المفتاح المضغوط حاليًا (Shift/Ctrl)

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift' && activeModeKey !== 'deselect') _setMode('select');
      else if ((e.key === 'Control' || e.key === 'Meta') && activeModeKey !== 'select') _setMode('deselect');
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift' && activeModeKey === 'select') _setMode(null);
      else if ((e.key === 'Control' || e.key === 'Meta') && activeModeKey === 'deselect') _setMode(null);
    });
    window.addEventListener('blur', () => {
      activeModeKey = null;
      dragStart = null;
      dragMode = null;
      rectEl.style.display = 'none';
      _map.setOptions({ gestureHandling: 'greedy' });
      if (mapEl) mapEl.style.cursor = '';
    });

    const onMouseDown = (e) => {
      if (!(activeModeKey || _touchSelectOn) || e.button !== 0) return;
      // ⚠️ Correctif "premier Shift+drag ne fonctionne pas": gestureHandling:'none'
      // appliqué au keydown peut ne pas encore avoir été pris en compte par le
      // moteur interne de Google Maps au moment du tout premier mousedown (délai
      // de propagation de l'option). On bloque donc EXPLICITEMENT et de façon
      // synchrone la propagation de l'événement natif de drag de la carte, en
      // plus de la désactivation via setOptions — ceci fonctionne dès la 1ère fois.
      // ⚠️ يُستدعى أيضًا يدويًا من onTouchStart بكائن حدث اصطناعي بسيط لا يملك
      // preventDefault/stopPropagation (تم استدعاؤهما بالفعل على حدث اللمس
      // الأصلي هناك) — لذا نستخدم استدعاءً آمنًا (?.) بدل الاستدعاء المباشر،
      // وإلا يرمي استثناء يوقف التحديد بالكامل على الهاتف قبل ضبط dragStart.
      e.preventDefault?.();
      e.stopPropagation?.();
      dragMode = activeModeKey || (_touchSelectOn ? 'select' : null); // نثبّت الوضع لحظة بدء السحب (لو تغيّر المفتاح أثناء السحب، نكمل بنفس الوضع الأصلي)
      rectEl.style.borderColor = dragMode === 'deselect' ? '#DC2626' : '#3B82F6';
      rectEl.style.background = dragMode === 'deselect' ? 'rgba(220,38,38,.12)' : 'rgba(59,130,246,.15)';
      const box = mapContainer.getBoundingClientRect();
      dragStart = { x: e.clientX - box.left, y: e.clientY - box.top };
      rectEl.style.display = 'block';
      rectEl.style.left = dragStart.x + 'px';
      rectEl.style.top = dragStart.y + 'px';
      rectEl.style.width = '0px';
      rectEl.style.height = '0px';
    };

    const onMouseMove = (e) => {
      if (!dragStart) return;
      const box = mapContainer.getBoundingClientRect();
      const curX = e.clientX - box.left, curY = e.clientY - box.top;
      const left = Math.min(dragStart.x, curX), top = Math.min(dragStart.y, curY);
      const w = Math.abs(curX - dragStart.x), h = Math.abs(curY - dragStart.y);
      rectEl.style.left = left + 'px';
      rectEl.style.top = top + 'px';
      rectEl.style.width = w + 'px';
      rectEl.style.height = h + 'px';
    };

    const onMouseUp = (e) => {
      if (!dragStart) return;
      const box = mapContainer.getBoundingClientRect();
      const endX = e.clientX - box.left, endY = e.clientY - box.top;
      const p1 = dragStart, p2 = { x: endX, y: endY };
      const mode = dragMode;
      dragStart = null;
      dragMode = null;
      rectEl.style.display = 'none';
      if (!activeModeKey && !_touchSelectOn) {
        _map.setOptions({ gestureHandling: 'greedy' });
        if (mapEl) mapEl.style.cursor = '';
      }

      // مستطيل صغير جدًا (نقرة عرضية أثناء الضغط على Shift/Ctrl) → تجاهل
      if (Math.abs(p2.x - p1.x) < 4 && Math.abs(p2.y - p1.y) < 4) return;

      const pxBounds = {
        left: Math.min(p1.x, p2.x), right: Math.max(p1.x, p2.x),
        top: Math.min(p1.y, p2.y), bottom: Math.max(p1.y, p2.y),
      };
      _selectMarkersInPixelBounds(pxBounds, mode === 'deselect');
    };

    // مع gestureHandling:'none' لم نعد بحاجة لـ capture/stopPropagation
    // لمنع السحب، لكن نُبقي mousedown على الحاوية (bubble عادي يكفي).
    // ⚠️ نسجّله في مرحلة الـ capture (true) لضمان تنفيذه قبل أي مستمع داخلي
    // لخرائط جوجل على العنصر الابن (مصدر مشكلة "أول محاولة لا تعمل").
    mapContainer.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // يمنع القائمة السياقية (right-click) من الظهور أثناء وضع التحديد إن
    // فُتحت صدفة، ويمنع أيضًا تصرف Ctrl+drag الافتراضي ببعض المتصفحات
    mapContainer.addEventListener('contextmenu', (e) => { if (activeModeKey) e.preventDefault(); });

    // ── دعم اللمس (الهاتف): لا توجد أحداث mouse* موثوقة على اللمس فوق خرائط
    // جوجل (تُلتقط داخليًا للسحب/التكبير)، لذا نستخدم touchstart/move/end
    // مباشرة، ونُفعّلها فقط عندما يكون مفتاح التبديل (dmBtnTouchSelect) مُشغّلًا.
    // ⚠️ نفس مشكلة "أول محاولة لا تعمل" الموثّقة أعلاه لـ Shift+drag على
    // الكمبيوتر تحدث هنا أيضًا: preventDefault() وحده لا يكفي لمنع خرائط
    // جوجل من بدء سحبها الداخلي، لأن مستمعها الخاص بـ touchstart/touchmove
    // مُسجَّل على عنصر الخريطة (mapEl) ويستمر بالتنفيذ ما لم نوقف *انتشار*
    // الحدث بالكامل. نضيف stopPropagation() (وليس فقط preventDefault) على
    // كل من touchstart وtouchmove، ونسجّلها جميعًا بمرحلة capture (true)
    // على الحاوية الأب حتى تُنفَّذ قبل وصول الحدث لعنصر الخريطة نفسه —
    // هذا يضمن عمل أول لمسة/سحب من أول مرة دون الحاجة لمحاولة ثانية.
    const onTouchStart = (e) => {
      if (!_touchSelectOn || e.touches.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      onMouseDown({ button: 0, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    };
    const onTouchMove = (e) => {
      if (!dragStart) return;
      e.preventDefault();
      e.stopPropagation();
      onMouseMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
    };
    const onTouchEnd = (e) => {
      if (!dragStart) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.changedTouches[0];
      onMouseUp({ clientX: t.clientX, clientY: t.clientY });
    };
    mapContainer.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    mapContainer.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    mapContainer.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    mapContainer.addEventListener('touchcancel', onTouchEnd, { passive: false, capture: true });
  }

  function _selectMarkersInPixelBounds(pxBounds, deselect) {
    const helper = _pixelHelper();
    if (!helper) return;
    // getProjection() قد يُرجع undefined لو الـ overlay أُنشئ للتو ولم يُضَف بعد
    // بشكل متزامن من طرف خرائط Google (onAdd/draw غير متزامنين) → نتجنب الانهيار
    const projection = helper.getProjection();
    if (!projection) return;

    let changed = 0;
    _markers.forEach((marker, blId) => {
      if (!marker.getVisible()) return;
      const pt = projection.fromLatLngToContainerPixel(marker.getPosition());
      if (!pt) return;
      if (pt.x >= pxBounds.left && pt.x <= pxBounds.right && pt.y >= pxBounds.top && pt.y <= pxBounds.bottom) {
        if (deselect) {
          if (_selectedBLIds.has(blId)) { _selectedBLIds.delete(blId); changed++; }
        } else {
          if (!_selectedBLIds.has(blId)) { _selectedBLIds.add(blId); changed++; }
        }
        _refreshMarkerIcon(blId);
      }
    });
    if (changed) _renderConsolide();
  }

  // OverlayView فارغ (بدون رسم) فقط للوصول إلى fromLatLngToContainerPixel
  // بشكل متزامن وموثوق (Google Maps لا يوفر هذا التحويل مباشرة من الخريطة).
  function _pixelHelper() {
    if (_pixelHelperOv && _pixelHelperOv.getProjection()) return _pixelHelperOv;
    if (!window.google?.maps || !_map) return null;
    function EmptyOverlay() { google.maps.OverlayView.call(this); this.setMap(_map); }
    EmptyOverlay.prototype = Object.create(google.maps.OverlayView.prototype);
    EmptyOverlay.prototype.onAdd = function () {};
    EmptyOverlay.prototype.draw = function () {};
    EmptyOverlay.prototype.onRemove = function () {};
    _pixelHelperOv = new EmptyOverlay();
    return _pixelHelperOv;
  }

  function _selectMarkersInPolygon(poly) {
    _markers.forEach((marker, blId) => {
      if (!marker.getVisible()) return;
      if (google.maps.geometry?.poly?.containsLocation(marker.getPosition(), poly) ||
          _containsLocation(marker.getPosition(), poly)) {
        _selectedBLIds.add(blId);
        _refreshMarkerIcon(blId);
      }
    });
    _renderConsolide();
  }

  function _containsLocation(point, polygon) {
    // Fallback if geometry library not available
    try { return google.maps.geometry.poly.containsLocation(point, polygon); } catch (_) { return false; }
  }

  function _fitMapToMarkers() {
    if (!_map) return;
    const bounds = new google.maps.LatLngBounds();
    let count = 0;
    _markers.forEach(m => { if (m.getVisible()) { bounds.extend(m.getPosition()); count++; } });
    if (count > 0) _map.fitBounds(bounds);
  }

  // ── Actors sidebar ─────────────────────────────────────────
  function _stripActorPrefix(name) {
    return String(name || '').replace(/^\s*(LIVREUR|VENDEUR)\s+/i, '');
  }

  let _actorSearchQuery = '';

  // ── Recherche intelligente dans le modal "Sélection" (BLs cochés) ──
  // تتجاوز المسافات وترتيب الكلمات: كل كلمة من نص البحث تُقارن كنص فرعي
  // بعد حذف كل المسافات من الطرفين (مرجع BL + اسم العميل)، بغض النظر عن
  // ترتيبها أو مكان المسافات فيها.
  let _selModalSearchQuery = '';

  function _normalizeForSearch(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '');
  }

  function _selModalMatchesSearch(bl, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const tokens = q.split(/\s+/).filter(Boolean).map(_normalizeForSearch);
    if (!tokens.length) return true;
    const haystack = _normalizeForSearch(`${bl?.name || ''} ${bl?.partner_shipping_id?.name || ''}`);
    return tokens.every(t => haystack.includes(t));
  }

  function _renderActorsList() {
    const el = document.getElementById('dmActorsList');
    if (!el) return;
    const q = _actorSearchQuery.trim().toLowerCase();
    const filtered = q
      ? _actors.filter(a => _stripActorPrefix(a.name).toLowerCase().includes(q))
      : _actors;
    if (!_actors.length) {
      el.innerHTML = `<div style="font-size:11px;color:var(--text3,#94A3B8);padding:10px">Aucun livreur disponible</div>`;
      return;
    }
    if (!filtered.length) {
      el.innerHTML = `<div style="font-size:11px;color:var(--text3,#94A3B8);padding:10px">Aucun résultat</div>`;
      return;
    }
    el.innerHTML = filtered.map(actor => {
      const hasPlan = !_planningIsNew(actor);
      const freq = hasPlan ? (actor.planning_id?.name || '') : '';
      return `<div class="dm-actor-bubble${actor.id === _selectedActorId ? ' dm-actor-bubble--active' : ''}"
          data-actor-id="${actor.id}">
        <div class="dm-actor-bubble-name">${escHtml(_stripActorPrefix(actor.name))}</div>
        <div class="dm-actor-bubble-freq">${escHtml(freq)}</div>
      </div>`;
    }).join('');

    el.querySelectorAll('.dm-actor-bubble').forEach(row => {
      row.addEventListener('click', () => _selectActor(Number(row.dataset.actorId)));
    });

    // تصغير حجم خط تردد الجولة ديناميكياً حتى يظهر كاملاً بدون تجاوز حدود الفقاعة
    el.querySelectorAll('.dm-actor-bubble-freq').forEach(_autoFitFreqText);
  }

  function _autoFitFreqText(el) {
    const text = el.textContent;
    if (!text) return;
    let fontSize = 10;
    el.style.fontSize = fontSize + 'px';
    const maxWidth = el.clientWidth;
    if (!maxWidth) return;
    while (fontSize > 6 && el.scrollWidth > maxWidth) {
      fontSize -= 0.5;
      el.style.fontSize = fontSize + 'px';
    }
  }

  async function _selectActor(actorId) {
    // ملاحظة: لا نُفرغ _selectedBLIds عند تبديل/إلغاء اختيار الليفرور — يجب أن يبقى
    // تحديد الـ BL(s) قائماً عبر التبديل بين الجولات، حتى يعمل الإسناد المباشر
    // (désaffectation تلقائية من الجولة القديمة ثم affectation للجولة الجديدة عبر
    // زر "Affecter" في _doAssign) دون الحاجة لعملية désaffecter يدوية منفصلة.
    if (_selectedActorId === actorId) {
      // Deselect
      _selectedActorId = null;
      _assignedBLs = new Map();
      _actorFilterTab = 'all';
      _renderActorsList();
      _renderAllMarkers();
      _hideConsolide();
      return;
    }
    _selectedActorId = actorId;
    _actorFilterTab = 'all';
    _renderActorsList();
    _setLoading(true);
    try {
      const [actor, assigned] = await Promise.all([
        _getActor(actorId),
        _getDeliveries(actorId),
      ]);
      // Update actor in list
      // ⚠️ حماية: تحقق أن الـ actor المُرجَع من _getActor يطابق فعلاً actorId
      // المطلوب. إذا رجع السيرفر (أو race condition بين نقرتين متتاليتين)
      // بيانات actor آخر، تحديث _actors[idx] بها كان كيسبب ظهور نفس اسم
      // الجولة (planning_id.name) مكرر على بطاقة موزع مختلف في الشريط.
      if (actor && actor.id === actorId) {
        const idx = _actors.findIndex(a => a.id === actorId);
        if (idx >= 0) _actors[idx] = actor;
      }
      _assignedBLs = new Map((assigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
      _assignedBLs.forEach((bl, id) => _routeAssignedBLs.set(id, bl)); // keep global set fresh
      _renderActorsList();
      _renderAllMarkers();
      _renderConsolide();
    } catch (e) {
      addNotif?.('Erreur: ' + (e.message || String(e)), 'error');
    } finally {
      _setLoading(false);
    }
  }

  function _setLoading(on) {
    _loading = on;
    // Could add spinner overlay to map here if needed
  }

  // ── Render markers ─────────────────────────────────────────
  function _renderAllMarkers() {
    if (!_map) return;
    // Clear all
    _markers.forEach(m => m.setMap(null));
    _markers = new Map();

    _unassignedBLs.forEach(bl => {
      // Skip if it's now really in a tournée (globally) or to the selected actor
      if (!_isInTournee(bl) && !(_assignedBLs.has(bl.id) && _isInTournee(_assignedBLs.get(bl.id)))) _upsertMarker(bl, false);
    });
    _routeAssignedBLs.forEach(bl => { if (_isInTournee(bl)) _upsertMarker(bl, true); }); // every BL really in a tournée, any actor
    _assignedBLs.forEach(bl => { if (_isInTournee(bl)) _upsertMarker(bl, true); });      // selected actor's BLs really in tournée (freshest data)

    _applyFilterTab();
    _updateBLCount();
  }

  function _applyFilterTab() {
    if (!_map) return 0;
    let visibleCount = 0;
    _markers.forEach((marker, blId) => {
      let show = true;
      const bl = _routeAssignedBLs.get(blId) || _assignedBLs.get(blId) || _unassignedBLs.get(blId);
      const isAssigned = _isInTournee(bl);
      if (_filterTab === 'assigned') show = isAssigned;
      else if (_filterTab === 'unassigned') show = !isAssigned;

      // Second filter, scoped to the currently selected actor (from the consolide modal).
      // "Affectés" here = assigned to THIS actor's own tournée; "Non affectés" = not
      // assigned to this actor (may still be assigned to another actor, or free).
      //
      // ⚠️ Bug corrigé: _assignedBLs.has(blId) + _isInTournee(...) ne suffit PAS, car
      // _getDeliveries(actorId) renvoie aussi des BLs "à proximité" qui appartiennent en
      // réalité à la tournée d'un AUTRE acteur (donc _isInTournee est vrai, mais pas pour
      // CETTE tournée). Il faut comparer explicitement le planning_delivery_id.id de ce BL
      // à celui de la tournée de l'acteur sélectionné (même logique que tourneeList dans
      // _renderConsolide, y compris l'id temporaire "draft-{actorId}" en mode brouillon).
      if (_selectedActorId && _actorFilterTab !== 'all') {
        const selActor = _actors.find(a => a.id === _selectedActorId);
        const selHasPlan = selActor && !_planningIsNew(selActor);
        const expectedPlanningId = selActor
          ? (selHasPlan ? String(selActor.planning_id.id) : `draft-${selActor.id}`)
          : null;
        const abl = _assignedBLs.get(blId);
        const isAssignedToActor = !!abl && _isInTournee(abl) && expectedPlanningId != null
          && String(abl.planning_delivery_id.id) === expectedPlanningId;
        if (_actorFilterTab === 'assigned') show = show && isAssignedToActor;
        else if (_actorFilterTab === 'unassigned') show = show && !isAssignedToActor;
      }

      // فلترة حسب تاريخ التوزيع الموضوع للـ BL (date prévue / scheduled_date).
      // BL بدون تاريخ يبقى مخفياً عند تفعيل فلتر تاريخ (لا ننسبه لأي يوم).
      if (_currentDates.size) {
        show = show && _currentDates.has(_blDateStr(bl));
      }

      // فلترة حسب تاريخ إنشاء الـ BL (create_date) — متعدد التحديد.
      if (_creationFilters.size) {
        show = show && _creationFilters.has(_blCreationBucket(bl));
      }

      // فلترة حسب اسم البائع (بحث ذكي يتجاهل الترتيب والمسافات).
      if (_vendeurSearchQuery.trim()) {
        show = show && _matchesVendeurQuery(_vendeurCache.get(blId), _vendeurSearchQuery);
      }

      // فلترة حسب اسم(اء) الزبون: النص الحالي أثناء الكتابة (فوري) + الأسماء المثبَّتة بـ Enter (OR بين الكل).
      if (_clientSearchTags.length || _clientSearchQuery.trim()) {
        const clientName = bl.partner_shipping_id?.name || '';
        const liveMatch = _clientSearchQuery.trim() ? _matchesVendeurQuery(clientName, _clientSearchQuery) : false;
        const tagMatch = _clientSearchTags.some(tag => _matchesVendeurQuery(clientName, tag));
        show = show && (liveMatch || tagMatch);
      }

      // فلترة "Reporté" (فقاعة مستقلة):
      // 1 = إظهار فقط المؤجَّلة، 2 = إخفاء المؤجَّلة، 0 = بدون فلتر
      if (_reportedOnly === 1) {
        show = show && !!_reportDateCache.get(blId);
      } else if (_reportedOnly === 2) {
        show = show && !_reportDateCache.get(blId);
      }

      marker.setVisible(show);
      if (show) visibleCount++;
    });
    _updateBLCount();
    return visibleCount;
  }

  function _updateBLCount() {
    const el = document.getElementById('dmBLCount');
    if (!el) return;
    let count = 0;
    _markers.forEach(m => { if (m.getVisible()) count++; });
    el.textContent = `${count} BL`;
  }

  // ── Date tabs ──────────────────────────────────────────────
  function _updateDateTrigger() {
    const trigger = document.getElementById('dmDateTrigger');
    if (!trigger) return;
    const todayStr = _todayStr();
    if (!_currentDates.size) {
      trigger.textContent = '📅 Date';
      trigger.classList.remove('dm-fgroup-trigger--active');
    } else if (_currentDates.size === 1) {
      const d = [..._currentDates][0];
      trigger.textContent = '📅 ' + (d === todayStr ? "Aujourd'hui" : _fmtDate(d));
      trigger.classList.add('dm-fgroup-trigger--active');
    } else {
      trigger.textContent = `📅 ${_currentDates.size} dates`;
      trigger.classList.add('dm-fgroup-trigger--active');
    }
  }

  function _buildDateTabs() {
    const el = document.getElementById('dmDateTabs');
    if (!el) return;

    // نجمع كل التواريخ الموجودة فعلياً في BLs (المتاحة + المسندة لأي تورنية)
    // بدل نطاق ثابت من 5 أيام، حتى نعرض فقط التواريخ ذات المعنى.
    const allBls = new Map([..._unassignedBLs, ..._routeAssignedBLs, ..._assignedBLs]);
    const dateSet = new Set();
    allBls.forEach(bl => {
      const d = _blDateStr(bl);
      if (d) dateSet.add(d);
    });
    const dates = [...dateSet].sort();
    const todayStr = _todayStr();

    if (!dates.length) {
      el.innerHTML = `<span style="font-size:10px;color:var(--text3,#94A3B8)">Aucune date disponible</span>`;
      _updateDateTrigger();
      return;
    }

    el.innerHTML = dates.map(d => {
      const label = d === todayStr ? "Aujourd'hui" : _fmtDate(d);
      const active = _currentDates.has(d);
      return `<button class="dm-datetab${active ? ' dm-ftab--active' : ''}" data-date="${d}"
        style="padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;border:1.5px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer;transition:all .15s">${escHtml(label)}</button>`;
    }).join('');
    el.querySelectorAll('.dm-datetab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const date = btn.dataset.date;
        const prevDates = new Set(_currentDates);
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd + clic: تبديل التاريخ ضمن التحديد المتعدد
          if (_currentDates.has(date)) _currentDates.delete(date);
          else _currentDates.add(date);
        } else {
          // نقر عادي: إذا كان هذا التاريخ هو التحديد الوحيد الحالي، ألغه (رجوع لكل التواريخ)
          // وإلا اجعله التحديد الوحيد
          if (_currentDates.size === 1 && _currentDates.has(date)) _currentDates.clear();
          else { _currentDates.clear(); _currentDates.add(date); }
        }
        const count = _applyFilterTab();
        if (count === 0 && _currentDates.size) {
          // Aucun résultat : on gèle ce filtre et on revient à l'état précédent.
          _currentDates = prevDates;
          _applyFilterTab();
          addNotif?.('Aucun BL ne correspond à ce filtre', 'warning');
          return;
        }
        el.querySelectorAll('.dm-datetab').forEach(b => b.classList.toggle('dm-ftab--active', _currentDates.has(b.dataset.date)));
        _updateDateTrigger();
      });
    });
    _updateDateTrigger();
  }

  // Extrait la partie YYYY-MM-DD de scheduled_date (date prévue) d'un BL, que ce
  // soit une chaîne datetime Odoo ("YYYY-MM-DD HH:mm:ss") ou une date/ISO string.
  function _blDateStr(bl) {
    const raw = bl?.scheduled_date;
    if (!raw) return null;
    if (typeof raw === 'string') return raw.slice(0, 10);
    try { return new Date(raw).toISOString().slice(0, 10); } catch (_) { return null; }
  }

  // Extrait la partie YYYY-MM-DD de create_date (date de création) d'un BL.
  // create_date est chargé à part (voir _loadCreateDates) car absent du payload
  // par défaut de get-deliveries ; on retombe sur bl.create_date si présent.
  function _blCreationDateStr(bl) {
    const raw = (bl?.id != null && _createDateCache.get(bl.id)) || bl?.create_date;
    if (!raw) return null;
    if (typeof raw === 'string') return raw.slice(0, 10);
    try { return new Date(raw).toISOString().slice(0, 10); } catch (_) { return null; }
  }

  // Classe la date de création d'un BL en 'today' / 'yesterday' / 'week' (7 derniers
  // jours, hors aujourd'hui/hier) / 'older' (plus de 7 jours) — null si pas de date.
  function _blCreationBucket(bl) {
    const d = _blCreationDateStr(bl);
    if (!d) return null;
    const today = new Date(_todayStr() + 'T00:00:00');
    const created = new Date(d + 'T00:00:00');
    const diffDays = Math.round((today - created) / 86400000);
    if (diffDays <= 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays <= 7) return 'week';
    return 'older';
  }

  // ── Floating modal: drag + corner-resize helpers (shared by dmConsolide & dmSelModal) ─
  // Panels move freely across the whole app area (#dmBody: sidebar + map),
  // clamped so they never leave those bounds. Each panel keeps its own
  // position + frame size (width/height) for the session — resizing only
  // enlarges the frame (more room to show hidden/scrolled content), it never
  // scales text, numbers, or icons.
  let _consolideDetailsOpen = false; // collapsible BL table/actions state
  let _consolideTourneeListOpen = false; // collapsible tournée BL list (under the count)

  const _PANEL_MIN_W = 260, _PANEL_MIN_H = 180;
  const _PANEL_DEFAULT_SIZE = { dmConsolide: { w: 340, h: 420 }, dmSelModal: { w: 360, h: 420 } };
  const _panelState = {}; // panelId -> { pos:{left,top}|null, size:{w,h}|null, dragBound, resizeBound }

  function _panelSt(panelId) {
    return _panelState[panelId] || (_panelState[panelId] = { pos: null, size: null, dragBound: false, resizeBound: false });
  }

  function _defaultPanelPos(panelId) {
    const bounds = document.getElementById('dmBody');
    const panel = document.getElementById(panelId);
    if (!bounds || !panel) return { left: 16, top: 16 };
    const bw = bounds.clientWidth || 0;
    const bh = bounds.clientHeight || 0;
    const size = _panelSt(panelId).size || _PANEL_DEFAULT_SIZE[panelId];
    // dmConsolide defaults to top-right, dmSelModal to bottom-left (matches prior look)
    if (panelId === 'dmSelModal') return { left: 16, top: Math.max(16, bh - size.h - 16) };
    return { left: Math.max(16, bw - size.w - 16), top: 16 };
  }

  function _clampPanelPos(panelId, left, top) {
    const bounds = document.getElementById('dmBody');
    if (!bounds) return { left, top };
    const bw = bounds.clientWidth || 0;
    const bh = bounds.clientHeight || 0;
    const size = _panelSt(panelId).size || _PANEL_DEFAULT_SIZE[panelId];
    return {
      left: Math.min(Math.max(0, left), Math.max(0, bw - size.w)),
      top:  Math.min(Math.max(0, top),  Math.max(0, bh - size.h)),
    };
  }

  function _clampPanelSize(panelId, w, h, left, top) {
    const bounds = document.getElementById('dmBody');
    const bw = bounds?.clientWidth || 0;
    const bh = bounds?.clientHeight || 0;
    const maxW = bw ? Math.max(_PANEL_MIN_W, bw - left) : w;
    const maxH = bh ? Math.max(_PANEL_MIN_H, bh - top) : h;
    return {
      w: Math.min(Math.max(_PANEL_MIN_W, w), maxW),
      h: Math.min(Math.max(_PANEL_MIN_H, h), maxH),
    };
  }

  function _applyPanelFrame(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const st = _panelSt(panelId);
    if (!st.size) st.size = { ..._PANEL_DEFAULT_SIZE[panelId] };
    if (!st.pos) st.pos = _defaultPanelPos(panelId);
    st.pos = _clampPanelPos(panelId, st.pos.left, st.pos.top);
    st.size = _clampPanelSize(panelId, st.size.w, st.size.h, st.pos.left, st.pos.top);
    panel.style.left = st.pos.left + 'px';
    panel.style.top = st.pos.top + 'px';
    panel.style.width = st.size.w + 'px';
    panel.style.height = st.size.h + 'px';
    panel.style.maxHeight = 'none'; // explicit height now drives the frame
  }

  function _bindPanelDrag(panelId) {
    const st = _panelSt(panelId);
    if (st.dragBound) return;
    st.dragBound = true;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    panel.addEventListener('mousedown', e => {
      const handle = e.target.closest('.dm-modal-header');
      if (!handle) return;
      if (e.target.closest('button')) return; // don't drag when clicking header buttons
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startLeft = st.pos.left; startTop = st.pos.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      st.pos = _clampPanelPos(panelId, startLeft + dx, startTop + dy);
      panel.style.left = st.pos.left + 'px';
      panel.style.top = st.pos.top + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // Resize from the bottom-right corner handle: grows/shrinks the panel's
  // frame only (width/height) — fonts, numbers and icons stay unchanged.
  function _bindPanelResize(panelId, handleId) {
    const st = _panelSt(panelId);
    if (st.resizeBound) return;
    st.resizeBound = true;
    const panel = document.getElementById(panelId);
    const handle = document.getElementById(handleId);
    if (!panel || !handle) return;
    let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;

    handle.addEventListener('mousedown', e => {
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = st.size.w; startH = st.size.h;
      e.preventDefault();
      e.stopPropagation(); // don't trigger header drag
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      st.size = _clampPanelSize(panelId, startW + dx, startH + dy, st.pos.left, st.pos.top);
      panel.style.width = st.size.w + 'px';
      panel.style.height = st.size.h + 'px';
    });
    document.addEventListener('mouseup', () => { resizing = false; });
  }

  function _resizeHandleHtml(handleId) {
    return `<div id="${handleId}" title="Redimensionner" style="position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:2">
      <svg width="16" height="16" viewBox="0 0 16 16" style="display:block"><path d="M13 3L3 13M13 8L8 13M13 13L13 13" stroke="#94A3B8" stroke-width="1.5" stroke-linecap="round"/></svg>
    </div>`;
  }

  // Sum move_lines quantities into Fardeau / Carton / Autre totals.
  // Calcul décimal :
  //   1. packaging_quantity si disponible (= nbre de cartons/fardeaux direct)
  //   2. sinon product_uom_qty / _packagingQtyCache(product_id)  ← CDN de product.packaging
  // Ex: 10 pièces / 20 pièces par carton = 0.5 carton
  // حساب Carton/Fardeau/Autre بشكل عشري صحيح.
  // المصادر بالأولوية لكل سطر:
  //   A) product_packaging موجود في السطر (name + qty)  → يُستخدم مباشرة
  //   B) packaging_quantity موجود  → يُستخدم مباشرة كعدد حزم
  //   C) product_uom_qty + كاش _packagingQtyCache → qty / pkgSize (حساب عشري)
  // إذا لم يوجد product_packaging.name ولا pkgName → يُصنَّف حسب اسم الحزمة من الكاش
  //
  // بالإضافة للإجماليات (fardeau/carton/autre) تُبنى تفاصيل لكل قسم:
  // details.<type> = [{ name: اسم Catégorie Article, qty, products: [{name: اسم المنتج, qty}] }]
  // مُجمّعة ومُرتّبة تنازلياً على مستويين (الفئة ثم المنتج داخلها)
  function _classifyPackaging(list) {
    const totals = { fardeau: 0, carton: 0, autre: 0 };
    // detailMaps[type]: Map<categName, { qty, products: Map<productName, qty> }>
    const detailMaps = { fardeau: new Map(), carton: new Map(), autre: new Map() };

    const addQty = (type, qty, categName, productName) => {
      if (!qty) return;
      totals[type] += qty;
      const catKey = categName || 'Sans catégorie';
      const prodKey = productName || '—';
      let bucket = detailMaps[type].get(catKey);
      if (!bucket) { bucket = { qty: 0, products: new Map() }; detailMaps[type].set(catKey, bucket); }
      bucket.qty += qty;
      bucket.products.set(prodKey, (bucket.products.get(prodKey) || 0) + qty);
    };

    list.forEach(bl => {
      (bl.move_lines || []).forEach(l => {
        // استخراج مفتاح الكاش: رقم product_id إن توفر، وإلا اسم المنتج (string) كما يصل من move_lines
        const rawPid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        let productId = parseInt(rawPid, 10);
        const pidIsValid = Number.isInteger(productId) && String(productId) === String(rawPid).trim() && productId > 0;
        if (!pidIsValid) productId = null;
        const pkgCacheKey = pidIsValid ? productId : (typeof rawPid === 'string' ? rawPid.trim() : null);

        // Catégorie Article للسطر (من الكاش المُحمَّل عبر _loadPackagingQtys)
        const categName = _productCategName(pkgCacheKey);
        // اسم المنتج المعروض داخل تفاصيل الفئة
        const productName = Array.isArray(l.product_id) ? (l.product_id[1] || '') : (typeof l.product_id === 'string' ? l.product_id : '');

        // اسم وحجم الحزمة من السطر مباشرة
        const pkgObj = l.product_packaging;
        const pkgNameFromLine = (pkgObj?.name || pkgObj?.prefix || '').toUpperCase();
        const pkgSizeFromLine = pkgObj?.qty || 0;

        // الكاش: مصفوفة [{qty, name}] لكل منتج (مفتاح رقمي أو اسم)
        const cached = (pkgCacheKey !== null ? _packagingQtyCache.get(pkgCacheKey) : null) || [];

        // حالة A: product_packaging موجود في السطر مع qty
        if (pkgNameFromLine && pkgSizeFromLine > 0) {
          const qty = l.packaging_quantity || (l.product_uom_qty ? l.product_uom_qty / pkgSizeFromLine : 0);
          if (!qty) return;
          if (/CARTON/.test(pkgNameFromLine)) addQty('carton', qty, categName, productName);
          else if (/FARDEAU/.test(pkgNameFromLine)) addQty('fardeau', qty, categName, productName);
          else addQty('autre', qty, categName, productName);
          return;
        }

        // حالة B: packaging_quantity موجود لكن بدون product_packaging واضح
        if (l.packaging_quantity && pkgNameFromLine) {
          const qty = l.packaging_quantity;
          if (/CARTON/.test(pkgNameFromLine)) addQty('carton', qty, categName, productName);
          else if (/FARDEAU/.test(pkgNameFromLine)) addQty('fardeau', qty, categName, productName);
          else addQty('autre', qty, categName, productName);
          return;
        }

        // حالة C: نعتمد على الكاش لحساب الكمية لكل نوع حزمة
        if (cached.length > 0 && l.product_uom_qty) {
          // إذا كان هناك packaging_quantity وpkgName من السطر
          if (l.packaging_quantity && pkgNameFromLine) {
            const qty = l.packaging_quantity;
            if (/CARTON/.test(pkgNameFromLine)) addQty('carton', qty, categName, productName);
            else if (/FARDEAU/.test(pkgNameFromLine)) addQty('fardeau', qty, categName, productName);
            else addQty('autre', qty, categName, productName);
            return;
          }
          // نبحث في الكاش عن أكبر حزمة carton أولاً ثم fardeau
          const cartonPkg = cached.find(p => /CARTON/.test(p.name));
          const fardeauPkg = cached.find(p => /FARDEAU/.test(p.name));
          const bestPkg = cartonPkg || fardeauPkg || cached[0];
          if (bestPkg && bestPkg.qty > 0) {
            const qty = l.product_uom_qty / bestPkg.qty;
            const name = bestPkg.name;
            if (/CARTON/.test(name)) addQty('carton', qty, categName, productName);
            else if (/FARDEAU/.test(name)) addQty('fardeau', qty, categName, productName);
            else addQty('autre', qty, categName, productName);
          }
          return;
        }

        // fallback: packaging_quantity seul sans nom → autre
        if (l.packaging_quantity) {
          addQty('autre', l.packaging_quantity, categName, productName);
        }
      });
    });

    const details = {};
    ['fardeau', 'carton', 'autre'].forEach(type => {
      details[type] = [...detailMaps[type].entries()]
        .map(([name, bucket]) => ({
          name,
          qty: bucket.qty,
          products: [...bucket.products.entries()]
            .map(([pname, pqty]) => ({ name: pname, qty: pqty }))
            .sort((a, b) => b.qty - a.qty),
        }))
        .sort((a, b) => b.qty - a.qty);
    });

    totals.details = details;
    return totals;
  }

  // حالة الانسحاب (open/closed) لكل قسم Fardeau/Carton/Autre — نفس منطق _consolideTourneeListOpen
  let _pkgDetailOpen = { fardeau: false, carton: false, autre: false };
  // حالة الانسحاب لكل Catégorie Article داخل كل قسم: Set<categName> مفتوحة حالياً
  let _pkgCategOpen = { fardeau: new Set(), carton: new Set(), autre: new Set() };

  // يعرض صف الإجمالي (Fardeau/Carton/Autre) + قائمة قابلة للانسحاب أسفله بالـ Catégorie Article
  // وكل فئة بدورها قابلة للانسحاب لعرض المنتجات داخلها (نفس أسلوب BL(s) dans la tournée، منسحبة داخل نفس اللوحة)
  // suffix: نص اختياري يُلحق بالقيمة المعروضة (مثلاً " DA" لصف CA) — بدون تأثير على المنطق القابل للطي.
  function _renderPkgTotal(title, value, type, details, suffix) {
    if (!value) return '';
    const items = details || [];
    const clickable = type && items.length > 0;
    const isOpen = clickable && _pkgDetailOpen[type];
    const rowId = type ? `dmPkgToggle-${type}` : '';
    const bodyId = type ? `dmPkgBody-${type}` : '';
    const openCats = (type && _pkgCategOpen[type]) || new Set();
    return `
      <div id="${rowId}" class="dm-pkg-total-row"${clickable ? ` data-pkg-type="${escHtml(type)}"` : ''} style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border,#E2E8F0);border-radius:8px;${isOpen ? 'border-bottom-left-radius:0;border-bottom-right-radius:0;' : ''}margin-bottom:${isOpen ? '0' : '6px'}${clickable ? ';cursor:pointer' : ''}">
        <span style="font-size:11px;font-weight:700;color:var(--text2,#475569)">${escHtml(title)}${clickable ? ` <span style="color:#94A3B8;font-weight:400">${isOpen ? '▲' : '▼'}</span>` : ''}</span>
        <span class="dm-pkg-total" style="font-size:18px">${Number.isInteger(value) ? value : _fmtNum(value, 2)}${suffix || ''}</span>
      </div>
      ${clickable ? `
      <div id="${bodyId}" style="${isOpen ? '' : 'display:none'};border:1px solid var(--border,#E2E8F0);border-top:none;border-radius:0 0 8px 8px;margin-bottom:6px;padding:2px 8px">
        ${items.map((cat, idx) => {
          const catOpen = openCats.has(cat.name);
          const hasProducts = cat.products && cat.products.length > 0;
          return `
          <div class="dm-pkg-cat-row"${hasProducts ? ` data-pkg-type="${escHtml(type)}" data-cat-idx="${idx}"` : ''} style="display:flex;justify-content:space-between;gap:8px;padding:5px 2px;border-bottom:${catOpen ? 'none' : '1px dashed var(--border,#E2E8F0)'};font-size:10.5px${hasProducts ? ';cursor:pointer' : ''}">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2,#475569)" title="${escHtml(cat.name)}">${escHtml(cat.name)}${hasProducts ? ` <span style="color:#CBD5E1">${catOpen ? '▲' : '▼'}</span>` : ''}</span>
            <span style="font-weight:700;flex-shrink:0;color:var(--text,#0F172A)">${Number.isInteger(cat.qty) ? cat.qty : _fmtNum(cat.qty, 2)}</span>
          </div>
          ${hasProducts && catOpen ? `
          <div style="padding:0 0 4px 10px;border-bottom:1px dashed var(--border,#E2E8F0)">
            ${cat.products.map(p => `
              <div style="display:flex;justify-content:space-between;gap:8px;padding:3px 2px;font-size:10px;color:var(--text3,#94A3B8)">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(p.name)}">${escHtml(productLabel(p.name))}</span>
                <span style="font-weight:600;flex-shrink:0;color:var(--text2,#475569)">${Number.isInteger(p.qty) ? p.qty : _fmtNum(p.qty, 2)}</span>
              </div>`).join('')}
          </div>` : ''}`;
        }).join('')}
      </div>` : ''}`;
  }

  // ── Consolidé panel ────────────────────────────────────────
  function _renderConsolide() {
    const panel = document.getElementById('dmConsolide');
    const inner = document.getElementById('dmConsolideInner');
    if (!panel || !inner) return;

    if (!_selectedActorId) {
      _hideConsolide();
      _renderSelModal();
      return;
    }

    panel.style.display = 'flex';
    const actor = _actors.find(a => a.id === _selectedActorId);
    if (!actor) { _renderSelModal(); return; }

    const planning = actor.planning_id || {};
    const vehicle = planning.vehicle_id || {};
    const hasPlan = !_planningIsNew(actor);

    // Compute summary stats
    const assignedList = [..._assignedBLs.values()];
    const selectedAssigned = assignedList.filter(bl => _selectedBLIds.has(bl.id));
    const selectedUnassigned = [..._unassignedBLs.values()].filter(bl => _selectedBLIds.has(bl.id));
    // BLs selected that are actually assigned to a DIFFERENT actor's tournée
    // (present globally in _routeAssignedBLs, in a real round, but not part of
    // the currently selected actor's own _assignedBLs). Moving these should
    // désaffecter them from their old tournée then affecter to the new one.
    const selectedOtherActor = [..._routeAssignedBLs.values()].filter(bl =>
      _selectedBLIds.has(bl.id) && _isInTournee(bl) && !_assignedBLs.has(bl.id)
    );

    const sumQty = (list) => list.reduce((s, bl) => s + (bl.move_lines || []).reduce((a, l) => a + (l.product_uom_qty || 0), 0), 0);
    const sumAmt = (list) => list.reduce((s, bl) => s + (bl.amount_total || 0), 0);

    // ملاحظة: تمّ حذف حساب Résumé (rotation/poids/حجم) مع الجدول من هذه اللوحة بناءً على الطلب.

    // Selected BL totals (for "to add" — unassigned ones + ones belonging to another actor)
    const toAddBLs = [...selectedUnassigned, ...selectedOtherActor];
    const selAmt = sumAmt([...selectedAssigned, ...selectedUnassigned, ...selectedOtherActor]);

    // Rotations present (لم تعد مستخدمة بعد حذف جدول Résumé، أُبقيت الإشارة هنا لتفادي كسر أي منطق مستقبلي)

    // BLs belonging specifically to the *current* tournée. Derived directly from the
    // assigned BLs themselves (not from actor.planning_id, which comes from a different
    // endpoint — /actor/{id} — and can be unreliable/out of sync): `planning_delivery_id`
    // is an OBJECT ({ id, name, ... }) on a BL that's actually part of a round, or `null`
    // when it's just available/nearby but not yet assigned to any round (confirmed from
    // an actual get-deliveries?actor_id= response, where such "pool" BLs were mixed in
    // alongside the 2 real round BLs). We take the round id(s) actually present on the
    // assigned BLs rather than trusting a separate field.
    // "Nouvelle tournée" (pas encore de planning_id réel côté serveur): en mode
    // brouillon, les BL affectés localement portent un id temporaire "draft-{actorId}"
    // (voir _doAssign) au lieu du vrai planning.id — donc on ne peut plus se baser
    // uniquement sur hasPlan pour décider si la liste doit être vide.
    const draftPlanningId = `draft-${actor.id}`;
    const tourneeList = assignedList
      .filter(bl => _isInTournee(bl) && String(bl.planning_delivery_id.id) === (hasPlan ? String(planning.id) : draftPlanningId))
      .sort((a, b) => String(a.delivery_rotation || '1').localeCompare(String(b.delivery_rotation || '1')));

    const pkg = _classifyPackaging(tourneeList);
    const tourneeAmt = sumAmt(tourneeList); // CA الكلي لكل BL(s) الموجودة فعلاً في تورنية هذا الموزع

    inner.innerHTML = `
      <!-- Header (drag handle) -->
      <div class="dm-modal-header" style="padding:10px 12px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px">
              <div style="font-size:11px;font-weight:800;color:var(--text,#0F172A);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(actor.name)}</div>
              <div id="dmActorFilterTabs" style="display:flex;gap:3px;flex-shrink:0">
                <button class="dm-actor-ftab${_actorFilterTab === 'all' ? ' dm-actor-ftab--active' : ''}" data-actor-tab="all" title="Tous" style="width:18px;height:18px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:5px;border:1.5px solid var(--border,#E2E8F0);background:${_actorFilterTab === 'all' ? 'var(--bg3,#F1F5F9)' : 'transparent'};color:${_actorFilterTab === 'all' ? 'var(--text,#0F172A)' : 'var(--text3,#94A3B8)'};cursor:pointer">
                  <svg width="13" height="11" viewBox="0 0 28 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 12 6 17 13 6"/><polyline points="13 12 18 17 27 5"/></svg>
                </button>
                <button class="dm-actor-ftab${_actorFilterTab === 'assigned' ? ' dm-actor-ftab--active' : ''}"${_filterTab === 'unassigned' ? ' disabled' : ''} data-actor-tab="assigned" title="Affectés" style="width:18px;height:18px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:5px;border:1.5px solid var(--border,#E2E8F0);background:${_actorFilterTab === 'assigned' ? 'var(--bg3,#F1F5F9)' : 'transparent'};color:${_filterTab === 'unassigned' ? '#CBD5E1' : (_actorFilterTab === 'assigned' ? '#16A34A' : 'var(--text3,#94A3B8)')};cursor:${_filterTab === 'unassigned' ? 'not-allowed' : 'pointer'}">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </button>
                <button class="dm-actor-ftab${_actorFilterTab === 'unassigned' ? ' dm-actor-ftab--active' : ''}" data-actor-tab="unassigned" title="Non affectés" style="width:18px;height:18px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:5px;border:1.5px solid var(--border,#E2E8F0);background:${_actorFilterTab === 'unassigned' ? 'var(--bg3,#F1F5F9)' : 'transparent'};color:${_actorFilterTab === 'unassigned' ? '#DC2626' : 'var(--text3,#94A3B8)'};cursor:pointer">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
                </button>
              </div>
            </div>
            ${actor.warehouse_id?.name ? `<div style="font-size:10px;color:var(--text3,#94A3B8);margin-top:1px">${escHtml(actor.warehouse_id.name)}</div>` : ''}
            ${vehicle.name ? `<div style="font-size:10px;color:var(--text3,#94A3B8);margin-top:1px">${escHtml(vehicle.name)}</div>` : ''}
            ${hasPlan ? `<div id="dmPlanningOpenOdoo" title="Ouvrir la tournée dans Odoo" style="font-size:10px;color:#3B82F6;font-weight:600;margin-top:2px;cursor:pointer;text-decoration:underline;text-underline-offset:2px">${escHtml(planning.name || '')}</div>` : '<div style="font-size:10px;color:#94A3B8;margin-top:2px">Nouvelle tournée</div>'}
            ${hasPlan && planning.date_start ? `<div style="font-size:9.5px;color:var(--text3,#94A3B8);margin-top:1px">${escHtml(String(planning.date_start).slice(0,10))}</div>` : ''}
          </div>
          <button id="dmCloseConsolide" style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:18px;line-height:1;padding:2px;flex-shrink:0">×</button>
        </div>
      </div>

      <div style="flex:1;overflow-y:auto;padding:10px 12px">

        <!-- BL count (prominent, clickable) — scoped to the current tournée -->
        <div id="dmTourneeCountToggle" style="text-align:center;padding:8px 0 12px 0;border-bottom:1px solid var(--border,#E2E8F0);margin-bottom:10px;cursor:pointer">
          <div class="dm-pkg-total">${tourneeList.length}</div>
          <div style="font-size:10px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.04em">
            BL(s) dans la tournée <span id="dmTourneeCountIcon">${_consolideTourneeListOpen ? '▲' : '▼'}</span>
          </div>
        </div>

        <!-- Collapsible: list of the BLs actually in the tournée -->
        <div id="dmTourneeListBody" style="${_consolideTourneeListOpen ? '' : 'display:none'};margin:-4px 0 10px 0">
          ${tourneeList.length === 0 ? `<div style="text-align:center;padding:8px;color:#94A3B8;font-size:11px">Aucun BL.</div>` : tourneeList.map(bl => {
            const blPkg = _classifyPackaging([bl]);
            const cat = _blCategory(bl);
            const clusterLetter = _categoryLetter(cat);
            const clusterColor = _blColor(bl);
            const hasBtoB = _hasBtoBBadge(bl);
            const hasAcile = _hasAcileBadge(bl);
            const hasReported = _hasReportedBadge(bl);
            const isPending = _isPendingBL(bl.id);
            return `
            <div class="dm-tournee-bl-row" data-bl-id="${bl.id}" style="padding:5px 2px;border-bottom:1px dashed ${isPending ? '#F59E0B' : 'var(--border,#E2E8F0)'};font-size:10.5px;cursor:pointer;${isPending ? 'background:#FFFBEB' : ''}">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <span style="flex:1;min-width:0;color:#3B82F6;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(bl.partner_shipping_id?.name || '')}">${escHtml(bl.partner_shipping_id?.name || '—')}${_clientLinkIconHtml(bl.partner_shipping_id?.id, null)}</span>
                <span style="display:flex;align-items:center;gap:4px;flex-shrink:0;white-space:nowrap">
                  ${isPending ? `<span title="En attente d'application" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#F59E0B;flex-shrink:0">${_hourglassIconSvg('#fff')}</span>` : ''}
                  ${hasBtoB ? `<span title="BtoB" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#F59E0B;color:#fff;font-size:8.5px;font-weight:800;flex-shrink:0">B</span>` : ''}
                  ${hasAcile ? `<span title="ACILE" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;overflow:hidden;flex-shrink:0"><img src="data:image/png;base64,${_ACILE_LOGO_B64}" style="width:100%;height:100%;object-fit:cover" alt="ACILE"/></span>` : ''}
                  ${hasReported ? `<span title="Reporté" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#8B5CF6;flex-shrink:0">${_hourglassIconSvg('#fff')}</span>` : ''}
                  ${clusterLetter ? `<span title="${escHtml(cat)}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:${clusterColor};color:#fff;font-size:8.5px;font-weight:800;flex-shrink:0">${clusterLetter}</span>` : ''}
                  <span style="font-weight:700">${_fmtNum(bl.amount_total, 0)} DA</span>
                </span>
              </div>
              <div style="display:flex;justify-content:space-between;gap:8px;margin-top:1px;color:var(--text3,#94A3B8)">
                <span>C: <b style="color:var(--text,#0F172A)">${Number.isInteger(blPkg.carton) ? blPkg.carton : _fmtNum(blPkg.carton, 2)}</b> · F: <b style="color:var(--text,#0F172A)">${Number.isInteger(blPkg.fardeau) ? blPkg.fardeau : _fmtNum(blPkg.fardeau, 2)}</b></span>
              </div>
            </div>`;
          }).join('')}
        </div>

        <!-- Tout ouvrir / Tout fermer — affecte Fardeau + Carton + Autre + toutes les catégories -->
        ${(pkg.fardeau || pkg.carton || pkg.autre) ? `
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button id="dmPkgExpandAll" type="button" style="flex:1;font-size:10px;font-weight:700;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">▼ Tout ouvrir</button>
          <button id="dmPkgCollapseAll" type="button" style="flex:1;font-size:10px;font-weight:700;padding:5px 8px;border-radius:6px;border:1px solid var(--border,#E2E8F0);background:var(--bg3,#F1F5F9);color:var(--text2,#475569);cursor:pointer">▲ Tout fermer</button>
        </div>` : ''}

        <!-- Packaging totals (Fardeau / Carton), scoped to la tournée — قابلة للنقر لعرض التفاصيل -->
        ${_renderPkgTotal('Fardeau', pkg.fardeau, 'fardeau', pkg.details.fardeau)}
        ${_renderPkgTotal('Carton', pkg.carton, 'carton', pkg.details.carton)}
        ${_renderPkgTotal('CA total', tourneeAmt, null, null, ' DA')}
        ${_renderPkgTotal('Autre', pkg.autre, 'autre', pkg.details.autre)}
        ${!pkg.fardeau && !pkg.carton && !pkg.autre ? `<div style="text-align:center;padding:10px;color:#94A3B8;font-size:11px">Aucun produit.</div>` : ''}
      </div>
    `;

    // Position + size + drag + resize (idempotent)
    _applyPanelFrame('dmConsolide');
    _bindPanelDrag('dmConsolide');
    _bindPanelResize('dmConsolide', 'dmConsolideResize');

    // Attach events
    document.getElementById('dmCloseConsolide')?.addEventListener('click', () => {
      _selectedActorId = null;
      _assignedBLs = new Map();
      _selectedBLIds = new Set();
      _actorFilterTab = 'all';
      _renderActorsList();
      _renderAllMarkers();
      _hideConsolide();
    });

    // النقر على مرجع "الجولة/التورنيه" في رأس اللوحة: يفتح سجل الجولة نفسه (planning.planning)
    // بنفس الصيغة المستخدمة في زر "Ouvrir tournée" بالكروت (rpcController.js)، بدل فتح
    // قائمة BLs الجولة (stock.picking) كما كان سابقاً.
    document.getElementById('dmPlanningOpenOdoo')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const base = getOdooBase();
      if (!base || !planning?.id) return;
      const cleanBase = base.replace(/\/$/, '');
      const url = `${cleanBase}/web#id=${planning.id}&action=549&model=planning.planning&view_type=form&cids=1&menu_id=336`;
      window.open(url, '_blank');
    });

    // النقر على BL ضمن قائمة "BL(s) dans la tournée" يفتحه في نفس المودل المستخدم في Bons de livraison (prevente & livraison)
    document.querySelectorAll('#dmConsolideInner .dm-tournee-bl-row').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const blId = Number(row.dataset.blId);
        const bl = tourneeList.find(b => b.id === blId);
        if (bl && typeof window._showBLDetails === 'function') {
          window._showBLDetails(bl, getOdooBase(), tourneeList);
        }
      });
    });

    // زرّي "Tout ouvrir / Tout fermer" — يفتحان أو يغلقان دفعة واحدة: Fardeau + Carton + Autre + كل الـ Catégorie داخلهم
    document.getElementById('dmPkgExpandAll')?.addEventListener('click', (e) => {
      e.stopPropagation();
      ['fardeau', 'carton', 'autre'].forEach(type => {
        _pkgDetailOpen[type] = true;
        _pkgCategOpen[type] = new Set((pkg.details[type] || []).map(cat => cat.name));
      });
      _renderConsolide();
    });
    document.getElementById('dmPkgCollapseAll')?.addEventListener('click', (e) => {
      e.stopPropagation();
      ['fardeau', 'carton', 'autre'].forEach(type => {
        _pkgDetailOpen[type] = false;
        _pkgCategOpen[type] = new Set();
      });
      _renderConsolide();
    });

    // النقر على Fardeau/Carton/Autre يفتح/يطوي تفصيل Catégorie Article ضمن نفس اللوحة (مثل قائمة BLs)
    document.querySelectorAll('#dmConsolideInner .dm-pkg-total-row[data-pkg-type]').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = row.dataset.pkgType;
        _pkgDetailOpen[type] = !_pkgDetailOpen[type];
        _renderConsolide();
      });
    });

    // النقر على فئة (Catégorie Article) يفتح/يطوي قائمة المنتجات داخلها
    document.querySelectorAll('#dmConsolideInner .dm-pkg-cat-row[data-pkg-type]').forEach(row => {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = row.dataset.pkgType;
        const idx = parseInt(row.dataset.catIdx, 10);
        const catName = pkg.details[type]?.[idx]?.name;
        if (catName === undefined) return;
        const set = _pkgCategOpen[type];
        if (set.has(catName)) set.delete(catName); else set.add(catName);
        _renderConsolide();
      });
    });

    document.querySelectorAll('.dm-actor-ftab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const tab = btn.dataset.actorTab;
        // Toggle: clicking the already-active tab resets to "all"
        _actorFilterTab = (_actorFilterTab === tab) ? 'all' : tab;
        _renderConsolide();
        _applyFilterTab();
      });
    });

    document.getElementById('dmToggleDetails')?.addEventListener('click', () => {
      _consolideDetailsOpen = !_consolideDetailsOpen;
      _renderConsolide();
    });

    document.getElementById('dmTourneeCountToggle')?.addEventListener('click', () => {
      _consolideTourneeListOpen = !_consolideTourneeListOpen;
      _renderConsolide();
    });

    // Selected-BLs modal renders/hides independently based on selection state
    _renderSelModal();
  }

  // ── Selection modal (separate floating modal) ───────────────
  // Shown only when 1+ BL is selected; lists ONLY the selected BLs (not all
  // assigned/available ones).
  function _renderSelModal() {
    const modal = document.getElementById('dmSelModal');
    const inner = document.getElementById('dmSelModalInner');
    if (!modal || !inner) return;

    if (_selectedBLIds.size === 0) {
      modal.style.display = 'none';
      return;
    }
    modal.style.display = 'flex';

    const selectedBLs = [..._selectedBLIds]
      .map(id => _assignedBLs.get(id) || _routeAssignedBLs.get(id) || _unassignedBLs.get(id))
      .filter(Boolean);
    // "Assigné" (لِزر Désaffecter) = في أي جولة كانت (أي actor) — حتى لا يبقى Désaffecter
    // مجمّداً عند (0) عند تحديد BLs من ليفرور آخر أو بدون اختيار ليفرور.
    const selectedAssigned = selectedBLs.filter(bl => _isInTournee(bl));
    // "À affecter" (لِزر Affecter) = كل BL ليس مُسنداً *للجولة الحالية المُختارة* —
    // سواء كان غير مُسند إطلاقاً أو مُسنداً لجولة/ليفرور آخر (سيُنقَل تلقائياً عبر
    // désaffectation ثم affectation داخل _doAssign). الاعتماد على _isInTournee فقط
    // كان يستبعد خطأً كل BL مُسند مسبقاً حتى لو لجولة أخرى، فيجمّد العدّاد.
    const toAddBLs = selectedBLs.filter(bl => !(_isInTournee(bl) && _assignedBLs.has(bl.id)));
    const selAmt = selectedBLs.reduce((s, bl) => s + (bl.amount_total || 0), 0);

    inner.innerHTML = `
      <div class="dm-modal-header" style="padding:10px 12px;border-bottom:1px solid var(--border,#E2E8F0);flex-shrink:0;display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:11px;font-weight:800;color:var(--text,#0F172A)">Sélection <span style="color:#16A34A">(${selectedBLs.length})</span></div>
        <button id="dmCloseSelModal" style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:18px;line-height:1;padding:2px">×</button>
      </div>

      <div style="padding:8px 12px 0;flex-shrink:0">
        <div style="position:relative">
          <input id="dmSelSearchInput" type="text" autocomplete="off" placeholder="Rechercher (réf. BL, client)…" value="${escHtml(_selModalSearchQuery)}"
            style="width:100%;box-sizing:border-box;font-size:11px;padding:5px 26px 5px 9px;border-radius:12px;border:1px solid var(--border,#E2E8F0);background:var(--bg,#F8FAFC);color:var(--text,#0F172A);outline:none">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);color:var(--text3,#94A3B8);pointer-events:none"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
      </div>

      <div style="flex:1;overflow-y:auto;padding:8px 12px">
        <table class="dm-table" style="margin-bottom:8px;table-layout:fixed;width:100%">
          <colgroup>
            <col style="width:44%">
            <col style="width:32%">
            <col style="width:18%">
            <col style="width:6%">
          </colgroup>
          <thead>
            <tr>
              <th>Client</th><th style="text-align:right">Total DA</th><th>Rotation</th><th></th>
            </tr>
          </thead>
          <tbody id="dmSelModalTbody">${_renderSelModalRows(selectedBLs, _selModalSearchQuery)}</tbody>
        </table>
      </div>

      <div style="padding:10px 12px;border-top:1px solid var(--border,#E2E8F0);flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="dm-btn-assign" id="dmBtnAssign" ${toAddBLs.length === 0 ? 'disabled' : ''}>
            Affecter (${toAddBLs.length})
          </button>
          <button class="dm-btn-unassign" id="dmBtnUnassign" ${selectedAssigned.length === 0 ? 'disabled' : ''}>
            Désaffecter (${selectedAssigned.length})
          </button>
          <div style="flex:1;text-align:right;font-size:11px;color:var(--text2,#475569)">
            Total: <b>${_fmtNum(selAmt, 0)} DA</b>
          </div>
        </div>
      </div>
    `;

    // Position + size + drag + resize (idempotent)
    _applyPanelFrame('dmSelModal');
    _bindPanelDrag('dmSelModal');
    _bindPanelResize('dmSelModal', 'dmSelModalResize');

    document.getElementById('dmCloseSelModal')?.addEventListener('click', () => {
      const idsToRefresh = [..._selectedBLIds];
      _selectedBLIds = new Set();
      idsToRefresh.forEach(id => _refreshMarkerIcon(id));
      _selModalSearchQuery = '';
      _renderSelModal();
    });

    const searchInput = inner.querySelector('#dmSelSearchInput');
    if (searchInput) {
      // نعيد رسم صفوف الجدول فقط عند الكتابة (وليس المودال كاملاً) حتى لا
      // يفقد حقل البحث تركيزه/مؤشره مع كل حرف يُكتب.
      searchInput.addEventListener('input', () => {
        _selModalSearchQuery = searchInput.value;
        const tbody = inner.querySelector('#dmSelModalTbody');
        if (tbody) {
          tbody.innerHTML = _renderSelModalRows(selectedBLs, _selModalSearchQuery);
          _bindSelModalRowEvents(inner, selectedBLs);
        }
      });
    }

    _bindSelModalRowEvents(inner, selectedBLs);

    document.getElementById('dmBtnAssign')?.addEventListener('click', _doAssign);
    document.getElementById('dmBtnUnassign')?.addEventListener('click', async () => {
      const ids = [..._selectedBLIds].filter(id => {
        const bl = _assignedBLs.get(id) || _routeAssignedBLs.get(id);
        return bl && _isInTournee(bl);
      });
      if (!ids.length) return;
      await _doUnassign(ids, true);
    });
  }

  // يبني صفوف <tr> الخاصة بجدول "Sélection"، مصفّاة حسب نص البحث (إن وُجد).
  function _renderSelModalRows(selectedBLs, query) {
    const filtered = selectedBLs.filter(bl => _selModalMatchesSearch(bl, query));
    if (!filtered.length) {
      return `<tr><td colspan="4" style="text-align:center;padding:14px 6px;font-size:11px;color:var(--text3,#94A3B8)">Aucun résultat</td></tr>`;
    }
    return filtered.map(bl => {
      const cat = _blCategory(bl);
      const clusterLetter = _categoryLetter(cat);
      const clusterColor = _blColor(bl);
      const hasBtoB = _hasBtoBBadge(bl);
      const hasAcile = _hasAcileBadge(bl);
      const hasReported = _hasReportedBadge(bl);
      const isAssigned = _assignedBLs.has(bl.id);
      const isPending = _isPendingBL(bl.id);
      const blPkg = _classifyPackaging([bl]);
      return `<tr data-bl-id="${bl.id}" class="dm-sel-row" style="${isPending ? 'background:#FFFBEB' : ''}">
        <td style="overflow:hidden" title="${escHtml(bl.partner_shipping_id?.name || '')}">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${isPending ? '<span title="En attente" style="color:#F59E0B;margin-right:3px">⏳</span>' : ''}${escHtml(bl.partner_shipping_id?.name || '—')}${_clientLinkIconHtml(bl.partner_shipping_id?.id, null)}</div>
          <div style="font-size:9px;color:var(--text3,#94A3B8);margin-top:1px;white-space:nowrap">C: <b style="color:var(--text2,#475569)">${Number.isInteger(blPkg.carton) ? blPkg.carton : _fmtNum(blPkg.carton, 2)}</b> · F: <b style="color:var(--text2,#475569)">${Number.isInteger(blPkg.fardeau) ? blPkg.fardeau : _fmtNum(blPkg.fardeau, 2)}</b></div>
        </td>
        <td style="text-align:right;font-weight:600">
          <div style="display:flex;flex-wrap:nowrap;align-items:center;justify-content:flex-end;gap:4px;white-space:nowrap">
            <span style="display:inline-flex;align-items:center;justify-content:flex-end;gap:4px;min-width:34px;flex-shrink:0">
              ${hasBtoB ? `<span title="BtoB" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#F59E0B;color:#fff;font-size:8.5px;font-weight:800;flex-shrink:0">B</span>` : ''}
              ${hasAcile ? `<span title="ACILE" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;overflow:hidden;flex-shrink:0"><img src="data:image/png;base64,${_ACILE_LOGO_B64}" style="width:100%;height:100%;object-fit:cover" alt="ACILE"/></span>` : ''}
              ${hasReported ? `<span title="Reporté" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:#8B5CF6;flex-shrink:0">${_hourglassIconSvg('#fff')}</span>` : ''}
              ${clusterLetter ? `<span title="${escHtml(cat)}" style="display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:${clusterColor};color:#fff;font-size:8.5px;font-weight:800;flex-shrink:0">${clusterLetter}</span>` : ''}
            </span>
            <span style="min-width:44px;text-align:right;flex-shrink:0">${_fmtNum(bl.amount_total, 0)}</span>
          </div>
        </td>
        <td style="overflow:hidden">
          ${isAssigned ? `<select class="dm-rotation-sel" data-bl-id="${bl.id}" data-current-rotation="${escHtml(bl.delivery_rotation || '1')}">
            ${['1','2','3','4'].map(r => `<option value="${r}" ${bl.delivery_rotation === r ? 'selected' : ''}>R-${r}</option>`).join('')}
          </select>` : '—'}
        </td>
        <td>
          <button class="dm-btn-desel" data-bl-id="${bl.id}" title="Retirer de la sélection" style="background:none;border:none;color:#DC2626;cursor:pointer;padding:2px;border-radius:3px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  // يربط أحداث صفوف الجدول (نقر/إزالة/تغيير الجولة) — يُستدعى بعد كل رسم
  // للصفوف، سواء عند الفتح الأول للمودال أو عند إعادة تصفيتها بالبحث.
  function _bindSelModalRowEvents(inner, selectedBLs) {
    inner.querySelectorAll('.dm-sel-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', (e) => {
        if (e.target.closest('.dm-btn-desel') || e.target.closest('.dm-rotation-sel')) return;
        const blId = Number(row.dataset.blId);
        const bl = selectedBLs.find(b => b.id === blId);
        if (bl && typeof window._showBLDetails === 'function') {
          window._showBLDetails(bl, getOdooBase(), selectedBLs);
        }
      });
    });

    inner.querySelectorAll('.dm-btn-desel').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.blId);
        _selectedBLIds.delete(id);
        _refreshMarkerIcon(id);
        _renderSelModal();
      });
    });

    inner.querySelectorAll('.dm-rotation-sel').forEach(sel => {
      sel.addEventListener('change', async e => {
        const blId = Number(e.target.dataset.blId);
        const newRot = e.target.value;
        const bl = _assignedBLs.get(blId);
        if (!bl) return;
        const actor = _actors.find(a => a.id === _selectedActorId);
        if (!actor) return;
        if (!_acquireBusy('Mise à jour de la rotation…')) { e.target.value = e.target.dataset.currentRotation; return; }
        const planningId = _planningIsNew(actor) ? 0 : actor.planning_id.id;
        try {
          await _assignDeliveries(planningId, [{ delivery_id: blId, delivery_rotation: newRot }], _selectedActorId);
          await _refreshActorAndBLs();
        } catch (err) {
          addNotif?.('Erreur rotation: ' + err.message, 'error');
          e.target.value = e.target.dataset.currentRotation; // revert
        } finally {
          _releaseBusy();
        }
      });
    });
  }

  function _hideConsolide() {
    const panel = document.getElementById('dmConsolide');
    if (panel) panel.style.display = 'none';
  }

  function _isPendingBL(blId) {
    return _pendingOps.some(o => o.blId === blId);
  }

  function _sumObj(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    return Object.values(obj).reduce((s, v) => s + (Number(v) || 0), 0);
  }

  // ── Draft mode: bar events, pending badge, apply/cancel ──────
  function _attachDraftBarEvents(viewEl) {
    const sw = viewEl.querySelector('#dmDraftSwitch');
    if (sw) {
      sw.addEventListener('change', async (e) => {
        if (_pendingOps.length) {
          e.target.checked = _draftMode; // ابقِ الحالة كما هي
          addNotif?.("Vous avez des modifications en attente. Appliquez-les ou annulez-les avant de changer de mode.", 'warning');
          return;
        }
        _draftMode = e.target.checked;
        try { localStorage.setItem(_DRAFT_MODE_KEY, _draftMode ? '1' : '0'); } catch (err) {}
        const track = viewEl.querySelector('#dmDraftTrack');
        const knob = viewEl.querySelector('#dmDraftKnob');
        if (track) track.style.background = _draftMode ? '#3B82F6' : '#CBD5E1';
        if (knob) knob.style.left = _draftMode ? '16px' : '2px';
      });
    }
    viewEl.querySelector('#dmBtnApplyDraft')?.addEventListener('click', _applyPendingDraft);
    viewEl.querySelector('#dmBtnCancelDraft')?.addEventListener('click', _cancelPendingDraft);
    _updatePendingUI();
  }

  function _updatePendingUI() {
    const badge = document.getElementById('dmPendingBadge');
    const count = document.getElementById('dmPendingCount');
    if (!badge || !count) return;
    if (_pendingOps.length) {
      badge.style.display = 'flex';
      count.textContent = `${_pendingOps.length} modification(s) en attente`;
    } else {
      badge.style.display = 'none';
    }
  }

  function _setDraftBtnLoading(on) {
    const btn = document.getElementById('dmBtnApplyDraft');
    if (!btn) return;
    btn.disabled = on;
    if (on) btn.dataset._origText = btn.textContent;
    btn.textContent = on ? '…' : (btn.dataset._origText || 'Appliquer');
  }

  // ينفّذ فعلياً كل العمليات المعلّقة على الخادم، بالترتيب، مجمّعة قدر الإمكان.
  async function _applyPendingDraft() {
    if (!_pendingOps.length) return;
    if (!_acquireBusy('Application des modifications…')) return;
    _setDraftBtnLoading(true);
    try {
      const ops = _pendingOps;
      _pendingOps = [];

      // 1) désaffectations (directes + celles issues d'un déplacement depuis une autre tournée)
      const unassignGroups = new Map(); // planningId -> [blId,...]
      ops.filter(o => o.type === 'unassign').forEach(o => {
        if (o.planningId == null) return;
        if (!unassignGroups.has(o.planningId)) unassignGroups.set(o.planningId, []);
        unassignGroups.get(o.planningId).push(o.blId);
      });
      ops.filter(o => o.type === 'assign' && o.fromPlanningId != null).forEach(o => {
        if (!unassignGroups.has(o.fromPlanningId)) unassignGroups.set(o.fromPlanningId, []);
        unassignGroups.get(o.fromPlanningId).push(o.blId);
      });
      for (const [planningId, ids] of unassignGroups) {
        await _unassignDeliveries(planningId, ids);
      }

      // 2) affectations، مجمّعة حسب الـ actor (livreur)
      const assignGroups = new Map(); // actorId -> [{delivery_id, delivery_rotation}]
      ops.filter(o => o.type === 'assign').forEach(o => {
        if (!assignGroups.has(o.actorId)) assignGroups.set(o.actorId, []);
        assignGroups.get(o.actorId).push({ delivery_id: o.blId, delivery_rotation: o.rotation || '1' });
      });
      const newlyCreatedActorIds = []; // ليفروريون كانت جولتهم غير موجودة قبل هذا التطبيق
      for (const [actorId, toAdd] of assignGroups) {
        const actor = _actors.find(a => a.id === actorId);
        if (!actor) continue;
        const wasNewPlanning = _planningIsNew(actor);
        const planningId = wasNewPlanning ? 0 : actor.planning_id.id;
        await _assignDeliveries(planningId, toAdd, actorId);
        if (wasNewPlanning) newlyCreatedActorIds.push(actorId);
      }

      addNotif?.(`${ops.length} modification(s) appliquée(s) avec succès`, 'success');

      // نُحدّد فقط الليفروريين الذين تأثروا فعلاً بهذا التطبيق، ونطلب بياناتهم
      // فقط — بدل استعلام كل ليفرور في التطبيق (كان هذا سبب البطء).
      const touchedActorIds = new Set([...assignGroups.keys()]);
      for (const planningId of unassignGroups.keys()) {
        const a = _actors.find(x => !_planningIsNew(x) && x.planning_id?.id === planningId);
        if (a) touchedActorIds.add(a.id);
      }
      await _loadRouteAssignedBLsForActors(touchedActorIds);
      if (_selectedActorId) await _refreshActorAndBLs();
      _renderAllMarkers();
      _renderConsolide();
      _renderSelModal();
      // كما في _doAssign: انتظر ظهور مرجع الجولة فوراً في شريط الموزعين للجولات
      // المُنشأة حديثاً، بدل الحاجة لتحديث الصفحة يدوياً.
      if (newlyCreatedActorIds.length) {
        await Promise.all(newlyCreatedActorIds.map(id => _waitForActorPlanningRef(id)));
      }
    } catch (e) {
      addNotif?.('Erreur lors de l\'application des modifications: ' + (e.message || String(e)), 'error');
      // في حال الفشل، من الأسلم إعادة القراءة من الخادم لتفادي عدم تطابق الحالة المحلية.
      // نستخدم الاستعلام الكامل هنا فقط لأن نطاق الأخطاء قد يشمل أي ليفرور.
      await _loadAllRouteAssignedBLs();
      if (_selectedActorId) await _refreshActorAndBLs();
      _renderAllMarkers();
    } finally {
      _setDraftBtnLoading(false);
      _updatePendingUI();
      _releaseBusy();
    }
  }

  // يلغي كل التعديلات المعلّقة (التي لم تُرسَل أصلاً للخادم) ويعيد الحالة المحلية
  // كما هي في الخادم بإعادة تحميلها.
  async function _cancelPendingDraft() {
    if (!_pendingOps.length) return;
    // نلتقط الليفروريين المتأثرين بالتعديلات المعلّقة قبل مسحها، لنطلب بياناتهم
    // فقط بدل كل ليفرور في التطبيق.
    const touchedActorIds = new Set();
    _pendingOps.forEach(o => {
      if (o.type === 'assign') touchedActorIds.add(o.actorId);
      if (o.planningId != null) {
        const a = _actors.find(x => !_planningIsNew(x) && x.planning_id?.id === o.planningId);
        if (a) touchedActorIds.add(a.id);
      }
    });
    _pendingOps = [];
    try {
      await _loadRouteAssignedBLsForActors(touchedActorIds);
      if (_selectedActorId) {
        await _refreshActorAndBLs();
      } else {
        const unassigned = await _getDeliveries();
        _unassignedBLs = new Map((unassigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
      }
      _renderAllMarkers();
      _renderConsolide();
      _renderSelModal();
      addNotif?.('Modifications en attente annulées', 'info');
    } finally {
      _updatePendingUI();
    }
  }

  // ── Assign ─────────────────────────────────────────────────
  async function _doAssign() {
    const actor = _actors.find(a => a.id === _selectedActorId);
    if (!actor) return;

    // BLs selected that belong to ANOTHER actor's tournée: must be désaffecté
    // from their old planning before being affecté to the new one.
    const otherActorBLs = [..._routeAssignedBLs.values()].filter(bl =>
      _selectedBLIds.has(bl.id) && _isInTournee(bl) && !_assignedBLs.has(bl.id)
    );
    const otherActorIds = new Set(otherActorBLs.map(bl => bl.id));

    // ⚠️ Doit rester STRICTEMENT identique au calcul de "toAddBLs" utilisé pour
    // activer/désactiver le bouton "Affecter" (_renderSelModal). On se base sur
    // _isInTournee + _assignedBLs plutôt que sur `_unassignedBLs.has(id)` seul :
    // un BL "Reporté" (ou tout autre BL non encore présent dans _unassignedBLs à
    // cause d'un cache local pas encore synchronisé) pouvait être compté dans le
    // libellé du bouton ("Affecter (N)") sans jamais être envoyé au serveur ici,
    // ce qui gelait le bouton — le clic ne faisait rien silencieusement.
    const toAdd = [..._selectedBLIds]
      .filter(id => !otherActorIds.has(id))
      .map(id => {
        const bl = _assignedBLs.get(id) || _routeAssignedBLs.get(id) || _unassignedBLs.get(id);
        if (!bl || (_isInTournee(bl) && _assignedBLs.has(id))) return null; // déjà affecté à cet acteur
        return { delivery_id: id, delivery_rotation: bl.delivery_rotation || '1' };
      })
      .filter(Boolean);

    otherActorBLs.forEach(bl => {
      toAdd.push({ delivery_id: bl.id, delivery_rotation: bl.delivery_rotation || '1' });
    });

    if (!toAdd.length) return;

    // ── Draft mode: تسجيل التعديل محليًا فقط، بدون أي استدعاء للخادم ──
    if (_draftMode) {
      toAdd.forEach(({ delivery_id: id, delivery_rotation: rotation }) => {
        const fromOther = otherActorBLs.find(bl => bl.id === id);
        _pendingOps.push({
          type: 'assign',
          blId: id,
          actorId: _selectedActorId,
          rotation,
          fromPlanningId: fromOther ? (fromOther.planning_delivery_id?.id ?? null) : null
        });
        const existing = _unassignedBLs.get(id) || _routeAssignedBLs.get(id) || _assignedBLs.get(id) || {};
        const draftPlanningId = (!_planningIsNew(actor)) ? actor.planning_id.id : `draft-${actor.id}`;
        const updated = {
          ...existing,
          id,
          planning_delivery_id: { id: draftPlanningId },
          delivery_user_id: { id: actor.id, display_name: actor.name },
          delivery_rotation: rotation
        };
        _unassignedBLs.delete(id);
        _routeAssignedBLs.set(id, updated);
        _assignedBLs.set(id, updated); // actor sélectionné == cet actor (bouton visible seulement pour lui)
        _selectedBLIds.delete(id);
      });
      addNotif?.(`${toAdd.length} BL(s) en attente (mode brouillon)`, 'info');
      _renderAllMarkers();
      _renderConsolide();
      _renderSelModal();
      _updatePendingUI();
      return;
    }

    const wasNewPlanning = _planningIsNew(actor); // جولة جديدة ستُنشأ الآن إن لم تكن موجودة
    const planningId = wasNewPlanning ? 0 : actor.planning_id.id;

    if (!_acquireBusy('Affectation en cours…')) return;
    _setBtnLoading('dmBtnAssign', true);
    try {
      // Group the "other actor" BLs by their old planning and désaffecter them first.
      const byOldPlanning = new Map();
      otherActorBLs.forEach(bl => {
        const pid = bl.planning_delivery_id.id;
        if (!byOldPlanning.has(pid)) byOldPlanning.set(pid, []);
        byOldPlanning.get(pid).push(bl.id);
      });
      for (const [oldPlanningId, ids] of byOldPlanning) {
        await _unassignDeliveries(oldPlanningId, ids);
      }

      const result = await _assignDeliveries(planningId, toAdd, _selectedActorId);
      const added = result?.added || [];
      const movedCount = otherActorBLs.length;
      addNotif?.(
        movedCount
          ? `${added.length} BL(s) affecté(s) (dont ${movedCount} déplacé(s) d'une autre tournée)`
          : `${added.length} BL(s) affecté(s)`,
        'success'
      );

      // Un-select them (they move to assigned)
      added.forEach(id => _selectedBLIds.delete(id));
      // العملية الحرجة (الكتابة على الخادم) انتهت هنا: نُحرّر التجميد فوراً
      // بدل الانتظار لتحديث القوائم/الخرائط، الذي قد يستغرق وقتاً أطول
      // دون أن يشكّل خطر تداخل حقيقي (قراءة فقط).
      _releaseBusy();
      await _refreshActorAndBLs();
      // ملاحظة: لا حاجة لـ _loadAllRouteAssignedBLs() هنا — _refreshActorAndBLs
      // يُحدّث _routeAssignedBLs بدقة لكل الـ BL المتأثرة بهذه العملية (كلها
      // تخص الليفرور المحدد)، فتفادينا استعلام كل ليفرور آخر بلا داعٍ (كان
      // هذا السبب الرئيسي في بطء العملية).
      // إن كانت هذه أول affectation لهذا الليفرور (جولة جديدة)، تأكد من ظهور مرجعها
      // فوراً في شريط الموزعين بدل انتظار refresh يدوي للصفحة.
      if (wasNewPlanning && added.length) {
        await _waitForActorPlanningRef(_selectedActorId);
      }
    } catch (e) {
      addNotif?.('Erreur affectation: ' + (e.message || String(e)), 'error');
      _releaseBusy();
    } finally {
      _setBtnLoading('dmBtnAssign', false);
    }
  }

  let _unassignInFlight = false;

  async function _doUnassign(blIds, withUndo) {
    if (_unassignInFlight) return; // يمنع سباق الطلبات (double-click / زر الصف + الزر العام معًا)
    if (!_acquireBusy('Désaffectation en cours…')) return;

    // ── Draft mode: تسجيل الإزالة محليًا فقط، بدون أي استدعاء للخادم ──
    if (_draftMode) {
      let n = 0;
      blIds.forEach(id => {
        const bl = _assignedBLs.get(id) || _routeAssignedBLs.get(id);
        if (!bl || !_isInTournee(bl)) return;
        // إن كان هذا BL نفسه ضمن تعديل "assign" معلّق لم يُطبَّق بعد، فيكفي إلغاء ذلك
        // التعديل بدل تسجيل عملية إزالة زائدة.
        const pendingAssignIdx = _pendingOps.findIndex(o => o.type === 'assign' && o.blId === id);
        if (pendingAssignIdx !== -1) {
          _pendingOps.splice(pendingAssignIdx, 1);
        } else {
          _pendingOps.push({ type: 'unassign', blId: id, planningId: bl.planning_delivery_id.id });
        }
        _routeAssignedBLs.delete(id);
        _assignedBLs.delete(id);
        const updated = { ...bl, planning_delivery_id: false, delivery_user_id: false };
        _unassignedBLs.set(id, updated);
        _selectedBLIds.delete(id);
        n++;
      });
      if (!n) { _releaseBusy(); return; }
      addNotif?.(`${n} BL(s) en attente de désaffectation (mode brouillon)`, 'info');
      _renderAllMarkers();
      _renderConsolide();
      _renderSelModal();
      _updatePendingUI();
      _releaseBusy();
      return;
    }

    // BLs sélectionnés peuvent appartenir à des tournées différentes (voire aucune
    // n'étant celle de l'acteur actuellement sélectionné). On regroupe donc par
    // planning_delivery_id réel de chaque BL plutôt que d'exiger l'acteur sélectionné.
    const groups = new Map(); // planningId -> [blId,...]
    blIds.forEach(id => {
      const bl = _assignedBLs.get(id) || _routeAssignedBLs.get(id);
      const pid = bl?.planning_delivery_id?.id;
      if (pid == null) return;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(id);
    });

    if (!groups.size) {
      addNotif?.('Aucune tournée active à désaffecter', 'warning');
      _releaseBusy();
      return;
    }

    _unassignInFlight = true;
    _setBtnLoading('dmBtnUnassign', true);
    const allDeleted = [];
    const originRotations = new Map(blIds.map(id => [id, (_assignedBLs.get(id) || _routeAssignedBLs.get(id))?.delivery_rotation || '1']));
    try {
      for (const [planningId, ids] of groups) {
        const result = await _unassignDeliveries(planningId, ids);
        const deleted = result?.deleted || ids;
        allDeleted.push(...deleted);
      }
      addNotif?.(`${allDeleted.length} BL(s) désaffecté(s)`, 'success');

      // العملية الحرجة على الخادم انتهت هنا: نحرّر التجميد فوراً، الباقي قراءة/تحديث محلي فقط.
      _unassignInFlight = false;
      _releaseBusy();

      if (withUndo) {
        const toReAddByActor = allDeleted.map(id => ({ delivery_id: id, delivery_rotation: originRotations.get(id) || '1' }));
        _pushUndo({
          type: 'assign',
          msg: `Annuler la désaffectation de ${allDeleted.length} BL(s)`,
          action: async () => {
            const a = _actors.find(x => x.id === _selectedActorId);
            const pid = a && !_planningIsNew(a) ? a.planning_id.id : 0;
            await _assignDeliveries(pid, toReAddByActor, _selectedActorId);
            await _refreshActorAndBLs();
          }
        });
      }

      allDeleted.forEach(id => _selectedBLIds.delete(id));
      // Le BL désaffecté n'est plus "dans une tournée" mais reste un BL actif
      // valide : il doit repasser dans le pool _unassignedBLs (sinon il disparaît
      // de partout — marqueurs, modale — jusqu'au rechargement de la page).
      allDeleted.forEach(id => {
        const bl = _assignedBLs.get(id) || _routeAssignedBLs.get(id);
        _routeAssignedBLs.delete(id);
        _assignedBLs.delete(id);
        if (bl) {
          const updated = { ...bl, planning_delivery_id: false, delivery_user_id: false };
          _unassignedBLs.set(id, updated);
        }
      });
      if (_selectedActorId) {
        await _refreshActorAndBLs();
      } else {
        // Aucun acteur sélectionné : on rafraîchit quand même l'affichage local
        // (marqueurs + modale de sélection) avec les données déjà mises à jour.
        allDeleted.forEach(id => _refreshMarkerIcon?.(id));
        _renderAllMarkers?.();
        _renderConsolide?.();
        _renderSelModal();
      }
    } catch (e) {
      const msg = e.message || String(e);
      // "Enregistrement inexistant ou détruit" على planning.planning: الجولة
      // انحذفت أصلاً (سلوك متوقع عند تفريغها بالكامل) لكن الواجهة كانت متأخرة
      // بسبب طلب متزامن سابق. نتعامل معه كحالة "تمّت العملية فعليًا" بدل خطأ حقيقي.
      if (/inexistant ou d[ée]truit/i.test(msg) && /planning\.planning/i.test(msg)) {
        addNotif?.('الجولة كانت قد حُذفت مسبقًا (نُفّذت العملية بالفعل)', 'warning');
        blIds.forEach(id => _selectedBLIds.delete(id));
        await _refreshActorAndBLs();
      } else {
        addNotif?.('Erreur désaffectation: ' + msg, 'error');
      }
      _unassignInFlight = false;
      _releaseBusy();
    } finally {
      _setBtnLoading('dmBtnUnassign', false);
    }
  }

  function _setBtnLoading(id, on) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = on;
    if (on) btn.dataset._origText = btn.textContent;
    btn.textContent = on ? '…' : (btn.dataset._origText || btn.textContent);
  }

  // ── Refresh after assign/unassign ──────────────────────────
  // بعد إنشاء جولة جديدة (planningId = 0)، قد يستغرق Odoo لحظة إضافية حتى يُحسب
  // مرجع الجولة (planning_id.name) فعلياً على السيرفر — فتصل استجابة _getActor
  // الأولى أحياناً وكأن الليفرور لا يزال بلا جولة، مما يُظهر تأخّراً في شريط
  // الموزعين إلى حين تحديث الصفحة يدوياً. نُعيد جلب الـ actor عدة محاولات قصيرة
  // حتى يظهر مرجع الجولة، بدل انتظار refresh كامل للصفحة.
  async function _waitForActorPlanningRef(actorId, attempts = 5, delayMs = 350) {
    for (let i = 0; i < attempts; i++) {
      const idx = _actors.findIndex(a => a.id === actorId);
      const cur = idx >= 0 ? _actors[idx] : null;
      if (cur && !_planningIsNew(cur) && cur.planning_id?.name) return; // مرجع الجولة ظاهر بالفعل
      await new Promise(r => setTimeout(r, delayMs));
      try {
        const actor = await _getActor(actorId);
        if (idx >= 0) _actors[idx] = actor;
        _renderActorsList();
        if (!_planningIsNew(actor) && actor.planning_id?.name) return;
      } catch (e) { /* تجاهل، سنحاول مجدداً */ }
    }
  }

  // زر "🔄 Actualiser": يعيد تحميل كل الـ BL (غير مسندة + مسندة لكل الجولات)
  // بدل انتظار تحديث الصفحة يدوياً بعد إضافة BL أو أي عملية جديدة في Odoo.
  async function _refreshAllBLs(btnEl) {
    if (!_acquireBusy('Actualisation…')) return;
    if (btnEl) { btnEl.disabled = true; btnEl.classList.add('dm-spin'); }
    try {
      if (_selectedActorId) {
        // ثلاث استدعاءات فقط بالتوازي — سريعة، لا حاجة لتمديد التجميد بعدها.
        const [actor, allUnassigned, assigned] = await Promise.all([
          _getActor(_selectedActorId),
          _getDeliveries(),
          _getDeliveries(_selectedActorId),
        ]);
        const idx = _actors.findIndex(a => a.id === _selectedActorId);
        if (idx >= 0) _actors[idx] = actor;
        const oldAssignedIds = new Set(_assignedBLs.keys());
        _unassignedBLs = new Map((allUnassigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
        _assignedBLs = new Map((assigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
        oldAssignedIds.forEach(id => { if (!_assignedBLs.has(id)) _routeAssignedBLs.delete(id); });
        _assignedBLs.forEach((bl, id) => _routeAssignedBLs.set(id, bl));
        _renderActorsList();
        _renderAllMarkers();
        _renderConsolide();
        _updateBLCount();
        addNotif?.('BL(s) actualisés', 'success');
        _releaseBusy(); // التجميد يُحرَّر هنا؛ ما تبقى تحميل خلفي غير حاجب
        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('dm-spin'); }

        const ids = [...(allUnassigned||[]).map(b=>b.id), ...(assigned||[]).map(b=>b.id)];
        _loadOrigins(ids).then(() => { _renderAllMarkers(); _renderConsolide(); });
        _loadCreateDates(ids).then(() => _applyFilterTab());
        _loadVendeurs(ids).then(() => _applyFilterTab());
        _loadReportDates(ids).then(() => {
          _markers.forEach((m, blId) => _refreshMarkerIcon(blId));
          _applyFilterTab();
        });
        _loadPricelists([...(allUnassigned||[]), ...(assigned||[])].map(bl => bl?.partner_shipping_id?.id)).then(() => {
          _renderAllMarkers();
          _renderConsolide();
        });
        return;
      }

      // لا يوجد ليفرور محدد: نجلب فقط الـ actors + BL غير مسندة أولاً (سريع)،
      // ثم نحرّر التجميد، ونكمل جلب "كل BL مسندة لأي جولة" في الخلفية —
      // هذا الاستدعاء الأخير هو الأبطأ لأنه يستعلم كل ليفرور على حدة.
      const [actors, unassigned] = await Promise.all([_getActors(), _getDeliveries()]);
      _actors = actors || [];
      _unassignedBLs = new Map((unassigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
      _renderActorsList();
      _renderAllMarkers();
      _updateBLCount();
      addNotif?.('BL(s) actualisés', 'success');
      _releaseBusy();
      if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('dm-spin'); }

      await _loadAllRouteAssignedBLs();
      _renderAllMarkers();
      _renderConsolide();
      const ids = [..._unassignedBLs.keys(), ..._routeAssignedBLs.keys()];
      _loadOrigins(ids).then(() => { _renderAllMarkers(); _renderConsolide(); });
      _loadCreateDates(ids).then(() => _applyFilterTab());
      _loadVendeurs(ids).then(() => _applyFilterTab());
      _loadReportDates(ids).then(() => {
        _markers.forEach((m, blId) => _refreshMarkerIcon(blId));
        _applyFilterTab();
      });
      const _allBls = [...new Map([..._unassignedBLs, ..._routeAssignedBLs]).values()];
      _loadPricelists(_allBls.map(bl => bl?.partner_shipping_id?.id)).then(() => {
        _renderAllMarkers();
        _renderConsolide();
      });
    } catch (e) {
      addNotif?.('Erreur lors de l\'actualisation: ' + (e.message || String(e)), 'error');
      _releaseBusy();
      if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('dm-spin'); }
    }
  }

  async function _refreshActorAndBLs() {
    if (!_selectedActorId) return;
    try {
      const [actor, allUnassigned, assigned] = await Promise.all([
        _getActor(_selectedActorId),
        _getDeliveries(),                    // all unassigned
        _getDeliveries(_selectedActorId),    // this actor's BLs
      ]);

      // Update actor
      const idx = _actors.findIndex(a => a.id === _selectedActorId);
      if (idx >= 0) _actors[idx] = actor;

      const oldAssignedIds = new Set(_assignedBLs.keys());
      _unassignedBLs = new Map((allUnassigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));
      _assignedBLs = new Map((assigned || []).filter(_isActiveBL).map(bl => [bl.id, bl]));

      // Keep the global "assigned to any tournée" set in sync with this change
      oldAssignedIds.forEach(id => { if (!_assignedBLs.has(id)) _routeAssignedBLs.delete(id); });
      _assignedBLs.forEach((bl, id) => _routeAssignedBLs.set(id, bl));

      _renderActorsList();
      _renderAllMarkers();
      _renderConsolide();
      _loadOrigins([...(allUnassigned||[]).map(b=>b.id), ...(assigned||[]).map(b=>b.id)]).then(() => {
        _renderAllMarkers();
        _renderConsolide();
      });
      _loadCreateDates([...(allUnassigned||[]).map(b=>b.id), ...(assigned||[]).map(b=>b.id)]).then(() => {
        _applyFilterTab();
      });
      _loadVendeurs([...(allUnassigned||[]).map(b=>b.id), ...(assigned||[]).map(b=>b.id)]).then(() => {
        _applyFilterTab();
      });
      _loadReportDates([...(allUnassigned||[]).map(b=>b.id), ...(assigned||[]).map(b=>b.id)]).then(() => {
        _markers.forEach((m, blId) => _refreshMarkerIcon(blId));
        _applyFilterTab();
      });
      _loadPricelists([...(allUnassigned||[]), ...(assigned||[])].map(bl => bl?.partner_shipping_id?.id)).then(() => {
        _renderAllMarkers();
        _renderConsolide();
      });
      const _refreshBls = [...(allUnassigned||[]), ...(assigned||[])];
      const _refreshPids = [...new Set(
        _refreshBls.flatMap(bl => (bl.move_lines || []).map(l => {
          const raw = l.product_id;
          if (Array.isArray(raw)) return parseInt(raw[0], 10);
          if (typeof raw === 'number') return raw;
          if (typeof raw === 'string' && /^\d+$/.test(raw)) return parseInt(raw, 10);
          if (typeof raw === 'string' && raw.trim()) return raw.trim();
          return null;
        }).filter(id => id !== null && id !== '' && !(typeof id === 'number' && id <= 0)))
      )];
      if (_refreshPids.length) {
        _loadPackagingQtys(_refreshPids).then(() => { _renderConsolide(); });
      }
    } catch (e) {
      addNotif?.('Erreur de mise à jour: ' + e.message, 'error');
    }
  }

  // ── Undo system ────────────────────────────────────────────
  function _pushUndo(entry) {
    _undoStack = [entry]; // single-level undo for now
    const toast = document.getElementById('dmUndoToast');
    const msg = document.getElementById('dmUndoMsg');
    if (!toast || !msg) return;
    msg.textContent = entry.msg;
    toast.style.display = 'flex';
    if (_undoTimer) clearTimeout(_undoTimer);
    _undoTimer = setTimeout(_hideUndo, 8000);
  }

  function _hideUndo() {
    const toast = document.getElementById('dmUndoToast');
    if (toast) toast.style.display = 'none';
    if (_undoTimer) { clearTimeout(_undoTimer); _undoTimer = null; }
  }

  async function _doUndo() {
    const entry = _undoStack.pop();
    if (!entry) return;
    if (!_acquireBusy('Annulation…')) { _undoStack.push(entry); return; }
    _hideUndo();
    try {
      await entry.action();
      addNotif?.('Action annulée', 'info');
    } catch (e) {
      addNotif?.('Impossible d\'annuler: ' + e.message, 'error');
    } finally {
      _releaseBusy();
    }
  }

  // ── Mount the view in index.html ───────────────────────────
  function mount() {
    // Add mode button if missing
    if (!document.getElementById('btnModeDeliveryMap')) {
      const anchor = document.getElementById('btnModeRoute');
      const container = anchor?.parentElement;
      if (container) {
        const btn = document.createElement('button');
        btn.id = 'btnModeDeliveryMap';
        btn.className = 'mode-btn mode-btn--delivmap';
        btn.setAttribute('data-mode', 'delivmap');
        btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="vertical-align:-1px"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg> TOURNÉES`;
        container.appendChild(btn);
        btn.addEventListener('click', () => {
          if (window.setMode) window.setMode('delivmap');
          else show();
        });
      }
    }

    // Inject CSS for mode button active state
    if (!document.getElementById('_dmModeStyle')) {
      const s = document.createElement('style');
      s.id = '_dmModeStyle';
      s.textContent = `
        .mode-btn--delivmap { flex:0 0 auto!important;padding-left:8px!important;padding-right:8px!important; }
        .mode-btn[data-mode="delivmap"].mode-btn--active { background:#FFF7ED;border-color:#EA580C;color:#EA580C;box-shadow:0 0 8px rgba(234,88,12,.2); }
        [data-theme="dark"] .mode-btn[data-mode="delivmap"].mode-btn--active { background:rgba(234,88,12,.15);border-color:#EA580C;color:#EA580C; }
      `;
      document.head.appendChild(s);
    }

    // Inject deliveryMapView div if missing
    if (!document.getElementById('deliveryMapView')) {
      const rv = document.getElementById('routesView');
      if (rv) {
        const div = document.createElement('div');
        div.id = 'deliveryMapView';
        div.style.cssText = 'display:none;flex-direction:column;flex:1;overflow:hidden';
        rv.after(div);
      }
    }

  }

  return { mount, show };
})();

window.DeliveryPlanner = DeliveryPlanner;

// Auto-mount when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => DeliveryPlanner.mount());
} else {
  // DOMContentLoaded already fired — try now, fallback to after app init
  setTimeout(() => DeliveryPlanner.mount(), 500);
}

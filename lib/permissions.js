// lib/permissions.js
// المرحلة الأولى: صلاحيات الكرت (card.*) + إدارة الـ agents (agents.*)

const ALL_PERMISSIONS = [
  "card.open",
  "card.openRoute",
  "card.analyseBl",
  "card.copyRef",
  "card.clearRound",
  "card.fetchLink",
  "card.acceptHors",
  "card.allowHorsZone",
  "card.planningCtrl.open",
  "card.planningCtrl.close",
  "card.payment.create",
  "card.payment.autoFill",
  "card.addProduct.submit",
  "card.addClient.submit",
  "card.deleteClient.submit",
  "card.addRouteClient.submit",
  "card.editRouteClient.submit",
  "card.deleteRouteClient.submit",
  "card.stockFinal",
  "card.journalStock",
  "card.showBLs",
  "card.showBLs.scheduled",
  "card.showBLs.delayed",
  "card.showBLs.canceled",
  "card.showBLs.unlink",
  "card.bonChargement",
  "card.showPayments",
  "card.showPayments.draft",
  "card.showPayments.post",
  "card.showPayments.cancel",
  "card.showPayments.editJournal",
  "card.showClients",
  "card.showMap",
  "card.showReports",
  "card.showVentes",
  "card.showRetours",
  "agents.reorder",
  "agents.toggle",
  "agents.editLabels",
  "agents.import",
  "agents.clearAll",
  "settings.odooUrlPayment",
  "settings.clientShortcuts",
  "settings.priorityRoutes",
  "settings.productCatalog",
  "settings.clientListTournee",
  "settings.cardDisplay",
  "settings.sharedView",
  "settings.constat",
  "settings.autoFetch",
  "settings.workflows",
  "settings.routeSettings",
  "export.excel",
];

function allTrue() {
  const o = {};
  for (const k of ALL_PERMISSIONS) o[k] = true;
  return o;
}

function allFalseExceptViewer() {
  const viewerKeys = [
    "card.showBLs",
    "card.showPayments",
    "card.showPayments.editJournal",
    "card.showClients",
    "card.showReports",
    "card.showVentes",
    "card.showRetours",
  ];
  const o = {};
  for (const k of ALL_PERMISSIONS) o[k] = viewerKeys.includes(k);
  return o;
}

const ROLE_DEFAULTS = {
  admin: allTrue(),
  editor: {
    ...allTrue(),
    "card.clearRound": false,
    "agents.clearAll": false,
    "agents.import": false,
    "settings.workflows": false,
    "settings.routeSettings": true,
  },
  viewer: {
    ...allFalseExceptViewer(),
    "settings.cardDisplay": true,
    "settings.sharedView": true,
  },
};

function computePermissions(role, overrides = {}) {
  const base = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.viewer;
  return { ...base, ...overrides };
}

module.exports = { ALL_PERMISSIONS, ROLE_DEFAULTS, computePermissions };

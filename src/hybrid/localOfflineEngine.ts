import type { HybridRequestEnvelope, HybridResponseEnvelope } from "./contracts";

const STORAGE_KEY = "NASQO_PRO_ERP_OFFLINE_DB_V1";
const IDEM_KEY = "NASQO_PRO_ERP_IDEM_V1";

function defaultSnapshot(): Record<string, unknown> {
  return {
    workspaceId: "local-erp-workspace",
    workspace: {
      id: "local-erp-workspace",
      name: "نسقو برو ERP - محلي",
      baseCurrency: "SAR",
      updatedAt: new Date().toISOString(),
    },
    currencies: [
      { code: "SAR", name: "ريال سعودي", symbol: "ر.س", rate: 1, isBase: true },
      { code: "YER", name: "ريال يمني", symbol: "ر.ي", rate: 140, isBase: false },
      { code: "USD", name: "دولار أمريكي", symbol: "$", rate: 0.2666, isBase: false },
    ],
    accountGroups: [
      { id: "grp_customers", name: "العملاء", category: "customers" },
      { id: "grp_suppliers", name: "الموردون", category: "suppliers" },
      { id: "grp_expenses", name: "المصروفات", category: "expenses" },
    ],
    accounts: [],
    cashboxes: [
      { id: "cb_main", name: "الصندوق الرئيسي", currency: "SAR", balance: 0, isDefault: true },
    ],
    ledger: [],
    warehouses: [
      { id: "wh_main", name: "المستودع الرئيسي", location: "الفرع الرئيسي", isDefault: true },
    ],
    inventory: [],
    erpData: null,
    uiPreferences: {},
  };
}

function loadDb(): any {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const init = defaultSnapshot();
      saveDb(init);
      return init;
    }
    return Object.assign(defaultSnapshot(), JSON.parse(raw));
  } catch {
    return defaultSnapshot();
  }
}

function saveDb(db: unknown): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    console.error("Failed to save local DB:", e);
  }
}

function loadIdem(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(IDEM_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveIdem(map: Record<string, unknown>): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > 500) {
      for (let i = 0; i < keys.length - 500; i++) delete map[keys[i]];
    }
    localStorage.setItem(IDEM_KEY, JSON.stringify(map));
  } catch {}
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function upsertById(arr: any[], item: any, prefix: string): any {
  const rec = Object.assign({}, item);
  if (!rec.id) rec.id = genId(prefix);
  const idx = arr.findIndex((x) => x && x.id === rec.id);
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], rec);
  else arr.unshift(rec);
  return rec;
}

function applyInventoryLines(db: any, lines: any[], multiplier: number): void {
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    const itemId = line.itemId || line.productId || line.id;
    const qty = Number(line.quantity || line.qty || 0) * multiplier;
    if (!itemId || !qty) continue;
    const idx = db.inventory.findIndex((i: any) => i.id === itemId);
    if (idx >= 0) {
      const curQty = Number(db.inventory[idx].quantity ?? db.inventory[idx].stock ?? 0);
      const nextQty = curQty + qty;
      db.inventory[idx].quantity = nextQty;
      if ("stock" in db.inventory[idx]) db.inventory[idx].stock = nextQty;
    }
  }
}

export function executeLocalOfflineRequest(req: HybridRequestEnvelope): HybridResponseEnvelope {
  const action = req.action;
  const rawPayload = req.payload as any;
  const p = rawPayload && rawPayload.payload !== undefined ? rawPayload.payload : rawPayload || {};
  const db = loadDb();

  if (req.idempotencyKey) {
    const idem = loadIdem();
    if (idem[req.idempotencyKey]) {
      return {
        protocolVersion: "1.0.0",
        kind: "response",
        requestId: req.requestId,
        action: req.action,
        ok: true,
        data: idem[req.idempotencyKey],
        timestampMs: Date.now(),
      };
    }
  }

  let resultData: any = { snapshot: db };

  switch (action) {
    case "getSnapshot":
    case "navigate":
    case "goBack":
    case "showMessage":
      resultData = { snapshot: db };
      break;
    case "changeCurrency":
      if (db.workspace && p.currency) db.workspace.baseCurrency = p.currency;
      saveDb(db);
      resultData = { snapshot: db };
      break;
    case "saveUiPreferences":
      db.uiPreferences = Object.assign({}, db.uiPreferences, p);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    case "saveWorkspaceSettings":
      db.workspace = Object.assign({}, db.workspace, p, { updatedAt: new Date().toISOString() });
      saveDb(db);
      resultData = { workspace: db.workspace, snapshot: db };
      break;
    case "saveAccountGroup": {
      const saved = upsertById(db.accountGroups, p, "grp");
      saveDb(db);
      resultData = { group: saved, snapshot: db };
      break;
    }
    case "saveCurrency": {
      const idx = db.currencies.findIndex((c: any) => c.code === p.code);
      if (idx >= 0) db.currencies[idx] = Object.assign({}, db.currencies[idx], p);
      else db.currencies.push(p);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    }
    case "deleteCurrency":
      db.currencies = db.currencies.filter((c: any) => c.code !== (p.code || p));
      saveDb(db);
      resultData = { snapshot: db };
      break;
    case "saveAccount": {
      const saved = upsertById(db.accounts, Object.assign({ balance: 0 }, p), "acc");
      saveDb(db);
      resultData = { account: saved, snapshot: db };
      break;
    }
    case "deleteAccount":
      db.accounts = db.accounts.filter((a: any) => a.id !== (p.id || p.accountId || p));
      saveDb(db);
      resultData = { snapshot: db };
      break;
    case "createLedgerEntry": {
      const entry = Object.assign({}, p, {
        id: p.id || genId("led"),
        entryNumber: p.entryNumber || 1000 + db.ledger.length + 1,
        createdAt: p.createdAt || new Date().toISOString(),
        isDeleted: false,
      });
      db.ledger.unshift(entry);
      if (entry.kind === "sale" || entry.kind === "sales_invoice") applyInventoryLines(db, entry.lines, -1);
      else if (entry.kind === "purchase" || entry.kind === "purchase_invoice" || entry.kind === "invoice")
        applyInventoryLines(db, entry.lines, 1);
      saveDb(db);
      resultData = { entry, snapshot: db };
      break;
    }
    case "updateLedgerEntry": {
      const idx = db.ledger.findIndex((e: any) => e.id === p.id);
      if (idx >= 0) db.ledger[idx] = Object.assign({}, db.ledger[idx], p, { updatedAt: new Date().toISOString() });
      saveDb(db);
      resultData = { entry: idx >= 0 ? db.ledger[idx] : p, snapshot: db };
      break;
    }
    case "setLedgerDeleted": {
      const id = p.id || p.entryId;
      const idx = db.ledger.findIndex((e: any) => e.id === id);
      if (idx >= 0) db.ledger[idx].isDeleted = Boolean(p.deleted !== undefined ? p.deleted : true);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    }
    case "permanentlyDeleteLedger": {
      const id = p.id || p.entryId;
      db.ledger = db.ledger.filter((e: any) => e.id !== id);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    }
    case "saveWarehouse": {
      const saved = upsertById(db.warehouses, p, "wh");
      saveDb(db);
      resultData = { warehouse: saved, snapshot: db };
      break;
    }
    case "createInventoryItem":
    case "updateInventoryItem": {
      const saved = upsertById(db.inventory, p, "itm");
      saveDb(db);
      resultData = { item: saved, snapshot: db };
      break;
    }
    case "deleteInventoryItem": {
      const id = p.id || p.itemId || p;
      db.inventory = db.inventory.filter((i: any) => i.id !== id);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    }
    case "importInventoryItems": {
      const items = Array.isArray(p.items) ? p.items : Array.isArray(p) ? p : [];
      for (const it of items) upsertById(db.inventory, it, "itm");
      saveDb(db);
      resultData = { importedCount: items.length, snapshot: db };
      break;
    }
    case "batchUpdateInventoryItems": {
      const updates = Array.isArray(p.items) ? p.items : Array.isArray(p) ? p : [];
      for (const u of updates) upsertById(db.inventory, u, "itm");
      saveDb(db);
      resultData = { snapshot: db };
      break;
    }
    case "saveErpData":
      db.erpData = Object.assign({}, db.erpData || {}, p.erpData || p);
      saveDb(db);
      resultData = { snapshot: db };
      break;
    case "getInvoiceDetail": {
      const id = p.id || p.entryId;
      resultData = { entry: db.ledger.find((e: any) => e.id === id) || null, snapshot: db };
      break;
    }
    case "getInventoryMovementsReport":
      resultData = { movements: db.ledger.filter((e: any) => Array.isArray(e.lines) && e.lines.length > 0), snapshot: db };
      break;
    case "getCashboxesReport":
      resultData = { cashboxes: db.cashboxes, snapshot: db };
      break;
    case "backupWorkspace":
      resultData = { backupJson: JSON.stringify(db), snapshot: db };
      break;
    case "restoreWorkspace": {
      const incoming = typeof p.backupJson === "string" ? JSON.parse(p.backupJson) : p.snapshot || p;
      const restored = Object.assign(defaultSnapshot(), incoming);
      saveDb(restored);
      resultData = { snapshot: restored };
      break;
    }
    case "resetWorkspace": {
      const fresh = defaultSnapshot();
      saveDb(fresh);
      resultData = { snapshot: fresh };
      break;
    }
    case "printDocument":
    case "exportPdf":
      try {
        window.print();
      } catch {}
      resultData = { printed: true, snapshot: db };
      break;
    default:
      resultData = { snapshot: db };
      break;
  }

  if (req.idempotencyKey) {
    const idem = loadIdem();
    idem[req.idempotencyKey] = resultData;
    saveIdem(idem);
  }

  return {
    protocolVersion: "1.0.0",
    kind: "response",
    requestId: req.requestId,
    action: req.action,
    ok: true,
    data: resultData,
    timestampMs: Date.now(),
  };
}

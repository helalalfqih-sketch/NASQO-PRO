import type { DatabaseSync } from "node:sqlite";
import type { SqlJsStatic } from "sql.js";
import * as accounting from "../../server/sqliteDb";
import {
  HYBRID_PROTOCOL_VERSION, validateHybridRequestEnvelope, isFinancialMutationCommand,
  type HybridRequestEnvelope, type HybridResponseEnvelope, type HybridWorkspaceSnapshot,
  type HybridHostEventEnvelope,
} from "../hybrid/contracts";
import { WasmDatabase, decodeBase64, encodeBase64 } from "./sqlite";

export interface NativeDevice {
  pickFile(options: { accept: string[] }): Promise<unknown>;
  saveFile(options: { filename: string; mimeType: string; base64Content: string }): Promise<unknown>;
  print(options: { title: string; html: string }): Promise<unknown>;
  showMessage(options: { message: string }): Promise<unknown>;
}

const WORKSPACE = accounting.DEFAULT_WORKSPACE_ID;
const READ_COMMANDS = new Set([
  "getSnapshot", "getInventoryMovementsReport", "getCashboxesReport", "getInvoiceDetail", "getProductPriceStats",
  "navigate", "goBack", "openInvoice", "openVoucher", "openAccountStatement", "showMessage", "pickFile",
  "printDocument", "exportPdf", "backupWorkspace", "googleDriveAction",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Serializes commands; acknowledges a write only after the native atomic save. */
export class CapacitorRepository {
  readonly sqlite: WasmDatabase;
  private queue: Promise<unknown> = Promise.resolve();
  private durableBytes: Uint8Array = new Uint8Array();
  activeRoute = "home";

  constructor(
    private readonly SQL: SqlJsStatic,
    bytes: Uint8Array | undefined,
    private readonly save: (bytes: Uint8Array) => Promise<void>,
    private readonly device: NativeDevice,
    private readonly emit: (event: HybridHostEventEnvelope) => void = () => {},
  ) {
    this.sqlite = new WasmDatabase(SQL, bytes);
    accounting.initializeSqliteSchema(this.db);
    accounting.ensureEmptyWorkspace(this.db, WORKSPACE);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capacitor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS capacitor_receipts (
        idempotency_key TEXT PRIMARY KEY, action TEXT NOT NULL,
        signature TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }

  private get db(): DatabaseSync { return this.sqlite as unknown as DatabaseSync; }

  async initialize(): Promise<void> {
    const bytes = this.sqlite.export();
    await this.save(bytes);
    this.durableBytes = bytes;
  }

  request(input: unknown): Promise<HybridResponseEnvelope> {
    const task = this.queue.then(() => this.execute(input));
    this.queue = task.catch(() => {});
    return task;
  }

  snapshot(): HybridWorkspaceSnapshot {
    const bundle = accounting.getFullWorkspaceBundle(this.db, WORKSPACE);
    const prefs = this.db.prepare("SELECT value FROM capacitor_state WHERE key = 'preferences'").get() as { value: string } | undefined;
    const currency = this.db.prepare("SELECT value FROM capacitor_state WHERE key = 'currency'").get() as { value: string } | undefined;
    return {
      ...bundle, workspaceId: WORKSPACE, userEmail: "offline@nasqo.local",
      activeRoute: this.activeRoute, activeCurrency: currency?.value || bundle.workspace.defaultCurrency,
      uiPreferences: prefs ? JSON.parse(prefs.value) : {}, snapshotVersion: 3,
      storageEngine: "Capacitor SQLite", storageBytes: this.durableBytes.byteLength,
      capabilities: { offlineReady: true, readOnlyFinancial: false, printingSupported: true,
        pdfExportSupported: true, filePickerSupported: true, googleDriveConfigured: false, whatsappShareSupported: false },
    };
  }

  private async execute(input: unknown): Promise<HybridResponseEnvelope> {
    const checked = validateHybridRequestEnvelope(input);
    const response: HybridResponseEnvelope = {
      protocolVersion: HYBRID_PROTOCOL_VERSION, kind: "response",
      requestId: typeof (input as { requestId?: unknown })?.requestId === "string" ? (input as { requestId: string }).requestId : "invalid-request",
      ok: false,
    };
    if (!checked.valid) return { ...response, error: { code: "VALIDATION_ERROR", message: checked.reason } };
    const request = checked.value;
    response.action = request.action;
    const payload = request.payload as { workspaceId?: string };
    if (payload.workspaceId && payload.workspaceId !== WORKSPACE) return { ...response, error: { code: "UNAUTHORIZED_ACTION", message: "مساحة العمل غير مسموح بها." } };
    if (request.idempotencyKey && request.idempotencyKey.length > 200) return { ...response, error: { code: "VALIDATION_ERROR", message: "مفتاح العملية أطول من الحد المسموح." } };
    const mutation = !READ_COMMANDS.has(request.action);
    try {
      const signature = canonical({ action: request.action, payload: request.payload });
      if (isFinancialMutationCommand(request.action) && request.idempotencyKey) {
        const prior = this.db.prepare("SELECT signature, result FROM capacitor_receipts WHERE idempotency_key = ?").get(request.idempotencyKey) as { signature: string; result: string } | undefined;
        if (prior) {
          if (prior.signature !== signature) return { ...response, error: { code: "DUPLICATE_REQUEST", message: "مفتاح العملية مستخدم لبيانات مختلفة." } };
          return { ...response, ok: true, data: { ...JSON.parse(prior.result), replayed: true, snapshot: this.snapshot() } };
        }
      }
      if (!mutation) return { ...response, ok: true, data: await this.readOrDeviceCommand(request) };

      const result = accounting.withTransaction(this.db, () => {
        const data = this.mutate(request);
        if (isFinancialMutationCommand(request.action)) {
          this.db.prepare("INSERT INTO capacitor_receipts (idempotency_key, action, signature, result, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(request.idempotencyKey!, request.action, signature, JSON.stringify(data), new Date().toISOString());
        }
        return data;
      });
      const bytes = this.sqlite.export();
      try {
        await this.save(bytes);
      } catch {
        this.sqlite.replace(this.durableBytes);
        return { ...response, error: { code: "SERVICE_UNAVAILABLE", message: "تعذر حفظ التغيير على الجهاز. لم يتم تأكيد العملية؛ أعد المحاولة.", retryable: true } };
      }
      this.durableBytes = bytes;
      const snapshot = this.snapshot();
      this.emit({ protocolVersion: HYBRID_PROTOCOL_VERSION, kind: "event", event: "snapshotUpdated", payload: snapshot });
      return { ...response, ok: true, data: { ...result, snapshot } };
    } catch (error) {
      return { ...response, error: { code: error instanceof accounting.SqliteValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR", message: error instanceof Error ? error.message : "تعذر تنفيذ العملية المحلية." } };
    }
  }

  private mutate(request: HybridRequestEnvelope): Record<string, unknown> {
    // The protocol validates the envelope; the shared accounting engine validates business data.
    const p = request.payload as Record<string, any>;
    switch (request.action) {
      case "saveWorkspaceSettings":
        accounting.saveWorkspaceSettingsRow(this.db, WORKSPACE, p.updates); return {};
      case "saveAccountGroup": return { group: accounting.upsertAccountGroupRow(this.db, WORKSPACE, p.payload) };
      case "saveCurrency":
        accounting.upsertCurrencyRow(this.db, WORKSPACE, p.payload); return { currencies: this.snapshot().currencies };
      case "deleteCurrency":
        accounting.deleteCurrencyRow(this.db, WORKSPACE, Number(p.currencyId)); return { currencies: this.snapshot().currencies };
      case "saveAccount": return { account: accounting.upsertAccountRow(this.db, WORKSPACE, p.payload, p.accountId) };
      case "deleteAccount": accounting.deleteAccountRow(this.db, WORKSPACE, p.accountId); return {};
      case "createLedgerEntry": return { entry: accounting.insertLedgerEntryRow(this.db, WORKSPACE, { ...p.payload, idempotencyKey: request.idempotencyKey }) };
      case "updateLedgerEntry": {
        const entry = accounting.updateLedgerEntryRow(this.db, WORKSPACE, p.entryId, p.payload);
        if (!entry) throw new accounting.SqliteValidationError("القيد غير موجود.");
        return { entry };
      }
      case "setLedgerDeleted": accounting.setLedgerDeletedRow(this.db, WORKSPACE, p.entryId, Boolean(p.deleted)); return {};
      case "permanentlyDeleteLedger": accounting.deleteLedgerEntryRow(this.db, WORKSPACE, p.entryId); return {};
      case "saveWarehouse": return { warehouse: accounting.upsertWarehouseRow(this.db, WORKSPACE, p.payload, p.warehouseId) };
      case "createInventoryItem": return { item: accounting.insertInventoryItemRow(this.db, WORKSPACE, p.payload) };
      case "updateInventoryItem": {
        const existing = accounting.listWorkspaceInventoryRows(this.db, WORKSPACE).find(item => item.id === p.itemId);
        if (!existing) throw new accounting.SqliteValidationError("الصنف غير موجود.");
        const merged = { ...existing, ...p.updates };
        accounting.updateInventoryCatalogRow(this.db, WORKSPACE, p.itemId, merged);
        if (["quantity", "warehouseId", "quantityUnverified"].some(key => key in p.updates)) {
          accounting.updateInventoryItemRow(this.db, WORKSPACE, p.itemId, { ...merged, warehouseId: merged.warehouseId || "" });
        }
        return { item: accounting.listWorkspaceInventoryRows(this.db, WORKSPACE).find(item => item.id === p.itemId) };
      }
      case "deleteInventoryItem": accounting.deleteInventoryCatalogRow(this.db, WORKSPACE, p.itemId); return {};
      case "importInventoryItems": return accounting.importInventoryCatalogRows(this.db, WORKSPACE, p.items, { mode: p.mode === "insert-only" ? "skip" : "upsert" });
      case "batchUpdateInventoryItems": {
        if (!Array.isArray(p.updates) || p.updates.length > 10000) throw new accounting.SqliteValidationError("قائمة تحديث الأصناف غير صالحة.");
        const items = accounting.listWorkspaceInventoryRows(this.db, WORKSPACE);
        const updates = p.updates.map((update: { id: string; data: Record<string, unknown> }) => {
          const item = items.find(i => i.id === update.id);
          if (!item) throw new accounting.SqliteValidationError("الصنف غير موجود.");
          return { item, ...update.data };
        });
        accounting.batchUpdateInventoryItemRows(this.db, WORKSPACE, updates); return {};
      }
      case "saveErpData": accounting.saveErpDataRows(this.db, WORKSPACE, p.data); return {};
      case "saveUiPreferences": {
        const current = this.snapshot().uiPreferences ?? {};
        this.db.prepare("INSERT INTO capacitor_state (key, value) VALUES ('preferences', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify({ ...current, ...p.preferences }));
        return {};
      }
      case "changeCurrency":
        this.db.prepare("INSERT INTO capacitor_state (key, value) VALUES ('currency', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(p.currency)); return {};
      case "restoreWorkspace": {
        const bytes = decodeBase64(p.base64Content);
        if (bytes.byteLength > 64 * 1024 * 1024) throw new accounting.SqliteValidationError("الحد الأقصى للنسخة الاحتياطية 64 ميغابايت.");
        let data: unknown;
        if (p.format === "json") {
          data = JSON.parse(new TextDecoder().decode(bytes));
        } else if (p.format === "sqlite") {
          // Read the selected file in isolation; never replace the live DB with unvalidated bytes.
          const isolated = new WasmDatabase(this.SQL, bytes);
          try {
            const check = isolated.prepare("PRAGMA integrity_check").get();
            if (check?.integrity_check !== "ok") throw new Error("ملف SQLite تالف.");
            data = accounting.exportWorkspaceJsonBackup(isolated as unknown as DatabaseSync, WORKSPACE);
          } finally { isolated.close(); }
        } else {
          throw new accounting.SqliteValidationError("استيراد ملفات SQL القديمة يحتاج إلى تحويلها إلى نسخة JSON موحدة أولاً.");
        }
        const restored = accounting.restoreUnifiedJsonBundle(this.db, WORKSPACE, data);
        return { restored, report: restored };
      }
      case "resetWorkspace":
        if (p.mode !== "empty") throw new accounting.SqliteValidationError("هذه النسخة تبدأ بقاعدة فارغة ولا تضيف بيانات تجريبية.");
        accounting.resetWorkspaceToEmpty(this.db, WORKSPACE);
        this.db.exec("DELETE FROM capacitor_receipts;");
        return {};
      default: throw new accounting.SqliteValidationError("الأمر غير مدعوم.");
    }
  }

  private async readOrDeviceCommand(request: HybridRequestEnvelope): Promise<unknown> {
    const p = request.payload as Record<string, any>;
    switch (request.action) {
      case "getSnapshot": return this.snapshot();
      case "getInventoryMovementsReport": return accounting.getInventoryMovementsReport(this.db, WORKSPACE, p.options);
      case "getCashboxesReport": return accounting.getCashboxesReport(this.db, WORKSPACE, p.options);
      case "getInvoiceDetail": return accounting.fetchInvoiceDetail(this.db, WORKSPACE, p.entryId);
      case "getProductPriceStats": return accounting.getProductPriceStats(this.db, WORKSPACE, p.itemId);
      case "navigate": this.activeRoute = String(p.route || "home"); return { route: this.activeRoute };
      case "goBack": this.activeRoute = String(p.currentRoute || "home"); return {};
      case "openInvoice": case "openVoucher": case "openAccountStatement": return {};
      case "pickFile": return this.device.pickFile({ accept: p.accept });
      case "showMessage": return this.device.showMessage({ message: String(p.message ?? "") });
      case "printDocument": return this.device.print({ title: String(p.title || "نسقو برو"), html: this.documentHtml(p) });
      case "exportPdf":
        if (p.base64Pdf) return this.device.saveFile({ filename: String(p.filename || "nasqo.pdf"), mimeType: "application/pdf", base64Content: p.base64Pdf });
        // Android's print dialog provides the system Save as PDF destination.
        return this.device.print({ title: String(p.title || "نسقو برو"), html: this.documentHtml(p) });
      case "backupWorkspace": {
        if (p.target !== "local") throw new Error("النسخ السحابي غير مهيأ في هذه النسخة. اختر حفظ نسخة محلية.");
        const sqlite = typeof p.backupName === "string" && p.backupName.toLowerCase().endsWith(".sqlite");
        const filename = `nasqo-${new Date().toISOString().slice(0, 10)}.${sqlite ? "sqlite" : "json"}`;
        const bytes = sqlite ? this.sqlite.export() : new TextEncoder().encode(JSON.stringify(accounting.exportWorkspaceJsonBackup(this.db, WORKSPACE)));
        await this.device.saveFile({ filename, mimeType: sqlite ? "application/vnd.sqlite3" : "application/json", base64Content: encodeBase64(bytes) });
        return { filename, exportedAtIso: new Date().toISOString() };
      }
      case "googleDriveAction": throw new Error("Google Drive غير مهيأ في هذه النسخة المحلية.");
      default: throw new Error("الأمر غير مدعوم.");
    }
  }

  private documentHtml(p: Record<string, any>): string {
    if (!["statement", "invoice"].includes(p.kind)) {
      throw new Error("طباعة هذا التقرير غير مهيأة بعد في نسخة Android. طباعة الفواتير وكشوف الحساب متاحة.");
    }
    if (p.kind === "invoice" && !p.entryId) throw new Error("حدد الفاتورة المطلوب طباعتها.");
    if (p.kind === "statement" && !p.accountId) throw new Error("حدد الحساب المطلوب طباعته.");
    const snapshot = this.snapshot();
    const title = escapeHtml(p.title || snapshot.workspace?.companyName || "نسقو برو");
    let headings = ["التاريخ", "الحساب", "البيان", "مدين", "دائن", "العملة"];
    let rows: unknown[][] = snapshot.ledger.filter(e => !e.deleted && e.postingStatus !== "draft" && e.accountId === p.accountId && (p.allCurrencies || e.currency === snapshot.activeCurrency)).map(e => [e.entryDate, e.accountName, e.details, e.direction === "debit" ? e.amount : "", e.direction === "credit" ? e.amount : "", e.currency]);
    if (p.entryId) {
      const invoice = accounting.fetchInvoiceDetail(this.db, WORKSPACE, String(p.entryId));
      if (!invoice) throw new Error("المستند غير موجود.");
      headings = ["الصنف", "الوحدة", "الكمية", "السعر", "الإجمالي"];
      rows = invoice.lines.map(line => [line.itemName, line.unit, line.quantity, line.price, line.total]);
      rows.push(["الإجمالي", "", "", invoice.entry.currency, invoice.entry.amount]);
    }
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:8px;text-align:right}h1{font-size:20px}</style></head><body><h1>${title}</h1><table><thead><tr>${headings.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
  }
}

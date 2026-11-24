import test from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import * as XLSX from "xlsx";
import { CapacitorRepository, type NativeDevice } from "../src/capacitor/repository";
import { decodeBase64, encodeBase64 } from "../src/capacitor/sqlite";
import { validateHybridSnapshot } from "../src/hybrid/contracts";
import { parseItemsSpreadsheetBytes } from "../src/utils/importItemsFile";

const SQL = await initSqlJs();
const workspaceId = "local-erp-workspace";
let sequence = 0;
const native: NativeDevice = {
  pickFile: async () => ({ cancelled: true }),
  saveFile: async () => ({ saved: true }),
  print: async () => ({ dialogOpened: true }),
  showMessage: async () => ({}),
};

function message(action: string, payload: unknown, key = `operation-${++sequence}`) {
  return { protocolVersion: "1.0.0", kind: "request", requestId: `request-${++sequence}`, action, payload, idempotencyKey: key, timestampMs: Date.now() };
}

async function fixture() {
  let bytes: Uint8Array | undefined;
  let fail = false;
  const save = async (next: Uint8Array) => {
    await Promise.resolve();
    if (fail) throw new Error("disk full");
    bytes = next.slice();
  };
  const repo = new CapacitorRepository(SQL, bytes, save, native);
  await repo.initialize();
  return { repo, bytes: () => bytes!, fail: (value: boolean) => { fail = value; }, reopen: async () => {
    const reopened = new CapacitorRepository(SQL, bytes, save, native);
    await reopened.initialize();
    return reopened;
  } };
}

async function successful(repo: CapacitorRepository, action: string, payload: unknown, key?: string): Promise<any> {
  const result = await repo.request(message(action, payload, key));
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}

test("clean install uses an empty real SQLite database with durable Arabic settings", async () => {
  const f = await fixture();
  const before = f.repo.snapshot();
  assert.equal(validateHybridSnapshot(before).valid, true);
  assert.equal(before.accounts.length, 0);
  assert.equal(before.ledger.length, 0);
  assert.equal(before.inventory.length, 0);
  assert.equal(new TextDecoder().decode(f.bytes().subarray(0, 15)), "SQLite format 3");
  await successful(f.repo, "saveWorkspaceSettings", { workspaceId, updates: { companyName: "متجر الاختبار" } });
  await successful(f.repo, "saveUiPreferences", { preferences: { themeMode: "dark" } });
  const reopened = await f.reopen();
  assert.equal(reopened.snapshot().workspace?.companyName, "متجر الاختبار");
  assert.equal(reopened.snapshot().uiPreferences?.themeMode, "dark");
  assert.equal(reopened.sqlite.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
});

test("posting, inventory and receipts commit atomically and replay once after reopening", async () => {
  const f = await fixture();
  const { account } = await successful(f.repo, "saveAccount", { workspaceId, payload: { name: "مورد اختبار", category: "purchases", currency: "ريال" } });
  const { warehouse } = await successful(f.repo, "saveWarehouse", { workspaceId, payload: { name: "المستودع", isDefault: true } });
  const { item } = await successful(f.repo, "createInventoryItem", { workspaceId, payload: { name: "صنف اختبار", warehouseId: warehouse.id, quantity: 0, avgCost: 0, unit: "حبة" } });
  const payload = { workspaceId, payload: { accountId: account.id, accountName: account.name, kind: "invoice", payment: "credit", direction: "credit", currency: "ريال", amount: 300, entryDate: "2026-11-24", lines: [{ inventoryItemId: item.id, warehouseId: warehouse.id, itemName: item.name, unit: "حبة", quantity: 2, price: 150, total: 300 }] } };
  const posted = await successful(f.repo, "createLedgerEntry", payload, "purchase-receipt-1");
  assert.equal(posted.entry.amount, 300);
  assert.equal(f.repo.snapshot().inventory[0].quantity, 2);
  const reopened = await f.reopen();
  const replay = await successful(reopened, "createLedgerEntry", payload, "purchase-receipt-1");
  assert.equal(replay.entry.id, posted.entry.id);
  assert.equal(replay.replayed, true);
  assert.equal(reopened.snapshot().ledger.length, 1);
  assert.equal(reopened.snapshot().inventory[0].quantity, 2);
  const conflict = await reopened.request(message("createLedgerEntry", { ...payload, payload: { ...payload.payload, amount: 600 } }, "purchase-receipt-1"));
  assert.equal(conflict.error?.code, "DUPLICATE_REQUEST");
  const invoice = await successful(reopened, "getInvoiceDetail", { workspaceId, entryId: posted.entry.id });
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].quantity, 2);
});

test("failed native persistence rolls back memory and receipts, allowing a real retry", async () => {
  const f = await fixture();
  const payload = { workspaceId, payload: { name: "حساب الحفظ", category: "clients", currency: "ريال" } };
  const diskBefore = f.bytes().slice();
  f.fail(true);
  const failed = await f.repo.request(message("saveAccount", payload, "durable-retry-1"));
  assert.equal(failed.ok, false);
  assert.equal(f.repo.snapshot().accounts.length, 0);
  assert.deepEqual(f.bytes(), diskBefore);
  f.fail(false);
  await successful(f.repo, "saveAccount", payload, "durable-retry-1");
  assert.equal((await f.reopen()).snapshot().accounts.length, 1);
});

test("concurrent requests are serialized and duplicate writes cannot double-post", async () => {
  const f = await fixture();
  const p = { workspaceId, payload: { name: "حساب واحد", category: "clients", currency: "ريال" } };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.repo.request(message("saveAccount", p, "same-receipt-1"))));
  assert.ok(results.every(r => r.ok));
  assert.equal(f.repo.snapshot().accounts.length, 1);
});

test("invalid data, wrong workspace, unallowlisted commands and missing receipts never persist", async () => {
  const f = await fixture();
  const cases = [
    message("executeSql", { sql: "DROP TABLE accounts" }),
    message("getSnapshot", { workspaceId: "another-workspace" }),
    { ...message("saveAccount", { workspaceId, payload: { name: "invalid" } }), idempotencyKey: undefined },
    message("createLedgerEntry", { workspaceId, payload: { accountId: "missing", accountName: "missing", amount: -10 } }),
    message("resetWorkspace", { workspaceId, mode: "demo" }),
  ];
  for (const request of cases) assert.equal((await f.repo.request(request)).ok, false);
  assert.equal(f.repo.snapshot().accounts.length, 0);
  assert.equal(f.repo.snapshot().ledger.length, 0);
  assert.equal(f.repo.sqlite.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
});

test("local JSON backup restores through shared validation and cloud backup reports unavailable", async () => {
  const f = await fixture();
  await successful(f.repo, "saveAccount", { workspaceId, payload: { name: "حساب النسخة", category: "clients", currency: "ريال" } });
  const exported: Array<{ base64Content: string }> = [];
  const backupRepo = new CapacitorRepository(SQL, f.bytes(), async () => {}, { ...native, saveFile: async options => { exported.push(options); return { saved: true }; } });
  await successful(backupRepo, "backupWorkspace", { workspaceId, target: "local" });
  assert.equal(exported.length, 1);
  const empty = await fixture();
  await successful(empty.repo, "restoreWorkspace", { workspaceId, fileName: "backup.json", format: "json", base64Content: exported[0].base64Content });
  assert.equal((await empty.reopen()).snapshot().accounts[0].name, "حساب النسخة");
  const bad = await empty.repo.request(message("restoreWorkspace", { workspaceId, format: "json", fileName: "invalid.json", base64Content: encodeBase64(new TextEncoder().encode('{"accounts":"bad"}')) }));
  assert.equal(bad.ok, false);
  assert.equal(empty.repo.snapshot().accounts.length, 1);
  assert.equal((await backupRepo.request(message("backupWorkspace", { workspaceId, target: "cloud" }))).ok, false);
});

test("updated SheetJS preserves Arabic Excel and CSV inventory import", () => {
  const sheet = XLSX.utils.aoa_to_sheet([["اسم الصنف", "الباركود", "الوحدة", "سعر التكلفة"], ["صنف عربي", "001234", "حبة", 125]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "الأصناف");
  for (const bookType of ["xlsx", "biff8", "csv"] as const) {
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType }));
    const result = parseItemsSpreadsheetBytes(bytes);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].name, "صنف عربي");
  }
});

test("SQLite export preserves the requested format and restores into an empty workspace", async () => {
  const f = await fixture();
  await successful(f.repo, "saveAccount", { workspaceId, payload: { name: "حساب SQLite", category: "clients", currency: "ريال" } });
  const files: Array<{ filename: string; mimeType: string; base64Content: string }> = [];
  const repo = new CapacitorRepository(SQL, f.bytes(), async () => {}, { ...native, saveFile: async options => { files.push(options); return { saved: true }; } });
  await successful(repo, "backupWorkspace", { workspaceId, target: "local", backupName: "backup.sqlite" });
  assert.match(files[0].filename, /\.sqlite$/);
  assert.equal(new TextDecoder().decode(decodeBase64(files[0].base64Content).subarray(0, 15)), "SQLite format 3");
  const empty = await fixture();
  await successful(empty.repo, "restoreWorkspace", { workspaceId, format: "sqlite", fileName: "backup.sqlite", base64Content: files[0].base64Content });
  assert.equal((await empty.reopen()).snapshot().accounts[0].name, "حساب SQLite");
});

test("unsupported report printing fails explicitly and cannot print an unrelated ledger", async () => {
  let calls = 0;
  const repo = new CapacitorRepository(SQL, undefined, async () => {}, { ...native, print: async () => { calls++; return {}; } });
  await repo.initialize();
  for (const kind of ["report", "trial-balance", "inventory", "purchases", "invoice", "statement"]) {
    const result = await repo.request(message("printDocument", { title: "اختبار", kind }));
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
});

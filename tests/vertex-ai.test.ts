import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { mountAiApi } from "../server/aiApi.ts";
import {
  DEFAULT_WORKSPACE_ID,
  closeSqliteDb,
  ensureEmptyWorkspace,
  getSqliteDb,
  insertInventoryItemRow,
  insertLedgerEntryRow,
  upsertAccountRow,
  upsertWarehouseRow,
} from "../server/sqliteDb.ts";
import {
  DEFAULT_VERTEX_MODEL,
  buildWorkspaceAiContextSnapshot,
  resolveAiBackendConfig,
  resolveAiModel,
} from "../server/vertexAi.ts";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nasqo-vertex-ai-test-"));
  const dbPath = path.join(dir, "nasqo-test.sqlite");
  closeSqliteDb();
  const db = getSqliteDb(dbPath);
  ensureEmptyWorkspace(db, DEFAULT_WORKSPACE_ID, "شركة الاختبار");
  return {
    db,
    cleanup: () => {
      closeSqliteDb();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("resolveAiModel rejects deprecated models and defaults to active gemini-4-hydrogen", () => {
  assert.equal(resolveAiModel({}), DEFAULT_VERTEX_MODEL);
  assert.equal(resolveAiModel({ VERTEX_AI_MODEL: "gemini-1.5-flash" }), DEFAULT_VERTEX_MODEL);
  assert.equal(resolveAiModel({ GEMINI_MODEL: "gemini-2.0-flash" }), DEFAULT_VERTEX_MODEL);
  assert.equal(resolveAiModel({ VERTEX_AI_MODEL: "gemini-4-hydrogen" }), "gemini-4-hydrogen");
});

test("resolveAiBackendConfig resolves Vertex GCP project, Vertex Express, Gemini API, and unconfigured states", () => {
  const unconfigured = resolveAiBackendConfig({});
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.provider, "unconfigured");

  const vertexProject = resolveAiBackendConfig({
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GOOGLE_CLOUD_PROJECT: "gen-lang-client-0457000612",
    GOOGLE_CLOUD_LOCATION: "europe-west3",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/fake-sa.json",
  });
  assert.equal(vertexProject.configured, true);
  assert.equal(vertexProject.provider, "vertex-project");
  assert.equal(vertexProject.project, "gen-lang-client-0457000612");
  assert.equal(vertexProject.location, "europe-west3");

  const vertexExpress = resolveAiBackendConfig({
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    VERTEX_AI_API_KEY: "test-vertex-key",
  });
  assert.equal(vertexExpress.configured, true);
  assert.equal(vertexExpress.provider, "vertex-express");

  const geminiApi = resolveAiBackendConfig({
    GEMINI_API_KEY: "test-gemini-key",
  });
  assert.equal(geminiApi.configured, true);
  assert.equal(geminiApi.provider, "gemini-api");
});

test("buildWorkspaceAiContextSnapshot computes read-only accounting metrics and excludes drafts", () => {
  const { db, cleanup } = makeTempDb();
  try {
    const wh = upsertWarehouseRow(db, DEFAULT_WORKSPACE_ID, {
      name: "المخزن الرئيسي",
      isDefault: true,
      codeNumber: 1,
    });

    const client = upsertAccountRow(db, DEFAULT_WORKSPACE_ID, {
      name: "شركة الأفق للتجارة",
      category: "clients",
      currency: "ريال",
      openingBalance: 1000,
      openingDirection: "debit",
    });

    upsertAccountRow(db, DEFAULT_WORKSPACE_ID, {
      name: "مورد الشرق",
      category: "purchases",
      currency: "دولار",
      openingBalance: 250,
      openingDirection: "credit",
    });

    // Posted sales invoice (debit 500 ريال -> client owes 1500 ريال total)
    insertLedgerEntryRow(db, DEFAULT_WORKSPACE_ID, {
      accountId: client.id,
      accountName: client.name,
      kind: "invoice",
      docType: 2,
      typeLabel: "فاتورة مبيعات",
      direction: "debit",
      amount: 500,
      currency: "ريال",
      description: "مبيعات بضائع",
      entryDate: "2026-11-20",
      postingStatus: "posted",
      settledOnReceipt: false,
    });

    // Draft invoice MUST NOT affect posted totals or receivables
    insertLedgerEntryRow(db, DEFAULT_WORKSPACE_ID, {
      accountId: client.id,
      accountName: client.name,
      kind: "invoice",
      docType: 2,
      typeLabel: "فاتورة مبيعات مسودة",
      direction: "debit",
      amount: 9999,
      currency: "ريال",
      description: "مسودة غير مرحلة",
      entryDate: "2026-11-21",
      postingStatus: "draft",
      settledOnReceipt: false,
    });

    // Inventory with low stock item
    insertInventoryItemRow(db, DEFAULT_WORKSPACE_ID, {
      name: "ورق طباعة A4",
      unit: "كرتون",
      quantity: 3,
      avgCost: 100,
      salePrice: 130,
      minThreshold: 5,
      warehouseId: wh.id,
    });

    const snapshot = buildWorkspaceAiContextSnapshot(db, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.accountsCount, 2);
    assert.equal(snapshot.postedLedgerCount, 1);
    assert.equal(snapshot.draftLedgerCount, 1);
    assert.equal(snapshot.inventoryTotalValue, 300);
    assert.equal(snapshot.lowStockItems.length, 1);
    assert.equal(snapshot.lowStockItems[0].name, "ورق طباعة A4");

    // Multi-currency isolation check: ريال and دولار must stay in separate buckets
    const sarBucket = snapshot.totalsByCurrency.find((b) => b.currency === "ريال");
    const usdBucket = snapshot.totalsByCurrency.find((b) => b.currency === "دولار");
    assert.ok(sarBucket, "ريال currency bucket should exist");
    assert.ok(usdBucket, "دولار currency bucket should exist");
    assert.equal(sarBucket.totalSales, 500);
    assert.equal(sarBucket.receivablesNet, 1500);
    assert.equal(usdBucket.payablesNet, 250);
  } finally {
    cleanup();
  }
});

test("AI HTTP endpoints enforce validation, CSRF/auth guard, and honest 503 when credentials are unset", async () => {
  const prevEnv = {
    GOOGLE_GENAI_USE_VERTEXAI: process.env.GOOGLE_GENAI_USE_VERTEXAI,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    VERTEX_AI_PROJECT: process.env.VERTEX_AI_PROJECT,
    VERTEX_AI_API_KEY: process.env.VERTEX_AI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    K_SERVICE: process.env.K_SERVICE,
  };
  delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.VERTEX_AI_PROJECT;
  delete process.env.VERTEX_AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.K_SERVICE;

  const app = express();
  mountAiApi(app);

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Status reports unconfigured honestly
    const statusRes = await fetch(`${baseUrl}/api/ai/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as { configured: boolean; model: string };
    assert.equal(statusJson.configured, false);
    assert.equal(statusJson.model, DEFAULT_VERTEX_MODEL);

    // 2. Empty question returns 400
    const badQ = await fetch(`${baseUrl}/api/ai/erp-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nasqo-Csrf": "1" },
      body: JSON.stringify({ question: "   " }),
    });
    assert.equal(badQ.status, 400);

    // 3. Invalid image MIME type returns 400
    const badMime = await fetch(`${baseUrl}/api/ai/parse-invoice-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nasqo-Csrf": "1" },
      body: JSON.stringify({ imageBase64: "AAAA", imageMimeType: "application/pdf" }),
    });
    assert.equal(badMime.status, 400);

    // 4. Valid request without credentials returns honest 503 (never fake AI data)
    const unconfiguredReq = await fetch(`${baseUrl}/api/ai/categorize-expense`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nasqo-Csrf": "1" },
      body: JSON.stringify({ description: "فاتورة كهرباء المكتب", vendorName: "شركة الكهرباء" }),
    });
    assert.equal(unconfiguredReq.status, 503);

    // 5. Remote host without auth session returns 401
    const prevAdmin = process.env.NASQO_SQLITE_ADMIN_PASSWORD;
    const prevSecret = process.env.NASQO_SQLITE_SESSION_SECRET;
    process.env.NASQO_SQLITE_ADMIN_PASSWORD = "strong-test-password-1234";
    process.env.NASQO_SQLITE_SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
    try {
      const httpMod = await import("node:http");
      const remoteStatus = await new Promise<number>((resolve, reject) => {
        const req = httpMod.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: "/api/ai/status",
            method: "GET",
            headers: { Host: "erp.example.com" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(remoteStatus, 401);
    } finally {
      if (prevAdmin === undefined) delete process.env.NASQO_SQLITE_ADMIN_PASSWORD;
      else process.env.NASQO_SQLITE_ADMIN_PASSWORD = prevAdmin;
      if (prevSecret === undefined) delete process.env.NASQO_SQLITE_SESSION_SECRET;
      else process.env.NASQO_SQLITE_SESSION_SECRET = prevSecret;
    }
  } finally {
    server.close();
    for (const [key, val] of Object.entries(prevEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
});

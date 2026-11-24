import express, { type Express, type Request, type Response } from "express";
import { requireSqliteAccess } from "./sqliteAccess.ts";
import { DEFAULT_WORKSPACE_ID, getSqliteDb } from "./sqliteDb.ts";
import {
  AiServiceUnavailableError,
  analyzeFinancialsWithAi,
  askErpAssistantWithAi,
  buildWorkspaceAiContextSnapshot,
  categorizeExpenseWithAi,
  extractInvoiceFromInputWithAi,
  resolveAiBackendConfig,
} from "./vertexAi.ts";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

function normalizeWorkspaceId(raw: unknown): string {
  if (typeof raw === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.trim())) {
    return raw.trim();
  }
  return DEFAULT_WORKSPACE_ID;
}

function handleAiError(res: Response, err: unknown, fallbackMessage: string) {
  if (err instanceof AiServiceUnavailableError) {
    res.status(503).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : fallbackMessage;
  const statusMatch = /\b(400|401|403|404|429)\b/.exec(message);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 500;
  console.error(`[NASQO Vertex AI] ${fallbackMessage}:`, err);
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
    error: `${fallbackMessage}: ${message}`,
  });
}

export function mountAiApi(app: Express): void {
  const router = express.Router();

  // Every AI route is protected by requireSqliteAccess (session + CSRF/Origin for remote access).
  router.use(requireSqliteAccess);

  router.get("/status", (_req: Request, res: Response) => {
    const cfg = resolveAiBackendConfig();
    res.json({
      configured: cfg.configured,
      provider: cfg.provider,
      model: cfg.model,
      ...(cfg.location ? { location: cfg.location } : {}),
    });
  });

  router.post("/categorize-expense", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      description?: unknown;
      vendorName?: unknown;
      amount?: unknown;
      currency?: unknown;
      entryType?: unknown;
    };

    const description = typeof body.description === "string" ? body.description.trim().slice(0, 500) : "";
    const vendorName = typeof body.vendorName === "string" ? body.vendorName.trim().slice(0, 120) : "";
    const amount = typeof body.amount === "number" || typeof body.amount === "string" ? String(body.amount) : "";
    const currency = typeof body.currency === "string" ? body.currency.trim().slice(0, 20) : "ريال";
    const entryType = typeof body.entryType === "string" ? body.entryType.trim().slice(0, 60) : "";

    if (!description && !vendorName) {
      res.status(400).json({ error: "أدخل بيان العملية أو اسم المورد أولًا للحصول على اقتراح التصنيف." });
      return;
    }

    try {
      const result = await categorizeExpenseWithAi({
        description,
        vendorName,
        amount,
        currency,
        entryType,
      });
      res.json(result);
    } catch (err) {
      handleAiError(res, err, "تعذر إتمام التصنيف الذكي");
    }
  });

  router.post("/erp-assistant", express.json({ limit: "128kb" }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      workspaceId?: unknown;
      question?: unknown;
      history?: unknown;
    };

    const question = typeof body.question === "string" ? body.question.trim().slice(0, 1200) : "";
    if (!question) {
      res.status(400).json({ error: "اكتب سؤالك المحاسبي أو الإداري أولًا." });
      return;
    }

    const workspaceId = normalizeWorkspaceId(body.workspaceId);
    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            (m): m is { role: "user" | "assistant"; text: string } =>
              Boolean(m) &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.text === "string" &&
              m.text.trim().length > 0,
          )
          .slice(-8)
      : [];

    try {
      const db = getSqliteDb();
      const snapshot = buildWorkspaceAiContextSnapshot(db, workspaceId);
      const result = await askErpAssistantWithAi({ question, history, snapshot });
      res.json({
        ...result,
        metrics: {
          accountsCount: snapshot.accountsCount,
          postedLedgerCount: snapshot.postedLedgerCount,
          inventoryItemsCount: snapshot.inventoryItemsCount,
        },
      });
    } catch (err) {
      handleAiError(res, err, "تعذر الحصول على إجابة المستشار الذكي");
    }
  });

  router.post("/analyze-financials", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { workspaceId?: unknown };
    const workspaceId = normalizeWorkspaceId(body.workspaceId);

    try {
      const db = getSqliteDb();
      const snapshot = buildWorkspaceAiContextSnapshot(db, workspaceId);
      const analysis = await analyzeFinancialsWithAi(snapshot);
      res.json({
        ...analysis,
        snapshotSummary: {
          accountsCount: snapshot.accountsCount,
          postedLedgerCount: snapshot.postedLedgerCount,
          inventoryItemsCount: snapshot.inventoryItemsCount,
          inventoryTotalValue: snapshot.inventoryTotalValue,
          lowStockCount: snapshot.lowStockItems.length,
        },
      });
    } catch (err) {
      handleAiError(res, err, "تعذر إنشاء التحليل المالي الذكي");
    }
  });

  router.post("/parse-invoice-note", express.json({ limit: "8mb" }), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      text?: unknown;
      imageBase64?: unknown;
      imageMimeType?: unknown;
      defaultCurrency?: unknown;
    };

    const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
    const rawBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const imageMimeType = typeof body.imageMimeType === "string" ? body.imageMimeType.trim().toLowerCase() : "";
    const defaultCurrency =
      typeof body.defaultCurrency === "string" && body.defaultCurrency.trim()
        ? body.defaultCurrency.trim().slice(0, 20)
        : "ريال";

    if (!text && !rawBase64) {
      res.status(400).json({ error: "أدخل نص الفاتورة أو أرفق صورة مستند لاستخراج البيانات." });
      return;
    }

    if (rawBase64) {
      if (!ALLOWED_IMAGE_MIME_TYPES.has(imageMimeType)) {
        res.status(400).json({ error: "صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WebP." });
        return;
      }
      if (rawBase64.length > 7_000_000) {
        res.status(413).json({ error: "حجم الصورة كبير جدًا. يرجى اختيار صورة أصغر من 5 ميجابايت." });
        return;
      }
    }

    try {
      const extracted = await extractInvoiceFromInputWithAi({
        text: text || undefined,
        imageBase64: rawBase64 || undefined,
        imageMimeType: imageMimeType || undefined,
        defaultCurrency,
      });
      res.json(extracted);
    } catch (err) {
      handleAiError(res, err, "تعذر استخراج بيانات الفاتورة");
    }
  });

  app.use("/api/ai", router);
}

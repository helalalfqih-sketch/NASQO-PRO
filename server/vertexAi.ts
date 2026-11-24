import type { DatabaseSync } from "node:sqlite";
import { GoogleGenAI, ThinkingLevel, Type, type Part } from "@google/genai";
import {
  DEFAULT_WORKSPACE_ID,
  ensureEmptyWorkspace,
  getCashboxesReport,
  getFullWorkspaceBundle,
} from "./sqliteDb.ts";
import { addMoney, mulMoney, roundMoney, subMoney } from "./moneyMath.ts";

export const ALLOWED_EXPENSE_CATEGORIES = [
  "مشتريات بضائع",
  "مصروفات تشغيلية",
  "شحن ونقل",
  "رواتب وأجور",
  "صيانة ومرافق",
  "تسويق ومبيعات",
  "إيجار ومقر",
  "أخرى",
] as const;

export type AllowedExpenseCategory = (typeof ALLOWED_EXPENSE_CATEGORIES)[number];

const DEPRECATED_MODELS = new Set([
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro",
  "gemini-2.0-flash",
  "gemini-2.0-pro",
  "gemini-2.0-flash-thinking",
]);

export const DEFAULT_VERTEX_MODEL = "gemini-4-hydrogen";

export interface AiBackendConfig {
  provider: "vertex-project" | "vertex-express" | "gemini-api" | "unconfigured";
  model: string;
  project?: string;
  location?: string;
  apiKey?: string;
  configured: boolean;
}

export function resolveAiModel(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = (env.VERTEX_AI_MODEL || env.GEMINI_MODEL || "").trim();
  if (!candidate || DEPRECATED_MODELS.has(candidate.toLowerCase())) {
    return DEFAULT_VERTEX_MODEL;
  }
  return candidate;
}

export function resolveAiBackendConfig(env: NodeJS.ProcessEnv = process.env): AiBackendConfig {
  const model = resolveAiModel(env);
  const useVertexFlag = /^(1|true|yes)$/i.test((env.GOOGLE_GENAI_USE_VERTEXAI || "").trim());
  const project = (env.VERTEX_AI_PROJECT || env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = (env.VERTEX_AI_LOCATION || env.GOOGLE_CLOUD_LOCATION || "europe-west3").trim();
  const vertexApiKey = (env.VERTEX_AI_API_KEY || "").trim();
  const geminiApiKey = (env.GEMINI_API_KEY || "").trim();
  const hasAdcCreds = Boolean(
    (env.GOOGLE_APPLICATION_CREDENTIALS || "").trim() ||
      (env.K_SERVICE || "").trim() ||
      (env.CLOUD_RUN_JOB || "").trim(),
  );

  // 1. Explicit Vertex AI mode with GCP project + ADC or Vertex API Key
  if (useVertexFlag && project && (hasAdcCreds || vertexApiKey)) {
    return {
      provider: "vertex-project",
      model,
      project,
      location,
      ...(vertexApiKey ? { apiKey: vertexApiKey } : {}),
      configured: true,
    };
  }

  // 2. Explicit Vertex AI Express Mode (API key without project/ADC)
  if (useVertexFlag && (vertexApiKey || geminiApiKey)) {
    return {
      provider: "vertex-express",
      model,
      apiKey: vertexApiKey || geminiApiKey,
      configured: true,
    };
  }

  // 3. Dedicated Vertex API Key set directly
  if (vertexApiKey) {
    return {
      provider: project ? "vertex-project" : "vertex-express",
      model,
      ...(project ? { project, location } : {}),
      apiKey: vertexApiKey,
      configured: true,
    };
  }

  // 4. Standard Gemini API key (e.g., AI Studio environment)
  if (geminiApiKey) {
    return {
      provider: "gemini-api",
      model,
      apiKey: geminiApiKey,
      configured: true,
    };
  }

  // 5. GCP Cloud Run / ADC environment with project configured
  if (project && hasAdcCreds) {
    return {
      provider: "vertex-project",
      model,
      project,
      location,
      configured: true,
    };
  }

  return {
    provider: "unconfigured",
    model,
    configured: false,
  };
}

export class AiServiceUnavailableError extends Error {
  status = 503;
  constructor(
    message = "خدمة الذكاء الاصطناعي (Vertex AI) غير مهيأة حاليًا على الخادم. يرجى تفعيل متغيرات البيئة المطلوبة (GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_CLOUD_PROJECT أو GEMINI_API_KEY).",
  ) {
    super(message);
    this.name = "AiServiceUnavailableError";
  }
}

export function createVertexGenAiClient(
  timeoutMs = 25_000,
  env: NodeJS.ProcessEnv = process.env,
): { ai: GoogleGenAI; config: AiBackendConfig } {
  const config = resolveAiBackendConfig(env);
  if (!config.configured) {
    throw new AiServiceUnavailableError();
  }

  const httpOptions = {
    timeout: timeoutMs,
    headers: {
      "User-Agent": "aistudio-build",
    },
  };

  if (config.provider === "vertex-project") {
    const ai = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      httpOptions,
    });
    return { ai, config };
  }

  if (config.provider === "vertex-express") {
    const ai = new GoogleGenAI({
      vertexai: true,
      apiKey: config.apiKey,
      httpOptions,
    });
    return { ai, config };
  }

  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions,
  });
  return { ai, config };
}

export interface WorkspaceFinancialSnapshot {
  workspaceId: string;
  companyName: string;
  defaultCurrency: string;
  closedUntilDate: string | null;
  accountsCount: number;
  postedLedgerCount: number;
  draftLedgerCount: number;
  inventoryItemsCount: number;
  warehousesCount: number;
  inventoryTotalValue: number;
  lowStockItems: Array<{
    name: string;
    quantity: number;
    minThreshold: number;
    unit: string;
  }>;
  totalsByCurrency: Array<{
    currency: string;
    totalSales: number;
    totalPurchases: number;
    totalReceipts: number;
    totalPayments: number;
    receivablesNet: number;
    payablesNet: number;
  }>;
  topDebtors: Array<{ name: string; currency: string; balance: number }>;
  topCreditors: Array<{ name: string; currency: string; balance: number }>;
  cashboxesSummary: Array<{ name: string; currency: string; netBalance: number }>;
}

/**
 * Builds a strictly read-only, sanitized accounting snapshot directly from SQLite
 * so Vertex AI responses are grounded in real posted figures (drafts excluded).
 */
export function buildWorkspaceAiContextSnapshot(
  db: DatabaseSync,
  workspaceId = DEFAULT_WORKSPACE_ID,
): WorkspaceFinancialSnapshot {
  ensureEmptyWorkspace(db, workspaceId);
  const bundle = getFullWorkspaceBundle(db, workspaceId);
  const postedEntries = bundle.ledger.filter((e) => !e.deleted && e.postingStatus !== "draft");
  const draftEntries = bundle.ledger.filter((e) => !e.deleted && e.postingStatus === "draft");

  const accountMap = new Map(bundle.accounts.map((a) => [a.id, a]));
  const currencyBuckets = new Map<
    string,
    {
      currency: string;
      totalSales: number;
      totalPurchases: number;
      totalReceipts: number;
      totalPayments: number;
      receivablesNet: number;
      payablesNet: number;
    }
  >();

  const getBucket = (curr: string) => {
    const key = curr.trim() || bundle.workspace.defaultCurrency || "ريال";
    let bucket = currencyBuckets.get(key);
    if (!bucket) {
      bucket = {
        currency: key,
        totalSales: 0,
        totalPurchases: 0,
        totalReceipts: 0,
        totalPayments: 0,
        receivablesNet: 0,
        payablesNet: 0,
      };
      currencyBuckets.set(key, bucket);
    }
    return bucket;
  };

  // Account net balances per (accountId, currency): positive = debit ("عليه"), negative = credit ("له")
  const accountNets = new Map<string, { name: string; category: string; currency: string; net: number }>();

  for (const acc of bundle.accounts) {
    const key = `${acc.id}::${acc.currency}`;
    const openSigned =
      acc.openingBalance > 0
        ? acc.openingDirection === "debit"
          ? roundMoney(acc.openingBalance)
          : -roundMoney(acc.openingBalance)
        : 0;
    accountNets.set(key, {
      name: acc.name,
      category: acc.category,
      currency: acc.currency,
      net: openSigned,
    });
  }

  for (const entry of postedEntries) {
    if (entry.kind === "quote" || entry.kind === "order") continue;
    const bucket = getBucket(entry.currency);
    const acc = accountMap.get(entry.accountId);
    const isSales =
      entry.docType === 2 ||
      (entry.kind === "invoice" && (acc?.category === "clients" || acc?.category === "sales" || /مبيع/.test(entry.typeLabel)));
    const isSalesReturn =
      entry.docType === 4 || (entry.kind === "return" && (acc?.category === "clients" || acc?.category === "sales" || /مبيع/.test(entry.typeLabel)));
    const isPurchase =
      entry.docType === 3 ||
      (entry.kind === "invoice" && (acc?.category === "purchases" || /مشتري/.test(entry.typeLabel)));
    const isPurchaseReturn =
      entry.docType === 5 || (entry.kind === "return" && (acc?.category === "purchases" || /مشتري/.test(entry.typeLabel)));

    if (isSales) bucket.totalSales = addMoney(bucket.totalSales, entry.amount);
    else if (isSalesReturn) bucket.totalSales = subMoney(bucket.totalSales, entry.amount);
    else if (isPurchase) bucket.totalPurchases = addMoney(bucket.totalPurchases, entry.amount);
    else if (isPurchaseReturn) bucket.totalPurchases = subMoney(bucket.totalPurchases, entry.amount);
    else if (entry.kind === "voucher") {
      if (entry.direction === "credit") bucket.totalReceipts = addMoney(bucket.totalReceipts, entry.amount);
      else bucket.totalPayments = addMoney(bucket.totalPayments, entry.amount);
    }

    if (!entry.settledOnReceipt) {
      const key = `${entry.accountId}::${entry.currency}`;
      const existing = accountNets.get(key) ?? {
        name: acc?.name ?? entry.accountName,
        category: acc?.category ?? "clients",
        currency: entry.currency,
        net: 0,
      };
      existing.net =
        entry.direction === "debit"
          ? addMoney(existing.net, entry.amount)
          : subMoney(existing.net, entry.amount);
      accountNets.set(key, existing);
    }
  }

  const debtors: Array<{ name: string; currency: string; balance: number }> = [];
  const creditors: Array<{ name: string; currency: string; balance: number }> = [];

  for (const row of accountNets.values()) {
    const bucket = getBucket(row.currency);
    if (row.net > 0) {
      if (row.category === "clients" || row.category === "sales") {
        bucket.receivablesNet = addMoney(bucket.receivablesNet, row.net);
      }
      debtors.push({ name: row.name, currency: row.currency, balance: row.net });
    } else if (row.net < 0) {
      const absBal = Math.abs(row.net);
      if (row.category === "purchases") {
        bucket.payablesNet = addMoney(bucket.payablesNet, absBal);
      }
      creditors.push({ name: row.name, currency: row.currency, balance: absBal });
    }
  }

  debtors.sort((a, b) => b.balance - a.balance);
  creditors.sort((a, b) => b.balance - a.balance);

  let inventoryTotalValue = 0;
  const lowStockItems: WorkspaceFinancialSnapshot["lowStockItems"] = [];
  for (const item of bundle.inventory) {
    const qty = Number(item.quantity) || 0;
    const cost = Number(item.avgCost) || 0;
    if (qty > 0 && cost > 0) {
      inventoryTotalValue = addMoney(inventoryTotalValue, mulMoney(qty, cost, 2));
    }
    const threshold = Number(item.minThreshold ?? 0);
    if (threshold > 0 && qty <= threshold) {
      lowStockItems.push({
        name: item.name,
        quantity: roundMoney(qty, 2),
        minThreshold: roundMoney(threshold, 2),
        unit: item.unit || "حبة",
      });
    }
  }
  lowStockItems.sort((a, b) => a.quantity - b.quantity);

  const cbReport = getCashboxesReport(db, workspaceId, {});
  const cashboxesSummary = cbReport.cashboxes.slice(0, 12).map((c) => ({
    name: c.name,
    currency: c.currencyCode,
    netBalance: roundMoney(c.netBalance, 2),
  }));

  return {
    workspaceId,
    companyName: bundle.workspace.companyName,
    defaultCurrency: bundle.workspace.defaultCurrency,
    closedUntilDate: bundle.workspace.closedUntilDate ?? null,
    accountsCount: bundle.accounts.length,
    postedLedgerCount: postedEntries.length,
    draftLedgerCount: draftEntries.length,
    inventoryItemsCount: bundle.inventory.length,
    warehousesCount: bundle.warehouses.length,
    inventoryTotalValue,
    lowStockItems: lowStockItems.slice(0, 12),
    totalsByCurrency: Array.from(currencyBuckets.values()),
    topDebtors: debtors.slice(0, 8),
    topCreditors: creditors.slice(0, 8),
    cashboxesSummary,
  };
}

export async function categorizeExpenseWithAi(input: {
  description: string;
  vendorName: string;
  amount: string;
  currency: string;
  entryType: string;
}): Promise<{ category: AllowedExpenseCategory; confidence: number; reason: string; provider: string }> {
  const { ai, config } = createVertexGenAiClient(12_000);
  const prompt = [
    "أنت محاسب مالي محترف لنظام محاسبة عربي (نسقو برو).",
    "صنّف العملية المالية أو المصروف التالي إلى واحدة فقط من الفئات المحاسبية المسموح بها:",
    ALLOWED_EXPENSE_CATEGORIES.join("، "),
    "",
    `اسم الحساب / المورد: ${input.vendorName || "غير محدد"}`,
    `بيان العملية / الأصناف: ${input.description || "غير محدد"}`,
    input.amount ? `المبلغ: ${input.amount} ${input.currency}` : "",
    input.entryType ? `نوع المستند: ${input.entryType}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await ai.models.generateContent({
      model: config.model,
      contents: prompt,
      config: {
        abortSignal: controller.signal,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            category: {
              type: Type.STRING,
              enum: [...ALLOWED_EXPENSE_CATEGORIES],
              description: "أقرب فئة محاسبية مناسبة باللغة العربية.",
            },
            confidence: {
              type: Type.NUMBER,
              description: "نسبة الثقة من 0 إلى 100.",
            },
            reason: {
              type: Type.STRING,
              description: "تفسير عربي موجز جدًا (أقل من 12 كلمة) لسبب التصنيف.",
            },
          },
          required: ["category", "confidence", "reason"],
        },
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("لم يُرجع نموذج التصنيف نتيجة صالحة.");
    }
    const parsed = JSON.parse(text) as {
      category?: string;
      confidence?: number;
      reason?: string;
    };
    const category: AllowedExpenseCategory = ALLOWED_EXPENSE_CATEGORIES.includes(
      parsed.category as AllowedExpenseCategory,
    )
      ? (parsed.category as AllowedExpenseCategory)
      : "أخرى";
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
        : 85;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 140) : "";

    return { category, confidence, reason, provider: config.provider };
  } finally {
    clearTimeout(timer);
  }
}

export async function askErpAssistantWithAi(input: {
  question: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  snapshot: WorkspaceFinancialSnapshot;
}): Promise<{ answer: string; provider: string; model: string }> {
  const { ai, config } = createVertexGenAiClient(25_000);

  const systemInstruction = [
    "أنت المستشار المحاسبي والمالي الذكي لنظام NASQO PRO ERP (يعمل عبر Google Vertex AI / Gemini).",
    "قواعد صارمة يجب الالتزام بها:",
    "1. أجب باللغة العربية الواضحة والمهنية وبإيجاز منظم (نقاط مرقمة أو قصيرة).",
    "2. اعتمد حصريًا على الأرقام الواردة في لقطة البيانات الحية المرفقة أدناه؛ لا تخترع أي أرقام أو فواتير غير موجودة.",
    "3. لا تخلط بين العملات المختلفة أبدًا، واذكر العملة بوضوح بجانب كل مبلغ.",
    "4. لا تنفذ أي ترحيل أو تعديل تلقائي؛ قدّم توصيات وملاحظات محاسبية قابلة للمراجعة فقط.",
    "5. إذا كانت قاعدة البيانات فارغة أو لا توجد حركات بعد، وضّح ذلك بلطف وقدّم خطوات البداية العملية.",
    "",
    "لقطة بيانات المنشأة الحية من SQLite (القيود المرحّلة فقط — المسودات مستبعدة):",
    JSON.stringify(input.snapshot, null, 2),
  ].join("\n");

  const contents = [
    ...input.history.slice(-8).map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.text.slice(0, 1500) }],
    })),
    {
      role: "user",
      parts: [{ text: input.question }],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await ai.models.generateContent({
      model: config.model,
      contents,
      config: {
        abortSignal: controller.signal,
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const answer = response.text?.trim();
    if (!answer) {
      throw new Error("لم يُرجع المساعد الذكي إجابة صالحة.");
    }
    return { answer, provider: config.provider, model: config.model };
  } finally {
    clearTimeout(timer);
  }
}

export interface FinancialAuditInsight {
  healthScore: number;
  summary: string;
  highlights: string[];
  risks: string[];
  recommendations: string[];
  provider: string;
}

export async function analyzeFinancialsWithAi(
  snapshot: WorkspaceFinancialSnapshot,
): Promise<FinancialAuditInsight> {
  const { ai, config } = createVertexGenAiClient(25_000);

  const prompt = [
    "حلّل الوضع المالي والمخزني التالي لمنشأة تستخدم نظام NASQO PRO ERP بناءً على البيانات الحقيقية المرفقة فقط.",
    "لا تخلط بين العملات المختلفة، وإذا كانت الأرصدة فارغة أعطِ تقييمًا تمهيديًا صادقًا مع خطوات التأسيس.",
    "",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await ai.models.generateContent({
      model: config.model,
      contents: prompt,
      config: {
        abortSignal: controller.signal,
        systemInstruction:
          "أنت مراجع مالي ومحلل ERP عربي. أعد JSON مطابقًا تمامًا للمخطط المطلوب باللغة العربية الواضحة وبإيجاز تنفيذي.",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            healthScore: {
              type: Type.INTEGER,
              description: "مؤشر صحة مالية من 0 إلى 100 بناءً على السيولة والذمم والمخزون.",
            },
            summary: {
              type: Type.STRING,
              description: "ملخص تنفيذي من جملتين إلى ثلاث جمل بالعربية.",
            },
            highlights: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "3 إلى 4 نقاط قوة أو مؤشرات إيجابية بارزة.",
            },
            risks: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "2 إلى 4 مخاطر مالية أو مخزنية محتملة.",
            },
            recommendations: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "3 توصيات عملية مرتبة حسب الأولوية.",
            },
          },
          required: ["healthScore", "summary", "highlights", "risks", "recommendations"],
        },
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("لم يُرجع نموذج التحليل المالي نتيجة صالحة.");
    }
    const parsed = JSON.parse(text) as Partial<FinancialAuditInsight>;
    return {
      healthScore:
        typeof parsed.healthScore === "number" && Number.isFinite(parsed.healthScore)
          ? Math.max(0, Math.min(100, Math.round(parsed.healthScore)))
          : 70,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      highlights: Array.isArray(parsed.highlights)
        ? parsed.highlights.filter((s): s is string => typeof s === "string").slice(0, 6)
        : [],
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.filter((s): s is string => typeof s === "string").slice(0, 6)
        : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((s): s is string => typeof s === "string").slice(0, 6)
        : [],
      provider: config.provider,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ExtractedInvoiceDraft {
  partyName: string;
  invoiceType: "sales" | "purchases" | "voucher";
  payment: "cash" | "credit";
  currency: string;
  entryDate: string;
  notes: string;
  totalAmount: number;
  items: Array<{
    name: string;
    unit: string;
    quantity: number;
    price: number;
    total: number;
  }>;
  provider: string;
}

export async function extractInvoiceFromInputWithAi(input: {
  text?: string;
  imageBase64?: string;
  imageMimeType?: string;
  defaultCurrency?: string;
}): Promise<ExtractedInvoiceDraft> {
  const { ai, config } = createVertexGenAiClient(25_000);
  const parts: Part[] = [];

  if (input.imageBase64 && input.imageMimeType) {
    parts.push({
      inlineData: {
        mimeType: input.imageMimeType,
        data: input.imageBase64,
      },
    });
  }

  parts.push({
    text: [
      "استخرج بيانات الفاتورة أو السند المالي من النص أو الصورة المرفقة بدقة محاسبية.",
      `العملة الافتراضية عند عدم الذكر: ${input.defaultCurrency || "ريال"}.`,
      "إذا لم تتضح قيمة حقل نصي اتركه فارغًا، وإذا لم توجد أصناف تفصيلية اجعل مصفوفة items فارغة واضبط totalAmount فقط.",
      input.text ? `النص المدخل:\n${input.text}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await ai.models.generateContent({
      model: config.model,
      contents: { parts },
      config: {
        abortSignal: controller.signal,
        systemInstruction:
          "أنت مدخل بيانات محاسبي خبير في الفواتير العربية. أعد JSON دقيقًا مطابقًا للمخطط دون أي نص إضافي.",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            partyName: { type: Type.STRING, description: "اسم العميل أو المورد إن وجد." },
            invoiceType: {
              type: Type.STRING,
              enum: ["sales", "purchases", "voucher"],
              description: "نوع المستند: مبيعات أو مشتريات أو سند.",
            },
            payment: {
              type: Type.STRING,
              enum: ["cash", "credit"],
              description: "طريقة الدفع: نقدي أو آجل.",
            },
            currency: { type: Type.STRING, description: "اسم العملة (مثل ريال أو دولار)." },
            entryDate: { type: Type.STRING, description: "تاريخ الفاتورة بصيغة YYYY-MM-DD إن وجد." },
            notes: { type: Type.STRING, description: "ملخص البيان أو الملاحظات." },
            totalAmount: { type: Type.NUMBER, description: "الإجمالي النهائي للمستند." },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  unit: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  price: { type: Type.NUMBER },
                  total: { type: Type.NUMBER },
                },
                required: ["name", "quantity", "price"],
              },
            },
          },
          required: ["partyName", "invoiceType", "payment", "currency", "totalAmount", "items"],
        },
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("لم يتمكن النموذج من استخراج بيانات الفاتورة.");
    }
    const parsed = JSON.parse(text) as Partial<ExtractedInvoiceDraft>;
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter((item) => item && typeof item.name === "string" && item.name.trim())
          .slice(0, 50)
          .map((item) => {
            const quantity = Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 ? roundMoney(Number(item.quantity), 2) : 1;
            const price = Number.isFinite(Number(item.price)) && Number(item.price) >= 0 ? roundMoney(Number(item.price), 2) : 0;
            const total =
              Number.isFinite(Number(item.total)) && Number(item.total) > 0
                ? roundMoney(Number(item.total), 2)
                : mulMoney(quantity, price, 2);
            return {
              name: item.name.trim().slice(0, 120),
              unit: typeof item.unit === "string" && item.unit.trim() ? item.unit.trim().slice(0, 30) : "حبة",
              quantity,
              price,
              total,
            };
          })
      : [];

    const computedItemsTotal = items.reduce((acc, item) => addMoney(acc, item.total), 0);
    const totalAmount =
      Number.isFinite(Number(parsed.totalAmount)) && Number(parsed.totalAmount) > 0
        ? roundMoney(Number(parsed.totalAmount), 2)
        : computedItemsTotal;

    return {
      partyName: typeof parsed.partyName === "string" ? parsed.partyName.trim().slice(0, 120) : "",
      invoiceType:
        parsed.invoiceType === "purchases" || parsed.invoiceType === "voucher" ? parsed.invoiceType : "sales",
      payment: parsed.payment === "credit" ? "credit" : "cash",
      currency:
        typeof parsed.currency === "string" && parsed.currency.trim()
          ? parsed.currency.trim().slice(0, 20)
          : input.defaultCurrency || "ريال",
      entryDate:
        typeof parsed.entryDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.entryDate.trim())
          ? parsed.entryDate.trim()
          : "",
      notes: typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 300) : "",
      totalAmount,
      items,
      provider: config.provider,
    };
  } finally {
    clearTimeout(timer);
  }
}

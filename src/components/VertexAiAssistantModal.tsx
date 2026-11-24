import { useRef, useState, type ChangeEvent } from "react";
import {
  BarChartIcon,
  CheckCircledIcon,
  CopyIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  FileTextIcon,
  ImageIcon,
  MagicWandIcon,
  PaperPlaneIcon,
  ReloadIcon,
} from "@radix-ui/react-icons";
import { KeyboardInput, KeyboardTextarea, MobileScroll, useKeyboard } from "../mobile";
import { formatAmount } from "../accounting";
import { triggerHaptic } from "../utils/haptics";

type AiTab = "chat" | "analysis" | "extract";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface FinancialAnalysisResult {
  healthScore: number;
  summary: string;
  highlights: string[];
  risks: string[];
  recommendations: string[];
  snapshotSummary?: {
    accountsCount: number;
    postedLedgerCount: number;
    inventoryItemsCount: number;
    inventoryTotalValue: number;
    lowStockCount: number;
  };
}

interface ExtractedInvoiceResult {
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
}

interface VertexAiAssistantModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  companyName: string;
  defaultCurrency: string;
  onNotify: (message: string) => void;
  onOpenInvoiceFlow?: () => void;
}

const STARTER_QUESTIONS = [
  "لخّص لي وضع السيولة والذمم المدينة والدائنة الحالية",
  "ما هي الأصناف التي وصلت للحد الأدنى وتحتاج إعادة طلب؟",
  "قدّم ملخصًا لحركة المبيعات والمشتريات حسب العملة",
  "ما أبرز 3 خطوات عملية لتحسين التحصيل النقدي هذا الشهر؟",
] as const;

function readFileAsBase64(file: File): Promise<{ base64: string; mimeType: string; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
      if (!match) {
        reject(new Error("تعذر قراءة الصورة المختارة."));
        return;
      }
      resolve({
        mimeType: match[1].toLowerCase(),
        base64: match[2],
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => reject(new Error("فشل تحميل ملف الصورة."));
    reader.readAsDataURL(file);
  });
}

export function VertexAiAssistantModal({
  open,
  onClose,
  workspaceId,
  companyName,
  defaultCurrency,
  onNotify,
  onOpenInvoiceFlow,
}: VertexAiAssistantModalProps) {
  const keyboard = useKeyboard();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<AiTab>("chat");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");

  const [analysisBusy, setAnalysisBusy] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysis, setAnalysis] = useState<FinancialAnalysisResult | null>(null);

  const [extractText, setExtractText] = useState("");
  const [extractImage, setExtractImage] = useState<{
    base64: string;
    mimeType: string;
    previewUrl: string;
    fileName: string;
  } | null>(null);
  const [extractBusy, setExtractBusy] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [extracted, setExtracted] = useState<ExtractedInvoiceResult | null>(null);

  if (!open) return null;

  const handleClose = () => {
    keyboard.hide();
    onClose();
  };

  const handleAsk = async (promptText?: string) => {
    const clean = (promptText ?? question).trim();
    if (!clean || chatBusy) return;

    keyboard.hide();
    triggerHaptic("light");
    setChatError("");
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: "user",
      text: clean,
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setQuestion("");
    setChatBusy(true);

    try {
      const res = await fetch("/api/ai/erp-assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nasqo-Csrf": "1",
        },
        body: JSON.stringify({
          workspaceId,
          question: clean,
          history: messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const payload = (await res.json()) as { answer?: string; error?: string };
      if (!res.ok || !payload.answer) {
        setChatError(payload.error || "تعذر الحصول على رد من خدمة Vertex AI حاليًا.");
        triggerHaptic("warning");
        return;
      }
      setMessages((prev) => [
        ...prev,
        { id: `a_${Date.now()}`, role: "assistant", text: payload.answer! },
      ]);
      triggerHaptic("success");
    } catch {
      setChatError("تعذر الاتصال بخادم الذكاء الاصطناعي. تحقق من الاتصال وأعد المحاولة.");
      triggerHaptic("warning");
    } finally {
      setChatBusy(false);
    }
  };

  const handleRunAnalysis = async () => {
    if (analysisBusy) return;
    keyboard.hide();
    triggerHaptic("light");
    setAnalysisBusy(true);
    setAnalysisError("");
    try {
      const res = await fetch("/api/ai/analyze-financials", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nasqo-Csrf": "1",
        },
        body: JSON.stringify({ workspaceId }),
      });
      const payload = (await res.json()) as FinancialAnalysisResult & { error?: string };
      if (!res.ok || typeof payload.summary !== "string") {
        setAnalysisError(payload.error || "تعذر إنشاء التحليل المالي الذكي حاليًا.");
        triggerHaptic("warning");
        return;
      }
      setAnalysis(payload);
      triggerHaptic("success");
    } catch {
      setAnalysisError("تعذر الاتصال بخادم الذكاء الاصطناعي لإتمام التحليل.");
      triggerHaptic("warning");
    } finally {
      setAnalysisBusy(false);
    }
  };

  const handleImagePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setExtractError("حجم الصورة أكبر من 5 ميجابايت. يرجى اختيار صورة أصغر.");
      return;
    }
    try {
      const parsed = await readFileAsBase64(file);
      setExtractImage({ ...parsed, fileName: file.name });
      setExtractError("");
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "تعذر قراءة الصورة.");
    }
  };

  const handleExtractInvoice = async () => {
    if (extractBusy) return;
    if (!extractText.trim() && !extractImage) {
      setExtractError("أدخل نص الفاتورة أو أرفق صورة مستند أولًا.");
      return;
    }
    keyboard.hide();
    triggerHaptic("light");
    setExtractBusy(true);
    setExtractError("");
    try {
      const res = await fetch("/api/ai/parse-invoice-note", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Nasqo-Csrf": "1",
        },
        body: JSON.stringify({
          text: extractText.trim() || undefined,
          imageBase64: extractImage?.base64,
          imageMimeType: extractImage?.mimeType,
          defaultCurrency,
        }),
      });
      const payload = (await res.json()) as ExtractedInvoiceResult & { error?: string };
      if (!res.ok || !Array.isArray(payload.items)) {
        setExtractError(payload.error || "تعذر استخراج بيانات الفاتورة حاليًا.");
        triggerHaptic("warning");
        return;
      }
      setExtracted(payload);
      triggerHaptic("success");
    } catch {
      setExtractError("تعذر الاتصال بخادم التحليل. حاول مرة أخرى.");
      triggerHaptic("warning");
    } finally {
      setExtractBusy(false);
    }
  };

  const handleCopyExtracted = async () => {
    if (!extracted) return;
    const typeLabel =
      extracted.invoiceType === "purchases"
        ? "فاتورة مشتريات"
        : extracted.invoiceType === "voucher"
          ? "سند مالي"
          : "فاتورة مبيعات";
    const linesText = extracted.items
      .map((item, idx) => `${idx + 1}. ${item.name} — ${item.quantity} ${item.unit} × ${formatAmount(item.price)} = ${formatAmount(item.total)}`)
      .join("\n");
    const summaryText = [
      `${typeLabel} (${extracted.payment === "credit" ? "آجل" : "نقدي"})`,
      extracted.partyName ? `الطرف: ${extracted.partyName}` : "",
      extracted.entryDate ? `التاريخ: ${extracted.entryDate}` : "",
      linesText ? `الأصناف:\n${linesText}` : "",
      `الإجمالي: ${formatAmount(extracted.totalAmount)} ${extracted.currency}`,
      extracted.notes ? `ملاحظات: ${extracted.notes}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(summaryText);
      onNotify("تم نسخ تفاصيل الفاتورة المستخرجة إلى الحافظة.");
    } catch {
      onNotify("تعذر النسخ التلقائي إلى الحافظة.");
    }
  };

  return (
    <div className="modal-backdrop-layer vertex-ai-backdrop" data-testid="vertex-ai-modal">
      <section className="vertex-ai-shell" role="dialog" aria-modal="true" aria-label="المستشار الذكي Vertex AI">
        <header className="vertex-ai-header">
          <div className="vertex-ai-title-group">
            <span className="vertex-ai-icon-badge" aria-hidden="true">
              <MagicWandIcon />
            </span>
            <div>
              <h2>المستشار الذكي — Vertex AI</h2>
              <p>{companyName || "نسقو برو"} • تحليل فوري مرتبط بدفاترك المحلية</p>
            </div>
          </div>
          <button type="button" className="vertex-ai-close" onClick={handleClose} aria-label="إغلاق">
            <Cross2Icon />
          </button>
        </header>

        <nav className="vertex-ai-tabs" role="tablist" aria-label="أقسام الذكاء الاصطناعي">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chat"}
            className={tab === "chat" ? "active" : ""}
            onClick={() => {
              keyboard.hide();
              setTab("chat");
            }}
            data-testid="vertex-ai-tab-chat"
          >
            <MagicWandIcon />
            <span>المستشار</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "analysis"}
            className={tab === "analysis" ? "active" : ""}
            onClick={() => {
              keyboard.hide();
              setTab("analysis");
            }}
            data-testid="vertex-ai-tab-analysis"
          >
            <BarChartIcon />
            <span>التحليل المالي</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "extract"}
            className={tab === "extract" ? "active" : ""}
            onClick={() => {
              keyboard.hide();
              setTab("extract");
            }}
            data-testid="vertex-ai-tab-extract"
          >
            <FileTextIcon />
            <span>قراءة فاتورة</span>
          </button>
        </nav>

        <MobileScroll className="vertex-ai-body">
          {tab === "chat" ? (
            <div className="vertex-ai-pane">
              {messages.length === 0 ? (
                <div className="vertex-ai-empty">
                  <p>
                    اسأل أي سؤال حول السيولة، الذمم، المخزون، أو المبيعات، وسيعتمد التحليل على الأرصدة المرحلة
                    الفعلية في قاعدة بياناتك (قراءة فقط دون أي تعديل تلقائي).
                  </p>
                  <div className="vertex-ai-starters">
                    {STARTER_QUESTIONS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        className="vertex-ai-starter-btn"
                        disabled={chatBusy}
                        onClick={() => void handleAsk(starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="vertex-ai-messages">
                  {messages.map((msg) => (
                    <article
                      key={msg.id}
                      className={`vertex-ai-bubble ${msg.role === "user" ? "user" : "assistant"}`}
                    >
                      <span className="vertex-ai-bubble-role">
                        {msg.role === "user" ? "أنت" : "المستشار الذكي"}
                      </span>
                      <p>{msg.text}</p>
                    </article>
                  ))}
                  {chatBusy ? (
                    <div className="vertex-ai-thinking" role="status">
                      جارٍ تحليل بيانات الدفاتر عبر Vertex AI...
                    </div>
                  ) : null}
                </div>
              )}

              {chatError ? (
                <div className="vertex-ai-alert" role="alert">
                  <ExclamationTriangleIcon />
                  <span>{chatError}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "analysis" ? (
            <div className="vertex-ai-pane">
              <div className="vertex-ai-action-card">
                <p>
                  توليد تقرير تنفيذي فوري يقيس الصحة المالية، الذمم المستحقة، ونواقص المخزون بناءً على
                  بياناتك المرحلة الحالية.
                </p>
                <button
                  type="button"
                  className="vertex-ai-primary-btn"
                  disabled={analysisBusy}
                  onClick={() => void handleRunAnalysis()}
                  data-testid="vertex-ai-run-analysis"
                >
                  <ReloadIcon />
                  <span>{analysisBusy ? "جارٍ إعداد التحليل..." : analysis ? "تحديث التحليل المالي" : "بدء التحليل المالي الذكي"}</span>
                </button>
              </div>

              {analysisError ? (
                <div className="vertex-ai-alert" role="alert">
                  <ExclamationTriangleIcon />
                  <span>{analysisError}</span>
                </div>
              ) : null}

              {analysis ? (
                <div className="vertex-ai-report">
                  <div className="vertex-ai-score-card">
                    <div>
                      <span>مؤشر الصحة المالية</span>
                      <strong>{analysis.healthScore} / 100</strong>
                    </div>
                    {analysis.snapshotSummary ? (
                      <small>
                        {analysis.snapshotSummary.accountsCount} حساب •{" "}
                        {analysis.snapshotSummary.postedLedgerCount} قيد مرحّل •{" "}
                        {analysis.snapshotSummary.lowStockCount} صنف منخفض
                      </small>
                    ) : null}
                  </div>

                  <p className="vertex-ai-summary">{analysis.summary}</p>

                  {analysis.highlights.length > 0 ? (
                    <section className="vertex-ai-list-box positive">
                      <h3>
                        <CheckCircledIcon /> نقاط القوة والمؤشرات الإيجابية
                      </h3>
                      <ul>
                        {analysis.highlights.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {analysis.risks.length > 0 ? (
                    <section className="vertex-ai-list-box warning">
                      <h3>
                        <ExclamationTriangleIcon /> المخاطر والتنبيهات المالية
                      </h3>
                      <ul>
                        {analysis.risks.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {analysis.recommendations.length > 0 ? (
                    <section className="vertex-ai-list-box neutral">
                      <h3>
                        <MagicWandIcon /> التوصيات العملية
                      </h3>
                      <ul>
                        {analysis.recommendations.map((rec, i) => (
                          <li key={i}>{rec}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "extract" ? (
            <div className="vertex-ai-pane">
              <div className="vertex-ai-extract-form">
                <label className="vertex-ai-field-label">
                  <span>نص الفاتورة أو رسالة العميل / المورد</span>
                  <KeyboardTextarea
                    rows={4}
                    placeholder="مثال: فاتورة مبيعات آجلة لمؤسسة النور — 5 كرتون ورق A4 بسعر 95 ريال، و2 حبر طابعة بسعر 180 ريال..."
                    value={extractText}
                    onChange={(e) => setExtractText(e.target.value)}
                    data-testid="vertex-ai-extract-input"
                  />
                </label>

                <div className="vertex-ai-image-row">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="vertex-ai-file-input"
                    onChange={(e) => void handleImagePick(e)}
                  />
                  <button
                    type="button"
                    className="vertex-ai-secondary-btn"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImageIcon />
                    <span>{extractImage ? "تغيير صورة الفاتورة" : "إرفاق صورة فاتورة / إيصال"}</span>
                  </button>
                  {extractImage ? (
                    <button
                      type="button"
                      className="vertex-ai-clear-btn"
                      onClick={() => setExtractImage(null)}
                    >
                      إزالة الصورة
                    </button>
                  ) : null}
                </div>

                {extractImage ? (
                  <div className="vertex-ai-preview-box">
                    <img src={extractImage.previewUrl} alt="معاينة الفاتورة" draggable={false} />
                    <span>{extractImage.fileName}</span>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="vertex-ai-primary-btn"
                  disabled={extractBusy}
                  onClick={() => void handleExtractInvoice()}
                  data-testid="vertex-ai-extract-btn"
                >
                  <MagicWandIcon />
                  <span>{extractBusy ? "جارٍ استخراج البيانات..." : "استخراج البنود والمبالغ"}</span>
                </button>
              </div>

              {extractError ? (
                <div className="vertex-ai-alert" role="alert">
                  <ExclamationTriangleIcon />
                  <span>{extractError}</span>
                </div>
              ) : null}

              {extracted ? (
                <div className="vertex-ai-extracted-card">
                  <div className="vertex-ai-extracted-meta">
                    <div>
                      <span>النوع</span>
                      <strong>
                        {extracted.invoiceType === "purchases"
                          ? "مشتريات"
                          : extracted.invoiceType === "voucher"
                            ? "سند"
                            : "مبيعات"}{" "}
                        ({extracted.payment === "credit" ? "آجل" : "نقدي"})
                      </strong>
                    </div>
                    <div>
                      <span>الطرف</span>
                      <strong>{extracted.partyName || "غير محدد"}</strong>
                    </div>
                    <div>
                      <span>الإجمالي</span>
                      <strong>
                        {formatAmount(extracted.totalAmount)} {extracted.currency}
                      </strong>
                    </div>
                  </div>

                  {extracted.items.length > 0 ? (
                    <table className="vertex-ai-items-table">
                      <thead>
                        <tr>
                          <th>الصنف</th>
                          <th>الكمية</th>
                          <th>السعر</th>
                          <th>الإجمالي</th>
                        </tr>
                      </thead>
                      <tbody>
                        {extracted.items.map((item, idx) => (
                          <tr key={idx}>
                            <td>{item.name}</td>
                            <td>
                              {item.quantity} {item.unit}
                            </td>
                            <td>{formatAmount(item.price)}</td>
                            <td>{formatAmount(item.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {extracted.notes ? <p className="vertex-ai-extracted-notes">{extracted.notes}</p> : null}

                  <div className="vertex-ai-extracted-actions">
                    <button type="button" className="vertex-ai-secondary-btn" onClick={() => void handleCopyExtracted()}>
                      <CopyIcon />
                      <span>نسخ التفاصيل</span>
                    </button>
                    {onOpenInvoiceFlow ? (
                      <button
                        type="button"
                        className="vertex-ai-primary-btn"
                        onClick={() => {
                          handleClose();
                          onOpenInvoiceFlow();
                        }}
                      >
                        <FileTextIcon />
                        <span>فتح شاشة الفاتورة</span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </MobileScroll>

        {tab === "chat" ? (
          <form
            className="vertex-ai-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAsk();
            }}
          >
            <KeyboardInput
              type="text"
              placeholder="اكتب سؤالك المحاسبي هنا..."
              aria-label="سؤال المستشار الذكي"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              data-testid="vertex-ai-chat-input"
            />
            <button
              type="submit"
              className="vertex-ai-send-btn"
              disabled={chatBusy || !question.trim()}
              aria-label="إرسال السؤال"
              data-testid="vertex-ai-chat-send"
            >
              <PaperPlaneIcon />
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

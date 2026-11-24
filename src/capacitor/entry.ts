import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { CapacitorRepository, type NativeDevice } from "./repository";
import { decodeBase64, encodeBase64 } from "./sqlite";
import { HYBRID_PROTOCOL_VERSION, type HybridHostEventEnvelope } from "../hybrid/contracts";

interface NativeStorage extends NativeDevice {
  load(): Promise<{ exists: boolean; data?: string; revision: string }>;
  save(options: { data: string; expectedRevision: string }): Promise<{ revision: string }>;
}

const storage = registerPlugin<NativeStorage>("NasqoStorage");
let ready: Promise<CapacitorRepository> | undefined;
let backRegistered = false;

function send(message: unknown): void { window.__nasqoHybridReceive?.(message); }

function initialize(): Promise<CapacitorRepository> {
  if (ready) return ready;
  ready = (async () => {
    if (!Capacitor.isNativePlatform()) throw new Error("افتح نسخة Android المثبتة لاستخدام قاعدة البيانات المحلية.");
    const [SQL, existing] = await Promise.all([initSqlJs({ locateFile: () => wasmUrl }), storage.load()]);
    let revision = existing.revision;
    const repository = new CapacitorRepository(SQL, existing.exists ? decodeBase64(existing.data!) : undefined,
      async bytes => {
        const saved = await storage.save({ data: encodeBase64(bytes), expectedRevision: revision });
        revision = saved.revision;
      }, storage, send);
    await repository.initialize();
    if (!backRegistered) {
      await App.addListener("backButton", () => {
        if (repository.activeRoute === "home" || repository.activeRoute === "dashboard") void App.minimizeApp();
        else send({ protocolVersion: HYBRID_PROTOCOL_VERSION, kind: "event", event: "backPressed", payload: {} } satisfies HybridHostEventEnvelope);
      });
      backRegistered = true;
    }
    return repository;
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}

// A production transport backed by the local accounting engine and atomic native storage.
// It is installed before the existing React entry requests its first snapshot.
window.NasqoHome = {
  postMessage(serialized: string) {
    let request: { requestId?: string; action?: string };
    try { request = JSON.parse(serialized); } catch { return; }
    void initialize().then(repository => repository.request(request)).then(send).catch(error => send({
      protocolVersion: HYBRID_PROTOCOL_VERSION, kind: "response", requestId: request.requestId,
      action: request.action, ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: error instanceof Error ? error.message : "تعذر فتح قاعدة البيانات المحلية.", retryable: true },
    }));
  },
};

void import("../hybrid/entry");

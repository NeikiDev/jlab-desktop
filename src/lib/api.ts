import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppError,
  ConfirmedFamily,
  HistoryEntry,
  RatterScannerIntel,
  ScanPhaseEvent,
  ScanResult,
  Severity,
  Signature,
  SignatureMatch,
  ThreatIntel,
  ThreatRipIntel,
  VirusTotalIntel,
} from "./types";

interface ApiMatch {
  className?: string | null;
  member?: string | null;
  path?: string | null;
  matchedValue?: string | null;
}

interface ApiSignature {
  id?: string | null;
  severity?: string;
  name?: string;
  description?: string;
  type?: string;
  count?: number;
  matches?: ApiMatch[];
  family?: string | null;
}

interface ApiScanResult {
  success: boolean;
  fileName: string;
  fileSize: number;
  totalSignatures: number;
  matchedSignatures: number;
  signatures: ApiSignature[];
  confirmedFamilies?: unknown;
}

interface ScanEnvelope {
  scan: ApiScanResult;
  threatIntel?: unknown;
  sha256?: string | null;
}

const KNOWN_SEVERITIES: ReadonlyArray<Severity> = ["critical", "high", "medium", "low", "info"];

function normalizeSeverity(value: string | undefined): Severity {
  return KNOWN_SEVERITIES.includes(value as Severity) ? (value as Severity) : "info";
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeErrorCode(stage: string, err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const msg = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
  const hash = fnv1a(`${stage}:${name}:${msg}`).toString(36).toUpperCase();
  const stagePart = stage.toUpperCase().slice(0, 3).padEnd(3, "X");
  return `${stagePart}-${hash.padStart(7, "0").slice(0, 7)}`;
}

function clientError(stage: string, err: unknown, userMessage: string): AppError {
  const name = err instanceof Error ? err.name : "Error";
  const code = makeErrorCode(stage, err);
  console.error(`[scanJar] ${stage} failed [${code}]`, err);
  return {
    kind: "invalid_response",
    message: `${userMessage} (${name})`,
    code,
  };
}

export async function scanJar(path: string): Promise<ScanResult> {
  const t0 = performance.now();
  console.log("[scanJar] invoke start", path);
  await ensurePhaseListener();
  resetPhaseBuffer();
  const json = await invoke<string>("scan_jar", { path });
  const t1 = performance.now();
  console.log(`[scanJar] invoke resolved in ${(t1 - t0).toFixed(0)}ms — ${json.length} chars`);

  let envelope: ScanEnvelope;
  try {
    envelope = JSON.parse(json);
  } catch (e) {
    throw clientError("parse", e, "Could not parse scan result");
  }
  const t2 = performance.now();

  const rawObj = asObj(envelope?.scan);
  const rawSignatures = rawObj && Array.isArray(rawObj.signatures) ? rawObj.signatures : null;
  if (!rawObj || !rawSignatures) {
    throw clientError(
      "shape",
      new Error("missing signatures array"),
      "Scan result was not in the expected shape",
    );
  }
  console.log(`[scanJar] JSON.parse in ${(t2 - t1).toFixed(0)}ms, ${rawSignatures.length} sigs`);

  let signatures: Signature[];
  try {
    signatures = (rawSignatures as ApiSignature[]).map((s, i) => {
      const matches: SignatureMatch[] = (s.matches ?? []).map((m) => ({
        className: m.className ?? null,
        member: m.member ?? null,
        path: m.path ?? null,
        matchedValue: m.matchedValue ?? null,
      }));
      const baseId = s.id && s.id.length > 0 ? s.id : (s.name ?? "signature");
      return {
        id: `${baseId}::${s.type ?? "?"}::${i}`,
        severity: normalizeSeverity(s.severity),
        name: s.name ?? "Unnamed signature",
        description: s.description ?? "",
        kind: s.type ?? "",
        count: s.count ?? 0,
        matches,
        family: typeof s.family === "string" && s.family.length > 0 ? s.family : null,
      };
    });
  } catch (e) {
    throw clientError("map", e, "Could not process scan result");
  }
  const t3 = performance.now();
  console.log(`[scanJar] mapped payload in ${(t3 - t2).toFixed(0)}ms`);

  const confirmedFamilies = normalizeConfirmedFamilies(rawObj.confirmedFamilies, signatures);
  const sha256 =
    typeof envelope.sha256 === "string" && envelope.sha256.length > 0
      ? envelope.sha256
      : null;
  const threatIntel = normalizeThreatIntel(envelope.threatIntel, sha256);

  return {
    success: asBool(rawObj.success, false),
    fileName: asStr(rawObj.fileName) ?? "(unknown file)",
    fileSize: asNum(rawObj.fileSize) ?? 0,
    totalSignatures: asNum(rawObj.totalSignatures) ?? signatures.length,
    matchedSignatures: asNum(rawObj.matchedSignatures) ?? signatures.length,
    signatures,
    confirmedFamilies,
    sha256,
    threatIntel,
  };
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalizeThreatRip(v: unknown): ThreatRipIntel | null {
  const o = asObj(v);
  if (!o) return null;
  return {
    available: asBool(o.available),
    verdict: asStr(o.verdict),
    threatScore: asNum(o.threatScore),
    threat: asStr(o.threat),
    sha256: asStr(o.sha256),
  };
}

function normalizeRatterGithubInfo(v: unknown) {
  const o = asObj(v);
  if (!o) return null;
  const info = {
    name: asStr(o.name),
    owner: asStr(o.owner),
    projectName: asStr(o.projectName),
    repoUrl: asStr(o.repoUrl),
    downloadUrl: asStr(o.downloadUrl),
  };
  if (!info.name && !info.owner && !info.projectName && !info.repoUrl) return null;
  return info;
}

function normalizeRatter(v: unknown): RatterScannerIntel | null {
  const o = asObj(v);
  if (!o) return null;
  return {
    available: asBool(o.available),
    safe: asBool(o.safe),
    malicious: asBool(o.malicious),
    automatedSafe: asBool(o.automated_safe),
    hash: asStr(o.hash),
    githubInfo: normalizeRatterGithubInfo(o.githubInfo),
  };
}

function normalizeVirusTotal(v: unknown): VirusTotalIntel | null {
  const o = asObj(v);
  if (!o) return null;
  return {
    available: asBool(o.available),
    malicious: asNum(o.malicious),
    suspicious: asNum(o.suspicious),
    undetected: asNum(o.undetected),
    harmless: asNum(o.harmless),
    detections: asNum(o.detections),
    totalScanners: asNum(o.totalScanners),
    reputation: asNum(o.reputation),
    fileType: asStr(o.fileType),
  };
}

function normalizeThreatIntel(v: unknown, sha256: string | null): ThreatIntel | null {
  const o = asObj(v);
  if (!o) return null;
  const intel: ThreatIntel = {
    sha256: asStr(o.sha256) ?? sha256,
    threatRip: normalizeThreatRip(o.threatRip),
    ratterScanner: normalizeRatter(o.ratterScanner),
    virusTotal: normalizeVirusTotal(o.virusTotal),
  };
  if (!intel.threatRip && !intel.ratterScanner && !intel.virusTotal) return null;
  return intel;
}

function familyEntryFromObject(
  obj: Record<string, unknown>,
): { name: string; explicitCount: number | null } | null {
  const nameKeys = ["name", "family", "familyName", "label", "id"];
  let name: string | null = null;
  for (const k of nameKeys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      name = v;
      break;
    }
  }
  if (!name) return null;

  const countKeys = ["signatureCount", "signatures", "count", "matches", "matchCount"];
  let explicitCount: number | null = null;
  for (const k of countKeys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      explicitCount = v;
      break;
    }
    if (Array.isArray(v)) {
      explicitCount = v.length;
      break;
    }
  }
  return { name, explicitCount };
}

function normalizeConfirmedFamilies(raw: unknown, signatures: Signature[]): ConfirmedFamily[] {
  if (raw == null) return [];

  const collected: { name: string; explicitCount: number | null }[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.length > 0) {
        collected.push({ name: item, explicitCount: null });
      } else if (item && typeof item === "object") {
        const e = familyEntryFromObject(item as Record<string, unknown>);
        if (e) collected.push(e);
      }
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!k) continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        collected.push({ name: k, explicitCount: v });
      } else if (Array.isArray(v)) {
        collected.push({ name: k, explicitCount: v.length });
      } else if (v && typeof v === "object") {
        const e = familyEntryFromObject(v as Record<string, unknown>);
        if (e) collected.push({ name: e.name || k, explicitCount: e.explicitCount });
      } else {
        collected.push({ name: k, explicitCount: null });
      }
    }
  }

  if (collected.length === 0) return [];

  const fallbackCounts = new Map<string, number>();
  for (const sig of signatures) {
    if (sig.family) {
      fallbackCounts.set(sig.family, (fallbackCounts.get(sig.family) ?? 0) + 1);
    }
  }

  const seen = new Set<string>();
  const out: ConfirmedFamily[] = [];
  for (const { name, explicitCount } of collected) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const count = explicitCount ?? fallbackCounts.get(name) ?? 0;
    out.push({ name, signatureCount: count });
  }
  return out;
}

export interface StatusInfo {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  version: string | null;
  error: string | null;
}

export async function checkStatus(): Promise<StatusInfo> {
  return await invoke<StatusInfo>("check_status");
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  releaseUrl: string;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  return await invoke<UpdateInfo>("check_for_update");
}

export async function appVersion(): Promise<string> {
  return await invoke<string>("app_version");
}

export async function openUrl(url: string): Promise<void> {
  await invoke<void>("open_url", { url });
}

export async function cancelScan(): Promise<void> {
  try {
    await invoke<void>("cancel_scan");
  } catch (e) {
    console.error("[cancelScan] failed", e);
  }
}

export async function openLogDir(): Promise<void> {
  await invoke<void>("open_log_dir");
}

export async function logDirSize(): Promise<number> {
  return await invoke<number>("log_dir_size");
}

export async function clearLogs(): Promise<number> {
  return await invoke<number>("clear_logs");
}

export async function historyList(): Promise<HistoryEntry[]> {
  return await invoke<HistoryEntry[]>("history_list");
}

export async function historyClear(): Promise<void> {
  await invoke<void>("history_clear");
}

export async function historyDelete(id: string): Promise<void> {
  await invoke<void>("history_delete", { id });
}

export const SCAN_PHASE_EVENT = "scan://phase";

type PhaseHandler = (event: ScanPhaseEvent) => void;

const phaseHandlers = new Set<PhaseHandler>();
let phaseListener: Promise<UnlistenFn> | null = null;
let phaseBuffer: ScanPhaseEvent[] = [];

function ensurePhaseListener(): Promise<UnlistenFn> {
  if (!phaseListener) {
    phaseListener = listen<ScanPhaseEvent>(SCAN_PHASE_EVENT, (e) => {
      if (phaseHandlers.size === 0) {
        phaseBuffer.push(e.payload);
        if (phaseBuffer.length > 500) phaseBuffer.shift();
        return;
      }
      for (const h of phaseHandlers) h(e.payload);
    });
  }
  return phaseListener;
}

function resetPhaseBuffer() {
  phaseBuffer = [];
}

export function subscribeScanPhases(handler: PhaseHandler): () => void {
  void ensurePhaseListener();
  if (phaseBuffer.length > 0) {
    const drained = phaseBuffer;
    phaseBuffer = [];
    for (const e of drained) handler(e);
  }
  phaseHandlers.add(handler);
  return () => {
    phaseHandlers.delete(handler);
  };
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

export const DISCORD_URL = "https://www.threat.rip/discord";

export function appErrorToUserText(err: AppError): string {
  switch (err.kind) {
    case "too_large":
      return `File exceeds the ${err.max_mb} MB limit.`;
    case "rate_limited":
      return `Rate limit reached. Try again in ${err.retry_after_seconds} seconds.`;
    case "server":
      return `Server error (${err.status}): ${err.message}`;
    case "network":
      return `Network error: ${err.message}`;
    case "io":
      return `Could not read file: ${err.message}`;
    case "invalid_response":
      return `Unexpected response from server: ${err.message}`;
    case "unsupported_file": {
      const list = err.allowed.map((e) => `.${e}`).join(", ");
      const got = err.extension ? ` (got .${err.extension})` : "";
      return `Unsupported file type${got}. Drop a ${list} file.`;
    }
    case "no_jar_in_archive":
      return "This archive does not contain any .jar files.";
    case "invalid_archive":
      return `Could not read archive: ${err.message}`;
    case "cancelled":
      return "Scan cancelled.";
    case "history_io":
      return `Could not read scan history: ${err.message}`;
  }
}

export function appErrorCode(err: AppError): string | null {
  if ("code" in err && typeof err.code === "string" && err.code.length > 0) {
    return err.code;
  }
  return null;
}

export function appErrorWantsSupport(err: AppError): boolean {
  return err.kind === "invalid_response" || err.kind === "server" || err.kind === "network";
}

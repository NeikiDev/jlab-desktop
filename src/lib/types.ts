export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type SignatureKind = string;

export interface SignatureMatch {
  className?: string | null;
  member?: string | null;
  path?: string | null;
  matchedValue?: string | null;
  // Present on `deobfuscation` matches: the encoding scheme (e.g.
  // "xor-base64"), the encoded source bytes, and the decoded plaintext.
  encoding?: string | null;
  original?: string | null;
  decoded?: string | null;
}

export interface Signature {
  id: string;
  severity: Severity;
  name: string;
  description: string;
  kind: SignatureKind;
  count: number;
  matches: SignatureMatch[];
  family?: string | null;
  // Set by the server when a malware family is confirmed: per-signature
  // names and descriptions get redacted to prevent attackers from using the
  // public scanner to confirm whether their evasion bypassed a specific
  // detection. The card still shows severity + count, just not the label.
  redacted?: boolean;
}

export interface ConfirmedFamily {
  name: string;
  // Older builds returned a per-family signature count. The current public
  // API redacts individual counts when a family is confirmed, so this is
  // optional and may be absent.
  signatureCount?: number;
}

export interface ThreatRipIntel {
  available: boolean;
  verdict?: string | null;
  threatScore?: number | null;
  threat?: string | null;
  sha256?: string | null;
}

export interface RatterGithubInfo {
  name: string | null;
  owner: string | null;
  projectName: string | null;
  repoUrl: string | null;
  downloadUrl: string | null;
}

export interface RatterScannerIntel {
  available: boolean;
  safe: boolean;
  malicious: boolean;
  automatedSafe: boolean;
  hash: string | null;
  githubInfo: RatterGithubInfo | null;
}

export interface VirusTotalIntel {
  available: boolean;
  malicious?: number | null;
  suspicious?: number | null;
  undetected?: number | null;
  harmless?: number | null;
  detections?: number | null;
  totalScanners?: number | null;
  reputation?: number | null;
  fileType?: string | null;
}

export interface ThreatIntel {
  sha256: string | null;
  threatRip: ThreatRipIntel | null;
  ratterScanner: RatterScannerIntel | null;
  virusTotal: VirusTotalIntel | null;
}

export interface ScanResult {
  success: boolean;
  fileName: string;
  fileSize: number;
  totalSignatures: number;
  matchedSignatures: number;
  signatures: Signature[];
  confirmedFamilies: ConfirmedFamily[];
  // Server-side advisory ("matches alone are not a final verdict"). We don't
  // surface this verbatim today but keep it on the type so future copy can.
  note?: string;
  sha256: string | null;
  threatIntel: ThreatIntel | null;
}

export type AppError =
  | { kind: "too_large"; max_mb: number }
  | { kind: "rate_limited"; retry_after_seconds: number }
  | { kind: "server"; status: number; message: string; code?: string }
  | { kind: "network"; message: string; code?: string }
  | { kind: "io"; message: string; code?: string }
  | { kind: "invalid_response"; message: string; code?: string }
  | { kind: "unsupported_file"; extension: string | null; allowed: string[] }
  | { kind: "no_jar_in_archive" }
  | { kind: "invalid_archive"; message: string; code?: string }
  | { kind: "cancelled" }
  | { kind: "history_io"; message: string; code?: string }
  | { kind: "watcher_io"; message: string }
  | { kind: "invalid_watch_path"; message: string }
  | { kind: "trash_failed"; message: string }
  | { kind: "rename_failed"; message: string }
  | { kind: "watcher_disabled" }
  | { kind: "notification_denied" };

export interface HistorySeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface HistoryEntry {
  id: string;
  scannedAt: string;
  fileName: string;
  fileSizeBytes: number;
  sha256: string;
  severityCounts: HistorySeverityCounts;
  topSeverity: Severity;
  signatureCount: number;
  /// "manual" for drag-drop scans, "watcher" for auto-scans. Older entries
  /// without this field decode as "manual" on the Rust side.
  source?: string;
}

// === Watcher ===

export type AlertThreshold =
  | "critical_single"
  | "multiple_criticals"
  | "confirmed_families_only";

export type ActionThreshold =
  | "off"
  | "multiple_criticals"
  | "confirmed_families_only";

export type ActionMode = "quarantine" | "trash";

export type RescanInterval = "off" | "days_7" | "days_14" | "days_30";

export interface WatchedFolder {
  path: string;
  addedAt: string;
  lastFullScanAt?: string | null;
}

export interface WatcherSettings {
  version: number;
  enabled: boolean;
  warningAcknowledged: boolean;
  folders: WatchedFolder[];
  notificationsEnabled: boolean;
  alertThreshold: AlertThreshold;
  coalesceWindowMs: number;
  multipleCriticalsThreshold: number;
  autoAction: ActionThreshold;
  autoActionMode: ActionMode;
  holdUntilScanned: boolean;
  rescanInterval: RescanInterval;
  minimizeToTray: boolean;
  startMinimized: boolean;
  launchAtLogin: boolean;
}

export type WatcherRunState = "off" | "idle" | "scanning" | "paused";

export interface WatcherRuntimeState {
  runState: WatcherRunState;
  queueDepth: number;
  currentFile: string | null;
  currentStartedMs: number | null;
}

export type WatcherEvent =
  | { type: "state-changed"; runState: WatcherRunState }
  | { type: "queue-updated"; depth: number }
  | { type: "scan-started"; fileName: string; path: string }
  | {
      type: "scan-completed";
      fileName: string;
      path: string;
      topSeverity: Severity;
      signatureCount: number;
      criticalCount: number;
      highCount: number;
      confirmedFamilies: number;
      sha256: string;
      flagged: boolean;
      action: "quarantined" | "trashed" | null;
    }
  | { type: "error"; path: string; code: string; message: string }
  | { type: "focus-review" };

export type ScanPhaseId =
  | "validate"
  | "read"
  | "upload"
  | "server"
  | "parse"
  | "done"
  | "cancelled"
  | "failed";

export type ScanPhaseStatus = "running" | "done" | "ok" | "error";

export interface ScanPhaseEvent {
  phase: ScanPhaseId;
  status: ScanPhaseStatus;
  elapsedMs: number;
  detail: string | null;
}

export type ScanState =
  | { state: "idle" }
  | { state: "scanning"; fileName: string; path: string }
  | { state: "result"; result: ScanResult }
  | { state: "error"; error: AppError; lastPath: string | null };

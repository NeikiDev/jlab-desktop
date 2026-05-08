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
  | { kind: "history_io"; message: string; code?: string };

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
}

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

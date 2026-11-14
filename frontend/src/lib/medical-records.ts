// Medical records stored in Onyx (pds.medical_documents + pds.lab_results + the private storage
// bucket "medical-records"): the wire shapes and checks shared by /health/records and the
// /api/medical/* routes, plus the pure lab helpers (flags, range parsing, trend series).
// Pure helpers only: no Supabase, no React, no Node built-ins, so the browser bundle and the
// offline tests (tests/medical-records.test.cjs) load the same code.
//
// The tables and the bucket are service-role only. The browser talks to /api/medical/* (owner
// session, same origin, JSON, small bodies); nothing here is reachable with the CI token, and no
// chat tool or model reads any of it.

export const MEDICAL_BUCKET = "medical-records";

export const DOC_KINDS = ["lab", "visit", "imaging", "prescription", "vaccination", "insurance", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  lab: "Lab report",
  visit: "Visit summary",
  imaging: "Imaging",
  prescription: "Prescription",
  vaccination: "Vaccination",
  insurance: "Insurance",
  other: "Other",
};

/** File types the bucket accepts (the bucket enforces the same list). */
export const DOC_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
export type DocMime = (typeof DOC_MIME_TYPES)[number];
const EXT_MIME: Record<string, DocMime> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
};
const MIME_EXT: Record<DocMime, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
};

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENTS = 2000;
export const MAX_LAB_RESULTS = 10000;
/** Results saved in one request (one lab report's worth). */
export const MAX_LAB_BATCH = 60;
export const MAX_DOC_TITLE = 120;
export const MAX_PROVIDER = 120;
export const MAX_DOC_NOTES = 2000;
export const MAX_TEST = 80;
export const MAX_VALUE_TEXT = 40;
export const MAX_UNIT = 24;
export const MAX_REF_TEXT = 40;
export const MAX_LAB = 100;
export const MAX_LAB_NOTES = 500;
/** A document's metadata with a full note (2000 chars of 4-byte text + the other fields). */
export const MAX_DOC_BODY_BYTES = 10_000;
/** One lab result with a full note. */
export const MAX_LAB_BODY_BYTES = 4_000;
/** A full batch of results. */
export const MAX_LAB_BATCH_BYTES = MAX_LAB_BATCH * MAX_LAB_BODY_BYTES;
/** How long a link to open a file works. */
export const VIEW_URL_SECONDS = 60;

/** Columns read from the tables. Explicit on purpose: never `*`. */
export const DOC_COLUMNS = "id,title,kind,doc_date,provider,notes,mime_type,size_bytes,uploaded_at";
export const LAB_COLUMNS = "id,test_name,value_num,value_text,unit,ref_low,ref_high,ref_text,collected_on,lab,document_id,notes";

export type MedicalDocument = {
  id: string;
  title: string;
  kind: DocKind;
  date: string; // YYYY-MM-DD, date of service
  provider: string;
  notes: string;
  mime: DocMime;
  size: number;
  uploadedAt: string | null;
};

/** What the browser sends to create a document (before the file is uploaded). */
export type NewDocument = Omit<MedicalDocument, "uploadedAt">;

export type LabResult = {
  id: string;
  test: string;
  value: number | null;
  valueText: string;
  unit: string;
  refLow: number | null;
  refHigh: number | null;
  refText: string;
  collectedOn: string; // YYYY-MM-DD
  lab: string;
  documentId: string | null;
  notes: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// C0 controls except tab / newline / carriage return, plus DEL. Notes may have line breaks; short fields may not.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK_RE = /[\t\n\r]/;
const MAX_ABS_NUMBER = 1e12;

export function parseId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where a document's file sits in the bucket. Only the id: never the title or a file name. */
export function storagePathFor(id: string): string {
  return `documents/${id}`;
}

export function validDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "1900-01-01" && v <= "9998-12-31";
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Field<T> = { ok: true; value: T } | { ok: false; error: string };

function plainObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function lineField(name: string, v: unknown, min: number, max: number): Field<string> {
  if (typeof v !== "string") return { ok: false, error: `${name} must be text` };
  const s = v.trim();
  if (s.length < min || s.length > max) return { ok: false, error: min ? `${name} must be ${min} to ${max} characters` : `${name} must be at most ${max} characters` };
  if (CONTROL_RE.test(s) || LINE_BREAK_RE.test(s)) return { ok: false, error: `${name} must be one line of plain text` };
  return { ok: true, value: s };
}
function notesField(v: unknown, max: number): Field<string> {
  if (typeof v !== "string") return { ok: false, error: "notes must be text" };
  if (v.length > max) return { ok: false, error: `notes must be at most ${max} characters` };
  if (CONTROL_RE.test(v)) return { ok: false, error: "notes must be plain text" };
  return { ok: true, value: v };
}
function dateField(name: string, v: unknown): Field<string> {
  return validDate(v) ? { ok: true, value: v } : { ok: false, error: `${name} must be a real date, YYYY-MM-DD` };
}
function kindField(v: unknown): Field<DocKind> {
  return typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v)
    ? { ok: true, value: v as DocKind }
    : { ok: false, error: `kind must be one of ${DOC_KINDS.join(", ")}` };
}
function mimeField(v: unknown): Field<DocMime> {
  return typeof v === "string" && (DOC_MIME_TYPES as readonly string[]).includes(v)
    ? { ok: true, value: v as DocMime }
    : { ok: false, error: "file must be a PDF or an image (JPEG, PNG, WebP, HEIC)" };
}
function sizeField(v: unknown): Field<number> {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_FILE_BYTES
    ? { ok: true, value: v }
    : { ok: false, error: `file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB` };
}
function numberField(name: string, v: unknown): Field<number | null> {
  if (v === null) return { ok: true, value: null };
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < MAX_ABS_NUMBER
    ? { ok: true, value: v }
    : { ok: false, error: `${name} must be a number or null` };
}
function docIdField(v: unknown): Field<string | null> {
  if (v === null) return { ok: true, value: null };
  const id = parseId(v);
  return id ? { ok: true, value: id } : { ok: false, error: "documentId must be null or a document id" };
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[]): string | null {
  if (Object.keys(o).some((k) => !keys.includes(k))) return "unknown field";
  const missing = keys.find((k) => !(k in o));
  return missing ? `missing ${missing}` : null;
}

// ---- documents --------------------------------------------------------------

const NEW_DOC_KEYS = ["id", "title", "kind", "date", "provider", "notes", "mime", "size"] as const;

/** Body of POST /api/medical/documents: a whole new document, nothing extra. */
export function parseNewDocument(body: unknown): Result<{ doc: NewDocument }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const keys = exactKeys(o, NEW_DOC_KEYS);
  if (keys) return { ok: false, error: keys };
  const id = parseId(o.id);
  if (!id) return { ok: false, error: "id must be a lowercase UUID" };
  const title = lineField("title", o.title, 1, MAX_DOC_TITLE);
  if (!title.ok) return title;
  const kind = kindField(o.kind);
  if (!kind.ok) return kind;
  const date = dateField("date", o.date);
  if (!date.ok) return date;
  const provider = lineField("provider", o.provider, 0, MAX_PROVIDER);
  if (!provider.ok) return provider;
  const notes = notesField(o.notes, MAX_DOC_NOTES);
  if (!notes.ok) return notes;
  const mime = mimeField(o.mime);
  if (!mime.ok) return mime;
  const size = sizeField(o.size);
  if (!size.ok) return size;
  return {
    ok: true,
    doc: { id, title: title.value, kind: kind.value, date: date.value, provider: provider.value, notes: notes.value, mime: mime.value, size: size.value },
  };
}

export type DocumentPatch = Partial<Pick<MedicalDocument, "title" | "kind" | "date" | "provider" | "notes">> & { removed?: false };

/** Body of PATCH /api/medical/documents/[id]: one or more of the editable fields; {removed: false} = Undo. */
export function parseDocumentPatch(body: unknown): Result<{ patch: DocumentPatch }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(o);
  if (!keys.length) return { ok: false, error: "nothing to change" };
  const patch: DocumentPatch = {};
  for (const key of keys) {
    const v = o[key];
    let f: Field<unknown>;
    switch (key) {
      case "title": f = lineField("title", v, 1, MAX_DOC_TITLE); if (f.ok) patch.title = f.value as string; break;
      case "kind": f = kindField(v); if (f.ok) patch.kind = f.value as DocKind; break;
      case "date": f = dateField("date", v); if (f.ok) patch.date = f.value as string; break;
      case "provider": f = lineField("provider", v, 0, MAX_PROVIDER); if (f.ok) patch.provider = f.value as string; break;
      case "notes": f = notesField(v, MAX_DOC_NOTES); if (f.ok) patch.notes = f.value as string; break;
      case "removed":
        f = v === false ? { ok: true, value: false } : { ok: false, error: "removed may only be false (use DELETE to remove)" };
        if (f.ok) patch.removed = false;
        break;
      default: return { ok: false, error: "unknown field" };
    }
    if (!f.ok) return f;
  }
  return { ok: true, patch };
}

/** A pds.medical_documents row as a MedicalDocument; null for a row without the expected shape. */
export function rowToDocument(row: unknown): MedicalDocument | null {
  const r = plainObject(row);
  if (!r) return null;
  const size = typeof r.size_bytes === "string" ? Number(r.size_bytes) : r.size_bytes;
  const parsed = parseNewDocument({
    id: r.id, title: r.title, kind: r.kind, date: r.doc_date, provider: r.provider ?? "", notes: r.notes ?? "", mime: r.mime_type, size,
  });
  if (!parsed.ok) return null;
  const uploadedAt = typeof r.uploaded_at === "string" ? r.uploaded_at : null;
  return { ...parsed.doc, uploadedAt };
}

export function documentColumns(fields: DocumentPatch | NewDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.title !== undefined) out.title = fields.title;
  if (fields.kind !== undefined) out.kind = fields.kind;
  if (fields.date !== undefined) out.doc_date = fields.date;
  if (fields.provider !== undefined) out.provider = fields.provider;
  if (fields.notes !== undefined) out.notes = fields.notes;
  if ("mime" in fields && fields.mime !== undefined) out.mime_type = fields.mime;
  if ("size" in fields && fields.size !== undefined) out.size_bytes = fields.size;
  if ("removed" in fields && fields.removed === false) out.removed_at = null;
  return out;
}

/** The file type to upload as: the browser's type when it is one we accept, else the extension's. */
export function mimeForFile(name: string, type: string): DocMime | null {
  const t = (type || "").toLowerCase();
  if ((DOC_MIME_TYPES as readonly string[]).includes(t)) return t as DocMime;
  if (t === "image/jpg") return "image/jpeg";
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return EXT_MIME[ext] ?? null;
}

/** A starting title from a file name: no extension, separators as spaces, trimmed to fit. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return base.slice(0, MAX_DOC_TITLE);
}

/** The file name a download is saved under: the title, safe characters only, plus the extension. */
export function downloadName(doc: Pick<MedicalDocument, "title" | "date" | "mime">): string {
  const safe = doc.title.replace(/[^A-Za-z0-9 ._-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "document";
  return `${doc.date} ${safe}.${MIME_EXT[doc.mime]}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- lab results ------------------------------------------------------------

const LAB_KEYS = ["id", "test", "value", "valueText", "unit", "refLow", "refHigh", "refText", "collectedOn", "lab", "documentId", "notes"] as const;

/** A whole lab result: every field present, nothing extra. */
export function parseLabResult(body: unknown): Result<{ result: LabResult }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "result must be a JSON object" };
  const keys = exactKeys(o, LAB_KEYS);
  if (keys) return { ok: false, error: keys };
  const id = parseId(o.id);
  if (!id) return { ok: false, error: "id must be a lowercase UUID" };
  const test = lineField("test", o.test, 1, MAX_TEST);
  if (!test.ok) return test;
  const value = numberField("value", o.value);
  if (!value.ok) return value;
  const valueText = lineField("valueText", o.valueText, 0, MAX_VALUE_TEXT);
  if (!valueText.ok) return valueText;
  if (value.value === null && !valueText.value) return { ok: false, error: `${test.value}: a result needs a value` };
  const unit = lineField("unit", o.unit, 0, MAX_UNIT);
  if (!unit.ok) return unit;
  const refLow = numberField("refLow", o.refLow);
  if (!refLow.ok) return refLow;
  const refHigh = numberField("refHigh", o.refHigh);
  if (!refHigh.ok) return refHigh;
  if (refLow.value !== null && refHigh.value !== null && refLow.value > refHigh.value) return { ok: false, error: `${test.value}: the range's low end is above its high end` };
  const refText = lineField("refText", o.refText, 0, MAX_REF_TEXT);
  if (!refText.ok) return refText;
  const collectedOn = dateField("collectedOn", o.collectedOn);
  if (!collectedOn.ok) return collectedOn;
  const lab = lineField("lab", o.lab, 0, MAX_LAB);
  if (!lab.ok) return lab;
  const documentId = docIdField(o.documentId);
  if (!documentId.ok) return documentId;
  const notes = notesField(o.notes, MAX_LAB_NOTES);
  if (!notes.ok) return notes;
  return {
    ok: true,
    result: {
      id, test: test.value, value: value.value, valueText: valueText.value, unit: unit.value, refLow: refLow.value, refHigh: refHigh.value,
      refText: refText.value, collectedOn: collectedOn.value, lab: lab.value, documentId: documentId.value, notes: notes.value,
    },
  };
}

/** Body of POST /api/medical/labs: {results: [1..MAX_LAB_BATCH whole results]}, ids unique. */
export function parseLabBatch(body: unknown): Result<{ results: LabResult[] }> {
  const o = plainObject(body);
  if (!o || Object.keys(o).some((k) => k !== "results") || !Array.isArray(o.results)) return { ok: false, error: "body must be {results: [...]}" };
  if (!o.results.length) return { ok: false, error: "nothing to save" };
  if (o.results.length > MAX_LAB_BATCH) return { ok: false, error: `at most ${MAX_LAB_BATCH} results at once` };
  const results: LabResult[] = [];
  for (const raw of o.results) {
    const parsed = parseLabResult(raw);
    if (!parsed.ok) return parsed;
    results.push(parsed.result);
  }
  if (new Set(results.map((r) => r.id)).size !== results.length) return { ok: false, error: "result ids must be unique" };
  return { ok: true, results };
}

export type LabPatch = Partial<Omit<LabResult, "id">> & { removed?: false };

/** Body of PATCH /api/medical/labs/[id]: one or more fields; {removed: false} = Undo. */
export function parseLabPatch(body: unknown): Result<{ patch: LabPatch }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(o);
  if (!keys.length) return { ok: false, error: "nothing to change" };
  const patch: LabPatch = {};
  for (const key of keys) {
    const v = o[key];
    let f: Field<unknown>;
    switch (key) {
      case "test": f = lineField("test", v, 1, MAX_TEST); if (f.ok) patch.test = f.value as string; break;
      case "value": f = numberField("value", v); if (f.ok) patch.value = f.value as number | null; break;
      case "valueText": f = lineField("valueText", v, 0, MAX_VALUE_TEXT); if (f.ok) patch.valueText = f.value as string; break;
      case "unit": f = lineField("unit", v, 0, MAX_UNIT); if (f.ok) patch.unit = f.value as string; break;
      case "refLow": f = numberField("refLow", v); if (f.ok) patch.refLow = f.value as number | null; break;
      case "refHigh": f = numberField("refHigh", v); if (f.ok) patch.refHigh = f.value as number | null; break;
      case "refText": f = lineField("refText", v, 0, MAX_REF_TEXT); if (f.ok) patch.refText = f.value as string; break;
      case "collectedOn": f = dateField("collectedOn", v); if (f.ok) patch.collectedOn = f.value as string; break;
      case "lab": f = lineField("lab", v, 0, MAX_LAB); if (f.ok) patch.lab = f.value as string; break;
      case "documentId": f = docIdField(v); if (f.ok) patch.documentId = f.value as string | null; break;
      case "notes": f = notesField(v, MAX_LAB_NOTES); if (f.ok) patch.notes = f.value as string; break;
      case "removed":
        f = v === false ? { ok: true, value: false } : { ok: false, error: "removed may only be false (use DELETE to remove)" };
        if (f.ok) patch.removed = false;
        break;
      default: return { ok: false, error: "unknown field" };
    }
    if (!f.ok) return f;
  }
  if ("value" in patch && "valueText" in patch && patch.value === null && !patch.valueText) return { ok: false, error: "a result needs a value" };
  if (patch.refLow != null && patch.refHigh != null && patch.refLow > patch.refHigh) return { ok: false, error: "the range's low end is above its high end" };
  return { ok: true, patch };
}

function num(v: unknown): unknown {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return v ?? null;
}

/** A pds.lab_results row as a LabResult (numeric columns may arrive as strings); null when malformed. */
export function rowToLab(row: unknown): LabResult | null {
  const r = plainObject(row);
  if (!r) return null;
  const parsed = parseLabResult({
    id: r.id, test: r.test_name, value: num(r.value_num), valueText: r.value_text ?? "", unit: r.unit ?? "", refLow: num(r.ref_low),
    refHigh: num(r.ref_high), refText: r.ref_text ?? "", collectedOn: r.collected_on, lab: r.lab ?? "", documentId: r.document_id ?? null,
    notes: r.notes ?? "",
  });
  return parsed.ok ? parsed.result : null;
}

export function labColumns(fields: LabPatch | LabResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.test !== undefined) out.test_name = fields.test;
  if (fields.value !== undefined) out.value_num = fields.value;
  if (fields.valueText !== undefined) out.value_text = fields.valueText;
  if (fields.unit !== undefined) out.unit = fields.unit;
  if (fields.refLow !== undefined) out.ref_low = fields.refLow;
  if (fields.refHigh !== undefined) out.ref_high = fields.refHigh;
  if (fields.refText !== undefined) out.ref_text = fields.refText;
  if (fields.collectedOn !== undefined) out.collected_on = fields.collectedOn;
  if (fields.lab !== undefined) out.lab = fields.lab;
  if (fields.documentId !== undefined) out.document_id = fields.documentId;
  if (fields.notes !== undefined) out.notes = fields.notes;
  if ("removed" in fields && fields.removed === false) out.removed_at = null;
  return out;
}

/** A number as typed on a report: "5.4", "1,200", "-3", ".5". Null for anything else. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) < MAX_ABS_NUMBER ? n : null;
}

/** The value box: a number goes to `value`, anything else ("Negative", "<0.5") to `valueText`. */
export function parseLabValue(text: string): { value: number | null; valueText: string } {
  const t = text.trim();
  const n = parseNumber(t);
  return n === null ? { value: null, valueText: t } : { value: n, valueText: "" };
}

/**
 * The range box as printed: "70-99", "70 – 99", "<200", "≤ 5.7", ">40", "≥ 60". The text is kept
 * as typed; the numbers are what the High / Low flag uses. Anything else keeps the text only.
 */
export function parseRange(text: string): { refLow: number | null; refHigh: number | null; refText: string } {
  const t = text.trim();
  const none = { refLow: null, refHigh: null, refText: t };
  if (!t) return none;
  const below = t.match(/^(?:<|≤|<=)\s*(.+)$/);
  if (below) {
    const n = parseNumber(below[1]);
    return n === null ? none : { refLow: null, refHigh: n, refText: t };
  }
  const above = t.match(/^(?:>|≥|>=)\s*(.+)$/);
  if (above) {
    const n = parseNumber(above[1]);
    return n === null ? none : { refLow: n, refHigh: null, refText: t };
  }
  const span = t.match(/^(-?[\d.,]+)\s*(?:-|–|—|to)\s*(-?[\d.,]+)$/i);
  if (span) {
    const lo = parseNumber(span[1]);
    const hi = parseNumber(span[2]);
    if (lo !== null && hi !== null && lo <= hi) return { refLow: lo, refHigh: hi, refText: t };
  }
  return none;
}

export type LabFlag = "low" | "high" | "in-range";

/** High / Low against the stored range; null when the result is not a number or there is no range. */
export function labFlag(r: Pick<LabResult, "value" | "refLow" | "refHigh">): LabFlag | null {
  if (r.value === null || (r.refLow === null && r.refHigh === null)) return null;
  if (r.refLow !== null && r.value < r.refLow) return "low";
  if (r.refHigh !== null && r.value > r.refHigh) return "high";
  return "in-range";
}

export const FLAG_LABEL: Record<LabFlag, string> = { low: "Low", high: "High", "in-range": "In range" };

/** The result as one line: "5.4 mmol/L", "Negative". */
export function formatResult(r: Pick<LabResult, "value" | "valueText" | "unit">): string {
  const v = r.value === null ? r.valueText : formatNumber(r.value);
  return r.unit ? `${v} ${r.unit}` : v;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** The range as one line: the printed text when there is one, else built from the numbers. */
export function formatRange(r: Pick<LabResult, "refLow" | "refHigh" | "refText">): string {
  if (r.refText) return r.refText;
  if (r.refLow !== null && r.refHigh !== null) return `${formatNumber(r.refLow)}-${formatNumber(r.refHigh)}`;
  if (r.refHigh !== null) return `≤ ${formatNumber(r.refHigh)}`;
  if (r.refLow !== null) return `≥ ${formatNumber(r.refLow)}`;
  return "";
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Results of one test in one unit belong to one series (different units are never drawn together). */
export function seriesKey(r: Pick<LabResult, "test" | "unit">): string {
  return `${squash(r.test)}|${squash(r.unit)}`;
}

export type LabSeries = {
  key: string;
  test: string; // as written on the newest result
  unit: string;
  results: LabResult[]; // oldest first (same day: by id, so the order is stable)
  latest: LabResult;
  previous: LabResult | null;
  numericCount: number;
};

const byDateThenId = (a: LabResult, b: LabResult) => (a.collectedOn < b.collectedOn ? -1 : a.collectedOn > b.collectedOn ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One series per test + unit, alphabetical by test name. */
export function labSeries(results: LabResult[]): LabSeries[] {
  const groups = new Map<string, LabResult[]>();
  for (const r of results) {
    const key = seriesKey(r);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: LabSeries[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort(byDateThenId);
    const latest = sorted[sorted.length - 1];
    out.push({
      key, test: latest.test, unit: latest.unit, results: sorted, latest,
      previous: sorted.length > 1 ? sorted[sorted.length - 2] : null,
      numericCount: sorted.filter((r) => r.value !== null).length,
    });
  }
  return out.sort((a, b) => (squash(a.test) < squash(b.test) ? -1 : squash(a.test) > squash(b.test) ? 1 : a.key < b.key ? -1 : 1));
}

/** Newest first, then by test name: the order of the results table. */
export function compareNewestFirst(a: LabResult, b: LabResult): number {
  if (a.collectedOn !== b.collectedOn) return a.collectedOn < b.collectedOn ? 1 : -1;
  const ta = squash(a.test);
  const tb = squash(b.test);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Documents newest first (by date of service, then id). */
export function compareDocuments(a: MedicalDocument, b: MedicalDocument): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The free-text filter on the documents list: every word must appear in the title, provider, kind or note. */
export function documentMatches(doc: MedicalDocument, query: string): boolean {
  const words = squash(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = squash(`${doc.title} ${doc.provider} ${DOC_KIND_LABEL[doc.kind]} ${doc.notes}`);
  return words.every((w) => hay.includes(w));
}

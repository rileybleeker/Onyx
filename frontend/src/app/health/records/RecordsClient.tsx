"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { todayLocal } from '@/lib/care-planner';
import type { Section } from '@/lib/medical-records-server';
import InfoHint from '@/components/InfoHint';
import { AutosaveStatus } from '@/components/AutosaveStatus';
import { AutosaveRefused } from '@/lib/autosave';
import { useAutosave } from '@/lib/use-autosave';
import { Part, PartGroup, PartGrid } from '@/components/personalize/PartGrid';
import type { PageLayout } from '@/lib/personalize-layout';
import {
  DOC_KINDS, DOC_KIND_LABEL, FLAG_LABEL, MAX_DOC_NOTES, MAX_FILE_BYTES, MAX_LAB_BATCH, MAX_LAB_NOTES, MEDICAL_BUCKET,
  compareDocuments, compareNewestFirst, documentMatches, formatBytes, formatRange, formatResult, labFlag, labSeries,
  mimeForFile, newId, parseLabResult, parseLabValue, parseRange, rowToDocument, titleFromFileName,
  type DocKind, type LabResult, type LabSeries, type MedicalDocument,
} from '@/lib/medical-records';

const LabTrendChart = dynamic(() => import('./LabTrendChart'), { ssr: false, loading: () => <div style={{ height: 110 }} /> });

const panel = 'rounded-2xl border border-border-default bg-surface-card p-5';
const field = 'rounded-lg border border-border-default bg-surface-card px-3 py-2 text-text-primary';
const button = 'rounded-lg border border-border-default px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50';
const card = 'rounded-2xl border border-border-default bg-surface-card p-4';
const small = 'rounded-md border border-border-default px-2 py-1 text-xs hover:bg-surface-hover disabled:opacity-50';
const TABLE_PAGE = 100;

type Load = 'ready' | 'loading' | 'failed';
type Notice = { text: string; error?: boolean } | null;
type Undo = { text: string; run: () => Promise<void> } | null;
type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/** One request to /api/medical/*. Error text comes from the server's own message (never record text). */
async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Answer> {
  try {
    const res = await fetch(path, {
      method, cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: typeof data.error === 'string' ? data.error : `request failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

const UNREACHABLE = 'Onyx could not be reached. Check the connection and try again.';

/** A failed autosave: offline is retried on its own, anything the server refused waits for a change or Retry. */
function autosaveFailure(a: Answer): Error {
  if (!a.ok && a.error === UNREACHABLE) return new Error(a.error);
  return new AutosaveRefused(a.ok ? 'unexpected answer' : a.error);
}

function FlagChip({ result }: { result: LabResult }) {
  const flag = labFlag(result);
  if (!flag) return null;
  const out = flag !== 'in-range';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${out ? 'bg-amber-400/15 text-amber-300' : 'bg-accent-muted text-text-secondary'}`}>{FLAG_LABEL[flag]}</span>;
}

// headingTestId: "feed-page-heading" when rendered as a section of the continuous scroll (FeedSection.tsx).
// layout: the saved Personalize layout from the page's cookie (routed page only).
export default function RecordsClient({ documents, labs, headingTestId = 'page-heading', layout }: { documents: Section<MedicalDocument>; labs: Section<LabResult>; headingTestId?: string; layout?: PageLayout }) {
  const [docs, setDocs] = useState<MedicalDocument[]>(documents.state === 'ready' ? documents.items : []);
  const [docsLoad, setDocsLoad] = useState<Load>(documents.state === 'ready' ? 'ready' : 'failed');
  const [results, setResults] = useState<LabResult[]>(labs.state === 'ready' ? labs.items : []);
  const [labsLoad, setLabsLoad] = useState<Load>(labs.state === 'ready' ? 'ready' : 'failed');
  const [notice, setNotice] = useState<Notice>(null);
  const [undo, setUndo] = useState<Undo>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [today, setToday] = useState('');
  const [testFilter, setTestFilter] = useState('all');
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => { setToday(todayLocal()); }, []);

  const series = useMemo(() => labSeries(results), [results]);
  const listedDocs = useMemo(() => [...docs].sort(compareDocuments), [docs]);
  const docById = useMemo(() => new Map(docs.map(d => [d.id, d])), [docs]);
  const resultsPerDoc = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) if (r.documentId) m.set(r.documentId, (m.get(r.documentId) ?? 0) + 1);
    return m;
  }, [results]);

  const mark = (id: string, on: boolean) => setBusy(cur => { const next = new Set(cur); if (on) next.add(id); else next.delete(id); return next; });

  async function reloadLabs() {
    setLabsLoad('loading');
    const a = await call('GET', '/api/medical/labs');
    const list = a.ok && Array.isArray(a.data.results) ? a.data.results.map(rowFromApiLab).filter((r): r is LabResult => r !== null) : null;
    if (!list) { setLabsLoad('failed'); return; }
    setResults(list); setLabsLoad('ready');
  }
  async function reloadDocs() {
    setDocsLoad('loading');
    const a = await call('GET', '/api/medical/documents');
    const list = a.ok && Array.isArray(a.data.documents) ? a.data.documents.map(rowFromApiDoc).filter((d): d is MedicalDocument => d !== null) : null;
    if (!list) { setDocsLoad('failed'); return; }
    setDocs(list); setDocsLoad('ready');
  }

  async function removeLab(r: LabResult) {
    mark(r.id, true);
    const a = await call('DELETE', `/api/medical/labs/${r.id}`);
    mark(r.id, false);
    if (!a.ok) { console.error('remove lab result failed:', a.error); setNotice({ text: "Couldn't remove that result. Try again.", error: true }); return; }
    setResults(cur => cur.filter(x => x.id !== r.id));
    if (editing === r.id) setEditing(null);
    setNotice(null);
    setUndo({
      text: `Removed ${r.test} (${r.collectedOn}).`,
      run: async () => {
        const back = await call('PATCH', `/api/medical/labs/${r.id}`, { removed: false });
        const restored = back.ok ? rowFromApiLab(back.data.result) : null;
        if (!restored) { console.error('restore lab result failed:', back.ok ? 'unexpected answer' : back.error); setNotice({ text: "Couldn't bring it back. Try again.", error: true }); return; }
        setResults(cur => [...cur.filter(x => x.id !== restored.id), restored]);
        setNotice({ text: 'Brought back.' });
      },
    });
  }

  async function removeDoc(d: MedicalDocument) {
    mark(d.id, true);
    const a = await call('DELETE', `/api/medical/documents/${d.id}`);
    mark(d.id, false);
    if (!a.ok) { console.error('remove medical document failed:', a.error); setNotice({ text: "Couldn't remove that document. Try again.", error: true }); return; }
    setDocs(cur => cur.filter(x => x.id !== d.id));
    setNotice(null);
    setUndo({
      text: `Removed "${d.title}".`,
      run: async () => {
        const back = await call('PATCH', `/api/medical/documents/${d.id}`, { removed: false });
        const restored = back.ok ? rowFromApiDoc(back.data.document) : null;
        if (!restored) { console.error('restore medical document failed:', back.ok ? 'unexpected answer' : back.error); setNotice({ text: "Couldn't bring it back. Try again.", error: true }); return; }
        setDocs(cur => [...cur.filter(x => x.id !== restored.id), restored]);
        setNotice({ text: 'Brought back.' });
      },
    });
  }

  return <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
    <header>
      <div className="flex items-center gap-2">
        <h1 data-testid={headingTestId} className="text-2xl font-semibold">Medical records</h1>
        <InfoHint label="Medical records privacy">
          <p>Records are saved in Onyx&apos;s database and a private file store. Only the Onyx server can read them, and only after you sign in.</p>
          <p>Onyx Chat and Onyx&apos;s other AI features never read them, and nothing is sent to a provider. A file opens through a link that stops working after a minute.</p>
          <p>High and Low compare a value with the range you typed in; they are not medical advice.</p>
        </InfoHint>
      </div>
      <p className="mt-1 text-sm"><Link href="/health" className="text-accent hover:underline">← Health & appointments</Link></p>
    </header>

    {notice && <p role={notice.error ? 'alert' : 'status'} className={`text-sm ${notice.error ? 'text-amber-400' : 'text-text-secondary'}`}>{notice.text}</p>}
    {undo && <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
      <span className="text-text-secondary">{undo.text}</span>
      <button className={button} onClick={() => { const u = undo; setUndo(null); void u.run(); }}>Undo</button>
    </div>}

    {/* Personalize: every block is its own part, in two sections (Lab results, Documents); a part moves within its
        section or into the other. Each section's heading and its loading / failed state stay with the section.
        `layout` (routed page only) is the saved layout from the page's cookie, so the server renders it. */}
    <PartGrid page="/health/records" title="Medical records" initial={layout}>
      <PartGroup
        id="labs"
        title="Lab results"
        header={<div className="mb-4 space-y-4">
          <h2 id="labs-heading" className="text-lg font-semibold">Lab results</h2>
          {labsLoad === 'loading' && <p role="status">Loading lab results…</p>}
          {labsLoad === 'failed' && <div className={`${panel} space-y-3`} role="alert">
            <p>Couldn&apos;t load lab results.</p>
            <button className={button} onClick={reloadLabs}>Try again</button>
          </div>}
        </div>}
      >
        {labsLoad === 'ready' && <Part id="lab-trends" title="Lab trends">
          {series.length === 0
            ? <p className="text-text-secondary">No lab results yet. Add the values from a lab report below.</p>
            : <LabTrends series={series} onPick={key => setTestFilter(key)} />}
        </Part>}
        {labsLoad === 'ready' && <Part id="lab-entry" title="Add lab results">
          {/* A div, so the closed form's single button keeps its own width inside the part. */}
          <div>
          <LabEntryForm
            today={today} docs={listedDocs} series={series}
            onSaved={saved => {
              setResults(cur => [...cur.filter(x => !saved.some(s => s.id === x.id)), ...saved]);
              setUndo(null);
              setNotice({ text: `Saved ${saved.length} result${saved.length === 1 ? '' : 's'}.` });
            }}
          />
          </div>
        </Part>}
        {labsLoad === 'ready' && results.length > 0 && <Part id="lab-table" title="All lab results">
          <LabTable
            results={results} series={series} filter={testFilter} setFilter={setTestFilter} docById={docById}
            busy={busy} editing={editing} setEditing={setEditing} docs={listedDocs}
            onRemove={removeLab}
            onEdited={r => setResults(cur => cur.map(x => (x.id === r.id ? r : x)))}
          />
        </Part>}
      </PartGroup>

      <PartGroup
        id="docs"
        title="Documents"
        header={<div className="mb-4 space-y-4">
          <h2 id="docs-heading" className="text-lg font-semibold">Documents</h2>
          {docsLoad === 'loading' && <p role="status">Loading documents…</p>}
          {docsLoad === 'failed' && <div className={`${panel} space-y-3`} role="alert">
            <p>Couldn&apos;t load documents.</p>
            <button className={button} onClick={reloadDocs}>Try again</button>
          </div>}
        </div>}
      >
        {docsLoad === 'ready' && <Part id="doc-upload" title="Upload a document">
          <DocumentUpload today={today} onUploaded={d => { setDocs(cur => [...cur.filter(x => x.id !== d.id), d]); setUndo(null); setNotice({ text: `Uploaded "${d.title}".` }); }} />
        </Part>}
        {docsLoad === 'ready' && <Part id="doc-list" title="Documents list">
          {listedDocs.length === 0
            ? <p className="text-text-secondary">No documents yet. Upload a PDF or a photo of a record above.</p>
            : <DocumentList
                docs={listedDocs} busy={busy} resultsPerDoc={resultsPerDoc} onRemove={removeDoc}
                onEdited={d => setDocs(cur => cur.map(x => (x.id === d.id ? d : x)))}
              />}
        </Part>}
      </PartGroup>
    </PartGrid>
  </div>;
}

/** What the API sent back, checked before it goes on screen (the API speaks the camelCase shape). */
export function rowFromApiLab(raw: unknown): LabResult | null {
  const parsed = parseLabResult(raw);
  return parsed.ok ? parsed.result : null;
}
export function rowFromApiDoc(raw: unknown): MedicalDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  // Map back to row column names so rowToDocument applies the same checks the server does.
  return rowToDocument({
    id: d.id, title: d.title, kind: d.kind, doc_date: d.date, provider: d.provider, notes: d.notes, mime_type: d.mime, size_bytes: d.size,
    uploaded_at: d.uploadedAt,
  });
}

// ---- lab trends --------------------------------------------------------------

function LabTrends({ series, onPick }: { series: LabSeries[]; onPick: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = series.filter(s => s.test.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="space-y-3">
    {series.length > 6 && <input className={`${field} w-full sm:w-72`} placeholder="Find a test" value={query} onChange={e => setQuery(e.target.value)} aria-label="Find a test" />}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {shown.map(s => {
        const change = s.previous && s.latest.value !== null && s.previous.value !== null ? s.latest.value - s.previous.value : null;
        const range = formatRange(s.latest);
        return <div key={s.key} className={`${card} space-y-2`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate font-medium" title={s.test}>{s.test}</h3>
              <p className="text-xs text-text-tertiary">{s.results.length} result{s.results.length === 1 ? '' : 's'}{s.unit ? ` · ${s.unit}` : ''}</p>
            </div>
            <FlagChip result={s.latest} />
          </div>
          <p className="text-xl font-semibold">{formatResult(s.latest)}</p>
          <p className="text-xs text-text-secondary">
            {s.latest.collectedOn}
            {range ? ` · range ${range}` : ''}
            {change !== null ? ` · ${change > 0 ? '+' : ''}${Number(change.toPrecision(4))} since ${s.previous!.collectedOn}` : ''}
          </p>
          {s.numericCount >= 2 ? <LabTrendChart series={s} /> : <p className="text-xs text-text-tertiary">A chart appears once there are two numeric results.</p>}
          <button className={small} onClick={() => onPick(s.key)}>Show results</button>
        </div>;
      })}
    </div>
  </div>;
}

// ---- lab entry ---------------------------------------------------------------

type EntryRow = { key: string; test: string; value: string; unit: string; range: string };
const blankRow = (): EntryRow => ({ key: newId(), test: '', value: '', unit: '', range: '' });

function LabEntryForm({ today, docs, series, onSaved }: { today: string; docs: MedicalDocument[]; series: LabSeries[]; onSaved: (saved: LabResult[]) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EntryRow[]>(() => [blankRow(), blankRow(), blankRow()]);
  const [collectedOn, setCollectedOn] = useState('');
  const [lab, setLab] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Newest result per test name, to fill the unit and range when a known test is typed.
  const known = useMemo(() => {
    const m = new Map<string, LabResult>();
    for (const s of series) {
      const k = s.test.trim().toLowerCase();
      const cur = m.get(k);
      if (!cur || cur.collectedOn < s.latest.collectedOn) m.set(k, s.latest);
    }
    return m;
  }, [series]);
  const labs = useMemo(() => [...new Set(series.flatMap(s => s.results.map(r => r.lab)).filter(Boolean))].sort(), [series]);

  const setRow = (key: string, patch: Partial<EntryRow>) => setRows(cur => cur.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const fillFromKnown = (row: EntryRow) => {
    const hit = known.get(row.test.trim().toLowerCase());
    if (!hit) return;
    setRow(row.key, { unit: row.unit || hit.unit, range: row.range || formatRange(hit) });
  };

  async function save() {
    setError('');
    const date = collectedOn || today;
    const filled = rows.filter(r => r.test.trim() || r.value.trim() || r.unit.trim() || r.range.trim());
    if (!filled.length) { setError('Type at least one test and its value.'); return; }
    const out: LabResult[] = [];
    for (const [i, r] of filled.entries()) {
      if (!r.test.trim()) { setError(`Row ${i + 1} needs a test name.`); return; }
      if (!r.value.trim()) { setError(`${r.test.trim()} needs a value.`); return; }
      const parsed = parseLabResult({
        id: newId(), test: r.test, ...parseLabValue(r.value), unit: r.unit, ...parseRange(r.range),
        collectedOn: date, lab, documentId: documentId || null, notes: '',
      });
      if (!parsed.ok) { setError(parsed.error); return; }
      out.push(parsed.result);
    }
    setSaving(true);
    const a = await call('POST', '/api/medical/labs', { results: out });
    setSaving(false);
    const saved = a.ok && Array.isArray(a.data.results) ? a.data.results.map(rowFromApiLab).filter((r): r is LabResult => r !== null) : null;
    if (!a.ok || !saved) { setError('The lab results were not saved. Check the values and try again.'); return; }
    onSaved(saved);
    setRows([blankRow(), blankRow(), blankRow()]);
  }

  if (!open) return <button className={button} onClick={() => setOpen(true)}>Add lab results</button>;
  return <div className={`${panel} space-y-4`}>
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">Add lab results</h3>
        <InfoHint label="Adding lab results">
          <p>One row per test, as printed on the report. A value that is not a number (&quot;Negative&quot;, &quot;&lt;0.5&quot;) is kept as text.</p>
          <p>Ranges like 70-99, &lt;200 or &gt;40 set High / Low.</p>
        </InfoHint>
      </div>
      <button className={small} onClick={() => setOpen(false)}>Close</button>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="grid gap-1 text-sm">Collected on<input type="date" className={field} value={collectedOn || today} onChange={e => setCollectedOn(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">Lab
        <input className={field} list="known-labs" value={lab} maxLength={100} onChange={e => setLab(e.target.value)} placeholder="Optional" />
        <datalist id="known-labs">{labs.map(l => <option key={l} value={l} />)}</datalist>
      </label>
      <label className="grid gap-1 text-sm">From document
        <select className={field} value={documentId} onChange={e => setDocumentId(e.target.value)} aria-label="From document">
          <option value="">None</option>
          {docs.map(d => <option key={d.id} value={d.id}>{d.date} · {d.title}</option>)}
        </select>
      </label>
    </div>
    <datalist id="known-tests">{[...known.values()].map(r => <option key={r.id} value={r.test} />)}</datalist>
    <div className="space-y-2">
      <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_auto] gap-2 text-xs text-text-tertiary sm:grid"><span>Test</span><span>Value</span><span>Unit</span><span>Range</span><span /></div>
      {rows.map((r, i) => <div key={r.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <input className={`${field} col-span-2 sm:col-span-1`} list="known-tests" placeholder="Test, e.g. LDL cholesterol" aria-label={`Row ${i + 1} test`} maxLength={80}
          value={r.test} onChange={e => setRow(r.key, { test: e.target.value })} onBlur={() => fillFromKnown(r)} />
        <input className={field} placeholder="Value" aria-label={`Row ${i + 1} value`} maxLength={40} value={r.value} onChange={e => setRow(r.key, { value: e.target.value })} />
        <input className={field} placeholder="Unit" aria-label={`Row ${i + 1} unit`} maxLength={24} value={r.unit} onChange={e => setRow(r.key, { unit: e.target.value })} />
        <input className={field} placeholder="Range" aria-label={`Row ${i + 1} range`} maxLength={40} value={r.range} onChange={e => setRow(r.key, { range: e.target.value })} />
        <button className={small} aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows(cur => cur.filter(x => x.key !== r.key))}>✕</button>
      </div>)}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className={button} disabled={rows.length >= MAX_LAB_BATCH} onClick={() => setRows(cur => [...cur, blankRow()])}>Add a row</button>
      <button className={`${button} border-accent text-accent`} disabled={saving || !today} onClick={save}>{saving ? 'Saving…' : 'Save results'}</button>
      {error && <p role="alert" className="text-sm text-amber-400">{error}</p>}
    </div>
  </div>;
}

// ---- lab table -----------------------------------------------------------------

function LabTable(props: {
  results: LabResult[]; series: LabSeries[]; filter: string; setFilter: (f: string) => void; docById: Map<string, MedicalDocument>;
  busy: Set<string>; editing: string | null; setEditing: (id: string | null) => void; docs: MedicalDocument[];
  onRemove: (r: LabResult) => void; onEdited: (r: LabResult) => void;
}) {
  const { results, series, filter, setFilter, docById, busy, editing, setEditing, docs, onRemove, onEdited } = props;
  const [limit, setLimit] = useState(TABLE_PAGE);
  const tableRef = useRef<HTMLDivElement>(null);
  const picked = series.find(s => s.key === filter) ?? null;
  const rows = useMemo(() => (picked ? [...picked.results] : [...results]).sort(compareNewestFirst), [picked, results]);
  useEffect(() => { if (filter !== 'all') tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [filter]);

  return <div ref={tableRef} className={`${panel} space-y-3`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold">All results</h3>
      <select className={field} value={picked ? filter : 'all'} onChange={e => { setFilter(e.target.value); setLimit(TABLE_PAGE); }} aria-label="Show results for">
        <option value="all">All tests ({results.length})</option>
        {series.map(s => <option key={s.key} value={s.key}>{s.test}{s.unit ? ` (${s.unit})` : ''} · {s.results.length}</option>)}
      </select>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-text-tertiary">
          <tr><th className="py-2 pr-3">Date</th><th className="pr-3">Test</th><th className="pr-3">Result</th><th className="pr-3">Range</th><th className="pr-3">Flag</th><th className="pr-3">Lab · source</th><th /></tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map(r => editing === r.id
            ? <tr key={r.id}><td colSpan={7} className="py-2"><LabEditForm result={r} docs={docs} onDone={() => setEditing(null)} onSaved={onEdited} /></td></tr>
            : <tr key={r.id} className="border-t border-border-subtle align-top">
                <td className="py-2 pr-3 whitespace-nowrap">{r.collectedOn}</td>
                <td className="pr-3">{r.test}{r.notes && <p className="text-xs whitespace-pre-wrap text-text-tertiary">{r.notes}</p>}</td>
                <td className="pr-3 whitespace-nowrap">{formatResult(r)}</td>
                <td className="pr-3 whitespace-nowrap text-text-secondary">{formatRange(r)}</td>
                <td className="pr-3"><FlagChip result={r} /></td>
                <td className="pr-3 text-text-secondary">
                  {r.lab}
                  {r.documentId && docById.get(r.documentId) && <>{r.lab ? ' · ' : ''}<a className="text-accent hover:underline" href={`/api/medical/documents/${r.documentId}/file`} target="_blank" rel="noopener noreferrer">{docById.get(r.documentId)!.title}</a></>}
                </td>
                <td className="whitespace-nowrap text-right">
                  <button className={small} disabled={busy.has(r.id)} onClick={() => setEditing(r.id)}>Edit</button>{' '}
                  <button className={small} disabled={busy.has(r.id)} onClick={() => onRemove(r)}>Remove</button>
                </td>
              </tr>)}
        </tbody>
      </table>
    </div>
    {rows.length > limit && <button className={button} onClick={() => setLimit(l => l + TABLE_PAGE)}>Show {Math.min(TABLE_PAGE, rows.length - limit)} more</button>}
  </div>;
}

type LabFields = { test: string; value: string; unit: string; range: string; collectedOn: string; lab: string; documentId: string; notes: string };
const labFieldsOf = (r: LabResult): LabFields => ({
  test: r.test, value: r.value === null ? r.valueText : String(r.value), unit: r.unit, range: formatRange(r),
  collectedOn: r.collectedOn, lab: r.lab, documentId: r.documentId ?? '', notes: r.notes,
});

/**
 * Autosave (Riley 2026-11-15, lib/autosave.ts): each change is checked with the same parser and sent on its own
 * through PATCH /api/medical/labs/[id] (only the fields that differ from what is saved); Done closes the editor.
 */
function LabEditForm({ result, docs, onDone, onSaved }: { result: LabResult; docs: MedicalDocument[]; onDone: () => void; onSaved: (r: LabResult) => void }) {
  const [f, setF] = useState<LabFields>(() => labFieldsOf(result));
  const saved = useRef(result);
  const parse = (v: LabFields) => parseLabResult({ ...saved.current, test: v.test, ...parseLabValue(v.value), unit: v.unit, ...parseRange(v.range), collectedOn: v.collectedOn, lab: v.lab, documentId: v.documentId || null, notes: v.notes });
  const autosave = useAutosave<LabFields>('lab-edit', {
    delayMs: 1200,
    ready: v => { const next = parse(v); return next.ok ? null : next.error; },
    save: async v => {
      const next = parse(v);
      if (!next.ok) throw new AutosaveRefused(next.error);
      // Send only what changed: an unchanged link to a since-removed document is left alone.
      const patch: Partial<Record<keyof LabResult, unknown>> = {};
      for (const key of Object.keys(next.result) as (keyof LabResult)[]) {
        if (key !== 'id' && next.result[key] !== saved.current[key]) patch[key] = next.result[key];
      }
      if (Object.keys(patch).length) {
        const a = await call('PATCH', `/api/medical/labs/${result.id}`, patch);
        const row = a.ok ? rowFromApiLab(a.data.result) : null;
        if (!row) throw autosaveFailure(a);
        saved.current = row;
        onSaved(row);
      }
    },
  }, labFieldsOf(result));
  const edit = (patch: Partial<LabFields>, typed = true) => {
    const next = { ...f, ...patch };
    setF(next);
    autosave.change(next, { delayMs: typed ? 1200 : 400 });
  };
  const flush = () => void autosave.flush();
  async function done() {
    // Incomplete or not saved: stay open (the status line says what is wrong or has Retry).
    if (await autosave.flush()) onDone();
  }

  return <div className="space-y-2 rounded-xl border border-border-emphasis p-3">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <input className={`${field} col-span-2`} aria-label="Test" maxLength={80} value={f.test} onChange={e => edit({ test: e.target.value })} onBlur={flush} />
      <input className={field} aria-label="Value" maxLength={40} value={f.value} onChange={e => edit({ value: e.target.value })} onBlur={flush} />
      <input className={field} aria-label="Unit" placeholder="Unit" maxLength={24} value={f.unit} onChange={e => edit({ unit: e.target.value })} onBlur={flush} />
      <input className={field} aria-label="Range" placeholder="Range" maxLength={40} value={f.range} onChange={e => edit({ range: e.target.value })} onBlur={flush} />
      <input type="date" className={field} aria-label="Collected on" value={f.collectedOn} onChange={e => edit({ collectedOn: e.target.value })} onBlur={flush} />
      <input className={field} aria-label="Lab" placeholder="Lab" maxLength={100} value={f.lab} onChange={e => edit({ lab: e.target.value })} onBlur={flush} />
      <select className={field} aria-label="From document" value={f.documentId} onChange={e => edit({ documentId: e.target.value }, false)}>
        <option value="">No document</option>
        {result.documentId && !docs.some(d => d.id === result.documentId) && <option value={result.documentId}>(removed document)</option>}
        {docs.map(d => <option key={d.id} value={d.id}>{d.date} · {d.title}</option>)}
      </select>
      <textarea className={`${field} col-span-2 sm:col-span-4`} aria-label="Note" placeholder="Note (optional)" maxLength={MAX_LAB_NOTES} rows={2} value={f.notes} onChange={e => edit({ notes: e.target.value })} onBlur={flush} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className={`${small} border-accent text-accent`} onClick={() => void done()}>Done</button>
      <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />
    </div>
  </div>;
}

// ---- documents ---------------------------------------------------------------

type Phase = 'idle' | 'saving' | 'uploading' | 'finishing';
const PHASE_TEXT: Record<Phase, string> = { idle: 'Upload', saving: 'Starting…', uploading: 'Uploading…', finishing: 'Checking the file…' };

function DocumentUpload({ today, onUploaded }: { today: string; onUploaded: (d: MedicalDocument) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<DocKind>('lab');
  const [date, setDate] = useState('');
  const [provider, setProvider] = useState('');
  const [notes, setNotes] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  function pick(f: File | null) {
    setError('');
    if (!f) { setFile(null); return; }
    if (!mimeForFile(f.name, f.type)) { setFile(null); setError('Only a PDF or an image (JPEG, PNG, WebP, HEIC) can be uploaded.'); return; }
    if (f.size < 1 || f.size > MAX_FILE_BYTES) { setFile(null); setError(`The file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`); return; }
    setFile(f);
    if (!title.trim()) setTitle(titleFromFileName(f.name));
  }

  async function upload() {
    setError('');
    if (!file) { setError('Choose a file first.'); return; }
    const mime = mimeForFile(file.name, file.type);
    if (!mime) { setError('Only a PDF or an image can be uploaded.'); return; }
    const id = newId();
    setPhase('saving');
    const start = await call('POST', '/api/medical/documents', {
      id, title, kind, date: date || today, provider, notes, mime, size: file.size,
    });
    const ticket = start.ok ? (start.data.upload as { path?: unknown; token?: unknown } | undefined) : undefined;
    if (!start.ok || typeof ticket?.path !== 'string' || typeof ticket?.token !== 'string') {
      setPhase('idle'); setError('The file was not uploaded. Try again.'); return;
    }
    setPhase('uploading');
    // Straight to the private bucket with the one-time token (Vercel would cap a file sent
    // through Onyx's own server at about 4.5 MB). The bucket only takes the declared types.
    const body = file.type === mime ? file : new File([file], file.name, { type: mime });
    let uploadFailed = false;
    try {
      const { error: upErr } = await createSupabaseBrowser().storage.from(MEDICAL_BUCKET)
        .uploadToSignedUrl(ticket.path, ticket.token, body, { contentType: mime, upsert: false });
      uploadFailed = Boolean(upErr);
    } catch {
      uploadFailed = true;
    }
    // Ask the server to confirm even after an error: a retried upload may already be there.
    setPhase('finishing');
    const done = await call('POST', `/api/medical/documents/${id}/complete`);
    setPhase('idle');
    const doc = done.ok ? rowFromApiDoc(done.data.document) : null;
    if (!doc) { setError(uploadFailed ? 'The file did not upload. Check the connection and try again.' : 'The upload did not finish. Try again.'); return; }
    onUploaded(doc);
    setFile(null); setTitle(''); setProvider(''); setNotes('');
    if (input.current) input.current.value = '';
  }

  const working = phase !== 'idle';
  return <div className={`${panel} space-y-3`}>
    <h3 className="font-semibold">Upload a document</h3>
    <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.heic,.heif"
      className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border file:border-border-default file:bg-surface-card file:px-3 file:py-2 file:text-text-primary"
      disabled={working} onChange={e => pick(e.target.files?.[0] ?? null)} aria-label="File" />
    {file && <p className="text-xs text-text-tertiary">{formatBytes(file.size)}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">Title<input className={field} maxLength={120} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Annual blood work" /></label>
      <label className="grid gap-1 text-sm">Kind
        <select className={field} value={kind} onChange={e => setKind(e.target.value as DocKind)} aria-label="Kind">
          {DOC_KINDS.map(k => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Date of service<input type="date" className={field} value={date || today} onChange={e => setDate(e.target.value)} /></label>
      <label className="grid gap-1 text-sm">Provider<input className={field} maxLength={120} value={provider} onChange={e => setProvider(e.target.value)} placeholder="Optional" /></label>
      <label className="grid gap-1 text-sm sm:col-span-2">Note<textarea className={field} maxLength={MAX_DOC_NOTES} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" /></label>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className={`${button} border-accent text-accent`} disabled={working || !file || !title.trim() || !today} onClick={upload}>{PHASE_TEXT[phase]}</button>
      {error && <p role="alert" className="text-sm text-amber-400">{error}</p>}
    </div>
  </div>;
}

function DocumentList({ docs, busy, resultsPerDoc, onRemove, onEdited }: {
  docs: MedicalDocument[]; busy: Set<string>; resultsPerDoc: Map<string, number>; onRemove: (d: MedicalDocument) => void; onEdited: (d: MedicalDocument) => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<DocKind | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const shown = docs.filter(d => (kind === 'all' || d.kind === kind) && documentMatches(d, query));
  return <div className={`${panel} space-y-3`}>
    <div className="flex flex-wrap gap-2">
      <input className={`${field} flex-1`} placeholder="Search titles, providers, notes" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search documents" />
      <select className={field} value={kind} onChange={e => setKind(e.target.value as DocKind | 'all')} aria-label="Kind">
        <option value="all">All kinds</option>
        {DOC_KINDS.map(k => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
      </select>
    </div>
    {shown.length === 0 && <p className="text-sm text-text-secondary">No documents match.</p>}
    <ul className="divide-y divide-border-subtle">
      {shown.map(d => <li key={d.id} className="py-3">
        {editing === d.id
          ? <DocumentEditForm doc={d} onDone={() => setEditing(null)} onSaved={onEdited} />
          : <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <a className="font-medium text-accent hover:underline" href={`/api/medical/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer">{d.title}</a>
                <p className="text-xs text-text-tertiary">
                  {DOC_KIND_LABEL[d.kind]} · {d.date}{d.provider ? ` · ${d.provider}` : ''} · {formatBytes(d.size)}
                  {resultsPerDoc.get(d.id) ? ` · ${resultsPerDoc.get(d.id)} lab result${resultsPerDoc.get(d.id) === 1 ? '' : 's'}` : ''}
                </p>
                {d.notes && <p className="mt-1 text-sm whitespace-pre-wrap text-text-secondary">{d.notes}</p>}
              </div>
              <div className="flex shrink-0 gap-1">
                <a className={small} href={`/api/medical/documents/${d.id}/file?download=1`}>Download</a>
                <button className={small} disabled={busy.has(d.id)} onClick={() => setEditing(d.id)}>Edit</button>
                <button className={small} disabled={busy.has(d.id)} onClick={() => onRemove(d)}>Remove</button>
              </div>
            </div>}
      </li>)}
    </ul>
  </div>;
}

type DocFields = { title: string; kind: DocKind; date: string; provider: string; notes: string };

/** Autosave, as LabEditForm: each change goes through PATCH /api/medical/documents/[id]; Done closes. */
function DocumentEditForm({ doc, onDone, onSaved }: { doc: MedicalDocument; onDone: () => void; onSaved: (d: MedicalDocument) => void }) {
  const [f, setF] = useState<DocFields>({ title: doc.title, kind: doc.kind, date: doc.date, provider: doc.provider, notes: doc.notes });
  const autosave = useAutosave<DocFields>('document-edit', {
    delayMs: 1200,
    ready: v => (v.title.trim() ? null : 'Give the document a title.'),
    save: async v => {
      const a = await call('PATCH', `/api/medical/documents/${doc.id}`, v);
      const row = a.ok ? rowFromApiDoc(a.data.document) : null;
      if (!row) throw autosaveFailure(a);
      onSaved(row);
    },
  }, { title: doc.title, kind: doc.kind, date: doc.date, provider: doc.provider, notes: doc.notes });
  const edit = (patch: Partial<DocFields>, typed = true) => {
    const next = { ...f, ...patch };
    setF(next);
    autosave.change(next, { delayMs: typed ? 1200 : 400 });
  };
  const flush = () => void autosave.flush();
  async function done() {
    if (await autosave.flush()) onDone();
  }

  return <div className="space-y-2">
    <div className="grid gap-2 sm:grid-cols-2">
      <input className={field} aria-label="Title" maxLength={120} value={f.title} onChange={e => edit({ title: e.target.value })} onBlur={flush} />
      <select className={field} aria-label="Kind" value={f.kind} onChange={e => edit({ kind: e.target.value as DocKind }, false)}>
        {DOC_KINDS.map(k => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
      </select>
      <input type="date" className={field} aria-label="Date of service" value={f.date} onChange={e => edit({ date: e.target.value })} onBlur={flush} />
      <input className={field} aria-label="Provider" placeholder="Provider" maxLength={120} value={f.provider} onChange={e => edit({ provider: e.target.value })} onBlur={flush} />
      <textarea className={`${field} sm:col-span-2`} aria-label="Note" placeholder="Note" maxLength={MAX_DOC_NOTES} rows={2} value={f.notes} onChange={e => edit({ notes: e.target.value })} onBlur={flush} />
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button className={`${small} border-accent text-accent`} onClick={() => void done()}>Done</button>
      <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />
    </div>
  </div>;
}

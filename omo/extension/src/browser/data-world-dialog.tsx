/**
 * promise:share (L7) — "Build a world from data" dialog: a CSV file (pick the column to group by) or a local
 * repo folder (each top-level folder becomes a room). It only BUILDS a world and hands it back; the widget
 * plans it through the world planner as one proposal (Apply / Discard / Undo like any other change).
 * The folder is read through a read-only adapter; its path never enters the world.
 */
import * as React from 'react';
import type { WorldSpec } from '../common/world-model';
import { CsvTable, DataPlan, FolderReader, parseCsv, planFromCsv, planFromRepo, suggestGroupColumn, worldFromPlan, CSV_MAX_BYTES } from '../common/world-data';
import '../../src/browser/world-share.css';

export interface DataWorldDialogProps {
    /** A suggested folder (the project folder), shown in the folder field. */
    folderHint?: string;
    /** Read-only access to a local folder (absolute path), or a readable error. */
    openFolder(path: string): Promise<{ reader: FolderReader; name: string }>;
    theme?: WorldSpec['shell']['theme'];
    onBuild(world: WorldSpec, source: string): void;
    onClose(): void;
}

export function DataWorldDialog(props: DataWorldDialogProps): React.ReactElement {
    const [tab, setTab] = React.useState<'csv' | 'repo'>('csv');
    const [table, setTable] = React.useState<CsvTable>();
    const [fileName, setFileName] = React.useState('');
    const [column, setColumn] = React.useState(0);
    const [folder, setFolder] = React.useState(props.folderHint ?? '');
    const [repoPlan, setRepoPlan] = React.useState<DataPlan>();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    const plan = React.useMemo<DataPlan | undefined>(() => {
        if (tab === 'repo') return repoPlan;
        if (!table) return undefined;
        try { return planFromCsv(table, column, { name: `${fileName.replace(/\.csv$/i, '') || 'Data'} by ${table.headers[column]}` }); } catch { return undefined; }
    }, [tab, table, column, fileName, repoPlan]);
    const readCsv = async (file: File): Promise<void> => {
        setError(''); setTable(undefined);
        if (file.size > CSV_MAX_BYTES) { setError(`CSV files must be at most ${CSV_MAX_BYTES / 1024 / 1024} MB.`); return; }
        try { const t = parseCsv(await file.text()); setTable(t); setFileName(file.name); setColumn(suggestGroupColumn(t)); }
        catch (e) { setError(e instanceof Error ? e.message : 'That CSV could not be read.'); }
    };
    const readFolder = async (): Promise<void> => {
        setError(''); setRepoPlan(undefined); setBusy(true);
        try { const { reader, name } = await props.openFolder(folder.trim()); setRepoPlan(await planFromRepo(reader, name)); }
        catch (e) { setError(e instanceof Error ? e.message : 'That folder could not be read.'); }
        finally { setBusy(false); }
    };
    const build = (): void => {
        if (!plan) return;
        try { props.onBuild(worldFromPlan(plan, { theme: props.theme }), tab === 'csv' ? `${fileName} by ${table?.headers[column]}` : plan.name); }
        catch (e) { setError(e instanceof Error ? e.message : 'That world could not be built.'); }
    };
    return <div className="omo-data-scrim" data-testid="data-world-scrim" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}>
        <section className="omo-data-dialog" role="dialog" aria-modal="true" aria-label="Build a world from data" data-testid="data-world-dialog"
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') props.onClose(); }}>
            <header><strong>Build a world from data</strong><button type="button" aria-label="Close" data-testid="data-world-close" onClick={props.onClose}>×</button></header>
            <nav role="tablist">
                <button type="button" role="tab" aria-selected={tab === 'csv'} data-testid="data-tab-csv" onClick={() => { setTab('csv'); setError(''); }}>CSV file</button>
                <button type="button" role="tab" aria-selected={tab === 'repo'} data-testid="data-tab-repo" onClick={() => { setTab('repo'); setError(''); }}>Repo folder</button>
            </nav>
            {tab === 'csv' ? <div className="omo-data-body">
                <label className="omo-field">CSV file<input type="file" accept=".csv,text/csv" data-testid="data-csv-input" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void readCsv(f); }} /></label>
                {table && <label className="omo-field">Group rows by<select data-testid="data-group-by" value={column} onChange={e => setColumn(Number(e.target.value))}>
                    {table.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}</select>
                    <small>{table.rows.length} rows. Each group is a room (at most 12) with a sign and up to 4 note boards.</small></label>}
            </div> : <div className="omo-data-body">
                <label className="omo-field">Folder on this computer<input data-testid="data-repo-path" value={folder} spellCheck={false} onChange={e => setFolder(e.target.value)} placeholder="/path/to/repo" /></label>
                <button type="button" data-testid="data-repo-read" disabled={busy || !folder.trim()} onClick={() => void readFolder()}>{busy ? 'Reading…' : 'Read folder'}</button>
                <small>Read only. Each top-level folder is a room; boards show its README first line and file counts. The folder path is not put in the world.</small>
            </div>}
            {plan && <ul className="omo-data-preview" data-testid="data-preview">{plan.rooms.map((r, i) => <li key={i} data-room={r.name}><b>{r.name}</b>{r.boards.length ? <small>{r.boards.join(' | ')}</small> : null}</li>)}</ul>}
            {plan?.notes.map((n, i) => <p key={i} className="omo-data-note">{n}</p>)}
            {error && <p role="alert" className="omo-error" data-testid="data-world-error">{error}</p>}
            <footer>
                <button type="button" className="omo-primary" data-testid="data-build" disabled={!plan || busy} onClick={build}>Build this world</button>
                <small>You see the change first. Apply keeps it; Undo takes it back.</small>
            </footer>
        </section>
    </div>;
}

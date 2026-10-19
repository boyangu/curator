// Backup data sets — the toggles in Settings → Backup. Lives in shared (not
// core) because the renderer needs the ids + labels as VALUES, and a value
// import from @curator/core would drag the backend (sqlite, chokidar) into
// the browser bundle. Everything else about backups is in
// apps/core/src/backup/types.ts.

export type BackupSetId = 'core' | 'peaks' | 'embeddings' | 'covers' | 'rekordboxDb' | 'rekordboxAnalysis' | 'tracks';

export const BACKUP_SET_IDS: readonly BackupSetId[] = ['core', 'peaks', 'embeddings', 'covers', 'rekordboxDb', 'rekordboxAnalysis', 'tracks'];

export const BACKUP_SET_LABELS: Record<BackupSetId, { label: string; hint: string }> = {
	core:              { label: 'Curator library',        hint: 'Library, tags, playlists, cues, analysis, settings (always on).' },
	peaks:             { label: 'Waveform peaks',          hint: 'Rebuildable by the analyzer, but that takes hours.' },
	embeddings:        { label: 'AI embeddings',           hint: 'mir.db — rebuildable by the AI engine (hours on a GPU).' },
	covers:            { label: 'Cover art cache',         hint: 'Re-fetched on demand; off by default.' },
	rekordboxDb:       { label: 'Rekordbox database + settings', hint: 'master.db, playlists XML, My Settings, key/MIDI mappings.' },
	rekordboxAnalysis: { label: 'Rekordbox analysis',      hint: 'Per-track ANLZ files (grids, waveforms, cues) and artwork.' },
	tracks:            { label: 'Audio files',             hint: 'Every local file in the library. Large — needs the quota.' },
};

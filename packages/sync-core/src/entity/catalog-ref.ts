// catalog_ref rows: which Global Catalog object a library entity is (schema.ts
// catalogRef). A cache on each device, never synced: catalogue objects merge
// and the uuid is only what the last lookup found. Written by the desktop's
// collection import and lookups (apps/core catalog-client/catalog-refs.ts)
// and by the phone's entity pages (apps/mobile js/entity.ts).

import type Database from 'better-sqlite3';

export type CatalogRefKind = 'track' | 'album' | 'artist' | 'label';
export type CatalogRefObjectKind = 'recording' | 'release' | 'artist' | 'label';
export type CatalogRefRow = { entityKind: CatalogRefKind; entityId: string; objectId: string; objectKind: CatalogRefObjectKind; provider: string | null; providerId: string | null };

export function writeRefs(raw: Database.Database, rows: CatalogRefRow[], now = Date.now()): void {
	const put = raw.prepare(
		`insert into catalog_ref (entity_kind, entity_id, object_id, object_kind, provider, provider_id, resolved_at) values (?, ?, ?, ?, ?, ?, ?)
		on conflict (entity_kind, entity_id) do update set object_id = excluded.object_id, object_kind = excluded.object_kind,
			provider = excluded.provider, provider_id = excluded.provider_id, resolved_at = excluded.resolved_at`,
	);
	raw.transaction(() => {
		for (const r of rows) put.run(r.entityKind, r.entityId, r.objectId, r.objectKind, r.provider, r.providerId, now);
	})();
}

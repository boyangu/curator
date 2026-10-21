// The body of a chunked bootstrap ('snapshot_chunks', protocol
// cloud-service.ts): the server names the gzipped body's size and this reads
// it in MAX_SNAPSHOT_CHUNK_BYTES pieces, each a small request, and joins
// them. Apart from transport.ts (which imports electron) so it can be tested.

import { CloudTransportError } from '@curator/core';
import { MAX_SNAPSHOT_CHUNK_BYTES, type BootstrapResult, type SnapshotChunkResult } from '@curator/protocol';

export async function readSnapshotBody(
	head: BootstrapResult,
	fetchPiece: (offset: number, length: number) => Promise<SnapshotChunkResult>,
	maxBytes: number,
	pieceBytes = MAX_SNAPSHOT_CHUNK_BYTES,
): Promise<Buffer> {
	if (!head.chunked) return Buffer.from(head.snapshot, 'base64');
	const total = head.chunked.totalBytes;
	if (total > maxBytes) throw new CloudTransportError('bad_request', `snapshot body of ${total} bytes is past the cap`);
	const parts: Buffer[] = [];
	for (let offset = 0; offset < total; offset += pieceBytes) {
		const piece = await fetchPiece(offset, Math.min(pieceBytes, total - offset));
		if (piece.snapshotSeq !== head.snapshotSeq || piece.offset !== offset) throw new CloudTransportError('server', 'snapshot piece out of order');
		parts.push(Buffer.from(piece.data, 'base64'));
	}
	const body = Buffer.concat(parts);
	if (body.length !== total) throw new CloudTransportError('server', `snapshot body short: ${body.length} of ${total} bytes`);
	return body;
}

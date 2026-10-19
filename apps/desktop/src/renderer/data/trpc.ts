// Renderer-side tRPC client over the Electron IPC bridge. The custom link
// turns each operation into a `window.api.trpc(path, input)` invoke and wraps
// the resolved value as a single-emission tRPC result. There is nothing to
// cancel — IPC invoke is fire-and-forget — so the teardown is a no-op.
//
// The AppRouter import is TYPE-ONLY: it's erased at runtime, so this does not
// couple the renderer bundle to main. It only feeds tRPC's client inference so
// `trpc.tracks.list.mutate(args)` is end-to-end typed against the handler
// surface. window.api.trpc is allowed here because this file lives under
// renderer/data/ (the boundary script's single window.api zone).

import { createTRPCClient, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '../../main/trpc.js';

const ipcLink: TRPCLink<AppRouter> = () => ({ op }) =>
	observable((observer) => {
		window.api.trpc(op.path, op.input).then(
			(data) => {
				observer.next({ result: { type: 'data', data } });
				observer.complete();
			},
			(err) => observer.error(err as never),
		);
		return () => { /* nothing to cancel — IPC invoke is fire-and-forget */ };
	});

export const trpc = createTRPCClient<AppRouter>({ links: [ipcLink] });

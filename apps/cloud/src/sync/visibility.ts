// What a reader of the op log may see while a batch commits ('batches',
// sql/0007_library_op_batch.sql, src/sync/batch.ts).
//
// A batch's commit moves up to ~120k staged ops into library_op in chunks,
// each its own transaction (one statement for all of them would run into
// the 30 s statement timeout on a busy database), then publishes. Until it
// publishes, nothing it moved may be seen: not by a pull, not by the
// far-behind hint, not by a bootstrap or a snapshot fold. The mechanism is a
// per-user fence, `curator.library_op_fence.visible_through`, and every read
// of library_op applies it as `seq <= VISIBLE_THROUGH`. With no fence row
// the bound is the largest bigint, so the predicate costs one primary-key
// probe and changes nothing.
//
// Why no pulling cursor can pass a seq that later becomes visible:
//   1. Seq order is commit order per user: every library_op insert (a push,
//      a commit chunk) takes the per-user advisory lock first and the seq
//      identity is CACHE 1, so any committed state shows a seq-prefix of the
//      user's log (pull.ts, "Seq visibility").
//   2. The fence goes up under that same lock, at the head H0 of the log:
//      every op at or below H0 is committed and visible, and every seq taken
//      afterwards, by the commit's chunks and by other devices' pushes
//      meanwhile alike, is above H0.
//   3. Every read clamps to the fence in the same statement as its rows
//      (one snapshot): a page returns ops <= H0 only, and the cursor a page
//      hands out (`nextSeq`, the skip-own page's head included) is at most
//      H0. So while the fence stands no cursor moves past H0, and nothing
//      at or below H0 can still appear.
//   4. Publishing deletes the fence only after every chunk has committed.
//      From then on the visible log is again the whole committed prefix,
//      and every op above H0 (the batch's and the pushes made meanwhile) is
//      above every cursor.
// Snapshots need no bound of their own: none is ever stored above a fence.
// The snapshot job clamps the head it folds to with this same predicate
// (and skips a user with a live batch altogether), so a snapshot built
// while a fence stands sits at or below it, and one built before sits at or
// below the head the fence later goes up at. Bootstrap and the far-behind
// hint may therefore offer the newest snapshot as it is. The commit itself
// builds none; the sweep snapshots the batch after it publishes.
//
// Other devices' pushes keep landing while the fence stands; they only
// become visible with the batch, a commit's duration later (seconds to a
// couple of minutes). Pushing never waits on the fence.

// Postgres' largest bigint: "no fence".
const NO_FENCE = '9223372036854775807';

// The calling user's visible bound, as a scalar subquery: evaluated once per
// statement, inside that statement's snapshot. RLS confines the fence table
// to the caller's own row; the explicit user predicate is for the index.
export const VISIBLE_THROUGH = `(select coalesce(min(f.visible_through), ${NO_FENCE}) from curator.library_op_fence f where f.user_id = (select auth.uid()))`;

/** Bounded asynchronous work whose completion order never changes result selection.
 * Successful, not-yet-consumed items reserve result slots. Failed/unusable items free
 * their slots immediately, even while an earlier ranked item is still running.
 */
export interface RankedWorkOptions {
  concurrency: number;
  scheduling: 'rolling' | 'batches';
}
export async function rankedWork<T, R>(items: readonly T[], options: RankedWorkOptions,
  work: (item: T, index: number) => Promise<R | null>, accept: (value: R, index: number) => void,
  remaining: () => number, equivalent?: (left:R,right:R)=>boolean): Promise<void> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    throw new Error('candidate concurrency must be a positive safe integer');
  if (!['rolling', 'batches'].includes(options.scheduling)) throw new Error('invalid candidate scheduling');
  type Outcome = { index: number; value: R | null; error?: never } | { index: number; error: unknown; value?: never };
  const active = new Map<number, Promise<Outcome>>(), ready = new Map<number, Outcome>();
  const consumed:R[]=[];
  let next = 0, frontier = 0, failed = false, failure: unknown;
  while (true) {
    const representatives:R[]=[];
    for(const row of ready.values())if(!('error' in row)&&row.value!==null){
      if(!equivalent||![...consumed,...representatives].some(prior=>equivalent(row.value!,prior)))representatives.push(row.value);
    }
    const reserved=representatives.length;
    let slots = Math.min(options.concurrency - active.size, remaining() - active.size - reserved);
    if (failed || (options.scheduling === 'batches' && active.size)) slots = 0;
    while (slots-- > 0 && next < items.length) {
      const index = next++;
      // Defer synchronous exceptions into the same drainable outcome path.
      active.set(index, Promise.resolve().then(() => work(items[index]!, index)).then(
        value => ({ index, value }), error => ({ index, error })));
    }
    if (!active.size) break;
    const outcome = await Promise.race(active.values());
    active.delete(outcome.index); ready.set(outcome.index, outcome);
    if ('error' in outcome && !failed) { failed = true; failure = outcome.error; }
    while (ready.has(frontier)) {
      const row = ready.get(frontier)!; ready.delete(frontier++);
      if (!failed && remaining() > 0 && !('error' in row) && row.value !== null) {
        try { accept(row.value, row.index); consumed.push(row.value); }
        catch (error) { failed = true; failure = error; }
      }
    }
    // On a fatal error or enough results, drain everything already started before
    // returning. This prevents late writes after the owner closes its artifacts.
  }
  if (failed) throw failure;
}

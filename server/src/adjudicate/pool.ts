// A bounded pool: at most `concurrency` items run at once, and when one finishes the next starts at
// once, without waiting for a group. Nothing here knows about models or money. Each run reports what
// should happen next, so one failure never rejects the others:
//   stop     dispatch nothing more (work already running finishes)
//   pauseMs  dispatch nothing for this long (a rate limit's retry-after)
//   requeue  this item couldn't start: try it again after another item finishes (a budget that is
//            only held by running requests). With nothing else running, the pool stops with `requeue`.
// `warmFirst` runs one item alone before the rest, so concurrent requests can read the prompt cache
// the first one wrote, instead of each paying to write it.

export type PoolStep = { stop?: string; pauseMs?: number; requeue?: string };
export type PoolResult<T> = { stopped: string | null; peak: number; started: number; unstarted: T[] };
export type PoolControl = { stop(reason: string): void };

export function runPool<T>(
  items: readonly T[],
  { concurrency, warmFirst = false }: { concurrency: number; warmFirst?: boolean },
  run: (item: T) => Promise<PoolStep | void>,
  onControl?: (control: PoolControl) => void,
): Promise<PoolResult<T>> {
  if (concurrency < 1) throw new Error("Concurrency must be at least 1.");
  const queue = [...items];
  let active = 0;
  let peak = 0;
  let started = 0;
  let stopped: string | null = null;
  let warmed = !warmFirst;
  let pauseUntil = 0;
  let waitingForSlot = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failure: { error: unknown } | null = null;

  return new Promise((resolve, reject) => {
    const finish = () => {
      if (timer) clearTimeout(timer);
      if (failure) reject(failure.error);
      else resolve({ stopped, peak, started, unstarted: queue });
    };
    const pump = () => {
      const limit = warmed ? concurrency : 1;
      const paused = Date.now() < pauseUntil;
      while (stopped === null && !paused && !waitingForSlot && active < limit && queue.length > 0) start(queue.shift()!);
      if (active > 0) return;
      if (stopped !== null || queue.length === 0) return finish();
      if (paused && !timer) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, pauseUntil - Date.now());
      }
    };
    const start = (item: T) => {
      active++;
      started++;
      peak = Math.max(peak, active);
      run(item).then(
        (step) => {
          active--;
          warmed = true;
          if (step?.requeue) {
            started--;
            if (active === 0) stopped ??= step.requeue;
            else waitingForSlot = true;
            queue.unshift(item);
            return pump();
          }
          waitingForSlot = false;
          if (step?.stop) stopped ??= step.stop;
          if (step?.pauseMs) pauseUntil = Math.max(pauseUntil, Date.now() + step.pauseMs);
          pump();
        },
        // A run that throws is a bug or a database failure, not a model failure: stop, and report it
        // once what is running has finished.
        (error: unknown) => {
          active--;
          stopped ??= "error";
          failure ??= { error };
          pump();
        },
      );
    };
    onControl?.({
      stop(reason) {
        stopped ??= reason;
        pump();
      },
    });
    pump();
  });
}

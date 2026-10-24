// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and runs every timer due on the way, in order, awaiting each.
// -----------------------------------------------------------------------------

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) {
        break;
      }
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      await next.timer.fn();
    }
    clock.now = target;
  }
  return { clock, timers, pending, advance };
}

// Hands out event timestamps (µs): as close to the real time as possible, but strictly increasing,
// so commit order and ts order are the same thing. A clock step backwards or a burst of events in one
// microsecond only squeezes ts together; it never reorders
export interface TsClock {
  next(hintUs: number): number;
  readonly last: number;
}

export function createTsClock(last: number, onRaised?: (byUs: number) => void): TsClock {
  let current = last;
  return {
    next(hintUs) {
      const ts = Math.max(hintUs, current + 1);
      // Over a second above the hint: the wall clock went back, or the log has a future ts in it
      if (ts - hintUs > 1_000_000) onRaised?.(ts - hintUs);
      current = ts;
      return ts;
    },
    get last() {
      return current;
    },
  };
}

export function nowUs(): number {
  return Math.floor((performance.timeOrigin + performance.now()) * 1000);
}

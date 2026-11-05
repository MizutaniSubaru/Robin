type Cleanup = () => void | Promise<void>;

// A stack of cleanups: register each resource right after acquiring it,
// stop() undoes them in reverse, so a half-finished startup is undone exactly as far as it got
export interface Lifecycle {
  defer(name: string, cleanup: Cleanup): void;
  stop(): Promise<void>;
}

export function createLifecycle(onError: (name: string, error: unknown) => void): Lifecycle {
  const stack: { name: string; cleanup: Cleanup }[] = [];
  let stopping: Promise<void> | undefined;

  return {
    defer(name, cleanup) {
      if (stopping !== undefined) throw new Error(`Cannot defer ${name}: shutting down`);
      stack.push({ name, cleanup });
    },
    stop() {
      // Every caller awaits the same promise, so concurrent stops run once
      stopping ??= (async () => {
        for (let entry = stack.pop(); entry; entry = stack.pop()) {
          try {
            await entry.cleanup();
          } catch (error) {
            onError(entry.name, error);
          }
        }
      })();
      return stopping;
    },
  };
}

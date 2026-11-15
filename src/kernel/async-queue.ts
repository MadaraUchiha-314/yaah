/**
 * A queue between code that is called back and code that iterates: values pushed from
 * event listeners are read with `for await`, in order, until the queue ends or fails.
 */
export interface AsyncQueue<T> extends AsyncIterable<T> {
  /** Adds a value. Ignored once the queue has ended or failed. */
  push(value: T): void;
  /** Ends the queue: the reader finishes after the values already pushed. */
  end(): void;
  /** Fails the queue: the reader throws `error` after the values already pushed. */
  fail(error: unknown): void;
}

/** Creates an empty queue. It has one reader. */
export function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let failure: { readonly error: unknown } | null = null;
  const notify = (): void => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const nextPush = (): Promise<void> =>
    new Promise((resolve: () => void) => {
      wake = resolve;
    });
  async function* read(): AsyncGenerator<T> {
    for (;;) {
      // Values pushed while one is being read are taken before the queue ends or fails.
      while (values.length > 0) {
        yield* values.splice(0);
      }
      if (failure !== null) {
        throw failure.error;
      }
      if (ended) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- waiting for the next push
      await nextPush();
    }
  }
  return {
    push: (value: T): void => {
      if (!ended && failure === null) {
        values.push(value);
        notify();
      }
    },
    end: (): void => {
      ended = true;
      notify();
    },
    fail: (error: unknown): void => {
      if (!ended && failure === null) {
        failure = { error };
        notify();
      }
    },
    [Symbol.asyncIterator]: read,
  };
}

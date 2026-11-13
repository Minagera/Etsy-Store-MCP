/**
 * The global fetch, safe to store in a variable or on an object and call later.
 *
 * Workers throws "Illegal invocation: function called with incorrect `this`
 * reference" if the global fetch runs with any `this` other than the global
 * object, which is what `this.fetchImpl(...)` does after `fetchImpl = fetch`.
 * This wrapper ignores `this`, and looks fetch up at call time.
 */
export const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

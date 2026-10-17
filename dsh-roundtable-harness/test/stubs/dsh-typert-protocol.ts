/**
 * Stand-in for `@deepseek-ai/dsh-typert-protocol` used by the verification
 * harness.
 *
 * `Remote(name)` reproduces the real decorator's contract: it hands back a
 * `(method, context)` function that records a marker through the context's
 * `addInitializer`, and the initializer writes onto `Object.getPrototypeOf(this)`.
 * The plugin's decorator shim depends on both halves, so a stub that merely
 * returned a no-op would not exercise the code that matters.
 *
 * @module dsh-roundtable-harness/test/stubs/dsh-typert-protocol
 */

export const REMOTE_MARKER = Symbol.for('dsh-roundtable-harness/test/remote-markers');

/**
 * Mark one method as a directly invocable Remote endpoint.
 * @param exportName - the wire name (this plugin always uses the method name).
 * @returns a method decorator.
 */
export function Remote(exportName) {
  return (_method, context) => {
    if (context.private || context.static || typeof context.name !== 'string') {
      throw new TypeError('typert-protocol: Remote decorators require a public instance method');
    }
    context.addInitializer(function initializer() {
      const prototype = Object.getPrototypeOf(this);
      const held = Object.prototype.hasOwnProperty.call(prototype, REMOTE_MARKER)
        ? Reflect.get(prototype, REMOTE_MARKER)
        : [];
      held.push({ method: context.name, exportName });
      Object.defineProperty(prototype, REMOTE_MARKER, { configurable: true, value: held });
    });
  };
}

/** Read the markers a shim recorded on a class prototype. */
export function remoteMethodsOf(klass) {
  return Reflect.get(klass.prototype, REMOTE_MARKER) ?? [];
}

export class RemoteError extends Error {
  constructor(code, message, details, options) {
    super(message, options);
    this.code = code;
    this.details = details;
  }
}

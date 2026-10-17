/**
 * Stand-in for `react` used by the verification harness.
 *
 * The client half needs `createElement` at module scope and `Component` to
 * declare its error boundary; the checks that use it never render anything, so
 * this is deliberately not a React implementation.
 *
 * @module dsh-roundtable-harness/test/stubs/react
 */

/**
 * Record child arguments and return a plain descriptor.
 * @param type - element type.
 * @param props - element props.
 * @param children - element children.
 * @returns a descriptor object, never a real fiber.
 */
export function createElement(type, props, ...children) {
  return { type, props, children };
}

/** Minimal class-component base: enough to define a boundary, never to render it. */
export class Component {
  constructor(props) {
    this.props = props ?? {};
    this.state = {};
  }

  setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
  }
}

/** Fragment sentinel; the harness never renders, it only needs the symbol to exist. */
export const Fragment = Symbol.for('react.fragment');

export default { createElement, Component, Fragment };

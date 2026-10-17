/**
 * Stand-in for `@deepseek-ai/schemastery` used by the verification harness.
 *
 * Only the builder surface this plugin uses, plus the Standard-Schema marker
 * Cordis checks — enough for the wiring test to prove `Config` is a real
 * schema object rather than a plain object literal.
 *
 * @module dsh-roundtable-harness/test/stubs/schemastery
 */

class Schema {
  constructor(kind, options = {}) {
    this.kind = kind;
    this.options = options;
  }

  default(value) {
    return new Schema(this.kind, { ...this.options, default: value });
  }

  required() {
    return new Schema(this.kind, { ...this.options, required: true });
  }

  description(text) {
    return new Schema(this.kind, { ...this.options, description: text });
  }

  /** Standard Schema marker: its presence is what Cordis looks for. */
  get '~standard'() {
    return { version: 1, vendor: 'schemastery-stub', validate: (value) => ({ value }) };
  }
}

function builder(kind) {
  return (inner) => new Schema(kind, inner === undefined ? {} : { inner });
}

const SchemaFactory = Object.assign(
  (value) => new Schema('any', { value }),
  {
    object: (shape) => new Schema('object', { shape }),
    string: builder('string'),
    number: builder('number'),
    boolean: builder('boolean'),
    array: builder('array'),
    union: builder('union'),
    dict: builder('dict'),
    const: builder('const'),
    any: builder('any'),
  },
);

export default SchemaFactory;

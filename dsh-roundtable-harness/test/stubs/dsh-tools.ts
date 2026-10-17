/**
 * Stand-in for `@deepseek-ai/dsh-tools` used by the verification harness.
 *
 * It is deliberately *stricter* than a no-op stub: `defineTool` re-implements
 * the real parameter-DSL validation, because that is exactly what broke the
 * first shipped build (`required: false` is rejected: `parameters.<key>.required
 * must be true when present`). A stub that accepted anything would have let the
 * bug through again.
 *
 * @module dsh-roundtable-harness/test/stubs/dsh-tools
 */

/** Raised for a malformed tool definition, mirroring the real dialect's error. */
export class JsonSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonSchemaError';
  }
}

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

function validateParameters(parameters, toolName) {
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (spec === null || typeof spec !== 'object') {
      throw new JsonSchemaError(`unsupported JSON schema: parameters.${key} must be an object`);
    }
    if (!ALLOWED_TYPES.has(spec.type)) {
      throw new JsonSchemaError(`unsupported JSON schema: parameters.${key}.type is required`);
    }
    // The real compiler's exact refusal, preserved verbatim.
    if ('required' in spec && spec.required !== true) {
      throw new JsonSchemaError(`unsupported JSON schema: parameters.${key}.required must be true when present`);
    }
    if ('required' in spec && Object.keys(parameters[key]).length > 3) {
      throw new JsonSchemaError(`unsupported JSON schema: parameters.${key} has unknown fields`);
    }
  }
  void toolName;
}

/**
 * Build a tool definition after validating it the way the real registry does.
 * @param definition - the candidate definition.
 * @returns the definition, unchanged.
 */
export function defineTool(definition) {
  if (typeof definition?.name !== 'string' || definition.name.length === 0) {
    throw new JsonSchemaError('a tool needs a non-empty name');
  }
  if (typeof definition?.description !== 'string' || definition.description.length === 0) {
    throw new JsonSchemaError(`tool "${definition.name}" needs a non-empty description`);
  }
  if (typeof definition?.execute !== 'function') {
    throw new JsonSchemaError(`tool "${definition.name}" needs an execute function`);
  }
  validateParameters(definition.parameters, definition.name);
  if (definition.output !== undefined) {
    if (typeof definition.output.schema !== 'object' || definition.output.schema === null) {
      throw new JsonSchemaError(`tool "${definition.name}" output.schema must be an object`);
    }
    if (typeof definition.output.render !== 'function') {
      throw new JsonSchemaError(`tool "${definition.name}" output.render must be a function`);
    }
  }
  return definition;
}

export class ToolRuntime {}

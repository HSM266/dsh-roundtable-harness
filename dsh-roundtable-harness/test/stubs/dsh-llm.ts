/**
 * Stand-in for `@deepseek-ai/dsh-llm` used by the verification harness.
 *
 * The Harness resolves the real package from its own installation; outside it
 * the verification bundle aliases the specifier here, so the engine can be
 * exercised end to end with mock providers and no API key.
 *
 * @module dsh-roundtable-harness/test/stubs/dsh-llm
 */

let counter = 0;

export function createMessage(input) {
  counter += 1;
  return { id: `mock-message-${counter}`, ...input };
}

export function createUserMessage(input) {
  return createMessage({ ...input, role: 'user' });
}

export function createAssistantMessage(input) {
  return createMessage({ ...input, role: 'assistant', source: { kind: 'model', ...input.source } });
}

export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

export class LlmRuntime {}

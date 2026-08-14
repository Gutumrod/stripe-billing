export type RedactOptions = {
  customSensitiveFields?: readonly string[];
  mask?: string;
};

const DEFAULT_MASK = '[REDACTED]';
const BUILT_IN_SENSITIVE_FIELDS = [
  'password',
  'token',
  'secret',
  'authorization',
  'apiKey',
  'apikey',
  'creditCard',
  'creditcard',
  'ssn',
  'privateKey',
  'privatekey',
] as const;

function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createSensitiveFieldSet(customSensitiveFields?: readonly string[]): Set<string> {
  const fields = new Set<string>();

  for (const field of BUILT_IN_SENSITIVE_FIELDS) {
    fields.add(field.toLowerCase());
  }

  for (const field of customSensitiveFields ?? []) {
    fields.add(field.toLowerCase());
  }

  return fields;
}

function redactValue(
  value: unknown,
  sensitiveFields: Set<string>,
  mask: string,
  seen: WeakSet<object>,
  copies: WeakMap<object, unknown>,
): unknown {
  if (isPrimitive(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    if (copies.has(value)) {
      return copies.get(value);
    }

    seen.add(value);
    const output: unknown[] = [];
    copies.set(value, output);

    for (const item of value) {
      output.push(redactValue(item, sensitiveFields, mask, seen, copies));
    }

    return output;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  if (copies.has(value)) {
    return copies.get(value);
  }

  seen.add(value);
  const output: Record<string, unknown> = {};
  copies.set(value, output);

  for (const [key, childValue] of Object.entries(value)) {
    if (sensitiveFields.has(key.toLowerCase())) {
      output[key] = mask;
      continue;
    }

    output[key] = redactValue(childValue, sensitiveFields, mask, seen, copies);
  }

  return output;
}

export function redactObject(data: unknown, options: RedactOptions = {}): unknown {
  const mask = options.mask ?? DEFAULT_MASK;
  const sensitiveFields = createSensitiveFieldSet(options.customSensitiveFields);
  return redactValue(data, sensitiveFields, mask, new WeakSet<object>(), new WeakMap<object, unknown>());
}

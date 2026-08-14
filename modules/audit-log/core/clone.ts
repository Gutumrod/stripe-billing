function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue<T>(data: T, seen: WeakMap<object, unknown>): T {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  if (seen.has(data)) {
    return seen.get(data) as T;
  }

  if (data instanceof Date) {
    return new Date(data.getTime()) as T;
  }

  if (data instanceof RegExp) {
    return new RegExp(data.source, data.flags) as T;
  }

  if (Array.isArray(data)) {
    const output: unknown[] = [];
    seen.set(data, output);

    for (const item of data) {
      output.push(cloneValue(item, seen));
    }

    return output as T;
  }

  if (data instanceof Map) {
    const output = new Map<unknown, unknown>();
    seen.set(data, output);

    for (const [key, value] of data.entries()) {
      output.set(cloneValue(key, seen), cloneValue(value, seen));
    }

    return output as T;
  }

  if (data instanceof Set) {
    const output = new Set<unknown>();
    seen.set(data, output);

    for (const value of data.values()) {
      output.add(cloneValue(value, seen));
    }

    return output as T;
  }

  if (!isPlainObject(data)) {
    return data;
  }

  const output: Record<string, unknown> = {};
  seen.set(data, output);

  for (const [key, value] of Object.entries(data)) {
    output[key] = cloneValue(value, seen);
  }

  return output as T;
}

export function deepClone<T>(data: T): T {
  return cloneValue(data, new WeakMap<object, unknown>());
}

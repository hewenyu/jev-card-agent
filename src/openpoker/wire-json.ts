/** Keep number spellings outside the business model: Python distinguishes 5 and 5.0. */
interface NumberSource {
  value: number;
  source: string;
}
const numberSources = new WeakMap<object, Map<string, NumberSource>>();

export function parseWireJson(raw: string): unknown {
  return JSON.parse(
    raw,
    function (this: object, key: string, value: unknown, context?: { source?: string }) {
      if (typeof value === 'number' && context?.source) {
        let entries = numberSources.get(this);
        if (!entries) {
          entries = new Map();
          numberSources.set(this, entries);
        }
        entries.set(key, { value, source: context.source });
      }
      return value;
    },
  );
}

/** Schema validation clones the envelope, while passthrough nested values retain identity. */
export function transferNumberSources(source: object, target: object): void {
  const entries = numberSources.get(source);
  if (entries) numberSources.set(target, entries);
}

/** Python-produced wire numeric tokens are already in Python JSON representation. */
export function serializeWireJson(value: unknown, excludeTopLevel = new Set<string>()): string {
  function entry(parent: object, key: string, current: unknown): string {
    const original = numberSources.get(parent)?.get(key);
    // A later mutation must not be hidden behind the original numeric spelling.
    if (original && Object.is(current, original.value)) return original.source;
    return encode(current);
  }
  function encode(current: unknown, excluded = new Set<string>()): string {
    if (current === undefined) return 'null';
    if (Array.isArray(current))
      return `[${current.map((item, index) => entry(current, String(index), item)).join(',')}]`;
    if (current && typeof current === 'object') {
      const fields = current as Record<string, unknown>;
      return `{${Object.keys(fields)
        .filter((key) => fields[key] !== undefined && !excluded.has(key))
        .sort()
        .map((key) => `${encode(key)}:${entry(current, key, fields[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(current).replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }
  return encode(value, excludeTopLevel);
}

// RFC 8785 JSON Canonicalization Scheme, the subset Bond signs over: objects, arrays,
// strings, booleans, null and finite numbers. Self-contained so it behaves identically
// under Node, jest and Hermes, and so signing has no ESM-only dependency to resolve.
//
// Correctness notes: object keys sort by UTF-16 code units, which is exactly what the
// default Array.sort on strings does. JSON.stringify already emits ECMAScript
// number-to-string and RFC 8785 compliant string escaping (minimal escapes, lowercase
// \u, non-ASCII kept literal), so it is reused for primitives.

function serialize(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("JCS: cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") throw new Error("JCS: bigint is not supported");

  if (Array.isArray(value)) {
    return "[" + value.map((v) => serialize(v === undefined ? null : v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort(); // default string sort is UTF-16 code unit order, per RFC 8785
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k])).join(",") +
      "}"
    );
  }
  throw new Error("JCS: unsupported value of type " + t);
}

/** Canonical JSON string for a value, per RFC 8785 over the supported subset. */
export function jcs(value: unknown): string {
  return serialize(value);
}

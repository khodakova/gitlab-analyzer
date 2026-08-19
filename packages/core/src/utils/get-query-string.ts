/**
 * Build a query string from an object, using `URLSearchParams`.
 *
 * - `null` / `undefined` values are omitted.
 * - Array values become repeated parameters (multi-select); objects are
 *   unwrapped to their `value` property; empty/null items are skipped.
 * - Everything else is coerced with `String()`.
 */
export const getUrlSearchParams = (obj: Record<string, unknown> = {}): string => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null || item === '') continue;
        const scalar = typeof item === 'object' && 'value' in item ? item.value : item;
        params.append(key, String(scalar));
      }
      continue;
    }

    params.append(key, String(value));
  }

  return params.toString();
};

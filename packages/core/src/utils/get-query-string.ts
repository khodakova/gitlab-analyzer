export const getQueryString = (obj: Record<string, unknown> = {}): string => {
  const params: string[][] = [];

  Object.entries(obj)
    .map(([k, v]) => {
      if (v == null) {
        return [k, ''];
      }
      if (typeof v === 'string') {
        return [k, v];
      }
      if (typeof v === 'number') {
        return [k, String(v)];
      }
      if (typeof v === 'boolean') {
        return [k, String(v)];
      }

      return [k, ''];
    }).forEach((x) => params.push(x as string[]));

  // если значение поля - массив (например из мультиселекта)
  Object.entries(obj).forEach(([k, v]) => {
    if (Array.isArray(v)) {
      const p = v.map((x) => {
        if (typeof x === 'object' && 'value' in x) {
          return x.value;
        }
        return x;
      })
        .filter((x) => x !== '')
        .filter((x) => x != null);

      p.forEach((x) => {
        params.push([k, x]);
      });
    }
  });

  const paramsNotEmpty = params.filter(([, v]) => v !== '' && v != null);
  return new URLSearchParams(paramsNotEmpty).toString();
};

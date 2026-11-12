/** Converts the basic condition form into the same JSON Logic accepted by Manager. */
export function buildRule(rows, conjunction) {
  if (!['and', 'or'].includes(conjunction)) throw new Error('Choose AND or OR');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Add at least one rule');
  const allowed = ['==', '!=', '>', '>=', '<', '<=', 'contains', 'exists'];
  const clauses = rows.map((row) => {
    if (typeof row.field !== 'string' || !row.field.trim())
      throw new Error('Each rule requires a field');
    if (!allowed.includes(row.operator)) throw new Error('Unsupported rule operator');
    const field = row.field.trim();
    if (row.operator === 'exists') return { exists: field };
    let value = row.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        /* Unquoted input is literal text. */
      }
    }
    return { [row.operator]: [{ var: field }, value] };
  });
  return { [conjunction]: clauses };
}

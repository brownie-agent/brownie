/**
 * Parse every bounded Patch/Create clause in a TODO first line.
 *
 * A TODO may deliberately have more than one clause, for example:
 * "Patch only `a`, then patch only `b`".  Consumers must share this parser so
 * admission, scope rollback, progress accounting, and work-product review
 * cannot disagree about which files are authorized.
 */
export function boundedScopeEntries(firstLine) {
  const source = String(firstLine ?? '');
  const markers = [...source.matchAll(/\b(patch|create)\s+only\b/giu)];
  const entries = [];

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const nextMarker = markers[index + 1]?.index ?? source.length;
    const descriptionEnd = source.indexOf(':', (marker.index ?? 0) + marker[0].length);
    const end = descriptionEnd >= 0 && descriptionEnd < nextMarker ? descriptionEnd : nextMarker;
    let clause = source.slice((marker.index ?? 0) + marker[0].length, end).trimStart();
    while (clause.startsWith('`')) {
      const closing = clause.indexOf('`', 1);
      if (closing < 0) break;
      const path = clause.slice(1, closing).trim();
      if (path) entries.push({ operation: marker[1].toLowerCase(), path });
      clause = clause.slice(closing + 1).trimStart();
      const separator = clause.match(/^(?:,|and\b|&)\s*/iu);
      if (!separator) break;
      clause = clause.slice(separator[0].length).trimStart();
    }
  }
  return entries;
}

export function boundedScopeValues(firstLine, operation) {
  const normalized = String(operation ?? '').trim().toLowerCase().replace(/\s+only$/u, '');
  return boundedScopeEntries(firstLine)
    .filter((entry) => entry.operation === normalized)
    .map((entry) => entry.path);
}

export function boundedScopes(firstLine) {
  return boundedScopeEntries(firstLine).map((entry) => entry.path);
}

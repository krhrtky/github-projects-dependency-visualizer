function hasUnquotedOr(query: string): boolean {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < query.length; index++) {
    const character = query[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && /^OR\b/i.test(query.slice(index)) && (index === 0 || /\s|\(/.test(query[index - 1]!))) return true;
  }
  return false;
}

export function appendNativeFilter(query: string, filter: string): string {
  const existing = query.trim();
  return existing ? `${hasUnquotedOr(existing) ? `(${existing})` : existing} ${filter}` : filter;
}

export function nativeFilterUrl(href: string, query: string): string {
  const url = new URL(href);
  url.searchParams.set('filterQuery', query);
  return url.href;
}

function nativeFilterInput(doc: Document): HTMLInputElement | null {
  return doc.querySelector<HTMLInputElement>('input#filter-bar-component, #filter-bar-component input, input[aria-label="Filter by keyword or by field"], input[placeholder="Filter by keyword or by field"]');
}

export function readNativeFilter(doc: Document, href: string): string {
  const input = nativeFilterInput(doc);
  if (input) return input.value;
  const url = new URL(href);
  const override = url.searchParams.get('filterQuery');
  if (override !== null) return override;
  try {
    const views: unknown = JSON.parse(doc.getElementById('memex-views')?.textContent ?? 'null');
    if (!Array.isArray(views)) return '';
    const number = /\/views\/(\d+)\/?$/.exec(url.pathname)?.[1];
    const view: unknown = number ? views.find(view => view && typeof view === 'object' && view.number === Number(number)) : views[0];
    return view && typeof view === 'object' && 'filter' in view && typeof view.filter === 'string' ? view.filter : '';
  } catch { return ''; }
}

export function applyNativeFilter(filter: string): void {
  const input = nativeFilterInput(document);
  const query = appendNativeFilter(readNativeFilter(document, location.href), filter);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (input && !input.disabled && setter) {
    setter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return;
  }
  location.assign(nativeFilterUrl(location.href, query));
}

/**
 * Rendering dell'albero dei Documenti come indice compatto.
 *
 * È il pezzo che rende la memoria "alla Claude Code": nel contesto degli agenti
 * NON mettiamo il contenuto dei file, ma solo questo indice — percorsi, tipo e
 * una riga di descrizione. Così l'agente sa cosa esiste e apre on-demand solo
 * ciò che gli serve con `read_document`.
 */

export interface DocNode {
  id: string;
  parentId: string | null;
  kind: string; // 'folder' | 'file'
  name: string;
  description: string | null;
  mime: string | null;
}

/** Percorso completo di un documento (es. `specs/auth.md`). */
export function docPath(node: DocNode, byId: Map<string, DocNode>): string {
  const parts: string[] = [node.name];
  let cur = node.parentId ? byId.get(node.parentId) : undefined;
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join('/');
}

/**
 * Albero indentato leggibile. Le cartelle finiscono con `/`, i file mostrano
 * la descrizione se c'è. Ordina cartelle prima dei file, poi per nome.
 */
export function renderDocumentTree(nodes: DocNode[]): string {
  if (nodes.length === 0) return '';
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, DocNode[]>();
  for (const n of nodes) {
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    (children.get(key) ?? children.set(key, []).get(key)!).push(n);
  }
  const sort = (a: DocNode, b: DocNode) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1;

  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const kids = (children.get(parentId) ?? []).slice().sort(sort);
    for (const k of kids) {
      const indent = '  '.repeat(depth);
      if (k.kind === 'folder') {
        lines.push(`${indent}📁 ${k.name}/`);
        walk(k.id, depth + 1);
      } else {
        const tag = k.mime === 'application/pdf' ? ' (PDF)' : '';
        const desc = k.description ? ` — ${k.description}` : '';
        lines.push(`${indent}📄 ${k.name}${tag}${desc}`);
      }
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

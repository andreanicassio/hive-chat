import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  X,
  FolderPlus,
  FilePlus,
  Upload,
  Folder,
  FolderOpen,
  FileText,
  FileType2,
  Trash2,
  Save,
  Eye,
  Pencil,
  Download,
  Loader2,
} from 'lucide-react';
import type { DocumentNode, DocumentFull } from '@hive/shared';
import { useStore } from '../store.js';
import { api } from '../lib/api.js';

const NO_DOCS: DocumentNode[] = [];

/** Ordina cartelle prima dei file, poi per nome. */
function sortNodes(a: DocumentNode, b: DocumentNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Area Documenti: la base di conoscenza del progetto. Albero di cartelle e
 * file a sinistra; a destra si legge/edita un file markdown o si sfoglia un PDF.
 * Tutto in tempo reale (gli agenti e le persone vedono le stesse modifiche).
 */
export function DocumentsPanel({ workspaceId }: { workspaceId: string }) {
  const docs = useStore((s) => s.documentsByWorkspace.get(workspaceId) ?? NO_DOCS);
  const loadDocuments = useStore((s) => s.loadDocuments);
  const close = useStore((s) => s.setDocumentsPanelOpen);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | 'folder' | 'file'>(null);
  const [newName, setNewName] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadDocuments(workspaceId);
  }, [workspaceId, loadDocuments]);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, DocumentNode[]>();
    for (const d of docs) {
      const key = d.parentId ?? null;
      const arr = map.get(key) ?? [];
      arr.push(d);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort(sortNodes);
    return map;
  }, [docs]);

  const selected = selectedId ? docs.find((d) => d.id === selectedId) ?? null : null;

  async function submitNew() {
    const name = newName.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    await api
      .createDocument(workspaceId, {
        kind: creating === 'folder' ? 'folder' : 'file',
        name: creating === 'file' && !/\.\w+$/.test(name) ? `${name}.md` : name,
        parentId: activeFolderId,
        content: creating === 'file' ? '' : undefined,
      })
      .catch(() => {});
    setNewName('');
    setCreating(null);
    if (activeFolderId) setExpanded((e) => new Set(e).add(activeFolderId));
  }

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        await api.uploadDocument(workspaceId, f, activeFolderId).catch(() => {});
      }
      if (activeFolderId) setExpanded((e) => new Set(e).add(activeFolderId));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove(node: DocumentNode) {
    const label = node.kind === 'folder' ? 'la cartella e tutto il suo contenuto' : 'il file';
    if (!confirm(`Eliminare ${label} «${node.name}»?`)) return;
    if (selectedId === node.id) setSelectedId(null);
    await api.deleteDocument(workspaceId, node.id).catch(() => {});
  }

  function renderTree(parentId: string | null, depth: number) {
    const kids = childrenOf.get(parentId) ?? [];
    return kids.map((node) => {
      const isFolder = node.kind === 'folder';
      const isOpen = expanded.has(node.id);
      const isActiveFolder = activeFolderId === node.id;
      const isSelected = selectedId === node.id;
      return (
        <div key={node.id}>
          <div
            className={
              'group flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-[13px] transition-colors ' +
              (isSelected || (isFolder && isActiveFolder)
                ? 'bg-[var(--color-honey-soft)]'
                : 'hover:bg-[var(--color-sunken)]')
            }
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => {
                if (isFolder) {
                  setActiveFolderId(node.id);
                  setExpanded((e) => {
                    const n = new Set(e);
                    n.has(node.id) ? n.delete(node.id) : n.add(node.id);
                    return n;
                  });
                } else {
                  setSelectedId(node.id);
                }
              }}
            >
              {isFolder ? (
                isOpen ? (
                  <FolderOpen size={15} className="shrink-0 text-[var(--color-honey)]" />
                ) : (
                  <Folder size={15} className="shrink-0 text-[var(--color-honey)]" />
                )
              ) : node.mime === 'application/pdf' ? (
                <FileType2 size={15} className="shrink-0 text-[var(--color-ink-faint)]" />
              ) : (
                <FileText size={15} className="shrink-0 text-[var(--color-ink-faint)]" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            <button
              onClick={() => void remove(node)}
              className="shrink-0 text-[var(--color-ink-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--color-error)]"
              title="Elimina"
            >
              <Trash2 size={13} strokeWidth={2.1} />
            </button>
          </div>
          {isFolder && isOpen && renderTree(node.id, depth + 1)}
        </div>
      );
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
      <div className="flex h-[82vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-2xl">
        {/* Colonna albero */}
        <div className="flex w-72 shrink-0 flex-col border-r border-[var(--color-line)]">
          <div className="flex items-center justify-between px-3.5 py-3">
            <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
              <FolderOpen size={16} className="text-[var(--color-honey)]" /> Documenti
            </h2>
          </div>
          <div className="flex items-center gap-1 px-2.5 pb-2">
            <button
              className="btn-icon-sm"
              title="Nuova cartella"
              onClick={() => {
                setCreating('folder');
                setNewName('');
              }}
            >
              <FolderPlus size={15} />
            </button>
            <button
              className="btn-icon-sm"
              title="Nuovo file"
              onClick={() => {
                setCreating('file');
                setNewName('');
              }}
            >
              <FilePlus size={15} />
            </button>
            <button
              className="btn-icon-sm"
              title="Carica un file (PDF, ecc.)"
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void onUpload(e.target.files)}
            />
            <div className="ml-auto text-[11px] text-[var(--color-ink-faint)]">
              {activeFolderId ? 'in cartella' : 'in radice'}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {/* voce radice, per creare/caricare al livello top */}
            <button
              onClick={() => setActiveFolderId(null)}
              className={
                'mb-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] font-medium transition-colors ' +
                (activeFolderId === null
                  ? 'bg-[var(--color-honey-soft)]'
                  : 'text-[var(--color-ink-soft)] hover:bg-[var(--color-sunken)]')
              }
            >
              <Folder size={14} className="text-[var(--color-ink-faint)]" /> Progetto
            </button>
            {creating && (
              <div className="mb-1 flex items-center gap-1.5 px-1.5" style={{ paddingLeft: 6 }}>
                {creating === 'folder' ? <FolderPlus size={14} /> : <FilePlus size={14} />}
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitNew();
                    if (e.key === 'Escape') setCreating(null);
                  }}
                  onBlur={() => void submitNew()}
                  placeholder={creating === 'folder' ? 'nome cartella' : 'nome-file.md'}
                  className="field h-7 flex-1 text-[12.5px]"
                />
              </div>
            )}
            {docs.length === 0 && !creating ? (
              <p className="px-2 py-6 text-center text-[12.5px] text-[var(--color-ink-faint)]">
                Nessun documento. Crea una nota o carica un PDF: gli agenti lo vedranno
                nell'indice e potranno leggerlo.
              </p>
            ) : (
              renderTree(null, 0)
            )}
          </div>
        </div>

        {/* Colonna contenuto */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-[var(--color-line)] px-4 py-3">
            <div className="min-w-0 truncate text-[13.5px] font-medium text-[var(--color-ink-soft)]">
              {selected ? selected.name : 'Seleziona un documento'}
            </div>
            <button onClick={() => close(false)} className="btn-icon-sm" title="Chiudi">
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {selected ? (
              <DocumentView key={selected.id} workspaceId={workspaceId} node={selected} />
            ) : (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-[var(--color-ink-faint)]">
                La base di conoscenza del progetto. Le note markdown le scrivi qui; i PDF li
                carichi e Hive ne estrae il testo per gli agenti.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Vista/editor di un singolo documento. */
function DocumentView({ workspaceId, node }: { workspaceId: string; node: DocumentNode }) {
  const [full, setFull] = useState<DocumentFull | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const isPdf = node.mime === 'application/pdf';
  const isBlob = node.hasBlob;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getDocument(workspaceId, node.id)
      .then(({ document }) => {
        if (!alive) return;
        setFull(document);
        setDraft(document.content ?? '');
        setMode(document.content ? 'preview' : 'edit');
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, node.id]);

  async function save() {
    setSaving(true);
    try {
      await api.updateDocument(workspaceId, node.id, { content: draft });
      setMode('preview');
    } finally {
      setSaving(false);
    }
  }

  if (isBlob) {
    const url = api.documentBlobUrl(workspaceId, node.id);
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-4 py-2">
          <a href={url} download={node.name} className="btn btn-ghost btn-sm">
            <Download size={13} /> Scarica
          </a>
          <span className="text-[11.5px] text-[var(--color-ink-faint)]">
            {isPdf ? 'PDF — il testo è già indicizzato per gli agenti.' : node.mime}
          </span>
        </div>
        {isPdf ? (
          <iframe src={url} title={node.name} className="min-h-0 flex-1 border-0" />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--color-ink-faint)]">
            Anteprima non disponibile — usa «Scarica».
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={18} className="animate-spin text-[var(--color-ink-faint)]" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 px-4 py-2">
        <button
          className={'btn btn-sm ' + (mode === 'edit' ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setMode('edit')}
        >
          <Pencil size={13} /> Modifica
        </button>
        <button
          className={'btn btn-sm ' + (mode === 'preview' ? 'btn-primary' : 'btn-ghost')}
          onClick={() => setMode('preview')}
        >
          <Eye size={13} /> Anteprima
        </button>
        <div className="ml-auto flex items-center gap-2">
          {full?.description && (
            <span className="max-w-[220px] truncate text-[11.5px] text-[var(--color-ink-faint)]">
              {full.description}
            </span>
          )}
          <button
            className="btn btn-primary btn-sm"
            disabled={saving || draft === (full?.content ?? '')}
            onClick={() => void save()}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Salva
          </button>
        </div>
      </div>
      {mode === 'edit' ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent px-5 py-3 font-mono text-[13px] leading-relaxed outline-none"
          placeholder="Scrivi in markdown…"
        />
      ) : (
        <div className="doc-prose min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {draft.trim() ? (
            <ReactMarkdown>{draft}</ReactMarkdown>
          ) : (
            <p className="text-[13px] text-[var(--color-ink-faint)]">Documento vuoto.</p>
          )}
        </div>
      )}
    </div>
  );
}

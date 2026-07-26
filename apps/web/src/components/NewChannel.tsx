import { useState } from 'react';
import clsx from 'clsx';
import { Hash, Lock } from 'lucide-react';
import { Modal } from './Modal.js';
import { api } from '../lib/api.js';
import { useStore } from '../store.js';

/**
 * Creating a channel.
 *
 * The button in the sidebar had been wired to an empty function since it was
 * drawn: it looked alive, it highlighted on hover, and it did nothing. The
 * API and the route existed all along — only this was missing.
 */

/**
 * A channel name is lowercase, digits and dashes.
 *
 * We convert as you type rather than rejecting afterwards: typing "Nuove
 * idee" and being told off is a worse experience than watching it become
 * "nuove-idee" under your fingers, which also teaches the rule.
 */
function toChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accenti: "però" → "pero"
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-/, '')
    .slice(0, 48);
}

export function NewChannel({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const groups = useStore((s) => s.groups);
  const openChannel = useStore((s) => s.openChannel);

  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [groupId, setGroupId] = useState<string>('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^[a-z0-9][a-z0-9-]*$/.test(name);

  async function create() {
    if (!workspace || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { channel } = await api.createChannel(workspace.id, {
        // Il trattino finale si toglie SOLO qui: mentre scrivi «nuove-» è un
        // passaggio normale, e vederselo sparire sotto le dita è peggio.
        name: name.replace(/-+$/, ''),
        topic: topic.trim() || null,
        groupId: groupId || null,
        visibility,
      });
      // Entrarci subito è il gesto che segue sempre: si crea un canale per
      // scriverci, non per vederlo comparire nell'elenco.
      await openChannel(channel.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Non è riuscito.');
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-[9px] border border-[var(--color-line-strong)] bg-[var(--color-panel)] px-3 py-2 text-[14px] outline-none focus:border-[color-mix(in_oklab,var(--color-honey)_55%,var(--color-line-strong))]';

  return (
    <Modal
      onClose={onClose}
      title="New channel"
      subtitle="A place for one subject, with the people and agents it needs."
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[9px] px-3 py-1.5 text-[13.5px] text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
          <button
            onClick={() => void create()}
            disabled={!valid || busy}
            className="rounded-[9px] bg-[var(--color-terracotta)] px-3.5 py-1.5 text-[13.5px] font-medium text-white transition-opacity disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      }
    >
      <div className="space-y-3.5">
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium text-[var(--color-ink-soft)]">
            Name
          </span>
          <div className="relative">
            <span className="absolute top-1/2 left-3 -translate-y-1/2 text-[14px] text-[var(--color-ink-faint)]">
              #
            </span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(toChannelName(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create();
              }}
              placeholder="progetto-nuovo"
              className={clsx(field, 'pl-7')}
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-[12.5px] font-medium text-[var(--color-ink-soft)]">
            What it is for <span className="font-normal">(optional)</span>
          </span>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value.slice(0, 280))}
            placeholder="Shown under the channel name"
            className={field}
          />
        </label>

        {groups.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-medium text-[var(--color-ink-soft)]">
              Section
            </span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className={field}
            >
              <option value="">No section</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Chi vede il canale. Detto con una frase, non con una parola sola:
            «privato» da solo non dice chi ci entra. */}
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { v: 'public' as const, icon: Hash, label: 'Open', hint: 'Everyone in the project' },
              { v: 'private' as const, icon: Lock, label: 'Private', hint: 'Only who you invite' },
            ]
          ).map(({ v, icon: Icon, label, hint }) => (
            <button
              key={v}
              onClick={() => setVisibility(v)}
              className={clsx(
                'rounded-[10px] border px-3 py-2 text-left transition-colors',
                visibility === v
                  ? 'border-[color-mix(in_oklab,var(--color-honey)_55%,transparent)] bg-[var(--color-honey-soft)]'
                  : 'border-[var(--color-line)] hover:border-[var(--color-line-strong)]',
              )}
            >
              <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
                <Icon size={13} strokeWidth={2.2} /> {label}
              </span>
              <span className="mt-0.5 block text-[11.5px] text-[var(--color-ink-faint)]">
                {hint}
              </span>
            </button>
          ))}
        </div>

        {error && <p className="text-[12.5px] text-[var(--color-error)]">{error}</p>}
      </div>
    </Modal>
  );
}

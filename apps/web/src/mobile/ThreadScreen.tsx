import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import { useStore } from '../store.js';
import { Avatar } from '../components/Avatar.js';
import { Composer, MessageBody, WorkRow } from '../components/Chat.js';
import { MobileHeader } from './Shell.js';
import type { Message } from '@hive/shared';

/* ==========================================================================
   04 — Thread

   La conversazione secondaria. Nel canale non compare: lì c'è solo la barra
   «N risposte», ed è quella che porta qui.
   ======================================================================== */

function Reply({ message, onOpenWork }: { message: Message; onOpenWork: (id: string) => void }) {
  const run = useStore((s) => s.runs.get(message.id));
  const isAgent = message.author.type === 'agent';

  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)] gap-2.5 py-2.5">
      <Avatar
        name={message.author.name}
        emoji={message.author.avatarEmoji}
        color={message.author.avatarColor}
        size={30}
        isAgent={isAgent}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[14px] font-semibold tracking-[-0.01em]">
            {message.author.name}
          </span>
          {isAgent && (
            <span className="rounded-[4px] bg-[var(--color-sunken)] px-1 py-px text-[9.5px] font-semibold tracking-[0.07em] text-[var(--color-ink-soft)] uppercase">
              agente
            </span>
          )}
          <span className="text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
            {format(new Date(message.createdAt), 'HH:mm')}
          </span>
        </div>
        {run && <WorkRow run={run} onOpen={() => onOpenWork(message.id)} />}
        {message.body && (
          <div className="mt-1">
            <MessageBody body={message.body} streaming={run?.streaming === true} />
          </div>
        )}
      </div>
    </div>
  );
}

export function MobileThread() {
  const { channelId, messageId } = useParams<{ channelId: string; messageId: string }>();
  const navigate = useNavigate();
  const channels = useStore((s) => s.channels);
  const root = useStore((s) =>
    channelId ? s.messagesByChannel.get(channelId)?.find((m) => m.id === messageId) : undefined,
  );
  const replies = useStore((s) => (messageId ? s.threadsByRoot.get(messageId) : undefined));
  const loadThread = useStore((s) => s.loadThread);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (channelId && messageId) void loadThread(channelId, messageId);
  }, [channelId, messageId, loadThread]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies]);

  const channel = channels.find((c) => c.id === channelId);
  const back = () => navigate(channelId ? `/c/${channelId}` : '/');
  const list = replies ?? [];
  const count = root?.replyCount ?? list.length;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-panel)]">
      <MobileHeader
        title="Thread"
        subtitle={`${count} ${count === 1 ? 'risposta' : 'risposte'}${
          channel ? ` · in #${channel.name}` : ''
        }`}
        onBack={back}
      />

      <div ref={scroller} className="screen-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-10">
        {root && (
          <div className="mt-3 rounded-[12px] border border-[var(--color-line)] bg-[var(--color-panel-alt)] px-3 py-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <Avatar
                name={root.author.name}
                emoji={root.author.avatarEmoji}
                color={root.author.avatarColor}
                size={20}
                isAgent={root.author.type === 'agent'}
              />
              <span className="text-[13px] font-semibold">{root.author.name}</span>
              <span className="text-[11.5px] text-[var(--color-ink-faint)] tabular-nums">
                {format(new Date(root.createdAt), 'HH:mm')}
              </span>
            </div>
            {/* Il messaggio radice è un riferimento, non il fuoco: corpo più
                piccolo delle risposte. */}
            <MessageBody body={root.body} className="msg-body-work" />
          </div>
        )}

        <div className="mt-4 mb-1 flex items-center gap-2.5">
          <span className="text-[11.5px] font-semibold tracking-[0.06em] text-[var(--color-ink-faint)] uppercase">
            {count} {count === 1 ? 'risposta' : 'risposte'}
          </span>
          <span className="h-px flex-1 bg-[var(--color-line)]" />
        </div>

        {list.map((m) => (
          <Reply
            key={m.id}
            message={m}
            onOpenWork={(id) => navigate(`/c/${channelId}/m/${id}/lavoro`)}
          />
        ))}
        {list.length === 0 && (
          <p className="py-6 text-center text-[13.5px] text-[var(--color-ink-faint)]">
            Ancora nessuna risposta. Scrivi tu la prima.
          </p>
        )}
      </div>

      {channel && messageId && (
        <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
          <Composer
            channelId={channel.id}
            channelName={channel.name}
            threadRootId={messageId}
            compact
          />
        </div>
      )}
    </div>
  );
}

import {ChannelPicture} from './channel-picture';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ModalContent } from '@opencraft/design-system-web/modal-content';
import { Button, IconButton } from '@opencraft/design-system-web/button';
import {
  CloseIcon,
  ChevronRightIcon,
} from '@opencraft/design-system-web/action-icons';
import { downloadBlob } from '@opencraft/design-system-web/download';
import {WebChatDocument} from '@opencraft/chat-render-web';
import {ChannelGallery, recordGalleryItems} from './channel-gallery';
import {type ChannelPictures} from './channel-pictures';
import {type ChannelResourceTarget} from './channel-resources';
import {ChannelMedia, channelMediaKind} from './channel-media';
import { FilePreviewDialog } from '@opencraft/file-preview-web/dialog';
import { useFilePreviewAvailable } from '@opencraft/file-preview-web';
import { useIntl } from '@opencraft/i18n/react';
import {
  FORWARDED_RECORD_MIME,
  parseForwardedRecord,
  type ChannelMessage,
  type ForwardedRecord,
  type ForwardedEntry,
  type ForwardedPart,
} from '@opencraft/appserver-protocol';
import { ChatAvatar } from './channel-chat-ui';
import './forwarded-record.scss';
const labels = {
  record: { id: 'im.record.title', defaultMessage: 'Chat history' },
  close: { id: 'im.direct.close', defaultMessage: 'Close' },
  loading: { id: 'im.record.loading', defaultMessage: 'Loading chat history…' },
  retry: {
    id: 'im.record.retry',
    defaultMessage: 'Could not load this record. Retry',
  },
  partial: {
    id: 'im.record.partial',
    defaultMessage: 'Only part of the forwarded history was received.',
  },
  legacy: {
    id: 'im.record.legacy',
    defaultMessage: 'Text archive · Original structure is unavailable',
  },
  more: { id: 'im.record.more', defaultMessage: 'Show more messages' },
  image: { id: 'im.record.image', defaultMessage: 'View image' },
  file: { id: 'im.record.file', defaultMessage: 'Download file' },
  preview: { id: 'im.record.preview', defaultMessage: 'Open file' },
  unavailable: {
    id: 'im.record.unavailable',
    defaultMessage: 'Attachment unavailable or expired. Retry',
  },
  voice: { id: 'im.record.voice', defaultMessage: 'Voice message' },
  nested: { id: 'im.record.nested', defaultMessage: 'Forwarded history' },
  count: {
    id: 'im.record.count',
    defaultMessage: '{count} messages · {people} participants',
  },
} as const;
const legacy = (m: ChannelMessage) =>
  m.sender?.kind === 'external' && m.text.startsWith('[聊天记录] ');
export const isRecordMessage = (m: ChannelMessage) =>
  m.attachment?.type === FORWARDED_RECORD_MIME || legacy(m);
function Resource({part,pictures,group,sequence}:{part:ForwardedPart;pictures:ChannelPictures;group:string;sequence:number}) {
  const intl=useIntl(),trigger=useRef<HTMLButtonElement>(null);
  const [failed,setFailed]=useState(false),[busy,setBusy]=useState(false),[fileOpen,setFileOpen]=useState(false),controller=useRef<AbortController|null>(null);
  const image=part.kind==='image',name=part.name??intl.formatMessage(part.kind==='voice'?labels.voice:labels.file);
  const target=useMemo<ChannelResourceTarget>(()=>({group,sequence,kind:'record',path:part.resource}),[group,sequence,part.resource]);
  const preview=useFilePreviewAvailable(name),media=channelMediaKind(name,part.kind==='voice'?'audio/unknown':'');
  useEffect(()=>()=>controller.current?.abort(),[]);
  const load=useCallback((signal:AbortSignal)=>pictures.resources.read(target,signal).then(v=>v.blob),[pictures,target]);
  async function download(){
    if(!part.resource||busy)return;
    const owner=new AbortController();controller.current=owner;setBusy(true);setFailed(false);
    try{const value=await pictures.resources.read(target,owner.signal);if(!owner.signal.aborted)downloadBlob(value.blob,value.name??name);}
    catch{if(!owner.signal.aborted)setFailed(true);}finally{if(!owner.signal.aborted)setBusy(false);}
  }
  return <div className="im-record__resource">
    {image?<ChannelPicture pictures={pictures} target={part.resource?target:null} unavailable={!part.resource} label={intl.formatMessage(labels.image)} />
      :<><span className="im-record__file-name">{name}</span>
        {media&&part.resource&&<ChannelMedia resources={pictures.resources} target={target} name={name} kind={media} />}
        {part.kind==='voice'&&!media&&<small>{intl.formatMessage({id:'media.unavailable',defaultMessage:'Preview unavailable. Download this file to open it.'})}</small>}
        {preview&&!media&&part.kind==='file'&&<Button ref={trigger} variant="ghost" onClick={()=>setFileOpen(true)}>{intl.formatMessage(labels.preview)}</Button>}
        <Button variant="ghost" disabled={busy||!part.resource} onClick={()=>void download()}>{intl.formatMessage(failed?labels.unavailable:labels.file)}</Button></>}
    {fileOpen&&<FilePreviewDialog resource={group+':'+sequence+':'+part.resource} name={name} load={load} onClose={()=>setFileOpen(false)} returnFocus={()=>trigger.current} />}
  </div>;
}
function Entry({
  entry,
  root,
  pictures,
  group,
  sequence,
}: {
  entry: ForwardedEntry;
  root: ForwardedRecord;
  pictures: ChannelPictures;
  group: string;
  sequence: number;
}) {
  const intl = useIntl();
  return (
    <article className="im-record__entry">
      <ChatAvatar
        id={entry.sender.id}
        label={entry.sender.name || entry.sender.id}
      />
      <div className="im-record__entry-main">
        <header>
          <span title={entry.sender.id}>
            {entry.sender.name || entry.sender.id}
          </span>
          {entry.at !== undefined && (
            <time dateTime={new Date(entry.at).toISOString()}>
              {intl.formatDate(entry.at, { month: '2-digit', day: '2-digit' })}{' '}
              {intl.formatTime(entry.at)}
            </time>
          )}
        </header>
        {entry.parts.map((p, i) =>
          p.kind === 'record' && p.record ? (
            <details key={i} className="im-record__nested">
              <summary>
                {p.record.title || intl.formatMessage(labels.nested)}
                <ChevronRightIcon />
              </summary>
              {p.record.entries.map((e) => (
                <Entry
                  key={e.path}
                  entry={e}
                  root={root}
                  pictures={pictures}
                  group={group}
                  sequence={sequence}
                />
              ))}
            </details>
          ) : ['image', 'file', 'voice'].includes(p.kind) ? (
            <React.Fragment key={i}>
              <Resource
                part={p}
                pictures={pictures}
                group={group}
                sequence={sequence}
              />
              {root.transcripts
                ?.filter((t) => t.path === p.resource)
                .map((t) => (
                  <WebChatDocument key={t.path} documentId={group+':'+sequence+':transcript:'+t.path} source={t.text} dialect="user-message" externalResourcePolicy="restricted" />
                ))}
            </React.Fragment>
          ) : (
            <WebChatDocument key={i} documentId={group+':'+sequence+':'+entry.path+':'+i}
              conversationId={'record:'+group+':'+sequence} source={[p.text,p.url].filter(Boolean).join('\n')}
              dialect="user-message" externalResourcePolicy="restricted" />
          ),
        )}
      </div>
    </article>
  );
}
export function ForwardedRecordCard({
  message,
  pictures,
  group,
  active,
}: {
  message: ChannelMessage;
  pictures: ChannelPictures;
  group: string;
  active: boolean;
}) {
  const intl = useIntl(),
    [open, setOpen] = useState(false),
    [record, setRecord] = useState<ForwardedRecord>(),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0),
    [count, setCount] = useState(50),
    close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) {
      setOpen(false);
      setRecord(undefined);
      setFailed(false);
    }
  }, [active]);
  const typed = message.attachment?.type === FORWARDED_RECORD_MIME,
    lines = message.text.split('\n'),
    title = typed
      ? message.attachment!.name.replace(/\.chat-record\.json$/u, '')
      : lines[0].replace(/^\[聊天记录\]\s*/u, '');
  const preview = lines
    .slice(1)
    .filter((s) => !s.includes('资料编号 '))
    .slice(0, 3)
    .map((s) => s.replace(/^\d{2}-\d{2} \d{2}:\d{2} /u, ''));
  useEffect(() => {
    if (!open || !active || !typed || record) return;
    const abort = new AbortController();
    setFailed(false);
    setRecord(undefined);
    setCount(50);
    void pictures.resources
      .read({group,sequence:message.sequence,kind:"attachment"}, abort.signal)
      .then(async ({blob}) => {
        if (blob.size > 2 * 1024 * 1024) throw Error('record_too_large');
        const value = parseForwardedRecord(JSON.parse(await blob.text()));
        if (!abort.signal.aborted) setRecord(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [open, active, typed, record, pictures, group, message.sequence, retry]);
  return (
    <Dialog.Root open={open && active} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          variant="ghost"
          contentLayout="row"
          className="im-record-card"
          disabled={!active}
          aria-label={title || intl.formatMessage(labels.record)}
        >
          <span className="im-record-card__title">
            {title || intl.formatMessage(labels.record)}
          </span>
          <span className="im-record-card__preview">{preview.join('\n')}</span>
          <span className="im-record-card__footer">
            {intl.formatMessage(labels.record)}
            <ChevronRightIcon />
          </span>
        </Button>
      </Dialog.Trigger>
      {open && active && (
        <ModalContent
          className="modal-surface im-record"
          overlayClassName="modal-surface__scrim"
          overlayProps={{ 'data-layer': 'nested' }}
          data-layer="nested"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            const preview =
              event.target instanceof Element
                ? event.target.closest('dialog[open]')
                : null;
            // Radix listens in capture phase. Forward dismissal to the native preview owner
            // instead of closing the record or suppressing the preview's cancel lifecycle.
            if (preview) {
              event.preventDefault();
              preview.dispatchEvent(new Event('cancel', { cancelable: true }));
            }
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            close.current?.focus({ preventScroll: true });
          }}
        >
          <header className="im-record__header">
            <Dialog.Close asChild>
              <IconButton
                ref={close}
                aria-label={intl.formatMessage(labels.close)}
              >
                <CloseIcon />
              </IconButton>
            </Dialog.Close>
            <div>
              <Dialog.Title>{record?.title ?? title}</Dialog.Title>
              <span>
                {record
                  ? intl.formatMessage(labels.count, {
                      count: record.entries.length,
                      people: new Set(record.entries.map((e) => e.sender.id))
                        .size,
                    })
                  : intl.formatMessage(typed ? labels.record : labels.legacy)}
              </span>
            </div>
            <span aria-hidden="true" />
          </header>
          <ChannelGallery pictures={pictures} items={record?recordGalleryItems(group,message.sequence,record):[]} active={active&&open}><div className="im-record__body" tabIndex={-1} data-record-body>
            {!typed ? (
              <pre className="im-record__legacy">
                {lines.slice(1).join('\n')}
              </pre>
            ) : failed ? (
              <Button
                variant="secondary"
                onClick={() => setRetry((n) => n + 1)}
              >
                {intl.formatMessage(labels.retry)}
              </Button>
            ) : !record ? (
              <p role="status">{intl.formatMessage(labels.loading)}</p>
            ) : (
              <>
                {record.partial && (
                  <p role="status" className="im-record__partial">
                    {intl.formatMessage(labels.partial)}
                  </p>
                )}
                {record.entries.slice(0, count).map((e) => (
                  <Entry
                    key={e.path}
                    entry={e}
                    root={record}
                    pictures={pictures}
                    group={group}
                    sequence={message.sequence}
                  />
                ))}
                {count < record.entries.length && (
                  <Button
                    variant="ghost"
                    onClick={() => setCount((n) => n + 50)}
                  >
                    {intl.formatMessage(labels.more)}
                  </Button>
                )}
              </>
            )}
          </div></ChannelGallery>
        </ModalContent>
      )}
    </Dialog.Root>
  );
}

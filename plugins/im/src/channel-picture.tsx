import {useRef,useState} from 'react';
import {MediaActionButton} from '@opencraft/design-system-web/object-controls';
import '@opencraft/design-system-web/object-controls.web';
import {useIntl} from '@opencraft/i18n/react';
import {useChannelPicture,type ChannelPictures,type ChannelPictureTarget} from './channel-pictures';
import {useChannelResourceVisible} from './channel-resources';
import {useChannelGallery} from './channel-gallery';

/** The same thumbnail adapter for ordinary messages, image files and forwarded parts. */
export function ChannelPicture({pictures,target,unavailable=false,label}:{
  pictures:ChannelPictures;target:ChannelPictureTarget|null;unavailable?:boolean;label?:string;
}) {
  const intl=useIntl(),host=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),gallery=useChannelGallery();
  const near=useChannelResourceVisible(host),snapshot=useChannelPicture(pictures,unavailable?null:target,near);
  const [broken,setBroken]=useState<string|null>(null),source=snapshot.value?.source;
  const failed=unavailable||!!source&&broken===source||target!==null&&snapshot.status==='unavailable';
  const name=label??intl.formatMessage({id:'im.shadow.previewImage',defaultMessage:'Preview image'});
  async function retry(){if(!target)return;try{await pictures.retry(target);setBroken(null);}catch{if(source)setBroken(source);}}
  return <div className="im-channel-chat__attachment im-channel-chat__picture-frame" ref={host}>
    {source&&!failed?<MediaActionButton ref={trigger} className="im-channel-chat__picture" aria-label={name}
      onClick={()=>{if(target&&trigger.current)gallery?.(target,trigger.current);}}><img src={source} alt="" onError={()=>setBroken(source)} /></MediaActionButton>
      :<MediaActionButton action="retry" disabled={!failed||!target||snapshot.isFetching} onClick={()=>void retry()}>
        <span className="im-channel-chat__picture-placeholder"><small role="status">{intl.formatMessage(failed?{id:'im.shadow.imageUnavailable',defaultMessage:'Image unavailable.'}:{id:'im.shadow.imagePending',defaultMessage:'Loading image…'})}</small></span>
      </MediaActionButton>}
  </div>;
}

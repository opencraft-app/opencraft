import {useIntl} from '@opencraft/i18n/react';
import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {ImagePreview} from '@opencraft/chat-render-web/image-preview';
import {useChannelPicture, type ChannelPictures, type ChannelPictureTarget} from './channel-pictures';
import {channelTargetKey} from './channel-resources';

import {type ChannelGalleryItem} from './channel-gallery-items';
export {channelGalleryItems,recordGalleryItems,isChannelImage} from './channel-gallery-items';
const GalleryContext = createContext<((target: ChannelPictureTarget, trigger: HTMLElement) => void) | null>(null);
export const useChannelGallery = () => useContext(GalleryContext);

/** Only supplies authorized loaded-page items; the shared viewer owns keys/gestures/focus. */
export function ChannelGallery({pictures, items, active, children}: {
  pictures: ChannelPictures; items: readonly ChannelGalleryItem[]; active: boolean; children: ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null),trigger=useRef<HTMLElement | null>(null),fallback=useRef<HTMLDivElement>(null);
  const index=items.findIndex(item=>item.id===selected),item=index<0?undefined:items[index];
  useEffect(()=>{if(!active || selected!==null&&!item)setSelected(null);},[active,selected,item]);
  const open=useCallback((target:ChannelPictureTarget,from:HTMLElement)=>{if(active){trigger.current=from;setSelected(channelTargetKey(target));}},[active]);
  return <GalleryContext.Provider value={open}><div className="im-channel-gallery" ref={fallback} tabIndex={-1}>
    {children}
    {active&&item&&<GalleryPreview pictures={pictures} item={item} index={index} items={items} select={setSelected}
      close={()=>setSelected(null)} returnFocus={()=>trigger.current?.isConnected?trigger.current:fallback.current?.querySelector<HTMLElement>('.im-record__body,.im-channel-chat__conversation')??null} />}
  </div></GalleryContext.Provider>;
}
function GalleryPreview({pictures,item,index,items,select,close,returnFocus}:{
  pictures:ChannelPictures;item:ChannelGalleryItem;index:number;items:readonly ChannelGalleryItem[];
  select(id:string):void;close():void;returnFocus():HTMLElement|null;
}) {
  const intl=useIntl(),snapshot=useChannelPicture(pictures,item.target,true);
  return <ImagePreview image={{id:item.id,source:snapshot.value?.source??null,alt:item.label||intl.formatMessage({id:'im.shadow.previewImage',defaultMessage:'Preview image'}),status:snapshot.status==='unavailable'?'unavailable':'loading'}}
    position={{index,count:items.length}} onClose={close} returnFocus={returnFocus}
    previous={index>0?{onSelect:()=>select(items[index-1]!.id)}:undefined}
    next={index+1<items.length?{onSelect:()=>select(items[index+1]!.id)}:undefined} />;
}

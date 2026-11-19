/** Transport framing only: retain every code point, including emoji, without truncating content. */
export function utf8Chunks(text,maxBytes=3000){
 if(typeof text!=='string'||!text.isWellFormed()||!Number.isSafeInteger(maxBytes)||maxBytes<4)throw Error('Invalid text framing');
 const chunks=[];let part='',size=0;
 for(const point of text){const n=Buffer.byteLength(point);if(size+n>maxBytes){chunks.push(part);part='';size=0;}part+=point;size+=n;}
 if(part)chunks.push(part);return chunks;
}

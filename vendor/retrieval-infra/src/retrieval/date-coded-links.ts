/** A dated URL is an uncertainty signal, not proof of first disclosure.
 * Current-page approval must not silently retain a visibly later story URL.
 * Verified historical versions are handled separately and need no such guard.
 */
export function futureDatedUrls(text:string,anchor:string):{url:string;date:string}[]{
  const cutoff=Date.parse(anchor);if(!Number.isFinite(cutoff))throw new Error('Invalid anchor');
  const found=new Map<string,{url:string;date:string}>();
  for(const match of text.matchAll(/https?:\/\/[^\s<>"\])]+/g)){
    const url=match[0];let decoded:string;
    try{const parsed=new URL(url),path=parsed.pathname+parsed.search;
      try{decoded=decodeURIComponent(path);}catch{decoded=path.replace(/%([a-f0-9]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));}
    }catch{continue;}
    for(const d of decoded.matchAll(/\b(20\d{2})[-/](\d{2})[-/](\d{2})\b/g)){
      const date=`${d[1]}-${d[2]}-${d[3]}`,ms=Date.parse(date+'T00:00:00Z');
      if(Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===date&&ms>=cutoff)found.set(url,{url,date});
    }
  }
  return [...found.values()];
}

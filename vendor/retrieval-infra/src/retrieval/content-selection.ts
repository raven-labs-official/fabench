/** Joint structural/temporal decisions over exact input blocks. No generated article text. */
import {splitReaderBlocks} from './reader-cleaner.js';
import {validateEvidence,EvidenceValidationError,type EvidenceCitation,type VisibleEvidence} from './evidence-validation.js';
import type {EvidenceDocument} from './document-reader.js';
import {futureDatedUrls} from './date-coded-links.js';
export const CONTENT_PROCESSING_POLICY='joint-structure-time-blocks-v2';
export type ContentBlock={id:string;field:'title'|'url'|'body';text:string;start:number;end:number;protected:boolean};
export type ContentDecision={id:string;status:'supported'|'leaked'|'unknown'|'ancillary'|'structure'|'locator';role:string;reason:string;evidence:EvidenceCitation[]};
export const CONTENT_INSTRUCTIONS=`Perform article structure selection and historical availability review together.
Each input group has exact block IDs. Return JSON {"decisions":[{"id":"block ID","status":"supported|leaked|unknown|ancillary|structure|locator","role":"main|heading|table|footnote|metadata|navigation|recommendation|advertisement|social|live_widget|unknown","reason":"...","evidence":[]}]}.
Return EXACTLY one decision for every target block. Context, if present, is only for orientation.
Use ancillary only for a whole separate navigation, recommendation, advertisement, social or live-widget block. Never delete article facts because of their date, topic, or inconvenient contents; mixed article/ancillary blocks remain main or unknown. Preserve corrections, units, table notes and disclosures. Protected blocks cannot be ancillary.
Ancillary blocks are removed and are never sent to the forecaster. Other factual blocks need the SAME retrieved temporal evidence and exact citations defined above. Use unknown when unresolved. The original article is withheld if any retained factual block is unknown or leaked; you are not allowed to silently remove inconvenient paragraphs.
Use structure only for a nonfactual Markdown heading or bold section label (never title, URL or a table). A period/quarter in a section label is not itself a reported result; a factual claim in a heading still requires supported/leaked/unknown. Byline, dates and article source attribution are retained metadata, not removable ancillary roles. Use locator only for the URL block if its text adds no facts beyond the supported title/article; otherwise unknown. Audit factual text embedded in URLs and recommendations even if the source publication date is old.
For supported/leaked each block's evidence uses candidateQuote from that exact block, and all other citation fields defined above. Evidence may be reused from the shared tool history when it actually supports that block. Searching without reading is not evidence. Do not reconstruct, rewrite or summarize the article.`;
export function contentGroups(doc:EvidenceDocument,maxChars:number):ContentBlock[][]{
  const blocks:ContentBlock[]=[{id:'title',field:'title',text:doc.title,start:0,end:doc.title.length,protected:true},
    {id:'url',field:'url',text:doc.url,start:0,end:doc.url.length,protected:true},
    ...splitReaderBlocks(doc.body).map(b=>({...b,field:'body' as const}))];
  const groups:ContentBlock[][]=[];let current:ContentBlock[]=[],size=0;
  for(const b of blocks){if(current.length&&size+b.text.length>maxChars){groups.push(current);current=[];size=0;}current.push(b);size+=b.text.length;}
  if(current.length)groups.push(current);return groups;
}
export function validateContentDecisions(raw:unknown,blocks:ContentBlock[],anchor:string,sources:Map<string,EvidenceDocument>,visible:VisibleEvidence):ContentDecision[]{
  const decisions=(raw as {decisions:ContentDecision[]})?.decisions;
  if(!Array.isArray(decisions)||decisions.length!==blocks.length||new Set(decisions.map(d=>d?.id)).size!==blocks.length)throw new EvidenceValidationError('block_coverage','Return exactly one decision for every target block');
  return blocks.map(b=>{
    const d=decisions.find(d=>d?.id===b.id);
    if(!d||typeof d.reason!=='string'||!d.reason.trim())throw new EvidenceValidationError('block_coverage',`Missing decision/reason for ${b.id}`);
    if(d.status==='ancillary'){
      if(b.protected||b.field!=='body')throw new EvidenceValidationError('protected_block',`Cannot discard protected ${b.id}; classify article material and audit its time`);
      if(!['navigation','recommendation','advertisement','social','live_widget'].includes(d.role))throw new EvidenceValidationError('ancillary_role',`${b.id} has retained article role ${d.role}; use supported or unknown, not ancillary`);
      return {...d,evidence:[]};
    }
    if(d.status==='structure'){
      if(b.field!=='body'||b.protected||!/^\s*(?:#{1,6}\s+[^\n]+|\*\*[^\n]+\*\*)\s*$/u.test(b.text)||futureDatedUrls(b.text,anchor).length)throw new EvidenceValidationError('factual_structure',`${b.id} needs a factual or ancillary decision; structure is only a nonfactual heading or bold section label`);
      return {...d,evidence:[]};
    }
    if(d.status==='locator'){
      if(b.field!=='url')throw new EvidenceValidationError('invalid_locator','Only URL can be a locator');
      new URL(b.text);
      if(futureDatedUrls(b.text,anchor).length)throw new EvidenceValidationError('future_locator','Date-coded URL requires temporal review');
      return {...d,evidence:[]};
    }
    try {const verdict=validateEvidence(d,b.text,anchor,sources,visible,b.start);return {...d,...verdict};}
    catch(error){if(error instanceof EvidenceValidationError)throw new EvidenceValidationError(error.code,`Block ${b.id}: ${error.message}`,error.citationIndex,b.id);throw error;}
  });
}

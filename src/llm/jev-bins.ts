/** Input-only numeric framing. No grading labels or model output are consulted. */
export interface NumericReference { value:number; scale:number; unit:string; evidence:string; basis:string }
export interface JevBin { key:string; lower:number|null; upper:number|null; deviation_lower:number|null; deviation_upper:number|null }
const NUMBER = "[+-]?[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?";
const number = (s:string) => Number(s.replaceAll(",", ""));
export function numericReference(prompt:string):NumericReference|null {
  const target=prompt.split("\n\nNumerical target:\n")[1]?.split("\n\nReturn one JSON object")[0];
  if (!target) {
    const criteria=prompt.split("\n\nResolution criteria:\n")[1]?.split("\n\nReturn one JSON object")[0];
    if(criteria?.endsWith("No numerical forecast is requested."))return null;
    throw new Error("Jev requires the reviewed structured numerical-target section");
  }
  if (target.includes("This is an event-only question. Set numeric_forecast to null.")) return null;
  const unit=target.match(/^Required unit: (.+)$/m)?.[1];
  const title=prompt.split("\n\nQuestion:\n")[1]?.split("\n\nBackground known")[0];
  const background=prompt.split("\n\nBackground known at the information as-of date:\n")[1]?.split("\n\nResolution criteria:\n")[0];
  if (!unit || !title || !background) throw new Error("Missing reviewed Jev question fields");
  let value:number|undefined, evidence="", basis="question threshold in target units";
  const capture=(regex:RegExp, multiplier=1) => {
    const m=title.match(regex); if(!m)return false;
    value=number(m[1]!)*multiplier;evidence=m[0];return true;
  };
  if(unit==="percent_departure_from_1961_1990_average" && title.includes("as above the 1961–1990 average")) {
    return {value:0,scale:100,unit,evidence:"above the 1961–1990 average",basis:"zero departure; scale 100 percentage points, so deviation coordinates equal percentage-point departure"};
  }
  if(unit==="points" && target.includes("points minus the highest points total of any other driver")) {
    const m=background.match(new RegExp(`led the Drivers' Championship by (${NUMBER}) points`));
    if(m){value=number(m[1]!);evidence=m[0];basis="pre-as-of background lead, not event threshold zero";}
  } else if(unit==="seconds") {
    const m=title.match(/more than (\d+) minutes (\d+) seconds/);
    if(m){value=Number(m[1])*60+Number(m[2]);evidence=m[0];}
  } else if(unit==="strokes relative to par") {
    capture(new RegExp(`better than (${NUMBER}) under par`),-1);
  } else if(unit==="percent" && target.includes("Upper bound of the federal funds target range")) {
    capture(new RegExp(`${NUMBER}%–(${NUMBER})%`));
  } else if(unit==="launches") {
    const m=title.match(/at least (one|two) /);
    if(m){value=m[1]==="one"?1:2;evidence=m[0];}
  } else {
    const currency=title.match(new RegExp(`(-?)(?:NT|US)?\\$(${NUMBER})(?: (billion|million))?`));
    if(currency) {
      value=(currency[1]==="-"?-1:1)*number(currency[2]!);evidence=currency[0];
      if(unit==="USD" && currency[3])value*=currency[3]==="billion"?1e9:1e6;
    } else if(!capture(new RegExp(`(${NUMBER})%`))) {
      if(!capture(new RegExp(`(?:above|higher than|namely|at least|more than|greater than|exceed) (?:the )?(${NUMBER})`))) {
        if(!capture(new RegExp(`(?:annual rate of |of |KRW )(${NUMBER})(?: GWh| trillion| million| units|, |\\?|°[FC])`))) {
          capture(new RegExp(`(?:than (?:the )?|of )(${NUMBER})(?:°[FC]| million square kilometers| mm| m\\b)`));
        }
      }
    }
    if(value!==undefined && unit.startsWith("thousand_"))value/=1000;
  }
  if(value===undefined || !Number.isFinite(value) || value===0)
    throw new Error(`No unambiguous nonzero input reference for ${unit}: ${title}`);
  return {value,scale:Math.abs(value),unit,evidence,basis};
}
export function makeJevBins(reference:NumericReference):JevBin[] {
  if(!Number.isFinite(reference.value)||!Number.isFinite(reference.scale)||reference.scale<=0)throw new Error("Invalid numeric reference");
  // 99 positive boundaries (1..500), their negatives, and zero: 199 internal
  // boundaries, hence exactly 200 exhaustive left-closed/right-open intervals.
  const positive=Array.from({length:99},(_,i)=>i===98?500:Number((500**(i/98)).toPrecision(12)));
  const relative:[number|null,...(number|null)[]]=[null,...positive.slice().reverse().map(x=>-x),0,...positive,null];
  const absolute=relative.map(x=>x===null?null:Number((reference.value+reference.scale*x/100).toPrecision(12)));
  for(let i=2;i<absolute.length-1;i++)if(absolute[i]!<=absolute[i-1]!)throw new Error("Collapsed numeric bin boundary");
  return Array.from({length:200},(_,i)=>({key:`b${String(i).padStart(3,"0")}`,lower:absolute[i]!,upper:absolute[i+1]!,deviation_lower:relative[i]!,deviation_upper:relative[i+1]!}));
}
export function binMedian(bins:JevBin[], probabilities:Record<string,number>):{value:number;bin:string;tail_clipped:boolean} {
  const total=bins.reduce((s,b)=>s+probabilities[b.key]!,0);
  let sum=0;
  for(const b of bins) {
    sum+=probabilities[b.key]!;
    if(sum>=total/2) return {value:b.lower===null?b.upper!:b.upper===null?b.lower:(b.lower+b.upper)/2,
      bin:b.key,tail_clipped:b.lower===null||b.upper===null};
  }
  throw new Error("No numeric median");
}

import {parseForecastResponse, type ForecastResponse} from "./forecast-response.js";

/** Interpretation only: never reforecast, clamp a probability, or fill a missing value. */
export const FORECAST_NORMALIZATION_POLICY = "raven.forecast-normalization.v1";
const KEY_ALIASES: Readonly<Record<string, string>> = {
  rationate: "rationale", "rationa le": "rationale", ration: "rationale",
  rationation: "rationale", rationally: "rationale", numeric_forest: "numeric_forecast",
};
export interface NormalizedForecast {
  answer: ForecastResponse;
  strict: boolean;
  corrections: string[];
}
export function normalizeForecastResponse(raw: string, unit: string | null): NormalizedForecast {
  try {return {answer:parseForecastResponse(raw,unit),strict:true,corrections:[]};} catch { /* Audited, narrow conversions follow. */ }
  const corrections: string[]=[];
  let text=raw.trim();
  const fences=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  if(fences.length===1) {
    const outside=text.replace(fences[0]![0],"");
    // Multiple structured candidates outside a fence are ambiguous.
    if(/[{}]/.test(outside)) throw new Error("Ambiguous forecast objects outside JSON fence");
    text=fences[0]![1]!; corrections.push("extract_single_json_fence");
  }
  let obj: Record<string, any>;
  try {obj=JSON.parse(text);} catch {throw new Error("No single recoverable JSON forecast");}
  if(!obj || typeof obj!=="object" || Array.isArray(obj)) throw new Error("Forecast must be an object");
  for(const [from,to] of Object.entries(KEY_ALIASES)) {
    if(Object.hasOwn(obj,from)) {
      if(Object.hasOwn(obj,to)) throw new Error("Conflicting forecast field aliases");
      obj[to]=obj[from]; delete obj[from]; corrections.push(`rename:${from}->${to}`);
    }
  }
  const n=obj.numeric_forecast;
  if(n && typeof n==="object" && !Array.isArray(n) && typeof n.value==="number") {
    let factor: number | undefined;
    if(unit==="USD" && ["billion USD","USD billion","USD_billion","billion"].includes(n.unit)) factor=1e9;
    if(unit==="USD" && ["million USD","USD million","USD_million"].includes(n.unit)) factor=1e6;
    if(unit==="subscribers" && ["million","million subscribers"].includes(n.unit)) factor=1e6;
    if(factor!==undefined) {
      corrections.push(`unit:${n.unit}->${unit}:x${factor}`);
      n.value*=factor; n.unit=unit;
    }
  }
  return {answer:parseForecastResponse(JSON.stringify(obj),unit),strict:false,corrections};
}

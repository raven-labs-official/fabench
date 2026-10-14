/** Benchmark-only transports; shared retrieval providers remain pinned upstream. */
import {createLlmClient as createApiClient} from "./providers.js";
import {CODEX_MODEL} from "./codex-subscription.js";
import {AstraSubscriptionClient,SOL6_MODEL} from "./codex-astra.js";
import {CLAUDE_MODEL,CLAUDE_OPUS_55_MODEL, ClaudeSubscriptionClient} from "./claude-subscription.js";
import type {LlmClient} from "./benchmark-client.js";
import {JevClient,JEV_MODEL} from "./jev.js";
export function createLlmClient(provider:string,model?:string):LlmClient {
  if(provider==="jev") {
    if(model!==JEV_MODEL)throw new Error(`Jev requires pinned model jev:${JEV_MODEL}`);
    return new JevClient();
  }
  if(provider==="claude") {
    if(model!==CLAUDE_MODEL && model!==CLAUDE_OPUS_55_MODEL) throw new Error(`Unsupported Claude subscription model: ${model}`);
    return new ClaudeSubscriptionClient(undefined,model);
  }
  if(provider!=="codex" && provider!=="codex-personal") return createApiClient(provider,model);
  if(provider==="codex" && model==="gpt-6-astra") return new AstraSubscriptionClient();
  if(provider==="codex" && model===SOL6_MODEL)
    return new AstraSubscriptionClient(undefined,undefined,{model:SOL6_MODEL,account:"team"});
  if(model!==CODEX_MODEL) throw new Error(`Subscription pilot only admits codex:${CODEX_MODEL}`);
  return new AstraSubscriptionClient(undefined,undefined,{
    model:CODEX_MODEL,account:provider==="codex-personal"?"personal":"team"});
}

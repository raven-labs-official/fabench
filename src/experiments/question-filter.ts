/** Provider-compatibility exclusions supported by observed multi-arm refusal evidence. */
const CHINA_HARD_POLITICS =
  /\b(taiwan|taiwanese|xi jinping|tibet|xinjiang|uyghur|hong kong|south china sea)\b/i;
const CHINA_MILITARY =
  /\bchina\b.*\b(invade|invasion|blockade|military|clash|war|strike)\b|\b(invade|invasion|blockade|military|clash|war|strike)\b.*\bchina\b/i;

/**
 * Titles are the general rule; explicit ids cover empirically refused questions whose short
 * title omits the politically sensitive entity named only in its resolution criteria.
 */
const EMPIRICALLY_REFUSED_QUESTION_IDS = new Set([
  "2f745d23-4b18-4614-896a-b3535a4841aa", // Lai Ching-te impeachment / Taiwan president
]);

function bareQuestionId(id: string): string {
  return id.replace(/^braven::/i, "").trim().toLowerCase();
}

export function isChinaFiltered(question: {
  question_id: string;
  question_text: string;
}): boolean {
  return (
    EMPIRICALLY_REFUSED_QUESTION_IDS.has(bareQuestionId(question.question_id)) ||
    CHINA_HARD_POLITICS.test(question.question_text) ||
    CHINA_MILITARY.test(question.question_text)
  );
}


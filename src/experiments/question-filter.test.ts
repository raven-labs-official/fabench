import assert from "node:assert/strict";
import test from "node:test";
import { isChinaFiltered } from "./question-filter.js";

test("excludes the empirically refused Lai Ching-te question by stable id", () => {
  assert.equal(
    isChinaFiltered({
      question_id: "braven::2f745d23-4b18-4614-896a-b3535a4841aa",
      question_text: "Lai Ching-te impeached by June 30?",
    }),
    true,
  );
});

test("keeps ordinary China economics and technology questions", () => {
  assert.equal(
    isChinaFiltered({
      question_id: "braven::ordinary-economics",
      question_text: "Will the People's Bank of China cut rates?",
    }),
    false,
  );
  assert.equal(
    isChinaFiltered({
      question_id: "braven::ordinary-tech",
      question_text: "Will a Chinese AI model reach number one?",
    }),
    false,
  );
});


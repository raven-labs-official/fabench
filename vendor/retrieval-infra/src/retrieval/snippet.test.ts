import { test } from 'node:test';
import assert from 'node:assert/strict';
import { querySnippet } from './snippet.js';

test('a matching evidence passage is surfaced beyond a long navigation header', () => {
  const body = 'Menu subscribe cookie privacy '.repeat(30) + 'Analysts expect Acme revenue to reach $40 billion next quarter. ' + 'Background '.repeat(100);
  const snippet = querySnippet(body, 'Acme revenue analysts forecast', 160);
  assert.ok(snippet.includes('Acme revenue to reach $40 billion'));
  assert.ok(snippet.length <= 160);
  assert.ok(body.replace(/\s+/g, ' ').includes(snippet.replace(/^…|…$/g, '')));
});

test('short documents remain extractive and unchanged except whitespace', () => {
  assert.equal(querySnippet('Acme\n revenue is unknown.', 'Acme'), 'Acme revenue is unknown.');
});

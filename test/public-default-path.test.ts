import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CARDS_ROOT } from '../mcp/ikb-cards-core.mjs';
test('default cards root belongs to the current checkout', () => {
  assert.equal(DEFAULT_CARDS_ROOT, fileURLToPath(new URL('../ikb-data/cards', import.meta.url)));
});

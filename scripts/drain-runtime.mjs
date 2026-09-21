import { setTimeout as delay } from 'node:timers/promises';
import { OpenPokerClient } from './dist/openpoker/client.js';

const headers = process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {};
const base = `http://127.0.0.1:${process.env.PORT || 8787}`;
async function request(path, method = 'GET') {
  const response = await fetch(base + path, {
    method,
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`Drain API returned HTTP ${response.status}; container left unchanged`);
  return response.json();
}
let view = (await request('/api/overview')).runtime;
if (view.running) {
  await request('/api/runtime/stop', 'POST');
  console.log('Waiting for the current hand to finish and the bot to leave...');
  while (view.running) {
    await delay(1000);
    view = (await request('/api/overview')).runtime;
  }
}
const key = process.env.OPEN_POKER_API_KEY || process.env.OPENPOKER_API_KEY;
if (key && view.mode !== 'demo') {
  const client = new OpenPokerClient({
    apiKey: key,
    restUrl: process.env.OPEN_POKER_REST_BASE_URL || process.env.OPENPOKER_REST_URL,
    wsUrl: process.env.OPEN_POKER_WS_URL || process.env.OPENPOKER_WS_URL,
  });
  const active = await client.activeGame(AbortSignal.timeout(10000));
  if (active.playing || active.table_id)
    throw new Error('OpenPoker still reports a seated bot; container left unchanged');
}
console.log('Bot is stopped and unseated. Container replacement may proceed.');

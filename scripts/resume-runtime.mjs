// Operator-only entry point, invoked inside the Compose service.
const response = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/runtime/resume`, {
  method: 'POST',
  headers: process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {},
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Resume failed: HTTP ${response.status}`);
const runtime = await response.json();
if (!runtime.running) throw new Error('Bot did not resume; inspect the saved runtime failure');
console.log(`Bot resumed: ${runtime.runId} (${runtime.strategy})`);

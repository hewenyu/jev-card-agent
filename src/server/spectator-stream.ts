import type { FastifyReply } from 'fastify';
import type { SpectatorFeed } from './spectator.js';

/** Disconnect a slow consumer instead of accumulating snapshots in a second queue. */
export function openSpectatorStream(reply: FastifyReply, feed: SpectatorFeed): () => void {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  let closed = false;
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    response.off('close', close);
    response.off('error', close);
    response.destroy();
  };
  const write = (data: string) => {
    if (closed) return;
    try {
      if (!response.write(data)) close();
    } catch {
      close();
    }
  };
  response.on('close', close);
  response.on('error', close);
  unsubscribe = feed.subscribe((snapshot) =>
    write(`id: ${snapshot.sequence}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`),
  );
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000);
  heartbeat.unref();
  const initial = feed.current();
  write(`id: ${initial.sequence}\nevent: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
  return close;
}

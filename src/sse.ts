import { Response } from "express";

type StreamId = number;
type SseClient = Response;

// Almacena clientes SSE por stream para enviar eventos en tiempo real (chat, regalos, level-ups).
const streamClients = new Map<StreamId, Set<SseClient>>();

const HEARTBEAT_MS = 25000;

const ensureStreamSet = (streamId: StreamId) => {
  if (!streamClients.has(streamId)) streamClients.set(streamId, new Set());
  return streamClients.get(streamId)!;
};

export const registerStreamClient = (streamId: StreamId, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clients = ensureStreamSet(streamId);
  clients.add(res);

  // Notificar conexión
  res.write(`event: connected\ndata: {"streamId":${streamId}}\n\n`);

  // Remover cliente al cerrar
  const cleanup = () => {
    const set = streamClients.get(streamId);
    if (set) {
      set.delete(res);
      if (!set.size) streamClients.delete(streamId);
    }
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
};

export const broadcastStreamEvent = (streamId: StreamId, event: string, data: any) => {
  const clients = streamClients.get(streamId);
  if (!clients || !clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
};

// Heartbeat global para mantener viva la conexión en proxies intermedios.
setInterval(() => {
  for (const [, clients] of streamClients.entries()) {
    for (const client of clients) {
      client.write(`:ping\n\n`);
    }
  }
}, HEARTBEAT_MS);

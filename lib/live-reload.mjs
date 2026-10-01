#!/usr/bin/env node
// live-reload.mjs
// Server-Sent Events hub for browser live reload.
//
// One EventSource stream per browser tab. On a file change the server sends a
// full-reload directive; the client runtime decides whether to reload the page
// or just soft-refresh the index.

export const SSE_PATH = '/__simhost/live';
export const RELOAD_PATH = '/__simhost/reload';

export class LiveReloadHub {
  constructor({ heartbeatMs = 25_000 } = {}) {
    /** @type {Set<{id:number,res:import('node:http').ServerResponse,page:string}>} */
    this.clients = new Set();
    this.nextId = 1;
    this.heartbeatMs = heartbeatMs;
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get size() {
    return this.clients.size;
  }

  /** Registers a new SSE connection and wires up cleanup. */
  attach(req, res, page = '/') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const client = { id: this.nextId++, res, page };
    this.clients.add(client);

    this.send(client, 'hello', { id: client.id, clients: this.size, page });

    const drop = () => {
      this.clients.delete(client);
      this.broadcastClients();
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);

    return client;
  }

  /** Sends one named event with a JSON payload to a single client. */
  send(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(client);
    }
  }

  /** Broadcasts an event to every connected client. */
  broadcast(event, data) {
    for (const client of this.clients) this.send(client, event, data);
  }

  /** Tells every client the full document should be re-fetched. */
  reloadAll(reason = 'file change') {
    this.broadcast('reload', { reason, at: Date.now() });
  }

  /** Tells index-page clients to re-fetch the generated listing only. */
  refreshIndex(reason = 'simulations changed') {
    this.broadcast('index', { reason, at: Date.now() });
  }

  /** Keeps proxies from closing idle connections. */
  ping() {
    for (const client of this.clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }

  broadcastClients() {
    this.broadcast('clients', { count: this.size });
  }

  closeAll() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}
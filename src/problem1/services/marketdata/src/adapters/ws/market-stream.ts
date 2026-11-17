import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { MarketDataApi } from '@exchange/contracts';
import { Gauge, type Logger, type Registry } from '@exchange/platform';
import { Ajv } from 'ajv';
import { WebSocket, WebSocketServer } from 'ws';
import { parse } from 'yaml';
import type { MarketData } from '../../app/market-data.js';
import { toDepthDto, toTickerDto, toTradeDto } from '../dto.js';

type Schemas = MarketDataApi.components['schemas'];
type Outgoing = Schemas['WsDepth'] | Schemas['WsTrades'] | Schemas['WsTicker'] | Schemas['WsError'];

export interface StreamOptions {
  readonly specPath: string;
  readonly path: string;
  readonly maxConnections: number;
  readonly depthLimit: number;
  readonly tickMs: number;
  readonly isCaughtUp: () => boolean;
}

interface Client {
  readonly socket: WebSocket;
  readonly channels: Set<string>;
  alive: boolean;
}

// Push model: coalesced depth snapshots per tick, trades as they land,
// tickers once a second. Clients never need sequence numbers.
export class MarketStream {
  private readonly clients = new Set<Client>();
  private readonly timers: NodeJS.Timeout[] = [];
  private server: WebSocketServer | undefined;
  private readonly isSubscribe: (message: unknown) => message is Schemas['WsSubscribe'];

  constructor(
    private readonly marketData: MarketData,
    private readonly options: StreamOptions,
    private readonly logger: Logger,
    private readonly now: () => number,
    registry: Registry,
  ) {
    const spec = parse(readFileSync(options.specPath, 'utf8')) as {
      components: { schemas: Record<string, object> };
    };
    this.isSubscribe = new Ajv({ strict: false }).compile<Schemas['WsSubscribe']>(
      spec.components.schemas.WsSubscribe ?? {},
    );
    const clients = this.clients;
    new Gauge({
      name: 'ws_connections',
      help: 'Open WebSocket connections',
      registers: [registry],
      collect() {
        this.set(clients.size);
      },
    });
  }

  attach(http: Server): void {
    this.server = new WebSocketServer({ server: http, path: this.options.path, maxPayload: 4096 });
    this.server.on('connection', (socket) => {
      this.accept(socket);
    });
    this.timers.push(
      setInterval(() => {
        this.publishUpdates();
      }, this.options.tickMs),
      setInterval(() => {
        this.publishTickers();
      }, 1000),
      setInterval(() => {
        this.heartbeat();
      }, 30_000),
    );
  }

  close(): Promise<void> {
    this.timers.forEach(clearInterval);
    for (const { socket } of this.clients) socket.close(1001, 'shutting down');
    return new Promise((resolve) => {
      if (this.server)
        this.server.close(() => {
          resolve();
        });
      else resolve();
    });
  }

  private accept(socket: WebSocket): void {
    if (this.clients.size >= this.options.maxConnections) {
      socket.close(1013, 'try again later');
      return;
    }
    const client: Client = { socket, channels: new Set(), alive: true };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(client);
    });
    socket.on('message', (data, isBinary) => {
      this.onMessage(client, !isBinary && Buffer.isBuffer(data) ? data.toString('utf8') : '');
    });
  }

  private onMessage(client: Client, raw: string): void {
    const message = safeJson(raw);
    if (!this.isSubscribe(message)) {
      send(client.socket, { error: 'invalid subscription message' });
      return;
    }
    for (const channel of message.channels) {
      if (message.op === 'unsubscribe') client.channels.delete(channel);
      else {
        client.channels.add(channel);
        this.sendSnapshot(client, channel);
      }
    }
  }

  // During replay the book is partial; clients get it once caught up.
  private sendSnapshot(client: Client, channel: string): void {
    if (!this.options.isCaughtUp()) {
      send(client.socket, { error: 'replaying, data follows shortly' });
      return;
    }
    const [kind, symbol = ''] = channel.split(':');
    const view = this.marketData.view(symbol);
    if (!view) return;
    if (kind === 'depth')
      send(client.socket, { channel, data: toDepthDto(view, this.options.depthLimit) });
    if (kind === 'trades')
      send(client.socket, { channel, data: view.recentTrades(20).map(toTradeDto) });
    if (kind === 'ticker') send(client.socket, { channel, data: toTickerDto(view, this.now()) });
  }

  private publishUpdates(): void {
    const { depth, trades } = this.marketData.drain();
    if (!this.options.isCaughtUp()) return;
    for (const symbol of depth) {
      const view = this.marketData.view(symbol);
      const channel = `depth:${symbol}`;
      if (view)
        this.broadcast(channel, () => ({
          channel,
          data: toDepthDto(view, this.options.depthLimit),
        }));
    }
    for (const [symbol, list] of trades) {
      const channel = `trades:${symbol}`;
      this.broadcast(channel, () => ({ channel, data: list.map(toTradeDto) }));
    }
  }

  private publishTickers(): void {
    for (const channel of new Set([...this.clients].flatMap((client) => [...client.channels]))) {
      if (channel.startsWith('ticker:')) this.sendSnapshotToAll(channel);
    }
  }

  private sendSnapshotToAll(channel: string): void {
    for (const client of this.clients)
      if (client.channels.has(channel)) this.sendSnapshot(client, channel);
  }

  // Builds the payload once and only if someone listens.
  private broadcast(channel: string, build: () => Outgoing): void {
    let payload: string | undefined;
    for (const client of this.clients) {
      if (!client.channels.has(channel)) continue;
      payload ??= JSON.stringify(build());
      send(client.socket, payload);
    }
  }

  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
    this.logger.debug({ connections: this.clients.size }, 'ws heartbeat');
  }
}

const MAX_BUFFERED_BYTES = 1024 * 1024;

// A reader that falls this far behind is dropped rather than buffered forever.
function send(socket: WebSocket, message: Outgoing | string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(typeof message === 'string' ? message : JSON.stringify(message));
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

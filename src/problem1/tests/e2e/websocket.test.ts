import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type Md, Trader, freePrice } from '../support/api.js';
import { env } from '../support/env.js';

type Message = Md['WsDepth'] | Md['WsTrades'] | Md['WsTicker'] | Md['WsError'];

const sockets: WebSocket[] = [];

async function connect(): Promise<{ socket: WebSocket; next: (match: (m: Message) => boolean) => Promise<Message> }> {
  const socket = new WebSocket(`${env.baseUrl.replace('http', 'ws')}/v1/ws`);
  sockets.push(socket);
  const inbox: Message[] = [];
  socket.on('message', (data: Buffer) => inbox.push(JSON.parse(data.toString('utf8')) as Message));
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  const next = async (match: (m: Message) => boolean): Promise<Message> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const index = inbox.findIndex(match);
      if (index >= 0) return inbox.splice(index, 1)[0] as Message;
      if (Date.now() > deadline) throw new Error('no matching message');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { socket, next };
}

describe('market data stream', () => {
  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.close());
  });

  it('sends a snapshot on subscribe, then pushes book changes', async () => {
    const { socket, next } = await connect();
    socket.send(JSON.stringify({ op: 'subscribe', channels: ['depth:ETH-USDT'] }));
    await next((m) => 'channel' in m && m.channel === 'depth:ETH-USDT');

    const price = await freePrice('ETH-USDT');
    const seller = await Trader.create('ws');
    await seller.fund('ETH', '1');
    await seller.place({ symbol: 'ETH-USDT', side: 'SELL', type: 'LIMIT', price: `${price}`, quantity: '0.25' });

    const update = await next(
      (m) => 'channel' in m && m.channel === 'depth:ETH-USDT' && JSON.stringify(m.data).includes(`"${price}"`),
    );
    expect(update).toMatchObject({ channel: 'depth:ETH-USDT' });
    await seller.cancelAllOpen();
  });

  it('answers malformed subscriptions with an error instead of closing', async () => {
    const { socket, next } = await connect();
    socket.send(JSON.stringify({ op: 'subscribe', channels: ['depth:DOGE-USDT'] }));

    expect(await next((m) => 'error' in m)).toEqual({ error: 'invalid subscription message' });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

import { MatchingEngine, findMarket, type MatcherCommand, parseAmount } from '@exchange/core';
import { describe, expect, it } from 'vitest';
import { decodeCommand, decodeEventBatch, encodeCommand, encodeEventBatch } from '../src/index.js';

const market = findMarket('BTC-USDT');
if (!market) throw new Error('BTC-USDT market missing');

const base = { symbol: 'BTC-USDT', issuedAt: '2026-11-17T00:00:00.000Z', userId: 'u1' };

const commands: MatcherCommand[] = [
  {
    ...base,
    kind: 'PLACE',
    commandId: 'c1',
    orderId: 'o1',
    spec: {
      type: 'LIMIT',
      symbol: 'BTC-USDT',
      side: 'SELL',
      timeInForce: 'GTC',
      price: parseAmount('100.5'),
      quantity: parseAmount('0.3'),
    },
  },
  {
    ...base,
    userId: 'u2',
    kind: 'PLACE',
    commandId: 'c2',
    orderId: 'o2',
    spec: { type: 'MARKET', symbol: 'BTC-USDT', side: 'BUY', quoteQuantity: parseAmount('20.1') },
  },
  {
    ...base,
    kind: 'PLACE',
    commandId: 'c3',
    orderId: 'o3',
    spec: { type: 'MARKET', symbol: 'BTC-USDT', side: 'SELL', quantity: parseAmount('0.01') },
  },
  { ...base, kind: 'CANCEL', commandId: 'c4', orderId: 'o1' },
  { ...base, kind: 'CANCEL', commandId: 'c5', orderId: 'missing' },
];

describe('wire codecs', () => {
  it.each(commands)('round-trips command $commandId', (command) => {
    expect(decodeCommand(encodeCommand(command))).toEqual(command);
  });

  it('round-trips every event kind the engine emits', () => {
    const engine = new MatchingEngine(market);
    const batches = commands.map((command) => ({
      commandId: command.commandId,
      symbol: command.symbol,
      events: engine.handle(command),
    }));
    const kinds = new Set(batches.flatMap((b) => b.events.map((e) => e.kind)));
    expect([...kinds].sort()).toEqual(['BOOK_LEVEL', 'CANCEL_REJECTED', 'ORDER_DONE', 'TRADE']);

    for (const batch of batches) {
      expect(decodeEventBatch(encodeEventBatch(batch))).toEqual(batch);
    }
  });

  it('rejects a command without a kind', () => {
    const bytes = encodeCommand(commands[3]!).slice(0, 10);
    expect(() => decodeCommand(bytes)).toThrow();
  });
});

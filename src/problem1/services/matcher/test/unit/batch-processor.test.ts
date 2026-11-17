import { encodeCommand } from '@exchange/codecs';
import { parseAmount } from '@exchange/core';
import type { Consumer, EachBatchPayload, Producer } from '@exchange/platform';
import { describe, expect, it, vi } from 'vitest';
import { CommandBatchProcessor } from '../../src/adapters/kafka/batch-processor.js';
import { Matcher } from '../../src/app/matcher.js';

const place = (commandId: string, orderId: string) =>
  Buffer.from(
    encodeCommand({
      kind: 'PLACE',
      commandId,
      symbol: 'BTC-USDT',
      issuedAt: '2026-11-17T00:00:00.000Z',
      orderId,
      userId: 'u1',
      spec: {
        type: 'LIMIT',
        symbol: 'BTC-USDT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: parseAmount('100'),
        quantity: parseAmount('1'),
      },
    }),
  );

function batchOf(values: Buffer[], firstOffset = 10): EachBatchPayload {
  const messages = values.map((value, i) => ({ value, offset: String(firstOffset + i) }));
  return {
    batch: { topic: 'orders.commands', partition: 2, messages },
  } as unknown as EachBatchPayload;
}

function fakes(sendFailures = 0) {
  let failuresLeft = sendFailures;
  const transaction = {
    send: vi.fn(() =>
      failuresLeft-- > 0 ? Promise.reject(new Error('broker timeout')) : Promise.resolve([]),
    ),
    sendOffsets: vi.fn(() => Promise.resolve()),
    commit: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
  };
  const producer = {
    transaction: vi.fn(() => Promise.resolve(transaction)),
  } as unknown as Producer;
  const pause = vi.fn();
  const consumer = { pause } as unknown as Consumer;
  const observer = { commandProcessed: vi.fn(), batchCommitted: vi.fn() };
  return { transaction, producer, consumer, pause, observer };
}

describe('CommandBatchProcessor', () => {
  it('publishes events to the source partition and commits offsets with them', async () => {
    const { transaction, producer, consumer, observer } = fakes();
    const processor = new CommandBatchProcessor(producer, new Matcher(), observer);

    await processor.process(consumer, batchOf([place('c1', 'o1'), place('c2', 'o2')]));

    expect(transaction.send).toHaveBeenCalledWith({
      topic: 'matcher.events',
      messages: [
        expect.objectContaining({ key: 'BTC-USDT', partition: 2 }),
        expect.objectContaining({ partition: 2 }),
      ],
    });
    expect(transaction.sendOffsets).toHaveBeenCalledWith(
      expect.objectContaining({
        topics: [{ topic: 'orders.commands', partitions: [{ partition: 2, offset: '12' }] }],
      }),
    );
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(observer.batchCommitted).toHaveBeenCalledWith(2);
  });

  // Regression: a redelivered batch hit the in-memory dedupe, produced no
  // events, and committed its offsets, silently losing the orders.
  it('refuses the redelivered batch after a failed publish instead of committing nothing', async () => {
    const { transaction, producer, consumer, pause, observer } = fakes(1);
    const processor = new CommandBatchProcessor(producer, new Matcher(), observer);
    const batch = batchOf([place('c1', 'o1')]);

    await expect(processor.process(consumer, batch)).rejects.toThrow('broker timeout');
    await expect(processor.process(consumer, batch)).rejects.toThrow(/halted/);

    expect(processor.halted).toBe(true);
    expect(transaction.abort).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledWith([{ topic: 'orders.commands' }]);
    expect(transaction.sendOffsets).not.toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });
});

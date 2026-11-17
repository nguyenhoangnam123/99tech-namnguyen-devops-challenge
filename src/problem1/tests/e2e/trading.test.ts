import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type Md, Trader, call, eventually, freePrice, uniqueId } from '../support/api.js';
import { ledgerViolations } from '../support/ledger.js';

const SYMBOL = 'ETH-USDT';
const traders: Trader[] = [];

async function trader(
  name: string,
  funds: Partial<Record<'ETH' | 'USDT', number>>,
): Promise<Trader> {
  const created = await Trader.create(name);
  traders.push(created);
  for (const [asset, amount] of Object.entries(funds))
    await created.fund(asset as 'ETH' | 'USDT', String(amount));
  return created;
}

const num = (value: string | null | undefined): number => Number(value);

// Full order lifecycle through edge, oms, outbox, Kafka, matcher and settlement.
describe('trading', () => {
  afterEach(async () => {
    await Promise.all(traders.splice(0).map((t) => t.cancelAllOpen()));
  });

  afterAll(async () => {
    expect(await ledgerViolations()).toEqual({});
  });

  it('matches at the maker price, charges fees and releases the price improvement', async () => {
    const price = await freePrice(SYMBOL);
    const seller = await trader('seller', { ETH: 2 });
    const buyer = await trader('buyer', { USDT: price * 3 });

    const ask = await seller.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '1.5',
    });
    expect(ask.status).toBe(201);
    expect(ask.body.status).toBe('NEW');
    const bid = await buyer.place({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      price: `${price + 1}`,
      quantity: '1',
    });
    expect(bid.status).toBe(201);

    expect(await buyer.orderWhen(bid.body.orderId, ['FILLED'])).toMatchObject({
      filledQuantity: '1',
    });
    const sellerOrder = await seller.orderWhen(ask.body.orderId, ['PARTIALLY_FILLED']);
    expect(num(sellerOrder.filledQuote)).toBe(price);

    const [buyerEth, buyerUsdt, sellerEth, sellerUsdt] = await Promise.all([
      buyer.balance('ETH'),
      buyer.balance('USDT'),
      seller.balance('ETH'),
      seller.balance('USDT'),
    ]);
    expect(num(buyerEth.available)).toBeCloseTo(0.999, 12);
    expect(num(buyerUsdt.available)).toBeCloseTo(price * 2, 9);
    expect(buyerUsdt.held).toBe('0');
    expect(num(sellerUsdt.available)).toBeCloseTo(price * 0.999, 9);
    expect(sellerEth).toMatchObject({ available: '0.5', held: '0.5' });

    const [buyerFill] = await buyer.fills(SYMBOL);
    const [sellerFill] = await seller.fills(SYMBOL);
    expect(buyerFill).toMatchObject({ role: 'TAKER', side: 'BUY', fee: '0.001', feeAsset: 'ETH' });
    expect(sellerFill).toMatchObject({ role: 'MAKER', side: 'SELL', feeAsset: 'USDT' });
    expect(num(sellerFill?.fee ?? null)).toBeCloseTo(price * 0.001, 9);

    const trades = await call<Md['TradeList']>('GET', `/v1/markets/${SYMBOL}/trades?limit=5`);
    expect(trades.body.trades.map((t) => t.tradeId)).toContain(buyerFill?.tradeId);
  });

  it('cancels a resting remainder and returns the held funds', async () => {
    const price = await freePrice(SYMBOL);
    const seller = await trader('canceller', { ETH: 1 });
    const ask = await seller.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.4',
    });
    await eventually(
      () => call<Md['Depth']>('GET', `/v1/markets/${SYMBOL}/depth`),
      ({ body }) => body.asks.some(([level]) => num(level) === price),
    );

    const cancel = await seller.cancel(ask.body.orderId);

    expect(cancel.status).toBe(202);
    expect(cancel.body.cancelRequested).toBe(true);
    expect(await seller.orderWhen(ask.body.orderId, ['CANCELLED'])).toMatchObject({
      filledQuantity: '0',
    });
    expect(await seller.balance('ETH')).toMatchObject({ available: '1', held: '0' });
  });

  it('spends a market buy budget and returns nothing held', async () => {
    const price = await freePrice(SYMBOL);
    const seller = await trader('mm', { ETH: 1 });
    const buyer = await trader('market-buyer', { USDT: price });
    await seller.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.3',
    });

    const order = await buyer.place({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'MARKET',
      quoteQuantity: `${price * 0.2}`,
    });

    expect(await buyer.orderWhen(order.body.orderId, ['FILLED'])).toMatchObject({
      filledQuantity: '0.2',
    });
    expect(await buyer.balance('USDT')).toMatchObject({ held: '0' });
    expect(num((await buyer.balance('USDT')).available)).toBeCloseTo(price * 0.8, 9);
  });

  it('expires an IOC remainder and releases its hold', async () => {
    const price = await freePrice(SYMBOL);
    const buyer = await trader('ioc', { USDT: price });

    const order = await buyer.place({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      price: `${price}`,
      quantity: '0.5',
    });

    expect(await buyer.orderWhen(order.body.orderId, ['EXPIRED'])).toMatchObject({
      filledQuantity: '0',
      doneReason: 'IOC_REMAINDER',
    });
    expect(await buyer.balance('USDT')).toMatchObject({ available: `${price}`, held: '0' });
  });

  it('expires a taker that would trade with its own resting order', async () => {
    const price = await freePrice(SYMBOL);
    const both = await trader('self', { ETH: 1, USDT: price });
    const ask = await both.place({
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.1',
    });

    const bid = await both.place({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      price: `${price}`,
      quantity: '0.1',
    });

    expect(await both.orderWhen(bid.body.orderId, ['EXPIRED'])).toMatchObject({
      filledQuantity: '0',
      doneReason: 'SELF_TRADE',
    });
    expect((await both.order(ask.body.orderId)).body.status).toBe('NEW');
  });

  it('replays an identical order request and refuses a reused client id', async () => {
    const buyer = await trader('idem', { USDT: 1000 });
    const clientOrderId = uniqueId('same');
    const request = {
      clientOrderId,
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      price: '10',
      quantity: '1',
    } as const;

    const first = await buyer.place(request);
    const replay = await buyer.place(request);
    const changed = await buyer.place({ ...request, price: '11' });

    expect([first.status, replay.status, changed.status]).toEqual([201, 200, 409]);
    expect(replay.body.orderId).toBe(first.body.orderId);
    expect(await buyer.balance('USDT')).toMatchObject({ available: '990', held: '10' });
  });

  it.each([
    ['insufficient funds', { price: '10', quantity: '1000' }, 'INSUFFICIENT_FUNDS'],
    ['an off-tick price', { price: '10.001', quantity: '1' }, 'INVALID_PRICE'],
    ['an off-lot quantity', { price: '10', quantity: '1.00001' }, 'INVALID_QUANTITY'],
    ['a dust notional', { price: '1', quantity: '0.0001' }, 'BELOW_MIN_NOTIONAL'],
  ])('rejects %s without creating an order', async (_label, terms, code) => {
    const buyer = await trader('reject', { USDT: 100 });

    const response = await buyer.place({ symbol: SYMBOL, side: 'BUY', type: 'LIMIT', ...terms });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe(code);
    expect(await buyer.balance('USDT')).toMatchObject({ available: '100', held: '0' });
  });
});

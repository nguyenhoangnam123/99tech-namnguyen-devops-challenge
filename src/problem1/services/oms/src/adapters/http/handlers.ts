import type { OmsApi } from '@exchange/contracts';
import {
  type Fill,
  InvariantViolation,
  formatAmount,
  parseAmount,
  priceOf,
  quantityOf,
  quoteQuantityOf,
  timeInForceOf,
} from '@exchange/core';
import { type OperationHandlers, type Principal, problem } from '@exchange/platform';
import type { AccountService } from '../../app/accounts.js';
import type { DepositService } from '../../app/deposits.js';
import type { OrderService, PlaceOrderError } from '../../app/orders.js';
import type { OrderRecord } from '../../app/ports.js';
import type { RateLimits } from './rate-limits.js';

type Schemas = OmsApi.components['schemas'];

export interface HttpDeps {
  readonly accounts: AccountService;
  readonly deposits: DepositService;
  readonly orders: OrderService;
  readonly limits: RateLimits;
  readonly readiness: () => Promise<Record<string, boolean>>;
}

const SYMBOLS = ['BTC-USDT', 'ETH-USDT'] as const satisfies readonly Schemas['Symbol'][];

const PLACE_ORDER_STATUS: Record<PlaceOrderError, 409 | 422> = {
  CLIENT_ORDER_ID_REUSED: 409,
  INSUFFICIENT_FUNDS: 422,
  UNKNOWN_SYMBOL: 422,
  INVALID_ORDER_SHAPE: 422,
  INVALID_PRICE: 422,
  INVALID_QUANTITY: 422,
  BELOW_MIN_NOTIONAL: 422,
  ABOVE_MAX_NOTIONAL: 422,
};

// One handler per OpenAPI operationId; the compiler checks bodies per status.
export function omsHandlers(deps: HttpDeps): OperationHandlers<OmsApi.operations> {
  const { accounts, deposits, orders, limits } = deps;
  return {
    register: async ({ body, clientIp }) => {
      if (!(await limits.allowRegister(clientIp))) return problem(429, 'RATE_LIMITED');
      const result = await accounts.register(body.email, body.password);
      return result.ok ? { status: 201, body: result.value } : problem(409, result.error);
    },

    login: async ({ body, clientIp }) => {
      if (!(await limits.allowLogin(clientIp, body.email))) return problem(429, 'RATE_LIMITED');
      const result = await accounts.login(body.email, body.password);
      if (!result.ok) return problem(401, result.error);
      const { token, expiresIn } = result.value;
      return { status: 200, body: { accessToken: token, tokenType: 'Bearer', expiresIn } };
    },

    listBalances: async (input) => {
      const balances = await accounts.balances(userOf(input));
      return {
        status: 200,
        body: {
          balances: balances.map(({ asset, available, held }) => ({
            asset,
            available: formatAmount(available),
            held: formatAmount(held),
          })),
        },
      };
    },

    getDepositAddress: async (input) => {
      const { asset } = input.path;
      return {
        status: 200,
        body: { asset, address: await accounts.depositAddress(userOf(input), asset) },
      };
    },

    recordDeposit: async ({ body }) => {
      const result = await deposits.record({ ...body, amount: parseAmount(body.amount) });
      if (result.ok) return { status: 200, body: result.value };
      return result.error === 'TX_ID_CONFLICT'
        ? problem(409, result.error)
        : problem(400, result.error);
    },

    placeOrder: async (input) => {
      const userId = userOf(input);
      if (!(await limits.allowOrder(userId))) return problem(429, 'RATE_LIMITED');
      const result = await orders.place(userId, input.body);
      if (!result.ok) return problem(PLACE_ORDER_STATUS[result.error], result.error);
      const { order, replayed } = result.value;
      return { status: replayed ? 200 : 201, body: toOrderDto(order) };
    },

    listOrders: async (input) => {
      const { symbol, status = 'open', limit = 50 } = input.query;
      const list = await orders.list(userOf(input), { symbol, openOnly: status === 'open', limit });
      return { status: 200, body: { orders: list.map(toOrderDto) } };
    },

    getOrder: async (input) => {
      const result = await orders.get(userOf(input), input.path.orderId);
      return result.ok
        ? { status: 200, body: toOrderDto(result.value) }
        : problem(404, result.error);
    },

    cancelOrder: async (input) => {
      const result = await orders.cancel(userOf(input), input.path.orderId);
      return result.ok
        ? { status: 202, body: toOrderDto(result.value) }
        : problem(404, result.error);
    },

    listFills: async (input) => {
      const { symbol, limit = 50 } = input.query;
      const fills = await orders.fills(userOf(input), { symbol, limit });
      return { status: 200, body: { fills: fills.map(toFillDto) } };
    },

    liveness: () => Promise.resolve({ status: 200, body: { status: 'ok' } }),

    readiness: async () => {
      const checks = await deps.readiness();
      const healthy = Object.values(checks).every(Boolean);
      const body = {
        status: healthy ? ('ok' as const) : ('unavailable' as const),
        checks: Object.fromEntries(
          Object.entries(checks).map(([name, up]) => [
            name,
            up ? ('ok' as const) : ('failed' as const),
          ]),
        ),
      };
      return healthy ? { status: 200, body } : { status: 503, body };
    },
  };
}

// The security scheme guarantees a principal; this only narrows the type.
function userOf(input: { principal: Principal | undefined }): string {
  if (input.principal?.kind !== 'user')
    throw Object.assign(new Error('Unauthenticated'), { status: 401 });
  return input.principal.subject;
}

function toSymbol(symbol: string): Schemas['Symbol'] {
  const known = SYMBOLS.find((candidate) => candidate === symbol);
  if (!known) throw new InvariantViolation(`Unknown symbol ${symbol}`);
  return known;
}

const optionalAmount = (amount: bigint | undefined): string | null =>
  amount === undefined ? null : formatAmount(amount);

function toOrderDto(order: OrderRecord): Schemas['Order'] {
  const { spec } = order;
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    symbol: toSymbol(spec.symbol),
    side: spec.side,
    type: spec.type,
    timeInForce: timeInForceOf(spec),
    price: optionalAmount(priceOf(spec)),
    quantity: optionalAmount(quantityOf(spec)),
    quoteQuantity: optionalAmount(quoteQuantityOf(spec)),
    filledQuantity: formatAmount(order.filledQuantity),
    filledQuote: formatAmount(order.filledQuote),
    status: order.status,
    cancelRequested: order.cancelRequestedAt !== null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

function toFillDto(fill: Fill): Schemas['Fill'] {
  return {
    tradeId: fill.tradeId,
    orderId: fill.orderId,
    symbol: toSymbol(fill.symbol),
    side: fill.side,
    role: fill.role,
    price: formatAmount(fill.price),
    quantity: formatAmount(fill.quantity),
    fee: formatAmount(fill.fee),
    feeAsset: fill.feeAsset,
    executedAt: fill.executedAt,
  };
}

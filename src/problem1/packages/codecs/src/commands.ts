import {
  create,
  fromBinary,
  OrderCommandSchema,
  type PlaceOrder,
  PlaceOrderSchema,
  toBinary,
} from '@exchange/contracts';
import {
  type MatcherCommand,
  type OrderSpec,
  formatAmount,
  parseAmount,
  priceOf,
  quantityOf,
  quoteQuantityOf,
  timeInForceOf,
} from '@exchange/core';
import { DecodeError, orderTypeCodec, sideCodec, timeInForceCodec } from './enums.js';

const optionalAmount = (amount: bigint | undefined): string | undefined =>
  amount === undefined ? undefined : formatAmount(amount);

export function encodeCommand(command: MatcherCommand): Uint8Array {
  const { commandId, symbol, issuedAt, orderId, userId } = command;
  const kind =
    command.kind === 'PLACE'
      ? { case: 'place' as const, value: encodePlace(orderId, userId, command.spec) }
      : { case: 'cancel' as const, value: { orderId, userId } };
  return toBinary(
    OrderCommandSchema,
    create(OrderCommandSchema, { commandId, symbol, issuedAt, kind }),
  );
}

function encodePlace(orderId: string, userId: string, spec: OrderSpec): PlaceOrder {
  return create(PlaceOrderSchema, {
    orderId,
    userId,
    side: sideCodec.encode(spec.side),
    type: orderTypeCodec.encode(spec.type),
    timeInForce: timeInForceCodec.encode(timeInForceOf(spec)),
    price: optionalAmount(priceOf(spec)),
    quantity: optionalAmount(quantityOf(spec)),
    quoteQuantity: optionalAmount(quoteQuantityOf(spec)),
  });
}

export function decodeCommand(bytes: Uint8Array): MatcherCommand {
  const { commandId, symbol, issuedAt, kind } = fromBinary(OrderCommandSchema, bytes);
  const base = { commandId, symbol, issuedAt };
  switch (kind.case) {
    case 'place':
      return {
        ...base,
        kind: 'PLACE',
        orderId: kind.value.orderId,
        userId: kind.value.userId,
        spec: decodeSpec(symbol, kind.value),
      };
    case 'cancel':
      return { ...base, kind: 'CANCEL', orderId: kind.value.orderId, userId: kind.value.userId };
    default:
      throw new DecodeError(`Command ${commandId} has no kind`);
  }
}

function decodeSpec(symbol: string, place: PlaceOrder): OrderSpec {
  const side = sideCodec.decode(place.side);
  const type = orderTypeCodec.decode(place.type);
  const required = (value: string | undefined, field: string): bigint => {
    if (value === undefined) throw new DecodeError(`${type} ${side} order needs ${field}`);
    return parseAmount(value);
  };
  if (type === 'LIMIT') {
    return {
      type,
      symbol,
      side,
      timeInForce: timeInForceCodec.decode(place.timeInForce),
      price: required(place.price, 'price'),
      quantity: required(place.quantity, 'quantity'),
    };
  }
  return side === 'BUY'
    ? { type, symbol, side, quoteQuantity: required(place.quoteQuantity, 'quoteQuantity') }
    : { type, symbol, side, quantity: required(place.quantity, 'quantity') };
}

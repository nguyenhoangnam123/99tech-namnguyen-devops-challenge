import { DoneReason, FinalStatus, OrderType, Side, TimeInForce } from '@exchange/contracts';
import type * as core from '@exchange/core';

export class DecodeError extends Error {
  override readonly name = 'DecodeError';
}

// Two-way map between a core string union and a proto enum.
function enumCodec<C extends string, P extends number>(
  name: string,
  pairs: readonly (readonly [C, P])[],
) {
  const toProto = new Map<C, P>(pairs);
  const fromProto = new Map<P, C>(pairs.map(([c, p]) => [p, c]));
  return {
    encode(value: C): P {
      const encoded = toProto.get(value);
      if (encoded === undefined) throw new DecodeError(`Unknown ${name}: ${value}`);
      return encoded;
    },
    decode(value: P): C {
      const decoded = fromProto.get(value);
      if (decoded === undefined) throw new DecodeError(`Unknown ${name} value: ${String(value)}`);
      return decoded;
    },
  };
}

export const sideCodec = enumCodec<core.Side, Side>('side', [
  ['BUY', Side.BUY],
  ['SELL', Side.SELL],
]);

export const orderTypeCodec = enumCodec<core.OrderType, OrderType>('order type', [
  ['LIMIT', OrderType.LIMIT],
  ['MARKET', OrderType.MARKET],
]);

export const timeInForceCodec = enumCodec<core.TimeInForce, TimeInForce>('time in force', [
  ['GTC', TimeInForce.GTC],
  ['IOC', TimeInForce.IOC],
]);

export const finalStatusCodec = enumCodec<core.FinalStatus, FinalStatus>('final status', [
  ['FILLED', FinalStatus.FILLED],
  ['CANCELLED', FinalStatus.CANCELLED],
  ['EXPIRED', FinalStatus.EXPIRED],
]);

export const doneReasonCodec = enumCodec<core.DoneReason, DoneReason>('done reason', [
  ['FILLED', DoneReason.FILLED],
  ['USER_CANCEL', DoneReason.USER_CANCEL],
  ['IOC_REMAINDER', DoneReason.IOC_REMAINDER],
  ['SELF_TRADE', DoneReason.SELF_TRADE],
  ['NO_LIQUIDITY', DoneReason.NO_LIQUIDITY],
]);

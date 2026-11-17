import {
  create,
  fromBinary,
  type MatcherEvent as ProtoEvent,
  MatcherEventBatchSchema,
  MatcherEventSchema,
  toBinary,
} from '@exchange/contracts';
import { type MatcherEvent, formatAmount, parseAmount } from '@exchange/core';
import { DecodeError, doneReasonCodec, finalStatusCodec, sideCodec } from './enums.js';

export interface EventBatch {
  readonly commandId: string;
  readonly symbol: string;
  readonly events: readonly MatcherEvent[];
}

export function encodeEventBatch(batch: EventBatch): Uint8Array {
  return toBinary(
    MatcherEventBatchSchema,
    create(MatcherEventBatchSchema, {
      commandId: batch.commandId,
      symbol: batch.symbol,
      events: batch.events.map(encodeEvent),
    }),
  );
}

export function decodeEventBatch(bytes: Uint8Array): EventBatch {
  const batch = fromBinary(MatcherEventBatchSchema, bytes);
  return {
    commandId: batch.commandId,
    symbol: batch.symbol,
    events: batch.events.map((event) => decodeEvent(batch.symbol, event)),
  };
}

function encodeEvent(event: MatcherEvent): ProtoEvent {
  const { eventId } = event;
  switch (event.kind) {
    case 'TRADE':
      return create(MatcherEventSchema, {
        eventId,
        kind: {
          case: 'trade',
          value: {
            tradeId: eventId,
            price: formatAmount(event.price),
            quantity: formatAmount(event.quantity),
            takerSide: sideCodec.encode(event.takerSide),
            makerOrderId: event.makerOrderId,
            makerUserId: event.makerUserId,
            takerOrderId: event.takerOrderId,
            takerUserId: event.takerUserId,
            executedAt: event.executedAt,
          },
        },
      });
    case 'ORDER_DONE':
      return create(MatcherEventSchema, {
        eventId,
        kind: {
          case: 'orderDone',
          value: {
            orderId: event.orderId,
            userId: event.userId,
            status: finalStatusCodec.encode(event.status),
            reason: doneReasonCodec.encode(event.reason),
          },
        },
      });
    case 'CANCEL_REJECTED':
      return create(MatcherEventSchema, {
        eventId,
        kind: { case: 'cancelRejected', value: { orderId: event.orderId, userId: event.userId } },
      });
    case 'BOOK_LEVEL':
      return create(MatcherEventSchema, {
        eventId,
        kind: {
          case: 'bookLevel',
          value: {
            side: sideCodec.encode(event.side),
            price: formatAmount(event.price),
            quantity: formatAmount(event.quantity),
          },
        },
      });
  }
}

function decodeEvent(symbol: string, { eventId, kind }: ProtoEvent): MatcherEvent {
  switch (kind.case) {
    case 'trade':
      return {
        kind: 'TRADE',
        eventId,
        symbol,
        price: parseAmount(kind.value.price),
        quantity: parseAmount(kind.value.quantity),
        takerSide: sideCodec.decode(kind.value.takerSide),
        makerOrderId: kind.value.makerOrderId,
        makerUserId: kind.value.makerUserId,
        takerOrderId: kind.value.takerOrderId,
        takerUserId: kind.value.takerUserId,
        executedAt: kind.value.executedAt,
      };
    case 'orderDone':
      return {
        kind: 'ORDER_DONE',
        eventId,
        symbol,
        orderId: kind.value.orderId,
        userId: kind.value.userId,
        status: finalStatusCodec.decode(kind.value.status),
        reason: doneReasonCodec.decode(kind.value.reason),
      };
    case 'cancelRejected':
      return {
        kind: 'CANCEL_REJECTED',
        eventId,
        symbol,
        orderId: kind.value.orderId,
        userId: kind.value.userId,
      };
    case 'bookLevel':
      return {
        kind: 'BOOK_LEVEL',
        eventId,
        symbol,
        side: sideCodec.decode(kind.value.side),
        price: parseAmount(kind.value.price),
        quantity: parseAmount(kind.value.quantity),
      };
    default:
      throw new DecodeError(`Event ${eventId} has no kind`);
  }
}

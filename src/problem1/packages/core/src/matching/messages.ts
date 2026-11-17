import type { Amount } from '../money.js';
import type { DoneReason, FinalStatus, OrderSpec, Side } from '../orders.js';

interface CommandBase {
  readonly commandId: string;
  readonly symbol: string;
  readonly issuedAt: string;
  readonly orderId: string;
  readonly userId: string;
}

export interface PlaceCommand extends CommandBase {
  readonly kind: 'PLACE';
  readonly spec: OrderSpec;
}

export interface CancelCommand extends CommandBase {
  readonly kind: 'CANCEL';
}

export type MatcherCommand = PlaceCommand | CancelCommand;

export interface TradeEvent {
  readonly kind: 'TRADE';
  readonly eventId: string;
  readonly symbol: string;
  readonly price: Amount;
  readonly quantity: Amount;
  readonly takerSide: Side;
  readonly makerOrderId: string;
  readonly makerUserId: string;
  readonly takerOrderId: string;
  readonly takerUserId: string;
  readonly executedAt: string;
}

export interface OrderDoneEvent {
  readonly kind: 'ORDER_DONE';
  readonly eventId: string;
  readonly symbol: string;
  readonly orderId: string;
  readonly userId: string;
  readonly status: FinalStatus;
  readonly reason: DoneReason;
}

export interface CancelRejectedEvent {
  readonly kind: 'CANCEL_REJECTED';
  readonly eventId: string;
  readonly symbol: string;
  readonly orderId: string;
  readonly userId: string;
}

// Absolute size of one price level after the command.
export interface BookLevelEvent {
  readonly kind: 'BOOK_LEVEL';
  readonly eventId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly price: Amount;
  readonly quantity: Amount;
}

export type MatcherEvent = TradeEvent | OrderDoneEvent | CancelRejectedEvent | BookLevelEvent;

// The trade id is its event id, so replays reproduce it exactly.
export const tradeIdOf = (event: TradeEvent): string => event.eventId;

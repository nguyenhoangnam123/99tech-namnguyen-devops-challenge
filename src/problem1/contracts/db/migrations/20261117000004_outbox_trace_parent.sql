-- migrate:up
-- W3C traceparent of the request that wrote the row, so one trace runs
-- from the API through the relay, the matcher and settlement.
alter table outbox add column trace_parent text;

-- migrate:down
alter table outbox drop column trace_parent;

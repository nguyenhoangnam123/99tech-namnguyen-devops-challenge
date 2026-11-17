-- migrate:up
-- Row triggers do not fire on TRUNCATE; block it separately.
create trigger journal_entries_no_truncate
  before truncate on journal_entries
  for each statement execute function reject_journal_mutation();

-- migrate:down
drop trigger journal_entries_no_truncate on journal_entries;

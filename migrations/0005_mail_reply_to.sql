-- The local dev mailbox keeps a message's Reply-To (inbound replies are relayed to staff with Reply-To = the customer).
-- Column add only: backward compatible.
ALTER TABLE dev_mailbox ADD COLUMN reply_to TEXT;

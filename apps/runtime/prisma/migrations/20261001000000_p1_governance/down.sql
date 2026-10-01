-- Reverses p1_governance. Run only after a pg_dump: this drops every approval,
-- policy row, proposal and audit entry. It also removes its own row from
-- _prisma_migrations, so the next `prisma migrate deploy` applies it again.
-- (`prisma migrate resolve --rolled-back` refuses a migration that applied
-- successfully, so it cannot do that part.)
DROP VIEW IF EXISTS audit_open_intents;
DROP TABLE IF EXISTS "RowChange", "AuditRollup", "AuditEntry", "Proposal", "ActionCounter", "ActionPolicy", "Approval", "ApprovalCredential" CASCADE;
DROP SCHEMA IF EXISTS flint_part CASCADE;
DROP FUNCTION IF EXISTS audit_insert_guard(), guard_append_only(), approval_consume_once(), approval_insert_check(), approval_credential_guard(),
  proposal_insert_check(), proposal_transition(), action_policy_matches_approval(), action_policy_update_guard(), row_history(),
  consume_approval(text, text, text, text, text, text), claim_action(text, text, integer), ensure_partitions(integer),
  drop_audit_partition(text, text) CASCADE;
DO $$
BEGIN
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    DELETE FROM _prisma_migrations WHERE migration_name = '20261001000000_p1_governance';
  END IF;
END;
$$;

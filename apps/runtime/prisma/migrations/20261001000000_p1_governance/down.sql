-- Reverses p1_governance. Run only after a pg_dump: this drops every approval,
-- policy row, proposal and audit entry. Follow with
--   prisma migrate resolve --rolled-back 20261001000000_p1_governance
DROP VIEW IF EXISTS audit_open_intents;
DROP TABLE IF EXISTS "RowChange", "AuditRollup", "AuditEntry", "Proposal", "ActionCounter", "ActionPolicy", "Approval", "ApprovalCredential" CASCADE;
DROP SCHEMA IF EXISTS flint_part CASCADE;
DROP FUNCTION IF EXISTS guard_append_only(), approval_consume_once(), approval_insert_check(), approval_credential_guard(),
  proposal_insert_check(), proposal_transition(), action_policy_matches_approval(), action_policy_update_guard(), row_history(),
  consume_approval(text, text, text, text, text, text), claim_action(text, text, integer), ensure_partitions(integer),
  drop_audit_partition(text, text) CASCADE;

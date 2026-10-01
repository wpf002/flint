import { describe, it, expect } from 'vitest';
import { isSafeTool } from '../src/tool-safety';

// Moved from apps/server/test/policy.test.ts with isSafeTool itself.
describe('isSafeTool — auto-approval gate', () => {
  it('auto-approves genuine reads', () => {
    for (const t of [
      'gmail.search_threads',
      'gcal.list_events',
      'vantage.get_score',
      'bellwether.digest',
      'meridian.bias_for_ticker',
      'crossbar.get_positions',
      'hive.list_orders',
      'prophet.forecast',
      'web.web_search',
    ]) {
      expect(isSafeTool(t), `${t} should auto-approve`).toBe(true);
    }
  });

  it('auto-approves Flint writing to his own memory', () => {
    expect(isSafeTool('remember')).toBe(true);
  });

  // THE money rule: Flint observes and reports, he never trades or moves money.
  // Every name below used to slip through the old read-verb regex.
  it('NEVER auto-approves execution or money movement', () => {
    for (const t of [
      'execute_trade',
      'submit_order',
      'close_position',
      'liquidate_position',
      'modify_order',
      'cancel_order',
      'place_order',
      'buy_shares',
      'sell_shares',
      'transfer_funds',
      'withdraw_balance',
      'deposit_funds',
      'wire_payment',
      'pay_invoice',
      'crossbar.execute_trade',
      'hive.submit_order',
      'bloomberg.close_position',
    ]) {
      expect(isSafeTool(t), `${t} must NOT auto-approve`).toBe(false);
    }
  });

  it('does not auto-approve other consequential actions', () => {
    for (const t of [
      'gmail.send_message',
      'gmail.trash_message',
      'gcal.create_event',
      'gcal.delete_event',
      'gdrive.share_file',
      'archive_account',
      'terminate_worker',
      'restart_bot',
      'deploy_service',
      'revoke_grant',
    ]) {
      expect(isSafeTool(t), `${t} must NOT auto-approve`).toBe(false);
    }
  });

  it('denies by default — an unrecognised name never auto-runs', () => {
    for (const t of ['frobnicate', 'do_the_thing', '', 'xyzzy.qux']) {
      expect(isSafeTool(t)).toBe(false);
    }
  });

  // REGRESSION GUARD. The first attempt at this fix was a blocklist: it denied
  // close_position but allowed open_position, denied submit_order but allowed
  // new_order. Every name below leaked through that version. A blocklist of
  // verbs guarding an allowlist of nouns is not deny-by-default.
  it('denies the MIRRORS of the blocked names, not just the blocked names', () => {
    for (const t of [
      'open_position', 'exit_position', 'flatten_position', 'reduce_position',
      'new_order', 'limit_order', 'market_order', 'fill_order', 'amend_order',
      'stop_order', 'bracket_order',
      'place_trade', 'trade', 'settle_trade', 'reverse_trade',
      'fund_account', 'sweep_account', 'link_account', 'debit_account',
      'move_funds', 'rebalance', 'allocate_capital', 'short_stock',
    ]) {
      expect(isSafeTool(t), `${t} must NOT auto-approve`).toBe(false);
    }
  });

  // REGRESSION GUARD (2026-09-26). Each of these carried a read segment
  // (load / check / report / top / read) next to an action and auto-approved.
  it('a read segment does not launder a write or a money move', () => {
    for (const t of [
      'bank.load_funds',
      'load_card',
      'wallet.top_up',
      'topup_balance',
      'bot.check_and_rebalance',
      'get_and_send',
      'fetch_then_delete',
      'check_in',
      'check_out',
      'store.checkout',
      'gmail.report_spam',
      'report_user',
      'gmail.mark_read',
      'gmail.mark_as_read',
      'list_refunds_and_issue',
      'get_payout',
      'view_invoice_and_pay',
      'recent_bets',
      'best_swap',
      'latest_stake',
      'bloomberg.orders',
      'fill_order',
    ]) {
      expect(isSafeTool(t), `${t} must NOT auto-approve`).toBe(false);
    }
  });

  it('still auto-approves reads of trading data in <read>_<noun> shape', () => {
    for (const t of [
      'crossbar.get_positions',
      'hive.list_orders',
      'crossbar.recent_trades',
      'bloomberg.get_balance',
      'vantage.top_scores',
      'bellwether.latest_digest',
      'get_market_status',
    ]) {
      expect(isSafeTool(t), `${t} should auto-approve`).toBe(true);
    }
  });

  it('a dangerous word in the NAMESPACE is caught too', () => {
    expect(isSafeTool('execute.trade')).toBe(false);
    expect(isSafeTool('broker.buy')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { judgeBrain, isSafeTool } from '../src/policy';

describe('judgeBrain', () => {
  it('falls back to local when no frontier is configured', () => {
    expect(judgeBrain('anything at all', false, false)).toBe('local');
  });

  it('defaults to the frontier brain', () => {
    expect(judgeBrain('what happened in the market today?', true, false)).toBe('frontier');
  });

  // The privacy switch. It was ignored for a while; a control that lies is worse
  // than no control, so this is the regression guard.
  it('HONORS the Local-only toggle', () => {
    expect(judgeBrain('summarize this private document', true, true)).toBe('local');
  });

  it('honors plain-language local requests', () => {
    for (const msg of ['stay local please', 'keep this private', 'answer on-device']) {
      expect(judgeBrain(msg, true, false)).toBe('local');
    }
  });
});

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

  it('a dangerous word in the NAMESPACE is caught too', () => {
    expect(isSafeTool('execute.trade')).toBe(false);
    expect(isSafeTool('broker.buy')).toBe(false);
  });
});

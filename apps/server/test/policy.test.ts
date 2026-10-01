import { describe, it, expect } from 'vitest';
import { judgeBrain, isSafeTool, routeTurn } from '../src/policy';
import { ActionQueue } from '../src/actions';

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

describe('routeTurn (attachments)', () => {
  const base = { message: 'what is in this?', hasFrontier: true, localOnly: false, frontierCan: { image: true, pdf: true } };

  it('routes a plain turn exactly like judgeBrain, with local fallback allowed', () => {
    expect(routeTurn({ ...base, needs: {} })).toEqual({ brain: 'frontier', localFallback: true });
    expect(routeTurn({ ...base, localOnly: true, needs: {} })).toEqual({ brain: 'local', localFallback: true });
    expect(routeTurn({ ...base, hasFrontier: false, needs: {} })).toEqual({ brain: 'local', localFallback: true });
  });

  it('sends image and PDF turns to the frontier, with NO silent local fallback', () => {
    expect(routeTurn({ ...base, needs: { image: true } })).toEqual({ brain: 'frontier', localFallback: false });
    expect(routeTurn({ ...base, needs: { pdf: true } })).toEqual({ brain: 'frontier', localFallback: false });
  });

  it('refuses rather than answering blind when there is no frontier', () => {
    const r = routeTurn({ ...base, hasFrontier: false, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/no frontier brain/);
  });

  // Privacy wins: Local-only must never be overridden by an attachment.
  it('HONORS Local-only: an image is refused, not shipped off-device', () => {
    const r = routeTurn({ ...base, localOnly: true, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/Local-only is on/);
    const r2 = routeTurn({ ...base, message: 'keep this private: what is this?', needs: { pdf: true } });
    expect(r2).toHaveProperty('error');
  });

  it('refuses when the configured frontier cannot read the file type', () => {
    const r = routeTurn({ ...base, frontierCan: {}, needs: { image: true } });
    expect((r as { error: string }).error).toMatch(/can't read images/);
    const r2 = routeTurn({ ...base, frontierCan: { image: true }, needs: { image: true, pdf: true } });
    expect(r2).toHaveProperty('error');
  });
});

// The audit found the approver handing isSafeTool the bare tool name, so a
// dangerous word in the server namespace (`execute.trade`) was never seen.
describe('ActionQueue approver — judges the full server.tool name', () => {
  const req = (server: string, tool: string) => ({ server, tool, args: {}, safety: 'guarded' as const, destructive: false });

  it('denies a read-shaped tool on a server whose name is an action', () => {
    const q = new ActionQueue(isSafeTool);
    expect(isSafeTool('list_items')).toBe(true); // the bare name alone looks safe
    expect(q.approver(req('execute', 'list_items'))).toBe(false);
    expect(q.list().map((p) => p.fullName)).toEqual(['execute.list_items']);
  });

  it('still runs a read on an ordinary server without approval', () => {
    const q = new ActionQueue(isSafeTool);
    expect(q.approver(req('trident', 'gdrive_search'))).toBe(true);
    expect(q.list()).toEqual([]);
  });

  it('passes the name it judged to isSafe', () => {
    const seen: string[] = [];
    new ActionQueue((t) => (seen.push(t), false)).approver(req('nexus', 'thread_append'));
    expect(seen).toEqual(['nexus.thread_append']);
  });
});


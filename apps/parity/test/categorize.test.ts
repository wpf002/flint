import { describe, it, expect } from 'vitest';
import { categorize } from '../src/categorize.js';

const t = (input: string, tools: string[] = []) => categorize({ input, tools: tools.map((tool) => ({ tool })) });

describe('categorize', () => {
  it('trusts the tools the original turn used over the wording', () => {
    expect(t('anything new?', ['bellwether.recent_signals'])).toBe('finance-systems');
    expect(t('what do I have going on', ['trident.gcal_upcoming'])).toBe('email-calendar-drive');
    expect(t('Tell me who are the top pitmasters in the U.S.A.', ['web.web_search'])).toBe('research');
  });

  it("tags Will's own systems by name", () => {
    expect(t("What's the Vantage score for NVDA?")).toBe('finance-systems');
    expect(t('Summarize my watchlists')).toBe('finance-systems');
    expect(t('Any unread emails from Tanner?')).toBe('email-calendar-drive');
    expect(t("What's on my calendar tomorrow?")).toBe('email-calendar-drive');
  });

  it('keeps textbook finance out of the finance-systems bucket', () => {
    expect(t('What is the difference between historical VaR and Monte Carlo VaR in tail risk estimation?')).toBe('knowledge');
    expect(t('How does modern portfolio theory handle correlated assets?')).toBe('knowledge');
  });

  it('spots coding asks without catching "function of mitochondria"', () => {
    expect(t('Why does this TypeScript narrowing fail on a union?')).toBe('coding');
    expect(t("I'm thinking about rewriting the whole trading stack in Rust this weekend. Thoughts?")).toBe('coding');
    expect(t('What is the function of mitochondria in a cell?')).toBe('knowledge');
  });

  it('tags live lookups as research', () => {
    expect(t('Who do you think will win UFC 329?')).toBe('research');
    expect(t('What are the current MLB rankings?')).toBe('research');
    expect(t("What's the weather in Dallas today?")).toBe('research');
  });

  it('tags imperatives to write or plan as planning-writing', () => {
    expect(t('Draft a short note to my landlord about the leak')).toBe('planning-writing');
    expect(t('Plan a 3-day itinerary for Austin')).toBe('planning-writing');
  });

  it("doesn't call a seeded textbook question research just because the teacher searched", () => {
    const q = 'What caused the sudden collapse of the Bronze Age civilizations around 1200 BCE?';
    expect(categorize({ input: q, tools: [{ tool: 'web.web_search' }], synthetic: true })).toBe('knowledge');
    expect(categorize({ input: q, tools: [{ tool: 'web.web_search' }] })).toBe('research');
  });

  it('tags explanatory questions as knowledge, including generic "you"', () => {
    expect(t('Explain the birthday paradox.')).toBe('knowledge');
    expect(t('How do you design a retry strategy that avoids amplifying load downstream?')).toBe('knowledge');
    expect(t('Roth IRA vs traditional IRA — how to choose?')).toBe('knowledge');
    expect(t('should I use postgres or mongodb for a financial ledger?')).toBe('knowledge');
  });

  it('falls back to chit-chat', () => {
    expect(t("What's my dog's name?")).toBe('chit-chat');
    expect(t('Are you Claude?')).toBe('chit-chat');
    expect(t('Say hello to my friends.')).toBe('chit-chat');
  });
});

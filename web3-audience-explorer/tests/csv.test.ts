import { describe, expect, it } from 'vitest';
import { csvText, importCSV, parseCSV } from '../src/csv';
import { filterAccounts, fromSorsa } from '../src/model';

describe('CSV and filters', () => {
  it('exports UTF-8 BOM, quoted multiline fields and neutralizes spreadsheet formulas', () => {
    const account = fromSorsa({ id: '1', username: 'alice', display_name: '=HYPERLINK("evil")',
      followers_count: 500, description: 'line one\nline two, "quoted"' }, 'one', 'followers')!;
    const csv = csvText([account]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\'=HYPERLINK(""evil"")"');
    expect(parseCSV(csv)).toHaveLength(2);
    expect(parseCSV(csv)[1]?.[9]).toBe('line one\nline two, "quoted"');
  });
  it('round trips tags and known scores while leaving unsupported API fields empty', () => {
    const account = fromSorsa({ id: '1', username: 'alice', followers_count: 42 }, 'one', 'followers')!;
    account.tags = ['DeFi', 'whale']; account.score = 1.25;
    const imported = importCSV(csvText([account]), 'two');
    expect(imported).toHaveLength(1);
    expect(imported[0]?.score).toBe(1.25);
    expect(imported[0]?.tags).toEqual(['DeFi', 'whale']);
    expect(imported[0]?.category).toBeNull();
    expect(imported[0]?.firstSeen).toBeNull();
  });
  it('imports optional category and first-seen only if supplied by a CSV', () => {
    const imported = importCSV('username,category,first_seen,tags\nALICE,Project,2026-10-01T00:00:00Z,DeFi', 'i');
    expect(imported[0]?.category).toBe('Project');
    expect(imported[0]?.firstSeen).toBe('2026-10-01T00:00:00Z');
    expect(imported[0]?.source).toBe('import');
  });
  it('deduplicates and filters on values only when present', () => {
    const a = fromSorsa({ id: '1', username: 'alice', followers_count: 42, description: 'Lending protocol' }, 'one', 'followers')!;
    const b = fromSorsa({ id: '2', username: 'bob' }, 'one', 'followers')!;
    a.tags = ['DeFi']; a.score = 2;
    expect(filterAccounts([a, b], { minFollowers: 40, minScore: 1, tag: 'defi', keyword: 'lending' })).toEqual([a]);
    expect(filterAccounts([a, b], { minScore: 1 })).toEqual([a]);
    expect(filterAccounts([a, b], { maxFollowers: 100 })).toEqual([a]);
  });
});

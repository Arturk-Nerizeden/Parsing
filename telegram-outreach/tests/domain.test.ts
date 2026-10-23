import { describe, expect, it, vi } from 'vitest';
import { createCampaign, exportCampaignCSV, normalizeUsername, parseContacts, renderMessage } from '../src/domain';

const contact = { username: 'alice', firstName: 'Alice' };

describe('Telegram usernames', () => {
  it.each(['Alice', ' @ALICE ', 'https://t.me/ALIce', 'https://telegram.me/Alice/', 't.me/Alice'])
    ('normalizes %s', (input) => expect(normalizeUsername(input)).toBe('alice'));

  it('accepts short collectible usernames and the maximum length', () => {
    expect(normalizeUsername('@a')).toBe('a');
    expect(normalizeUsername('a'.repeat(32))).toHaveLength(32);
  });

  it.each([
    '', '@', '@@alice', '1alice', '_alice', 'alice-name', 'a'.repeat(33), 'алиса',
    'https://t.me/+invite', 'https://t.me/joinchat', 'https://t.me/joinchat/invite',
    'https://t.me/c/123/4', 'https://t.me/s/alice', 'https://t.me/alice/123',
    'https://t.me/share', 'https://t.me/alice?start=bot', 'https://t.me/alice#fragment',
    'https://evil.example/alice', 'https://alice@t.me/bob', 'https://t.me:8080/alice',
    'https://t.me/%61lice', 'https://t.me//alice',
  ])('rejects non-user input %s', (input) => expect(() => normalizeUsername(input)).toThrow());
});

describe('contact imports', () => {
  it('splits pasted lists and reports invalid entries and case-insensitive duplicates', () => {
    expect(parseContacts('\uFEFF@Alice\nhttps://t.me/ALICE bob;@c,not-a-user\t@D')).toEqual({
      contacts: [
        { username: 'alice', firstName: '' }, { username: 'bob', firstName: '' },
        { username: 'c', firstName: '' }, { username: 'd', firstName: '' },
      ], duplicates: 1, invalid: ['not-a-user'],
    });
  });

  it('reads BOM, case-insensitive headers, Unicode, commas, escaped quotes, and quoted newlines', () => {
    const result = parseContacts('\uFEFFTeLeGrAm_UsErNaMe,DISPLAY_NAME,notes\r\n'
      + '"@Alice","Алиса, ""А""\r\nВторая строка",ignored\r\n'
      + 'https://telegram.me/BOB,Боб,ignored\r\n', 'csv');
    expect(result).toEqual({ contacts: [
      { username: 'alice', firstName: 'Алиса, "А"\r\nВторая строка' },
      { username: 'bob', firstName: 'Боб' },
    ], duplicates: 0, invalid: [] });
  });

  it.each(['username', 'telegram', 'telegram_username'])('supports the %s collector header', (header) => {
    expect(parseContacts(`${header},name\nalice, Alice `, 'csv').contacts).toEqual([contact]);
  });

  it('prefers first_name over display_name and name when present', () => {
    expect(parseContacts('name,display_name,first_name,username\nDisplay,Other,Alice,alice', 'csv')
      .contacts).toEqual([contact]);
  });

  it('imports distinct tags and carries them through the queue and CSV export', () => {
    const parsed = parseContacts('username,first_name,tags\nalice,Alice,"partners, event;partners"', 'csv');
    expect(parsed.contacts).toEqual([{ username: 'alice', firstName: 'Alice', tags: ['partners', 'event'] }]);
    const campaign = createCampaign(parsed.contacts, 'Hello', 30);
    expect(campaign.recipients[0]?.tags).toEqual(['partners', 'event']);
    expect(exportCampaignCSV(campaign)).toContain('"partners, event"');
  });

  it('keeps the first duplicate row and reports missing or bad usernames', () => {
    expect(parseContacts('username,first_name\nalice,Alice\nALICE,Other\n,Bob\nbad-name,Name', 'csv'))
      .toEqual({ contacts: [contact], duplicates: 1, invalid: ['CSV row 4: missing username', 'bad-name'] });
  });

  it.each(['', '\uFEFF', '\n\r\n', '  \n '])('returns an empty import for blank input', (input) => {
    expect(parseContacts(input)).toEqual({ contacts: [], duplicates: 0, invalid: [] });
    expect(parseContacts(input, 'csv')).toEqual({ contacts: [], duplicates: 0, invalid: [] });
  });

  it.each([
    'username,name\nalice,"unclosed',
    'username,name\nalice,"Alice"extra',
    'username,name\nalice,Al"ice',
    'username,name\nalice',
    'username,name\nalice,Alice,extra',
    'other,name\nalice,Alice',
    'username,telegram\nalice,bob',
  ])('rejects malformed or ambiguous CSV without partial imports', (input) => {
    expect(() => parseContacts(input, 'csv')).toThrow();
  });

  it('rejects contact lists above the limit instead of truncating them', () => {
    const usernames = Array.from({ length: 1001 }, (_, index) => `user${index}`);
    expect(() => parseContacts(usernames.join('\n'))).toThrow(/1000/);
    expect(() => parseContacts(`username\n${usernames.join('\n')}`, 'csv')).toThrow(/1000/);
    expect(parseContacts(usernames.slice(0, 1000).join('\n')).contacts).toHaveLength(1000);
  });
});

describe('message templates', () => {
  it('renders every occurrence and uses an @handle for a missing first name', () => {
    expect(renderMessage('Hello {{first_name}}: {{username}} {{username}}', contact))
      .toBe('Hello Alice: @alice @alice');
    expect(renderMessage('Hello {{first_name}}', { username: '@BOB', firstName: ' ' })).toBe('Hello @bob');
  });

  it('preserves literal replacement syntax and does not interpret placeholders inside contact names', () => {
    expect(renderMessage('{{first_name}}', { ...contact, firstName: '$& {{unknown}}' }))
      .toBe('$& {{unknown}}');
  });

  it.each(['', ' \n ', '{{surname}}', '{{ username }}', '{{username}', '{{username}} }}'])
    ('rejects empty or unsupported template %s', (template) => expect(() => renderMessage(template, contact)).toThrow());

  it('enforces the limit after substitution in UTF-16 code units', () => {
    expect(renderMessage('a'.repeat(4096), contact)).toHaveLength(4096);
    expect(() => renderMessage('a'.repeat(4097), contact)).toThrow(/4096/);
    expect(renderMessage('😀'.repeat(2048), contact)).toHaveLength(4096);
    expect(() => renderMessage('😀'.repeat(2048) + 'a', contact)).toThrow(/4096/);
    expect(() => renderMessage('{{first_name}}', { ...contact, firstName: 'a'.repeat(4097) })).toThrow(/4096/);
  });
});

describe('campaign creation and export', () => {
  it('creates independent pending recipients with unique signed 64-bit retry IDs', () => {
    const contacts = [contact, { username: 'b', firstName: '' }];
    const campaign = createCampaign(contacts, 'Hello {{first_name}}', 30);
    expect(campaign).toMatchObject({ status: 'draft', senderId: null, waitUntil: null, intervalSeconds: 30 });
    expect(campaign.createdAt).toBe(campaign.updatedAt);
    expect(campaign.recipients).toHaveLength(2);
    expect(new Set(campaign.recipients.map((row) => row.id)).size).toBe(2);
    expect(new Set(campaign.recipients.map((row) => row.randomId)).size).toBe(2);
    for (const recipient of campaign.recipients) {
      expect(recipient.status).toBe('pending');
      const randomId = BigInt(recipient.randomId);
      expect(randomId).not.toBe(0n);
      expect(randomId).toBeGreaterThanOrEqual(-(1n << 63n));
      expect(randomId).toBeLessThan(1n << 63n);
    }
    campaign.recipients[0]!.firstName = 'Changed';
    expect(contacts[0]!.firstName).toBe('Alice');
  });

  it('retries zero and colliding random IDs while preserving signed precision', () => {
    const words = [[0, 0], [0xffffffff, 0xffffffff], [0xffffffff, 0xffffffff], [0x80000000, 0]];
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint32Array).set(words.shift()!);
      return array;
    });
    try {
      const campaign = createCampaign([contact, { username: 'bob', firstName: '' }], 'Hello', 1);
      expect(campaign.recipients.map((row) => row.randomId)).toEqual(['-1', '-9223372036854775808']);
      expect(spy).toHaveBeenCalledTimes(4);
    } finally { spy.mockRestore(); }
  });

  it.each([0, -1, NaN, Infinity, 3601])('rejects invalid sending interval %s', (interval) => {
    expect(() => createCampaign([contact], 'Hello', interval)).toThrow(/interval/);
  });

  it('rejects empty lists, repeated recipients, and invalid messages before creating a campaign', () => {
    expect(() => createCampaign([], 'Hello', 30)).toThrow();
    expect(() => createCampaign([contact, { ...contact, username: '@ALICE' }], 'Hello', 30)).toThrow(/Duplicate/);
    expect(() => createCampaign([contact], '{{unknown}}', 30)).toThrow();
    expect(() => createCampaign([contact], '', 30)).toThrow();
  });

  it('exports a BOM, CRLF, all report fields, quoted text, and the recorded sent message', () => {
    const campaign = createCampaign([contact], 'New template', 30);
    Object.assign(campaign.recipients[0]!, {
      status: 'sent', messageId: '1234567890123456789', sentAt: '2026-01-02T03:04:05Z',
      text: 'Original, "message"\nSecond line', error: '',
    });
    const csv = exportCampaignCSV(campaign);
    expect(csv).toBe('\uFEFF"username","first_name","tags","status","error","message_id","sent_at","message"\r\n'
      + '"alice","Alice","","sent","","1234567890123456789","2026-01-02T03:04:05Z","Original, ""message""\nSecond line"\r\n');
    expect(parseContacts(csv, 'csv').contacts).toEqual([contact]);
  });

  it.each(['=HYPERLINK("https://example.com")', '+cmd', '-cmd', '@SUM(A1)', '  =SUM(1)', '\tplain', '\rplain', '\nplain'])
    ('neutralizes spreadsheet formula/control prefix %j in exported user fields', (unsafe) => {
      const campaign = createCampaign([{ username: 'alice', firstName: unsafe }], 'Hello', 30);
      campaign.recipients[0]!.firstName = unsafe;
      campaign.recipients[0]!.error = unsafe;
      campaign.recipients[0]!.text = unsafe;
      const csv = exportCampaignCSV(campaign);
      const escaped = unsafe.replace(/"/g, '""');
      expect(csv.split(`"'${escaped}"`)).toHaveLength(4);
    });
});

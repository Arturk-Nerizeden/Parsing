const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../extension/core.js');

test('normalizes public and collectible handles without guessing names', () => {
  assert.equal(Core.normalize('@Mixed_Name'), 'mixed_name');
  assert.equal(Core.normalize('Abcd'), 'abcd');
  for (const invalid of ['John Smith', '12345', 'abc', 'a'.repeat(33), '<script>', null]) assert.equal(Core.normalize(invalid), null);
});
test('handles public links, previews, posts and Telegram deep links', () => {
  for (const link of ['https://t.me/Some_user', 'http://telegram.me/Some_user/123',
    't.me/s/Some_user/5', 'tg://resolve?domain=Some_user&post=123']) assert.equal(Core.fromUrl(link), 'some_user');
});
test('rejects private/invite/system URLs and deceptive domains', () => {
  for (const link of ['https://t.me/+abcdef', 'https://t.me/c/123/4', 'https://t.me/joinchat/xyz',
    'https://t.me/addstickers/my_pack', 'https://t.me/share/url?url=abc', 'https://t.me.evil.test/alice',
    'https://evil.test/t.me/alice', 'https://t.me@evil.test/alice', 'https://t.me:8080/alice',
    'javascript:alert(1)', 'tg://user?id=123']) assert.equal(Core.fromUrl(link), null, link);
});
test('finds mentions but not email, partial, Unicode-adjacent or oversized handles', () => {
  const found = Core.extract('Привет, @Alice_One! foo@domain.test @@wrong_name @hello_123 @' + 'a'.repeat(33) + ' ё@bad_name @bad_nameя');
  assert.deepEqual(found, [{ username: 'alice_one', kind: 'mention' }, { username: 'hello_123', kind: 'mention' }]);
});
test('deduplicates links and preserves distinction from mentions', () => {
  assert.deepEqual(Core.extract('@Some_user @some_USER https://t.me/Some_user.', ['https://t.me/Some_user']), [
    { username: 'some_user', kind: 'mention' }, { username: 'some_user', kind: 'link' }
  ]);
  assert.deepEqual(Core.extract('https://evil.test/t.me/fake_user'), []);
});
test('merges usernames case-insensitively and does not recount virtualized messages', () => {
  const results = new Core.Results();
  results.add({ username: 'User_One', kind: 'author', peerId: '42' }, 'Chat', '-10:1');
  results.add({ username: 'user_one', kind: 'author', peerId: '42' }, 'Chat', '-10:1');
  results.add({ username: 'USER_ONE', kind: 'mention' }, 'Chat', '-10:2');
  const [row] = results.list();
  assert.equal(results.list().length, 1);
  assert.equal(row.occurrences, 2);
  assert.deepEqual(row.sources, ['author', 'mention']);
  assert.deepEqual(row.messageIds, ['-10:1', '-10:2']);
});
test('CSV quotes cells, handles Cyrillic and prevents spreadsheet formulas', () => {
  const results = new Core.Results();
  results.add({ username: 'user_name', kind: 'author' }, '=HYPERLINK("bad")\nРусский, чат', '1');
  const csv = Core.exportData(results.list(), 'csv');
  assert.ok(csv.startsWith('\uFEFFusername,'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")\nРусский, чат"'));
});
test('TXT and JSON export all matching rows, not the UI preview', () => {
  const results = new Core.Results();
  for (let i = 0; i < 125; i++) results.add({ username: `person_${i}`, kind: 'mention' }, 'Comments', String(i));
  assert.equal(Core.exportData(results.list(), 'txt').trim().split('\n').length, 125);
  assert.equal(JSON.parse(Core.exportData(results.list(), 'json')).length, 125);
});

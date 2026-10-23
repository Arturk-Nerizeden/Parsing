import { describe, expect, it, vi } from 'vitest';
import { recoverCampaign, runCampaign, type QueueOptions } from '../src/queue';
import { DeliveryError, type Campaign, type Peer, type TelegramGateway } from '../src/types';

const start = Date.parse('2026-10-23T12:00:00Z');
const peer = (username: string, id = username): Peer => ({
  id, accessHash: '1234567890123456789', username, firstName: 'Имя из Telegram',
});

function campaign(usernames = ['alice']): Campaign {
  return {
    id: 'campaign-1', title: 'Проверка', template: 'Привет, {{first_name}}! {{username}}',
    createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString(),
    senderId: null, status: 'draft', intervalSeconds: 2, waitUntil: null, notice: '',
    recipients: usernames.map((username, index) => ({
      id: `recipient-${index}`, username, firstName: index === 0 ? 'Анна' : '',
      randomId: String(9223372036854775800n + BigInt(index)), status: 'pending',
    })),
  };
}

function setup() {
  let clock = start;
  let suppressed: string[] = [];
  const controller = new AbortController();
  const saved: Campaign[] = [];
  const save = vi.fn(async (value: Campaign) => { saved.push(structuredClone(value)); });
  const gateway = {
    getSender: vi.fn(async () => ({ id: 'sender-1', label: '@sender' })),
    resolve: vi.fn(async (username: string) => peer(username)),
    send: vi.fn(async (_peer: Peer, _text: string, _randomId: string) => ({ messageId: '987' })),
  } satisfies TelegramGateway;
  const options = {
    signal: controller.signal,
    suppressed: () => suppressed,
    now: () => clock,
    sleep: vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) throw new Error('aborted');
      clock += milliseconds;
    }),
    onProgress: vi.fn(),
  } satisfies QueueOptions;
  return {
    gateway, options, controller, saved, save,
    advance: (milliseconds: number) => { clock += milliseconds; },
    suppress: (usernames: string[]) => { suppressed = usernames; },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe('persisted outgoing queue', () => {
  it('sends the saved photo with the personalized caption after the sending marker is durable', async () => {
    const h = setup();
    const photo = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const input = campaign();
    input.image = { name: 'picture.png', mimeType: 'image/png', size: photo.size };
    const sendPhoto = vi.fn(async (_peer: Peer, _caption: string, _randomId: string, _photo: Blob) => {
      expect(h.saved.at(-1)?.recipients[0]).toMatchObject({ status: 'sending', randomId: input.recipients[0]!.randomId });
      return { messageId: 'photo-100' };
    });
    const gateway = { ...h.gateway, sendPhoto };
    const result = await runCampaign(input, gateway, h.save, { ...h.options, loadPhoto: async () => photo });
    expect(result.recipients[0]).toMatchObject({ status: 'sent', messageId: 'photo-100' });
    expect(sendPhoto).toHaveBeenCalledWith(peer('alice'), 'Привет, Анна! @alice', input.recipients[0]!.randomId, photo);
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('stops a photo campaign if its saved image is missing', async () => {
    const h = setup();
    const input = campaign();
    input.image = { name: 'picture.png', mimeType: 'image/png', size: 100 };
    const gateway = { ...h.gateway, sendPhoto: vi.fn() };
    const result = await runCampaign(input, gateway, h.save, { ...h.options, loadPhoto: async () => null });
    expect(result.status).toBe('paused');
    expect(result.recipients[0]?.status).toBe('pending');
    expect(gateway.sendPhoto).not.toHaveBeenCalled();
    expect(gateway.resolve).not.toHaveBeenCalled();
  });
  it('binds the sender and saves exact peer, text and randomId before sending', async () => {
    const h = setup();
    const input = campaign();
    h.gateway.resolve.mockImplementation(async username => {
      expect(h.saved.at(-1)?.senderId).toBe('sender-1');
      return peer(username);
    });
    h.gateway.send.mockImplementation(async (resolvedPeer, text, randomId) => {
      const stored = h.saved.at(-1)?.recipients[0];
      expect(stored).toMatchObject({ status: 'sending', peer: resolvedPeer, text, randomId });
      expect(text).toBe('Привет, Анна! @alice');
      expect(randomId).toBe('9223372036854775800');
      return { messageId: '987' };
    });

    const result = await runCampaign(input, h.gateway, h.save, h.options);
    expect(result.status).toBe('complete');
    expect(result.recipients[0]).toMatchObject({ status: 'sent', messageId: '987', sentAt: new Date(start).toISOString() });
    expect(h.saved.at(-1)).toEqual(result);
    expect(input.recipients[0]?.status).toBe('pending');
    expect(input.senderId).toBeNull();
    expect(h.options.onProgress).toHaveBeenCalledTimes(h.save.mock.calls.length);
  });

  it('renders missing first names exactly like the imported-contact preview', async () => {
    const h = setup();
    const input = campaign();
    input.recipients[0]!.firstName = '';
    await runCampaign(input, h.gateway, h.save, h.options);
    expect(h.gateway.send.mock.calls[0]?.[1]).toBe('Привет, @alice! @alice');
  });

  it('recovers interrupted sending as review, resolving as pending, and never starts work', () => {
    const input = campaign(['alice', 'bob']);
    input.status = 'running';
    input.recipients[0]!.status = 'sending';
    input.recipients[1]!.status = 'resolving';
    const recovered = recoverCampaign(input);
    expect(recovered.status).toBe('paused');
    expect(recovered.recipients.map(row => row.status)).toEqual(['review', 'pending']);
    expect(input.recipients.map(row => row.status)).toEqual(['sending', 'resolving']);
  });

  it('never resends an unknown delivery when the campaign is resumed', async () => {
    const h = setup();
    h.gateway.send.mockRejectedValue(new Error('connection lost after dispatch'));
    const interrupted = await runCampaign(campaign(), h.gateway, h.save, h.options);
    expect(interrupted.status).toBe('paused');
    expect(interrupted.recipients[0]?.status).toBe('review');
    const resumed = await runCampaign(recoverCampaign(interrupted), h.gateway, h.save, h.options);
    expect(resumed.recipients[0]?.status).toBe('review');
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.gateway.getSender).toHaveBeenCalledTimes(1);
  });

  it('blocks a different Telegram sender before any resolution or sending', async () => {
    const h = setup();
    const input = campaign();
    input.senderId = 'original-sender';
    const result = await runCampaign(input, h.gateway, h.save, h.options);
    expect(result.status).toBe('paused');
    expect(result.senderId).toBe('original-sender');
    expect(h.gateway.resolve).not.toHaveBeenCalled();
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('persists flood waits and blocks every resume until the deadline', async () => {
    const h = setup();
    h.gateway.send.mockRejectedValueOnce(new DeliveryError('FLOOD_WAIT_90', 'wait', 90));
    const waiting = await runCampaign(campaign(), h.gateway, h.save, h.options);
    expect(waiting).toMatchObject({ status: 'waiting', waitUntil: start + 90_000 });
    expect(waiting.recipients[0]?.status).toBe('pending');

    h.advance(89_999);
    const stillWaiting = await runCampaign(recoverCampaign({ ...waiting, status: 'paused' }), h.gateway, h.save, h.options);
    expect(stillWaiting.status).toBe('waiting');
    expect(stillWaiting.waitUntil).toBe(start + 90_000);
    expect(h.gateway.getSender).toHaveBeenCalledTimes(1);
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    h.advance(1);
    const completed = await runCampaign(stillWaiting, h.gateway, h.save, h.options);
    expect(completed.status).toBe('complete');
    expect(completed.waitUntil).toBeNull();
    expect(h.gateway.send.mock.calls.map(call => call[2])).toEqual(['9223372036854775800', '9223372036854775800']);
  });

  it('also persists a flood wait while resolving a username', async () => {
    const h = setup();
    h.gateway.resolve.mockRejectedValueOnce(new DeliveryError('FLOOD_WAIT_12', 'wait', 12));
    const result = await runCampaign(campaign(), h.gateway, h.save, h.options);
    expect(result).toMatchObject({ status: 'waiting', waitUntil: start + 12_000 });
    expect(result.recipients[0]?.status).toBe('pending');
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it.each(['auth', 'restricted'] as const)('pauses explicit %s denials without marking an uncertain delivery', async kind => {
    const h = setup();
    h.gateway.send.mockRejectedValueOnce(new DeliveryError('RPC denial', kind));
    const result = await runCampaign(campaign(['alice', 'bob']), h.gateway, h.save, h.options);
    expect(result.status).toBe('paused');
    expect(result.recipients.map(row => row.status)).toEqual(['pending', 'pending']);
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
  });

  it('marks recipient RPC denials failed and continues at the configured interval', async () => {
    const h = setup();
    h.gateway.send.mockRejectedValueOnce(new DeliveryError('USER_PRIVACY_RESTRICTED', 'recipient'));
    const result = await runCampaign(campaign(['alice', 'bob']), h.gateway, h.save, h.options);
    expect(result.recipients.map(row => row.status)).toEqual(['failed', 'sent']);
    expect(result.status).toBe('paused');
    expect(h.options.sleep).toHaveBeenCalledWith(2000, h.controller.signal);
  });

  it('keeps a resolution network failure pending and stops without an immediate retry', async () => {
    const h = setup();
    h.gateway.resolve.mockRejectedValueOnce(new Error('network unavailable'));
    const result = await runCampaign(campaign(['alice', 'bob']), h.gateway, h.save, h.options);
    expect(result.status).toBe('paused');
    expect(result.recipients.map(row => row.status)).toEqual(['pending', 'pending']);
    expect(h.gateway.resolve).toHaveBeenCalledTimes(1);
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('waits for an in-flight send after abort, persists its success, and does not send the next row', async () => {
    const h = setup();
    const started = deferred<void>();
    const delivery = deferred<{ messageId: string }>();
    h.gateway.send.mockImplementation(async () => {
      started.resolve();
      return delivery.promise;
    });
    let finished = false;
    const running = runCampaign(campaign(['alice', 'bob']), h.gateway, h.save, h.options)
      .then(result => { finished = true; return result; });
    await started.promise;
    h.controller.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(h.saved.at(-1)?.recipients[0]?.status).toBe('sending');
    delivery.resolve({ messageId: 'late-success' });
    const result = await running;
    expect(result.status).toBe('paused');
    expect(result.recipients[0]).toMatchObject({ status: 'sent', messageId: 'late-success' });
    expect(result.recipients[1]?.status).toBe('pending');
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.saved.at(-1)).toEqual(result);
  });

  it('does not dispatch if aborted while the sending marker is being saved', async () => {
    const h = setup();
    h.save.mockImplementation(async value => {
      h.saved.push(structuredClone(value));
      if (value.recipients[0]?.status === 'sending') h.controller.abort();
    });
    const result = await runCampaign(campaign(), h.gateway, h.save, h.options);
    expect(result.status).toBe('paused');
    expect(result.recipients[0]?.status).toBe('pending');
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('skips suppressed usernames, self, and different usernames resolving to a sent user', async () => {
    const h = setup();
    h.suppress(['  @BLOCKED  ']);
    h.gateway.resolve.mockImplementation(async username => peer(username, username === 'alias' ? 'alice' : username === 'self' ? 'sender-1' : username));
    const result = await runCampaign(campaign(['alice', 'alias', 'self', 'blocked']), h.gateway, h.save, h.options);
    expect(result.recipients.map(row => row.status)).toEqual(['sent', 'skipped', 'skipped', 'skipped']);
    expect(result.status).toBe('complete');
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.gateway.resolve).not.toHaveBeenCalledWith('blocked');
  });

  it.each(['review', 'confirmed', 'sending'] as const)('reserves a user id from a previous %s row', async status => {
    const h = setup();
    const input = campaign(['alice', 'alias']);
    input.recipients[0] = { ...input.recipients[0]!, status, peer: peer('alice', 'same-id') };
    h.gateway.resolve.mockResolvedValue(peer('alias', 'same-id'));
    const result = await runCampaign(input, h.gateway, h.save, h.options);
    expect(result.recipients[1]?.status).toBe('skipped');
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('rechecks suppression after the durable sending marker is saved', async () => {
    const h = setup();
    h.save.mockImplementation(async value => {
      h.saved.push(structuredClone(value));
      if (value.recipients[0]?.status === 'sending') h.suppress(['alice']);
    });
    const result = await runCampaign(campaign(), h.gateway, h.save, h.options);
    expect(result.recipients[0]?.status).toBe('skipped');
    expect(h.gateway.send).not.toHaveBeenCalled();
  });

  it('prevents sending if storing the sending marker fails', async () => {
    const h = setup();
    h.save.mockImplementation(async value => {
      if (value.recipients[0]?.status === 'sending') throw new Error('storage failed');
      h.saved.push(structuredClone(value));
    });
    await expect(runCampaign(campaign(), h.gateway, h.save, h.options)).rejects.toThrow('storage failed');
    expect(h.gateway.send).not.toHaveBeenCalled();
    expect(recoverCampaign(h.saved.at(-1)!).recipients[0]?.status).toBe('pending');
  });

  it('leaves durable sending for manual review if saving a successful result fails', async () => {
    const h = setup();
    h.save.mockImplementation(async value => {
      if (value.recipients[0]?.status === 'sent') throw new Error('storage failed after send');
      h.saved.push(structuredClone(value));
    });
    await expect(runCampaign(campaign(), h.gateway, h.save, h.options)).rejects.toThrow('storage failed after send');
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(h.saved.at(-1)?.recipients[0]?.status).toBe('sending');
    const recovered = recoverCampaign(h.saved.at(-1)!);
    expect(recovered.recipients[0]?.status).toBe('review');
    await runCampaign(recovered, h.gateway, h.save, h.options);
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
  });

  it.each([[0, 1000], [999_999, 3_600_000]])('enforces interval bounds for configured %i seconds', async (configured, expectedDelay) => {
    const h = setup();
    const input = campaign(['alice', 'bob']);
    input.intervalSeconds = configured;
    const result = await runCampaign(input, h.gateway, h.save, h.options);
    expect(h.options.sleep).toHaveBeenCalledWith(expectedDelay, h.controller.signal);
    expect(result.intervalSeconds).toBe(expectedDelay / 1000);
  });

  it('preserves the remaining configured interval across resume', async () => {
    const h = setup();
    const input = campaign(['alice', 'bob']);
    input.status = 'paused';
    input.senderId = 'sender-1';
    input.recipients[0] = { ...input.recipients[0]!, status: 'sent', peer: peer('alice'), sentAt: new Date(start).toISOString() };
    h.advance(500);
    const result = await runCampaign(input, h.gateway, h.save, h.options);
    expect(h.options.sleep).toHaveBeenCalledWith(1500, h.controller.signal);
    expect(h.gateway.send).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('complete');
  });

  it('preserves the interval after an uncertain delivery when resuming another recipient', async () => {
    const h = setup();
    h.gateway.send.mockRejectedValueOnce(new Error('unknown delivery'));
    const paused = await runCampaign(campaign(['alice', 'bob']), h.gateway, h.save, h.options);
    expect(paused.recipients[0]?.status).toBe('review');
    expect(paused.lastAttemptAt).toBe(start);
    const resumed = await runCampaign(recoverCampaign(paused), h.gateway, h.save, h.options);
    expect(h.options.sleep).toHaveBeenCalledWith(2000, h.controller.signal);
    expect(resumed.recipients.map(row => row.status)).toEqual(['review', 'sent']);
    expect(h.gateway.send.mock.calls.map(call => call[0].username)).toEqual(['alice', 'bob']);
  });
});

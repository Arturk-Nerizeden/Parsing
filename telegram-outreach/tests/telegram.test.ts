import { describe, expect, it } from 'vitest';
import { tl } from '@mtcute/web';
import { TelegramConnection, translateTelegramError } from '../src/telegram';

describe('Telegram RPC errors', () => {
  it('turns the server wait into a durable queue deadline', () => {
    const error = tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' });
    expect(translateTelegramError(error)).toMatchObject({ kind: 'wait', waitSeconds: 45 });
    expect(translateTelegramError(new tl.RpcError(420, 'SLOWMODE_WAIT_20'))).toMatchObject({ kind: 'wait', waitSeconds: 20 });
  });
  it('does not treat a paid recipient or bad photo as a network retry', () => {
    expect(translateTelegramError(new tl.RpcError(400, 'ALLOW_PAYMENT_REQUIRED_10')).kind).toBe('recipient');
    expect(translateTelegramError(new tl.RpcError(400, 'IMAGE_PROCESS_FAILED')).kind).toBe('content');
  });
  it('requires a signed-in account before sending media', async () => {
    const connection = new TelegramConnection();
    await expect(connection.sendPhoto({ id: '1', accessHash: '2', username: 'alice', firstName: '' }, 'Hi', '42', new Blob(['x']))).rejects.toMatchObject({ kind: 'auth' });
  });
});

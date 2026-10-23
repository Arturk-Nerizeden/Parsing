import { BaseTelegramClient, Long, MemoryStorage, WebPlatform, WebSocketTransport, tl } from '@mtcute/web';
import { uploadFile } from '@mtcute/web/methods.js';
import { LogManager, readStringSession } from '@mtcute/web/utils.js';
import { DeliveryError, type Peer, type Sender, type SessionCredentials, type TelegramGateway } from './types';

const RPC_OPTIONS = { timeout: 30_000, maxRetryCount: 0, floodSleepThreshold: 0 };
const OPERATION_TIMEOUT = 45_000;

// The browser transport derives the address from this fixed DC ID map. It never
// uses the serverAddress/IP embedded in an imported session.
class TelegramOnlyTransport extends WebSocketTransport {
  override connect(dc: Parameters<WebSocketTransport['connect']>[0], signal: AbortSignal) {
    if (!Number.isInteger(dc.id) || dc.id < 1 || dc.id > 5 || dc.testMode) {
      throw new DeliveryError('The Telegram session contains an unsupported data center.', 'auth');
    }
    return super.connect(dc, signal);
  }
}

/** Translate only known error codes; raw errors can carry private RPC details. */
export function translateTelegramError(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  if (tl.RpcError.is(error)) {
    const code = error.text;
    if (/^(FLOOD_(?:PREMIUM_|TEST_PHONE_)?WAIT|SLOWMODE_WAIT)_/.test(code)) {
      const provided = (error as unknown as { seconds?: number }).seconds;
      const seconds = Number(provided ?? code.match(/_(\d+)$/)?.[1]);
      if (Number.isSafeInteger(seconds) && seconds > 0) {
        return new DeliveryError(`Telegram requires a wait of ${seconds} seconds.`, 'wait', seconds);
      }
      return new DeliveryError('Telegram limited this account. Stop and review the account in Telegram.', 'restricted');
    }
    if (['PEER_FLOOD', 'USER_RESTRICTED', 'USER_BANNED_IN_CHANNEL', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_DUPLICATED'].includes(code)) {
      return new DeliveryError('Telegram restricted this account or session. Stop and review it in Telegram.', 'restricted');
    }
    if (['PHOTO_INVALID', 'PHOTO_EXT_INVALID', 'PHOTO_INVALID_DIMENSIONS', 'IMAGE_PROCESS_FAILED', 'FILE_PARTS_INVALID', 'FILE_PART_INVALID', 'MEDIA_INVALID'].includes(code)) {
      return new DeliveryError('Telegram rejected the picture. Check the JPEG/PNG file before continuing.', 'content');
    }
    if (['PHONE_CODE_INVALID', 'PHONE_CODE_EMPTY'].includes(code)) {
      return new DeliveryError('The login code is incorrect. Start sign-in again.', 'auth');
    }
    if (code === 'PHONE_CODE_EXPIRED') return new DeliveryError('The login code expired. Start sign-in again.', 'auth');
    if (code === 'PASSWORD_HASH_INVALID') return new DeliveryError('The two-step verification password is incorrect.', 'auth');
    if (['PHONE_NUMBER_INVALID', 'PHONE_NUMBER_BANNED', 'API_ID_INVALID', 'API_ID_PUBLISHED_FLOOD'].includes(code)) {
      return new DeliveryError('Telegram rejected the phone number or API credentials. Check your account and my.telegram.org credentials.', 'auth');
    }
    if (error.code === 401 || ['SESSION_REVOKED', 'SESSION_EXPIRED', 'AUTH_KEY_UNREGISTERED'].includes(code)) {
      return new DeliveryError('The Telegram session is no longer authorized. Sign in again.', 'auth');
    }
    if (code.startsWith('ALLOW_PAYMENT_REQUIRED') || ['PAYMENT_REQUIRED', 'PREMIUM_ACCOUNT_REQUIRED', 'PRIVACY_PREMIUM_REQUIRED'].includes(code)) {
      return new DeliveryError('This recipient requires payment or Premium. No payment was authorized.', 'recipient');
    }
    if (['USERNAME_INVALID', 'USERNAME_NOT_OCCUPIED', 'USER_PRIVACY_RESTRICTED', 'USER_IS_BLOCKED', 'YOU_BLOCKED_USER', 'CHAT_WRITE_FORBIDDEN', 'CHAT_SEND_PHOTOS_FORBIDDEN', 'PEER_ID_INVALID', 'INPUT_USER_DEACTIVATED', 'MESSAGE_EMPTY', 'MESSAGE_TOO_LONG'].includes(code)) {
      return new DeliveryError('Telegram cannot deliver to this recipient. Check the username, privacy settings, and message.', 'recipient');
    }
  }
  return new DeliveryError('Telegram did not confirm the operation. Review the chat before retrying.', 'unknown');
}

function validateApi(apiId: number, apiHash: string): void {
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash)) {
    throw new DeliveryError('Enter a valid API ID and API hash from my.telegram.org.', 'auth');
  }
}

function senderFrom(user: tl.TypeUser): Sender {
  if (user._ !== 'user' || user.bot || user.deleted) {
    throw new DeliveryError('Sign in with an active personal Telegram account.', 'auth');
  }
  return { id: String(user.id), label: user.username ? `@${user.username}` : [user.firstName, user.lastName].filter(Boolean).join(' ') || String(user.id) };
}

export interface LoginInput { apiId: number; apiHash: string; phone: string }
export interface LoginPrompts { code(): Promise<string>; password(): Promise<string> }

export class TelegramConnection implements TelegramGateway {
  private client: BaseTelegramClient | null = null;
  private sender: Sender | null = null;
  private photoCache = new WeakMap<Blob, tl.TypeInputFile>();

  private createClient(apiId: number, apiHash: string): BaseTelegramClient {
    validateApi(apiId, apiHash);
    const platform = new WebPlatform();
    const logger = new LogManager('outreach', platform);
    logger.level = LogManager.OFF;
    logger.handler = () => {};
    const client = new BaseTelegramClient({
      apiId, apiHash, platform, logger, logLevel: LogManager.OFF,
      storage: new MemoryStorage(),
      transport: new TelegramOnlyTransport(),
      disableUpdates: true,
      updates: false,
      // The application queue owns waits and retry decisions.
      network: { middlewares: [] },
      initConnectionOptions: { deviceModel: 'Telegram Outreach extension', systemVersion: 'Chrome', appVersion: '1.0.0', langCode: 'en', systemLangCode: 'en' },
    });
    this.client = client;
    return client;
  }

  private requireClient(): BaseTelegramClient {
    if (!this.client || !this.sender) throw new DeliveryError('Sign in to Telegram first.', 'auth');
    return this.client;
  }

  /** Bound connection setup as well as the RPC; mtcute's RPC timer starts later. */
  private async bounded<T>(client: BaseTelegramClient, work: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      const stop = (message: string, kind: 'auth' | 'unknown') => {
        if (this.client === client) { this.client = null; this.sender = null; }
        void client.destroy().catch(() => {});
        reject(new DeliveryError(message, kind));
      };
      onAbort = () => stop('Sign-in was cancelled.', 'auth');
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => stop('Telegram did not respond in time. Review the chat before retrying.', 'unknown'), OPERATION_TIMEOUT);
    });
    try { return await Promise.race([work, cancelled]); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async login(input: LoginInput, prompts: LoginPrompts, signal?: AbortSignal): Promise<{ sender: Sender; credentials: SessionCredentials }> {
    await this.disconnect();
    validateApi(input.apiId, input.apiHash);
    const phone = input.phone.replace(/[\s()-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new DeliveryError('Enter your phone number with its country code, starting with +.', 'auth');
    if (signal?.aborted) throw new DeliveryError('Sign-in was cancelled.', 'auth');
    const client = this.createClient(input.apiId, input.apiHash);
    const options = { ...RPC_OPTIONS, abortSignal: signal };
    try {
      const sendCode = () => this.bounded(client, client.call({ _: 'auth.sendCode', phoneNumber: phone,
        apiId: input.apiId, apiHash: input.apiHash, settings: { _: 'codeSettings' } }, options), signal);
      let sent: Awaited<ReturnType<typeof sendCode>>;
      try { sent = await sendCode(); }
      catch (error) {
        const migration = tl.RpcError.is(error) && /^(?:PHONE|NETWORK|USER)_MIGRATE_/.test(error.text)
          ? Number((error as unknown as { newDc?: number }).newDc ?? error.text.match(/_(\d+)$/)?.[1]) : NaN;
        if (!Number.isInteger(migration) || migration < 1 || migration > 5) throw error;
        await this.bounded(client, client.changePrimaryDc(migration), signal);
        sent = await sendCode();
      }
      let authorization: tl.auth.TypeAuthorization;
      if (sent._ === 'auth.sentCodeSuccess') {
        authorization = sent.authorization;
      } else if (sent._ === 'auth.sentCodePaymentRequired') {
        throw new DeliveryError('Telegram requires payment for this login. Sign in using an official Telegram app.', 'auth');
      } else {
        const phoneCode = (await this.prompt(client, prompts.code(), signal)).trim();
        if (!phoneCode) throw new DeliveryError('Enter the login code from Telegram.', 'auth');
        try {
          authorization = await this.bounded(client, client.call({ _: 'auth.signIn', phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash, phoneCode }, options), signal);
        } catch (error) {
          if (!tl.RpcError.is(error, 'SESSION_PASSWORD_NEEDED')) throw error;
          const password = await this.prompt(client, prompts.password(), signal);
          if (!password) throw new DeliveryError('Enter your two-step verification password.', 'auth');
          const passwordInfo = await this.bounded(client, client.call({ _: 'account.getPassword' }, options), signal);
          const proof = await this.bounded(client, client.computeSrpParams(passwordInfo, password), signal);
          authorization = await this.bounded(client, client.call({ _: 'auth.checkPassword', password: proof }, options), signal);
        }
      }
      if (authorization._ !== 'auth.authorization') {
        throw new DeliveryError('This account needs registration. Create it in an official Telegram app first.', 'auth');
      }
      this.sender = senderFrom(authorization.user);
      await this.bounded(client, client.notifyLoggedIn(authorization), signal);
      const session = await client.exportSession();
      return { sender: { ...this.sender }, credentials: { apiId: input.apiId, apiHash: input.apiHash, session } };
    } catch (error) {
      await this.disconnect();
      throw translateTelegramError(error);
    }
  }

  // Human input has no deadline. Cancellation still tears down the connection.
  private async prompt(client: BaseTelegramClient, answer: Promise<string>, signal?: AbortSignal): Promise<string> {
    if (!signal) return answer;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        void client.destroy().catch(() => {});
        reject(new DeliveryError('Sign-in was cancelled.', 'auth'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([answer, cancelled]); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }

  async restore(credentials: SessionCredentials): Promise<Sender> {
    await this.disconnect();
    let session: ReturnType<typeof readStringSession>;
    try {
      validateApi(credentials.apiId, credentials.apiHash);
      if (typeof credentials.session !== 'string' || credentials.session.length > 2048) throw new Error();
      session = readStringSession(credentials.session);
      if (session.authKey.byteLength !== 256 || session.self?.isBot) throw new Error();
      for (const dc of [session.primaryDcs.main, session.primaryDcs.media]) {
        if (!Number.isInteger(dc.id) || dc.id < 1 || dc.id > 5 || dc.testMode) throw new Error();
      }
    } catch {
      throw new DeliveryError('The stored Telegram session is invalid. Sign in again.', 'auth');
    }
    const client = this.createClient(credentials.apiId, credentials.apiHash);
    try {
      await this.bounded(client, client.importSession(session));
      const users = await this.bounded(client, client.call({ _: 'users.getUsers', id: [{ _: 'inputUserSelf' }] }, RPC_OPTIONS));
      const user = users[0];
      if (!user) throw new DeliveryError('Telegram did not return the signed-in account.', 'auth');
      this.sender = senderFrom(user);
      return { ...this.sender };
    } catch (error) {
      await this.disconnect();
      throw translateTelegramError(error);
    }
  }

  async getSender(): Promise<Sender> {
    this.requireClient();
    return { ...this.sender! };
  }

  async resolve(username: string): Promise<Peer> {
    const client = this.requireClient();
    const normalized = username.replace(/^@/, '').toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) throw new DeliveryError('The Telegram username is invalid.', 'recipient');
    try {
      const result = await this.bounded(client, client.call({ _: 'contacts.resolveUsername', username: normalized }, RPC_OPTIONS));
      if (result.peer._ !== 'peerUser') throw new DeliveryError('This username belongs to a group or channel, not a person.', 'recipient');
      const resolvedId = result.peer.userId;
      const user = result.users.find((entry) => entry._ === 'user' && entry.id === resolvedId);
      if (!user || user._ !== 'user' || user.bot || user.deleted || user.min || !user.accessHash) {
        throw new DeliveryError('This username does not identify an available personal account.', 'recipient');
      }
      if (String(user.id) === this.sender?.id) throw new DeliveryError('The recipient is your own account.', 'recipient');
      return { id: String(user.id), accessHash: user.accessHash.toString(), username: normalized, firstName: user.firstName ?? '' };
    } catch (error) { throw translateTelegramError(error); }
  }

  async send(peer: Peer, text: string, randomId: string): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const userId = Number(peer.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || peer.id === this.sender?.id || !/^-?\d+$/.test(peer.accessHash)) {
      throw new DeliveryError('The saved recipient is invalid. Resolve the username again.', 'recipient');
    }
    if (!text.trim() || [...text].length > 4096) throw new DeliveryError('The message must contain between 1 and 4096 characters.', 'recipient');
    if (!/^-?\d+$/.test(randomId) || BigInt(randomId) === 0n || BigInt(randomId) < -(1n << 63n) || BigInt(randomId) >= 1n << 63n) {
      throw new DeliveryError('The saved message identifier is invalid. Create a new campaign.', 'unknown');
    }
    const requestId = Long.fromString(randomId);
    try {
      const result = await this.bounded(client, client.call({
        _: 'messages.sendMessage',
        peer: { _: 'inputPeerUser', userId, accessHash: Long.fromString(peer.accessHash) },
        message: text,
        randomId: requestId,
        noWebpage: true,
        // Plain text, no parser, no schedule, and no paid Stars authorization.
      }, RPC_OPTIONS));
      if (result._ === 'updateShortSentMessage' && Number.isSafeInteger(result.id) && result.id > 0) return { messageId: String(result.id) };
      if (result._ === 'updates' || result._ === 'updatesCombined') {
        const ack = result.updates.find((update) => update._ === 'updateMessageID' && update.randomId.equals(requestId));
        if (ack?._ === 'updateMessageID' && Number.isSafeInteger(ack.id) && ack.id > 0) return { messageId: String(ack.id) };
      }
      throw new DeliveryError('Telegram returned no message confirmation. Review the chat before retrying.', 'unknown');
    } catch (error) { throw translateTelegramError(error); }
  }

  /** Upload once per open queue; send one photo and its personalized caption in a single RPC. */
  async sendPhoto(peer: Peer, caption: string, randomId: string, image: Blob): Promise<{ messageId: string }> {
    const client = this.requireClient();
    const userId = Number(peer.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || peer.id === this.sender?.id || !/^-?\d+$/.test(peer.accessHash)) {
      throw new DeliveryError('The saved recipient is invalid. Resolve the username again.', 'recipient');
    }
    if (!caption.trim() || caption.length > 1024) throw new DeliveryError('The picture caption must contain 1–1024 characters.', 'content');
    if (!(image instanceof Blob) || !['image/jpeg', 'image/png'].includes(image.type) || image.size < 1 || image.size > 5 * 1024 * 1024) {
      throw new DeliveryError('Select a JPEG/PNG picture up to 5 MB.', 'content');
    }
    if (!/^-?\d+$/.test(randomId) || BigInt(randomId) === 0n || BigInt(randomId) < -(1n << 63n) || BigInt(randomId) >= 1n << 63n) {
      throw new DeliveryError('The saved message identifier is invalid. Create a new campaign.', 'unknown');
    }
    const requestId = Long.fromString(randomId);
    try {
      let file = this.photoCache.get(image);
      if (!file) {
        const uploaded = await this.bounded(client, uploadFile(client, {
          file: image,
          fileName: image.type === 'image/png' ? 'picture.png' : 'picture.jpg',
          fileMime: image.type,
          fileSize: image.size,
          requireFileSize: true,
          requestsPerConnection: 1,
        }));
        file = uploaded.inputFile;
        this.photoCache.set(image, file);
      }
      const result = await this.bounded(client, client.call({
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerUser', userId, accessHash: Long.fromString(peer.accessHash) },
        media: { _: 'inputMediaUploadedPhoto', file },
        message: caption,
        randomId: requestId,
        // No paid Stars, formatting, or scheduling; Telegram's rate limits apply.
      }, RPC_OPTIONS));
      if (result._ === 'updateShortSentMessage' && Number.isSafeInteger(result.id) && result.id > 0) return { messageId: String(result.id) };
      if (result._ === 'updates' || result._ === 'updatesCombined') {
        const ack = result.updates.find(update => update._ === 'updateMessageID' && update.randomId.equals(requestId));
        if (ack?._ === 'updateMessageID' && Number.isSafeInteger(ack.id) && ack.id > 0) return { messageId: String(ack.id) };
      }
      throw new DeliveryError('Telegram did not confirm the photo message. Review the chat before retrying.', 'unknown');
    } catch (error) { throw translateTelegramError(error); }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.sender = null;
    this.photoCache = new WeakMap();
    if (client) await client.destroy().catch(() => {});
  }

  async logout(): Promise<void> {
    const client = this.client;
    try {
      if (client) await this.bounded(client, client.call({ _: 'auth.logOut' }, RPC_OPTIONS));
    } catch (error) {
      throw new DeliveryError('Could not revoke the session online. Remove it in Telegram Settings → Devices.', 'auth');
    } finally { await this.disconnect(); }
  }
}

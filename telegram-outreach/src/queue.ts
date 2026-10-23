import { renderMessage } from './domain';
import { DeliveryError, type Campaign, type Recipient, type TelegramGateway } from './types';

export interface QueueOptions {
  signal: AbortSignal;
  suppressed: () => string[];
  onProgress?: (campaign: Campaign) => void;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  loadPhoto?: (campaignId: string) => Promise<Blob | null>;
}

const uncertainDelivery = 'Результат отправки неизвестен. Проверьте диалог в Telegram и отметьте результат вручную.';
const interruptedRun = 'Рассылка приостановлена. Для продолжения нажмите «Продолжить».';
const reservedStatuses = new Set<Recipient['status']>(['sent', 'confirmed', 'review', 'sending']);

function copyCampaign(campaign: Campaign): Campaign {
  return {
    ...campaign,
    recipients: campaign.recipients.map(row => ({ ...row, ...(row.peer ? { peer: { ...row.peer } } : {}) })),
  };
}

/** Recovery never starts work: an interrupted send requires a human decision. */
export function recoverCampaign(campaign: Campaign): Campaign {
  const recovered = copyCampaign(campaign);
  let uncertain = false;
  recovered.recipients = recovered.recipients.map(row => {
    if (row.status === 'sending') {
      uncertain = true;
      return { ...row, status: 'review', error: uncertainDelivery };
    }
    if (row.status === 'resolving') return { ...row, status: 'pending' };
    return row;
  });
  if (recovered.status === 'running') {
    recovered.status = 'paused';
    recovered.notice = interruptedRun;
  }
  if (uncertain) {
    if (recovered.status !== 'waiting') recovered.status = 'paused';
    recovered.notice = uncertainDelivery;
  }
  return recovered;
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Рассылка приостановлена.')); return; }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('Рассылка приостановлена.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function canonicalUsername(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

/** Caller holds the application-wide run lock for the entire returned promise. */
export async function runCampaign(
  campaign: Campaign,
  gateway: TelegramGateway,
  save: (campaign: Campaign) => Promise<void>,
  options: QueueOptions,
): Promise<Campaign> {
  let current = recoverCampaign(campaign);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const intervalSeconds = Number.isFinite(current.intervalSeconds)
    ? Math.min(3600, Math.max(1, current.intervalSeconds)) : 1;
  current.intervalSeconds = intervalSeconds;

  // Save failures deliberately escape. In particular, a failed post-send save
  // leaves the durable row as `sending`, which recovery converts to `review`.
  const commit = async (patch: Partial<Campaign> = {}): Promise<void> => {
    current = { ...current, ...patch, updatedAt: new Date(now()).toISOString() };
    await save(copyCampaign(current));
    options.onProgress?.(copyCampaign(current));
  };
  const changeRow = async (
    index: number, patch: Partial<Recipient>, campaignPatch: Partial<Campaign> = {},
  ): Promise<void> => {
    await commit({
      ...campaignPatch,
      recipients: current.recipients.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    });
  };
  const pause = async (): Promise<Campaign> => {
    await commit({ status: 'paused', notice: interruptedRun });
    return current;
  };
  const finish = async (): Promise<Campaign> => {
    const needsReview = current.recipients.some(row => row.status === 'review' || row.status === 'failed');
    await commit({
      status: needsReview ? 'paused' : 'complete',
      notice: needsReview
        ? 'Остались ошибки или неподтверждённые отправки. Проверьте их вручную перед повтором.'
        : 'Рассылка завершена.',
    });
    return current;
  };
  const isSuppressed = (username: string): boolean => {
    const canonical = canonicalUsername(username);
    return options.suppressed().some(item => canonicalUsername(item) === canonical);
  };
  const handleProblem = async (
    error: unknown, index: number | null, stage: 'sender' | 'resolve' | 'send',
  ): Promise<'continue' | 'stop'> => {
    const problem = error instanceof DeliveryError ? error.kind : 'unknown';
    let patch: Partial<Campaign>;
    let rowPatch: Partial<Recipient> = { status: 'pending' };
    if (problem === 'wait') {
      const seconds = error instanceof DeliveryError && Number.isFinite(error.waitSeconds)
        ? Math.max(1, Math.ceil(error.waitSeconds)) : 60;
      patch = {
        status: 'waiting',
        waitUntil: Math.max(current.waitUntil ?? 0, now() + seconds * 1000),
        notice: 'Telegram запросил паузу. Продолжить можно после указанного времени.',
      };
      rowPatch.error = 'Telegram запросил паузу перед следующей попыткой.';
    } else if (problem === 'recipient' && index !== null) {
      await changeRow(index, {
        status: 'failed',
        error: stage === 'resolve'
          ? 'Получатель не найден или недоступен.'
          : 'Telegram отклонил отправку этому получателю. Проверьте настройки приватности.',
      });
      return 'continue';
    } else if (problem === 'auth' || problem === 'restricted') {
      const notice = problem === 'auth'
        ? 'Сессия Telegram недействительна. Подключите аккаунт повторно.'
        : 'Telegram ограничил действия этого аккаунта. Рассылка приостановлена.';
      patch = { status: 'paused', notice };
      rowPatch.error = notice;
    } else if (problem === 'content') {
      patch = { status: 'paused', notice: 'Telegram отклонил картинку или подпись. Проверьте вложение и текст.' };
      rowPatch.error = patch.notice;
    } else if (stage === 'send') {
      patch = { status: 'paused', notice: uncertainDelivery };
      rowPatch = { status: 'review', error: uncertainDelivery };
    } else {
      const notice = 'Не удалось связаться с Telegram. Проверьте соединение и продолжите рассылку вручную.';
      patch = { status: 'paused', notice };
      rowPatch.error = notice;
    }
    if (index === null) await commit(patch);
    else await changeRow(index, rowPatch, patch);
    return 'stop';
  };

  // A persisted Telegram wait cannot be bypassed by pause, reload, or a new run.
  if (current.waitUntil !== null && current.waitUntil > now()) {
    await commit({ status: 'waiting', notice: 'Telegram запросил паузу. Продолжить можно после указанного времени.' });
    return current;
  }
  if (options.signal.aborted) return pause();
  if (!current.recipients.some(row => row.status === 'pending')) return finish();

  let sender;
  try {
    sender = await gateway.getSender();
  } catch (error) {
    await handleProblem(error, null, 'sender');
    return current;
  }
  if (current.senderId !== null && current.senderId !== sender.id) {
    await commit({
      status: 'paused',
      notice: 'Рассылка привязана к другому аккаунту Telegram. Подключите исходный аккаунт.',
    });
    return current;
  }
  if (options.signal.aborted) return pause();
  // This durable binding always happens before resolving or sending a recipient.
  await commit({ senderId: sender.id, status: 'running', waitUntil: null, notice: '' });

  let nextSendAt = current.recipients.reduce((latest, row) => {
    const sentAt = row.sentAt ? Date.parse(row.sentAt) : NaN;
    return Number.isFinite(sentAt) ? Math.max(latest, sentAt + intervalSeconds * 1000) : latest;
  }, current.lastAttemptAt === undefined ? 0 : current.lastAttemptAt + intervalSeconds * 1000);

  let image: Blob | null = null;
  if (current.image) {
    try {
      image = await options.loadPhoto?.(current.id) ?? null;
      if (!image || image.size !== current.image.size || image.type !== current.image.mimeType || !gateway.sendPhoto) {
        await commit({ status: 'paused', notice: 'Картинка этой очереди недоступна. Восстановите файл перед отправкой.' });
        return current;
      }
    } catch {
      await commit({ status: 'paused', notice: 'Не удалось прочитать картинку этой очереди. Отправка приостановлена.' });
      return current;
    }
  }

  for (let index = 0; index < current.recipients.length; index += 1) {
    let row = current.recipients[index]!;
    if (row.status !== 'pending') continue;
    if (options.signal.aborted) return pause();
    if (isSuppressed(row.username)) {
      await changeRow(index, { status: 'skipped', error: 'Получатель находится в стоп-листе.' });
      continue;
    }
    try {
      while (nextSendAt > now()) {
        await sleep(nextSendAt - now(), options.signal);
        if (options.signal.aborted) return pause();
      }
    } catch {
      return pause();
    }
    if (options.signal.aborted) return pause();
    await changeRow(index, { status: 'resolving', error: undefined });
    if (options.signal.aborted) {
      await changeRow(index, { status: 'pending' });
      return pause();
    }

    let peer;
    try {
      peer = await gateway.resolve(row.username);
    } catch (error) {
      if (await handleProblem(error, index, 'resolve') === 'stop') return current;
      continue;
    }
    if (options.signal.aborted) {
      await changeRow(index, { status: 'pending' });
      return pause();
    }
    const duplicate = current.recipients.some((other, otherIndex) =>
      otherIndex !== index && other.peer?.id === peer.id && reservedStatuses.has(other.status));
    if (peer.id === sender.id || duplicate || isSuppressed(row.username)) {
      await changeRow(index, {
        peer,
        status: 'skipped',
        error: peer.id === sender.id ? 'Отправка самому себе пропущена.'
          : duplicate ? 'Этот пользователь уже есть среди отправленных или проверяемых получателей.'
            : 'Получатель находится в стоп-листе.',
      });
      continue;
    }
    let text: string;
    try {
      text = renderMessage(current.template, {
        username: row.username,
        firstName: row.firstName,
      });
      if (current.image && text.length > 1024) {
        throw new Error('Подпись к картинке превышает 1024 символа.');
      }
    } catch {
      await changeRow(index, { peer, status: 'failed', error: 'Не удалось подготовить сообщение. Проверьте шаблон и его длину.' });
      continue;
    }

    // The exact peer, rendered text and stable randomId are durable before RPC.
    await changeRow(index, { peer, text, status: 'sending', error: undefined }, { lastAttemptAt: now() });
    row = current.recipients[index]!;
    if (options.signal.aborted) {
      await changeRow(index, { status: 'pending' });
      return pause();
    }
    if (isSuppressed(row.username)) {
      await changeRow(index, { status: 'skipped', error: 'Получатель находится в стоп-листе.' });
      continue;
    }
    let result;
    try {
      // No abort signal: once dispatched, wait for its result before stopping.
      result = image ? await gateway.sendPhoto!(peer, text, row.randomId, image)
        : await gateway.send(peer, text, row.randomId);
    } catch (error) {
      nextSendAt = now() + intervalSeconds * 1000;
      if (await handleProblem(error, index, 'send') === 'stop') return current;
      continue;
    }
    nextSendAt = now() + intervalSeconds * 1000;
    await changeRow(index, {
      status: 'sent', messageId: result.messageId, sentAt: new Date(now()).toISOString(), error: undefined,
    });
    if (options.signal.aborted) return pause();
  }
  return finish();
}

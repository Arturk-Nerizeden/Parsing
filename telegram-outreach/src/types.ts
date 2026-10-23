export type RecipientStatus = 'pending' | 'resolving' | 'sending' | 'sent' | 'failed' | 'review' | 'skipped' | 'confirmed';
export interface Contact { username: string; firstName: string; tags?: string[] }
export interface Peer { id: string; accessHash: string; username: string; firstName: string }
export interface Recipient extends Contact {
  id: string;
  randomId: string;
  status: RecipientStatus;
  peer?: Peer;
  text?: string;
  messageId?: string;
  error?: string;
  sentAt?: string;
}
export interface Campaign {
  id: string;
  title: string;
  template: string;
  createdAt: string;
  updatedAt: string;
  senderId: string | null;
  status: 'draft' | 'running' | 'paused' | 'waiting' | 'complete';
  intervalSeconds: number;
  lastAttemptAt?: number;
  waitUntil: number | null;
  notice: string;
  image?: { name: string; mimeType: 'image/jpeg' | 'image/png'; size: number };
  recipients: Recipient[];
}
export interface Sender { id: string; label: string }
export interface TelegramGateway {
  getSender(): Promise<Sender>;
  resolve(username: string): Promise<Peer>;
  send(peer: Peer, text: string, randomId: string): Promise<{ messageId: string }>;
  sendPhoto?(peer: Peer, caption: string, randomId: string, image: Blob): Promise<{ messageId: string }>;
}
export type DeliveryProblem = 'wait' | 'restricted' | 'recipient' | 'auth' | 'content' | 'unknown';
export class DeliveryError extends Error {
  constructor(message: string, public kind: DeliveryProblem, public waitSeconds = 0) {
    super(message); this.name = 'DeliveryError';
  }
}
export interface LocalState {
  version: 1;
  campaigns: Campaign[];
  selectedId: string | null;
  suppressed: string[];
}
export interface SessionCredentials { apiId: number; apiHash: string; session: string }

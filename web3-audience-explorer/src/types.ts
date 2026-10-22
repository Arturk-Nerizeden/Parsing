export type Mode = 'followers' | 'new7d' | 'imported';
export type Status = 'paused' | 'running' | 'complete' | 'limit' | 'error';

export interface RawUser {
  id?: unknown;
  username?: unknown;
  display_name?: unknown;
  followers_count?: unknown;
  description?: unknown;
  followerDate?: unknown;
}

export interface Account {
  collectionId: string;
  identity: string;
  id: string | null;
  username: string;
  displayName: string | null;
  followersCount: number | null;
  description: string | null;
  score: number | null;
  scoreChecked: boolean;
  category: string | null; // Only imported data. The documented API has no per-user category.
  firstSeen: string | null; // Only imported data. followerDate means followedAt, not firstSeen.
  followedAt: string | null;
  tags: string[]; // Local research annotations, or imported values.
  source: 'sorsa' | 'import';
}

export interface Collection {
  id: string;
  title: string;
  username: string | null;
  mode: Mode;
  status: Status;
  createdAt: string;
  updatedAt: string;
  limit: number;
  total: number;
  pages: number;
  requests: number;
  nextCursor: string | null;
  pendingUsers: RawUser[];
  hasFetched: boolean;
  seenCursors: string[];
  error: string | null;
}

export interface Usage {
  key_requests: number | null;
  remaining_requests: number | null;
  total_requests: number | null;
  valid_until: string | null;
}

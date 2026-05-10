import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface RefusedRecord {
  pattern_signature: string;
  subject: string;
  user_reason: string;
  ts: string;
  expires_at: string;
}

interface RawRefusedRecord {
  pattern_signature?: string;
  subject?: string;
  user_reason?: string;
  ts?: string;
  expires_at?: string;
  // Legacy (Python) field aliases — kept for backward compat across migrations
  ttl_until?: string;
  refused_at?: string;
  // Lines flagged with `_meta:true` are bookkeeping, not refusal records
  _meta?: boolean;
}

export const DEFAULT_REFUSED_PATH = join(homedir(), '.config', 'tuner', 'refused.jsonl');

export class RefusedStore {
  constructor(public readonly path: string, public ttlDays = 30) {}

  add(signature: string, subject: string, userReason = 'skip'): void {
    if (!signature) return; // empty signature means caller has nothing to dedup against
    mkdirSync(dirname(this.path), { recursive: true });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlDays * 86_400_000);
    const record: RefusedRecord = {
      pattern_signature: signature,
      subject,
      user_reason: userReason,
      ts: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  /**
   * Add a record with an explicit expiry timestamp. Used by the migration
   * script to preserve the original refusal date (and thus original TTL window)
   * rather than resetting it to 30 days from now.
   */
  addWithExpiry(signature: string, subject: string, userReason: string, ts: string, expiresAt: string): void {
    if (!signature) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const record: RefusedRecord = {
      pattern_signature: signature,
      subject,
      user_reason: userReason,
      ts,
      expires_at: expiresAt,
    };
    appendFileSync(this.path, JSON.stringify(record) + '\n');
  }

  activeSignatures(): Set<string> {
    const now = Date.now();
    const sigs = new Set<string>();
    for (const r of this._readRecords()) {
      // Accept either the new schema field (`expires_at`) or the legacy Python alias (`ttl_until`).
      // Without this fallback, records imported from the pre-migration Python store look
      // permanently expired and the dedup index goes silently empty.
      const expiryStr = r.expires_at ?? r.ttl_until;
      const sig = r.pattern_signature;
      if (!expiryStr || !sig) continue;
      try {
        if (new Date(expiryStr).getTime() > now) {
          sigs.add(sig);
        }
      } catch {
        // skip
      }
    }
    return sigs;
  }

  isRefused(sig: string): boolean {
    return this.activeSignatures().has(sig);
  }

  private _readRecords(): RawRefusedRecord[] {
    if (!existsSync(this.path)) return [];
    const records: RawRefusedRecord[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const obj = JSON.parse(l) as RawRefusedRecord;
        if (obj._meta) continue; // skip bookkeeping lines
        records.push(obj);
      } catch {
        // skip corrupt
      }
    }
    return records;
  }
}

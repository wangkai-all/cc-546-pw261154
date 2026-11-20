import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from './errors.js';

const SHA_PATTERN = /^[a-f0-9]{64}$/;

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeFileName(name) {
  return String(name ?? 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180) || 'file';
}

/**
 * Append-only JSONL journal plus a content-addressed blob library.
 *
 * The collector only reasons about bytes: every capture is stored under its
 * SHA-256 and the journal records which capture produced which hash. Assembly
 * and voucher downloads later pin an exact hash, so a stale capture can never
 * be swapped in merely because it has a familiar filename.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.contentDir = path.join(this.dataDir, 'content');
    this.journalPath = path.join(this.dataDir, 'journal.jsonl');
    fs.mkdirSync(this.contentDir, { recursive: true });

    this.events = [];
    this.state = this.#emptyState();
    this.#replay();
  }

  #emptyState() {
    return {
      seq: 0,
      lastAt: 0,
      collections: new Map(),
      files: new Map(),
      contents: new Map(),
      attempts: new Map(),
      versions: new Map(),
      retirements: new Map(),
      vouchers: new Map(),
      displays: [],
      served: [],
      counters: { collection: 0, file: 0, attempt: 0, version: 0, voucher: 0 },
    };
  }

  #replay() {
    if (!fs.existsSync(this.journalPath)) return;
    const raw = fs.readFileSync(this.journalPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    for (let i = 0; i < lines.length; i += 1) {
      let event;
      try {
        event = JSON.parse(lines[i]);
      } catch (error) {
        throw new Error(
          `Journal corrupt at line ${i + 1} of ${this.journalPath}: ${error.message}`,
        );
      }
      this.#apply(event);
      this.events.push(event);
      this.state.seq = Math.max(this.state.seq, Number(event.seq) || 0);
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) this.state.lastAt = Math.max(this.state.lastAt, at);
    }
  }

  #apply(event) {
    const s = this.state;
    switch (event.type) {
      case 'collect': {
        const collection = {
          collectionId: event.collectionId,
          label: event.label,
          at: event.at,
          fileIds: [],
        };
        s.collections.set(collection.collectionId, collection);
        s.counters.collection += 1;
        for (const file of event.files) {
          const record = {
            fileId: file.fileId,
            collectionId: event.collectionId,
            role: file.role,
            partId: file.partId ?? null,
            name: file.name,
            sha256: file.sha256,
            bytes: file.bytes,
            capturedAt: event.at,
            deduped: Boolean(file.deduped),
            withdrawn: false,
          };
          s.files.set(record.fileId, record);
          collection.fileIds.push(record.fileId);
          s.counters.file += 1;
          const content = s.contents.get(record.sha256);
          if (content) {
            content.captureCount += 1;
            if (!content.names.includes(record.name)) content.names.push(record.name);
          } else {
            s.contents.set(record.sha256, {
              sha256: record.sha256,
              bytes: record.bytes,
              firstSeenAt: event.at,
              captureCount: 1,
              names: [record.name],
            });
          }
        }
        break;
      }
      case 'withdraw-file': {
        const file = s.files.get(event.fileId);
        if (!file) break;
        file.withdrawn = true;
        file.withdrawnAt = event.at;
        file.withdrawnReason = event.reason;
        break;
      }
      case 'assemble': {
        s.attempts.set(event.attempt.attemptId, event.attempt);
        s.counters.attempt += 1;
        break;
      }
      case 'publish': {
        s.versions.set(event.version.versionId, event.version);
        s.counters.version += 1;
        break;
      }
      case 'retire': {
        s.retirements.set(event.versionId, {
          versionId: event.versionId,
          supersededBy: event.supersededBy ?? null,
          reason: event.reason,
          at: event.at,
        });
        break;
      }
      case 'display-switch': {
        s.displays.push({
          versionId: event.versionId ?? null,
          reason: event.reason,
          at: event.at,
        });
        break;
      }
      case 'issue-voucher': {
        s.vouchers.set(event.voucher.voucherId, event.voucher);
        s.counters.voucher += 1;
        break;
      }
      case 'serve-download': {
        s.served.push({ ...event });
        break;
      }
      default:
        throw new Error(`Unknown journal event type: ${event.type}`);
    }
  }

  #appendMany(events) {
    if (events.length === 0) return [];
    const prepared = [];
    for (const event of events) {
      const seq = this.state.seq + prepared.length + 1;
      const at = Math.max(Date.now(), this.state.lastAt + 1) + prepared.length;
      prepared.push({ ...event, seq, at: new Date(at).toISOString() });
    }
    fs.appendFileSync(
      this.journalPath,
      prepared.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );
    for (const event of prepared) {
      this.#apply(event);
      this.events.push(event);
      this.state.seq = event.seq;
      this.state.lastAt = Date.parse(event.at);
    }
    return prepared;
  }

  /** Discard the in-memory ledger after its directory has been removed. */
  reset() {
    fs.mkdirSync(this.contentDir, { recursive: true });
    this.events = [];
    this.state = this.#emptyState();
  }

  nextAt() {
    return new Date(Math.max(Date.now(), this.state.lastAt + 1)).toISOString();
  }

  contentPath(sha) {
    if (!SHA_PATTERN.test(sha)) throw new DomainError('bad-sha', '非法的内容校验和', 400);
    return path.join(this.contentDir, `${sha}.blob`);
  }

  #writeContent(buffer, sha) {
    const target = this.contentPath(sha);
    if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === sha) {
      return { existed: true };
    }
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, target);
    return { existed: false };
  }

  collect({ label, files }) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new DomainError('empty-collection', '采集批至少需要一个文件', 400);
    }
    const collectionId = `c${this.state.counters.collection + 1}`;
    const records = [];
    let nextFile = this.state.counters.file + 1;
    const seenInBatch = new Set();
    for (const input of files) {
      const content = Buffer.isBuffer(input.content)
        ? input.content
        : Buffer.from(String(input.content ?? ''), 'utf8');
      const sha = sha256(content);
      const knownBefore = this.state.contents.has(sha);
      const wrote = this.#writeContent(content, sha);
      const deduped = knownBefore || seenInBatch.has(sha) || wrote.existed;
      seenInBatch.add(sha);
      records.push({
        fileId: `f${nextFile}`,
        role: input.role,
        partId: input.partId ?? null,
        name: safeFileName(input.name || `${input.partId || input.role}.txt`),
        sha256: sha,
        bytes: content.length,
        deduped,
      });
      nextFile += 1;
    }
    const event = {
      type: 'collect',
      collectionId,
      label: label || `采集批 ${collectionId}`,
      files: records,
    };
    const [stored] = this.#appendMany([event]);
    return {
      collection: this.state.collections.get(collectionId),
      event: stored,
      files: records.map((record) => this.state.files.get(record.fileId)),
    };
  }

  withdrawFile(fileId, reason) {
    const file = this.state.files.get(fileId);
    if (!file) throw new DomainError('file-not-found', `找不到采集文件 ${fileId}`, 404);
    if (file.withdrawn) {
      throw new DomainError('already-withdrawn', `文件 ${fileId} 已经撤回`, 409);
    }
    const [event] = this.#appendMany([
      { type: 'withdraw-file', fileId, reason: reason || '编辑撤回' },
    ]);
    return { file: this.state.files.get(fileId), event };
  }

  recordAttempt(attempt) {
    const [event] = this.#appendMany([{ type: 'assemble', attempt }]);
    return { attempt: this.state.attempts.get(attempt.attemptId), event };
  }

  publish({ version, retires = [], display = false }) {
    const events = [{ type: 'publish', version }];
    for (const retire of retires) {
      events.push({
        type: 'retire',
        versionId: retire.versionId,
        supersededBy: retire.supersededBy ?? version.versionId,
        reason: retire.reason || `由 ${version.versionId} 取代`,
      });
    }
    if (display) {
      events.push({
        type: 'display-switch',
        versionId: version.versionId,
        reason: '发行版本齐全且固定内容全部可校验',
      });
    }
    const stored = this.#appendMany(events);
    return { version: this.state.versions.get(version.versionId), events: stored };
  }

  retireVersion(versionId, { reason, supersededBy = null } = {}) {
    if (!this.state.versions.has(versionId)) {
      throw new DomainError('version-not-found', `找不到发行版本 ${versionId}`, 404);
    }
    const existing = this.state.retirements.get(versionId);
    if (existing) {
      return { retirement: existing, alreadyRetired: true };
    }
    const [event] = this.#appendMany([
      { type: 'retire', versionId, supersededBy, reason: reason || '作废' },
    ]);
    return { retirement: this.state.retirements.get(versionId), event, alreadyRetired: false };
  }

  clearDisplay(reason) {
    const [event] = this.#appendMany([
      { type: 'display-switch', versionId: null, reason: reason || '展示站暂停' },
    ]);
    return event;
  }

  issueVoucher(voucher) {
    const [event] = this.#appendMany([{ type: 'issue-voucher', voucher }]);
    return { voucher: this.state.vouchers.get(voucher.voucherId), event };
  }

  recordServe({ voucherId, versionId, key, sha256: digest, ok, reason }) {
    this.#appendMany([
      {
        type: 'serve-download',
        voucherId,
        versionId,
        key,
        sha256: digest,
        ok: Boolean(ok),
        reason: reason ?? null,
      },
    ]);
  }

  readContent(sha) {
    const target = this.contentPath(sha);
    let buffer;
    try {
      buffer = fs.readFileSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new DomainError(
          'content-missing',
          `固定内容 ${sha.slice(0, 12)}… 不在内容库中，拒绝回退到同名旧声部`,
          409,
        );
      }
      throw error;
    }
    const actual = sha256(buffer);
    if (actual !== sha) {
      throw new DomainError(
        'content-integrity',
        `固定内容 ${sha.slice(0, 12)}… 校验失败（实际 ${actual.slice(0, 12)}…），拒绝回退到旧声部`,
        409,
      );
    }
    return buffer;
  }

  verifyContent(sha) {
    try {
      const bytes = this.readContent(sha).length;
      return { ok: true, bytes };
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  collectionList() {
    return [...this.state.collections.values()];
  }

  fileList() {
    return [...this.state.files.values()];
  }

  attemptList() {
    return [...this.state.attempts.values()];
  }

  versionList() {
    return [...this.state.versions.values()].sort((a, b) => a.sequence - b.sequence);
  }

  voucherList() {
    return [...this.state.vouchers.values()];
  }

  getCollection(id) {
    return this.state.collections.get(id) ?? null;
  }

  getFile(id) {
    return this.state.files.get(id) ?? null;
  }

  getAttempt(id) {
    return this.state.attempts.get(id) ?? null;
  }

  getVersion(id) {
    return this.state.versions.get(id) ?? null;
  }

  getVoucher(id) {
    return this.state.vouchers.get(id) ?? null;
  }

  getRetirement(versionId) {
    return this.state.retirements.get(versionId) ?? null;
  }

  isRetired(versionId) {
    return this.state.retirements.has(versionId);
  }

  displayPointer() {
    return this.state.displays.at(-1) ?? null;
  }

  displayHistory() {
    return [...this.state.displays];
  }

  servedList() {
    return [...this.state.served];
  }

  contentStats() {
    const blobs = [...this.state.contents.values()];
    return {
      blobs: blobs.length,
      capturedBytes: blobs.reduce((sum, item) => sum + item.bytes, 0),
      referencedFiles: blobs.reduce((sum, item) => sum + item.captureCount, 0),
    };
  }
}

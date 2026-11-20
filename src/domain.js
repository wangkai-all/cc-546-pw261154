import { DomainError } from './errors.js';

export const MANIFEST_SCHEMA = 'score-manifest/v1';

export const SCORE_SLOT = Object.freeze({
  slot: 'score',
  role: 'score',
  partId: null,
  label: '总谱',
  shortLabel: 'Score',
});

export const PART_SLOTS = Object.freeze([
  Object.freeze({ slot: 'vn1', role: 'part', partId: 'vn1', label: '小提琴 I', shortLabel: 'Vn I' }),
  Object.freeze({ slot: 'vn2', role: 'part', partId: 'vn2', label: '小提琴 II', shortLabel: 'Vn II' }),
  Object.freeze({ slot: 'va', role: 'part', partId: 'va', label: '中提琴', shortLabel: 'Va' }),
  Object.freeze({ slot: 'vc', role: 'part', partId: 'vc', label: '大提琴', shortLabel: 'Vc' }),
  Object.freeze({ slot: 'cb', role: 'part', partId: 'cb', label: '低音提琴', shortLabel: 'Cb' }),
]);

export const CONTENT_SLOTS = Object.freeze([SCORE_SLOT, ...PART_SLOTS]);

export const MANIFEST_SLOT = Object.freeze({
  slot: 'manifest',
  role: 'manifest',
  partId: null,
  label: '文件清单',
  shortLabel: 'Manifest',
});

export const ALL_SLOTS = Object.freeze([...CONTENT_SLOTS, MANIFEST_SLOT]);
export const ALL_SLOT_KEYS = Object.freeze(ALL_SLOTS.map((definition) => definition.slot));
export const TOTAL_REQUIRED = ALL_SLOTS.length;
export const SHA_PATTERN = /^[a-f0-9]{64}$/;

export const SLOT_BY_KEY = new Map(ALL_SLOTS.map((definition) => [definition.slot, definition]));
export const PART_BY_ID = new Map(PART_SLOTS.map((definition) => [definition.partId, definition]));

export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : '';
}

export function percent(satisfied, required) {
  if (!required) return 0;
  return Math.round((satisfied / required) * 1000) / 10;
}

export function buildManifestText({ title, note, entries }) {
  const files = entries.map((entry) => ({
    slot: entry.slot,
    role: entry.role,
    partId: entry.partId ?? null,
    name: entry.name,
    sha256: entry.sha256,
    bytes: entry.bytes,
  }));
  const document = {
    schema: MANIFEST_SCHEMA,
    title: title || '未命名作品',
    note: note || '',
    files,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural validation only. Whether the pinned bytes still exist is the
 * assembler's job, because that depends on the capture ledger.
 */
export function parseManifest(text) {
  const result = {
    ok: false,
    title: null,
    note: '',
    entriesBySlot: Object.create(null),
    errors: [],
    missingSlots: [],
  };
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    result.errors.push({ code: 'manifest-json', message: `文件清单不是合法 JSON：${error.message}` });
    return result;
  }
  if (!isPlainObject(document)) {
    result.errors.push({ code: 'manifest-shape', message: '文件清单顶层必须是对象' });
    return result;
  }
  result.title = typeof document.title === 'string' ? document.title : null;
  result.note = typeof document.note === 'string' ? document.note : '';
  if (document.schema !== MANIFEST_SCHEMA) {
    result.errors.push({ code: 'manifest-schema', message: `文件清单 schema 必须是 ${MANIFEST_SCHEMA}` });
  }
  if (!Array.isArray(document.files) || document.files.length === 0) {
    result.errors.push({ code: 'manifest-files', message: '文件清单 files 必须是非空数组' });
    return result;
  }

  document.files.forEach((entry, index) => {
    const where = `files[${index}]`;
    if (!isPlainObject(entry)) {
      result.errors.push({ code: 'entry-shape', message: `${where} 必须是对象` });
      return;
    }
    const definition = SLOT_BY_KEY.get(entry.slot);
    if (!definition || definition.slot === 'manifest') {
      result.errors.push({
        code: 'entry-unknown-slot',
        slot: typeof entry.slot === 'string' ? entry.slot : undefined,
        message: `${where} 使用了未知槽位 ${String(entry.slot)}`,
      });
      return;
    }
    if (result.entriesBySlot[definition.slot]) {
      result.errors.push({
        code: 'entry-duplicate-slot',
        slot: definition.slot,
        message: `槽位 ${definition.slot} 在清单中重复出现`,
      });
      return;
    }
    let valid = true;
    if (typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.length > 200) {
      result.errors.push({ code: 'entry-name', slot: definition.slot, message: `${where} 的 name 非法` });
      valid = false;
    }
    if (typeof entry.sha256 !== 'string' || !SHA_PATTERN.test(entry.sha256)) {
      result.errors.push({
        code: 'entry-sha',
        slot: definition.slot,
        message: `${where} 的 sha256 必须是 64 位小写十六进制`,
      });
      valid = false;
    }
    if (entry.role !== definition.role) {
      result.errors.push({
        code: 'entry-role',
        slot: definition.slot,
        message: `槽位 ${definition.slot} 的 role 应为 ${definition.role}`,
      });
      valid = false;
    }
    const actualPartId = entry.partId ?? null;
    if (actualPartId !== definition.partId) {
      result.errors.push({
        code: 'entry-part',
        slot: definition.slot,
        message: `槽位 ${definition.slot} 的 partId 应为 ${String(definition.partId)}`,
      });
      valid = false;
    }
    if (entry.bytes !== undefined && (!Number.isInteger(entry.bytes) || entry.bytes < 0)) {
      result.errors.push({ code: 'entry-bytes', slot: definition.slot, message: `${where} 的 bytes 必须是非负整数` });
      valid = false;
    }
    if (valid) {
      result.entriesBySlot[definition.slot] = {
        slot: definition.slot,
        role: entry.role,
        partId: actualPartId,
        name: entry.name,
        sha256: entry.sha256,
        bytes: entry.bytes,
      };
    }
  });

  result.missingSlots = CONTENT_SLOTS.map((definition) => definition.slot).filter(
    (slot) => !result.entriesBySlot[slot],
  );
  if (result.missingSlots.length > 0) {
    result.errors.push({
      code: 'manifest-incomplete',
      message: `文件清单缺少槽位：${result.missingSlots.map((slot) => SLOT_BY_KEY.get(slot).label).join('、')}`,
      missing: result.missingSlots,
    });
  }
  result.ok = result.errors.length === 0;
  return result;
}

export function entriesFromVersion(version) {
  return CONTENT_SLOTS.map((definition) => {
    const slot = version?.slots?.[definition.slot];
    if (!slot) return null;
    return {
      slot: definition.slot,
      role: definition.role,
      partId: definition.partId,
      name: slot.name,
      sha256: slot.sha256,
      bytes: slot.bytes,
    };
  }).filter(Boolean);
}

export function requirePart(partId) {
  const definition = PART_BY_ID.get(partId);
  if (!definition) {
    throw new DomainError('unknown-part', `未知声部：${String(partId)}`, 400, {
      allowed: PART_SLOTS.map((part) => part.partId),
    });
  }
  return definition;
}

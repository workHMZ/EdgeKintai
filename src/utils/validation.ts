import type { TransportMode, TransportTripType, WorkType } from '../types';
import { isValidDate, isValidTime } from './time';

export class RequestValidationError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 413 = 400,
  ) {
    super(message);
  }
}

export async function readJsonObject(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const bytes = await readBodyBytes(request, maxBytes);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestValidationError('JSONの形式が正しくありません');
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('リクエストボディはJSONオブジェクトである必要があります');
  }
  return value as Record<string, unknown>;
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length < 0) {
      throw new RequestValidationError('Content-Lengthが正しくありません');
    }
    if (length > maxBytes) {
      throw new RequestValidationError('リクエストのサイズが大きすぎます', 413);
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body too large');
        throw new RequestValidationError('リクエストのサイズが大きすぎます', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function requiredString(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${label}は必須です`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new RequestValidationError(`${label}は${minLength}文字以上${maxLength}文字以内で入力してください`);
  }
  if (/\p{C}/u.test(normalized)) throw new RequestValidationError(`${label}に無効な文字が含まれています`);
  return normalized;
}

export function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError(`${label}の形式が正しくありません`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > maxLength || /\p{C}/u.test(normalized)) {
    throw new RequestValidationError(`${label}は最大${maxLength}文字までです`);
  }
  return normalized;
}

/** Preserve line breaks in notes without accepting other control characters. */
export function memoValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new RequestValidationError('備考の形式が正しくありません');
  const normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
  if (normalized.length > 500) throw new RequestValidationError('備考は最大500文字までです');
  if (/\p{C}/u.test(normalized.replace(/\n/g, ''))) {
    throw new RequestValidationError('備考に無効な文字が含まれています');
  }
  return normalized;
}

export function displayNameValue(value: unknown): string {
  const displayName = requiredString(value, '氏名', 1, 80);
  const visible = displayName.replace(/[\p{C}\p{Z}]/gu, '');
  if (!visible || !/[\p{L}\p{N}\p{M}\p{S}]/u.test(visible)) {
    throw new RequestValidationError('氏名には表示可能な文字を含める必要があります');
  }
  return displayName;
}

export function usernameValue(value: unknown): string {
  const username = requiredString(value, 'ログインID', 3, 64);
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new RequestValidationError('ログインIDは半角英数字、ドット、アンダースコア、ハイフンのみ使用可能です');
  }
  return username.toLowerCase();
}

export function passwordValue(value: unknown, label = 'パスワード'): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new RequestValidationError(`${label}は12〜128文字で入力してください`);
  }
  return value;
}

export function workTypeValue(value: unknown, fallback?: WorkType): WorkType {
  if (value === undefined && fallback) return fallback;
  if (value === 'office' || value === 'remote' || value === 'paid_leave' || value === 'holiday' || value === 'absent') {
    return value;
  }
  throw new RequestValidationError('勤務区分が正しくありません');
}

export function defaultWorkTypeValue(
  value: unknown,
  fallback?: 'office' | 'remote',
): 'office' | 'remote' {
  const workType = workTypeValue(value, fallback);
  if (workType === 'office' || workType === 'remote') return workType;
  throw new RequestValidationError('既定の勤務区分は出社または在宅を選択してください');
}

export function tripTypeValue(value: unknown, fallback?: TransportTripType): TransportTripType {
  if (value === undefined && fallback) return fallback;
  if (value === 'one_way' || value === 'round_trip') return value;
  throw new RequestValidationError('交通費区分が正しくありません');
}

export function transportModeValue(value: unknown, fallback?: TransportMode): TransportMode {
  if (value === undefined && fallback) return fallback;
  if (value === 'rail' || value === 'bus' || value === 'taxi' || value === 'other') return value;
  throw new RequestValidationError('交通手段が正しくありません');
}

export function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestValidationError(`${label}は${min}から${max}までの整数で指定してください`);
  }
  return value;
}

export function nullableBoundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return boundedInteger(value, label, min, max);
}

export function positiveIdValue(value: string): number {
  if (!/^\d+$/.test(value)) throw new RequestValidationError('IDが正しくありません');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new RequestValidationError('IDが正しくありません');
  return id;
}

export function nullableTime(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isValidTime(value)) {
    throw new RequestValidationError(`${label}はHH:MM形式で指定してください`);
  }
  return value;
}

export function dateValue(value: string): string {
  if (!isValidDate(value)) throw new RequestValidationError('日付はYYYY-MM-DD形式で指定してください');
  return value;
}

export function yearMonthValues(yearText: string, monthText: string): { year: number; month: number } {
  if (!/^\d{4}$/.test(yearText) || !/^(?:[1-9]|1[0-2])$/.test(monthText)) {
    throw new RequestValidationError('年月が正しくありません');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  if (year < 1955 || year > 2100) throw new RequestValidationError('年は1955から2100の間で指定してください');
  return { year, month };
}

export function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new RequestValidationError('リクエストにサポートされていないフィールドが含まれています');
  }
}

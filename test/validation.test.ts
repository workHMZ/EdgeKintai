import { describe, expect, it } from 'vitest';
import {
  displayNameValue,
  optionalString,
  passwordValue,
  RequestValidationError,
  usernameValue,
} from '../src/utils/validation';

describe('validation utilities', () => {
  it('validates usernames correctly', () => {
    expect(usernameValue('valid.name-123_')).toBe('valid.name-123_');
    expect(() => usernameValue('invalid name')).toThrow(RequestValidationError);
    expect(() => usernameValue('ab')).toThrow(RequestValidationError); // Too short
    expect(() => usernameValue('a'.repeat(65))).toThrow(RequestValidationError); // Too long
    expect(() => usernameValue('invalid@name')).toThrow(RequestValidationError); // invalid char
  });

  it('validates passwords correctly', () => {
    expect(passwordValue('valid-password-123')).toBe('valid-password-123');
    expect(() => passwordValue('short')).toThrow(RequestValidationError); // Too short
    expect(() => passwordValue('a'.repeat(129))).toThrow(RequestValidationError); // Too long
  });

  it('validates display names correctly', () => {
    expect(displayNameValue('山田 太郎')).toBe('山田 太郎');
    expect(() => displayNameValue('   ')).toThrow(RequestValidationError); // Empty or just spaces
    expect(() => displayNameValue('a'.repeat(81))).toThrow(RequestValidationError); // Too long
  });

  it('distinguishes length violations from control characters in optional strings', () => {
    expect(optionalString(undefined, '出発地', 10)).toBeUndefined();
    expect(optionalString('  新宿駅  ', '出発地', 10)).toBe('新宿駅');
    expect(() => optionalString('あ'.repeat(11), '出発地', 10)).toThrow('出発地は最大10文字までです');
    expect(() => optionalString('新宿\u0000駅', '出発地', 10)).toThrow('出発地に無効な文字が含まれています');
    expect(() => optionalString('\u200B', '出発地', 10)).toThrow('出発地に無効な文字が含まれています');
  });
});

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_BYTES = 32 * 1024;

export class LibraryError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, {status, code});
  }
}
export function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LibraryError(400, 'INVALID_JSON', '请求必须是 JSON 对象。');
  return value;
}
export function textField(value, name, {max = 1000, empty = false} = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new LibraryError(400, 'INVALID_FIELD', `${name} 格式或长度无效。`);
  return value.trim();
}

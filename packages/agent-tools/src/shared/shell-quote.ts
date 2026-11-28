const SAFE_ARG_RE = /^[A-Za-z0-9_./:=-]+$/;

/**
 * POSIX 单引号 quoting。安全字符直接原样返回,其它字符走 `'…'` + 内部
 * `'\''` 转义。空串变 `''`。
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (SAFE_ARG_RE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

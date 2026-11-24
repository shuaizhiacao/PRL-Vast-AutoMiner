// 日志脱敏。创世哈希是 0x + 64 个十六进制字符，签名是 64 字节（128 个十六进制字符）起，只抹掉更长的 0x 串。
const LONG_HEX = /0x[0-9a-fA-F]{128,}/g;
const SECRET_FIELD = /(ssh_password|ssh_key|signature|secretPhrase|mnemonic|seed|privateKey|apiKey|auth)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

export function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text)
    .replace(LONG_HEX, '0x<redacted>')
    .replace(SECRET_FIELD, '$1=<redacted>');
}

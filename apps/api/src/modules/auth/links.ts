export function buildLink(base: string, path: string, token: string): string {
  const url = new URL(path, base);
  url.searchParams.set('token', token);
  return url.toString();
}

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { API_URL, DATABASE_URL, DEMO_URL, PORTS, REDIS_URL, TELEGRAM_URL, WEB_ORIGIN } from './env';

/** Derlenmiş yığını (api, worker, scheduler, demo-site, web) ayrı portlarda başlatan/durduran yardımcılar. */
export const REPO = resolve(__dirname, '..', '..', '..');
export const E2E_DIR = resolve(__dirname, '..');
const STATE_DIR = join(E2E_DIR, '.state');
const PIDS_FILE = join(STATE_DIR, 'pids.json');
export const LOG_DIR = join(E2E_DIR, '.logs');
const WEB_SRC = join(REPO, 'apps', 'web');
/** Web, API_ORIGIN derleme anında sabitlendiği için ayrı bir kopyada :3101'e göre derlenir (apps/web/.next'e dokunulmaz). */
const WEB_BUILD = join(E2E_DIR, '.web-build');
const isWindows = process.platform === 'win32';

export const DEMO_SIZE = 300;

export interface StackSecrets {
  jwtPrivateKey: string;
  jwtPublicKey: string;
  dataEncryptionKey: string;
  adminEmail: string;
  adminPassword: string;
  botToken: string;
}

export function generateSecrets(botToken: string): StackSecrets {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    jwtPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    jwtPublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    dataEncryptionKey: randomBytes(32).toString('base64'),
    adminEmail: `e2e-admin-${randomBytes(4).toString('hex')}@example.com`,
    adminPassword: randomBytes(18).toString('base64url'),
    botToken,
  };
}

// ---------------------------------------------------------------- süreç yönetimi

interface Tracked {
  name: string;
  pid: number;
  startedAt: string;
  /** Süreci tanımlayan komut satırı parçası (betik yolu); öldürmeden önce PID'in hâlâ bizim olduğu bununla doğrulanır. */
  cmd: string;
}

function readPids(): Tracked[] {
  try {
    return JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as Tracked[];
  } catch {
    return [];
  }
}

function writePids(list: Tracked[]): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PIDS_FILE, JSON.stringify(list, null, 2));
}

/** Verilen PID'lerin güncel komut satırları (yaşamayanlar haritada yer almaz). */
function commandLines(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  if (isWindows) {
    const script = `Get-CimInstance Win32_Process | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const sep = line.indexOf('|');
      if (sep > 0) out.set(Number(line.slice(0, sep)), line.slice(sep + 1));
    }
    return out;
  }
  for (const pid of pids) {
    try {
      out.set(pid, readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '));
    } catch {
      const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) out.set(pid, r.stdout.trim());
    }
  }
  return out;
}

const normalize = (s: string) => s.replace(/\\/g, '/').toLowerCase();

/** Süreci ve tüm alt süreçlerini öldürür (Windows: taskkill /T /F; POSIX: süreç grubu). */
function killTree(pid: number): void {
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // zaten ölmüş
  }
}

/**
 * Kayıtlı tüm süreçleri öldürür (önceki yarıda kalmış koşu dahil). PID yeniden kullanılmış olabilir: yalnızca komut
 * satırı kayıttaki betik yolunu hâlâ içeren süreçler öldürülür; diğerleri uyarıyla atlanır.
 */
export function killAll(): void {
  const list = readPids();
  if (list.length === 0) return;
  const live = commandLines(list.map((p) => p.pid));
  for (const p of [...list].reverse()) {
    const cmdline = live.get(p.pid);
    if (cmdline === undefined) continue; // zaten sonlanmış
    if (!normalize(cmdline).includes(normalize(p.cmd))) {
      console.warn(`[e2e] PID ${p.pid} (${p.name}, ${p.startedAt}) artık bizim süreç değil; öldürülmedi.`);
      continue;
    }
    killTree(p.pid);
  }
  rmSync(PIDS_FILE, { force: true });
}

/** `script` süreç kimliği olarak saklanır (ör. dist/main.js ya da next ikilisi). */
export function spawnTracked(name: string, script: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): number {
  mkdirSync(LOG_DIR, { recursive: true });
  const fd = openSync(join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(process.execPath, [script, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', fd, fd],
    detached: !isWindows, // POSIX: kendi süreç grubu → kill(-pid)
    windowsHide: true,
  });
  closeSync(fd);
  if (!child.pid) throw new Error(`${name} başlatılamadı`);
  child.unref();
  writePids([...readPids(), { name, pid: child.pid, startedAt: new Date().toISOString(), cmd: script }]);
  return child.pid;
}

export function logTail(name: string, lines = 40): string {
  try {
    return readFileSync(join(LOG_DIR, `${name}.log`), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(log yok)';
  }
}

// ---------------------------------------------------------------- bekleme yardımcıları

export async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, onTimeout?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} ${timeoutMs} ms içinde hazır olmadı${lastErr ? `: ${String(lastErr)}` : ''}${onTimeout ? `\n${onTimeout()}` : ''}`);
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => {
      sock.destroy();
      done(true);
    });
    sock.once('error', () => done(false));
  });
}

async function httpOk(url: string): Promise<boolean> {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  return res.status === 200;
}

// ---------------------------------------------------------------- altyapı

/** Dev compose (Postgres 5433, Redis 6380, Mailpit 8025) ayakta değilse kaldırır. */
export async function ensureInfra(): Promise<void> {
  const up = async () => (await portOpen(5433)) && (await portOpen(6380)) && (await portOpen(8025));
  if (await up()) return;
  execFileSync('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d'], { cwd: REPO, stdio: 'inherit' });
  await waitFor('dev compose (postgres/redis/mailpit)', up, 60_000);
}

export async function assertPortsFree(): Promise<void> {
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portOpen(port)) throw new Error(`Port ${port} (${name}) kullanımda; önceki bir e2e koşusu ya da başka bir süreç çalışıyor olabilir.`);
  }
}

const PRISMA_CLI = join(REPO, 'packages', 'db', 'node_modules', 'prisma', 'build', 'index.js');
const TSX_CLI = join(REPO, 'packages', 'db', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function baseEnv(): NodeJS.ProcessEnv {
  // Yalnızca gerekli sistem değişkenleri devralınır; kökteki .env'den sızıntı olmasın diye her şey açıkça verilir.
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PROGRAMDATA', 'NUMBER_OF_PROCESSORS'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * Yıkıcı adımlar (migrate reset, FLUSHDB) yalnızca e2e hedeflerinde çalışır: veritabanı adı `_e2e` ile bitmeli,
 * Redis db 14 olmalı (başka bir db için E2E_ALLOW_REDIS_DB=<n> açıkça verilmeli). Yanlış env ile geliştirme verisi silinmez.
 */
export function assertDestructiveTargets(databaseUrl = DATABASE_URL, redisUrl = REDIS_URL): void {
  const dbName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!dbName.endsWith('_e2e')) throw new Error(`Güvenlik: veritabanı adı '_e2e' ile bitmeli (bulunan: '${dbName}'); reset yapılmadı.`);
  const redisDb = new URL(redisUrl).pathname.slice(1) || '0';
  const allowed = process.env.E2E_ALLOW_REDIS_DB?.trim();
  if (redisDb !== '14' && redisDb !== allowed) {
    throw new Error(`Güvenlik: Redis db 14 olmalı (bulunan: ${redisDb}); başka bir db için E2E_ALLOW_REDIS_DB=${redisDb} verin.`);
  }
}

/** oto_e2e veritabanını sıfırlar (yoksa oluşturur), migrate eder ve seed'ler. */
export function resetDatabase(secrets: StackSecrets): void {
  assertDestructiveTargets();
  const env = { ...baseEnv(), DATABASE_URL };
  // Yüklü makinede Docker port yönlendirmesi anlık P1001 verebilir: en fazla 3 deneme.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'reset', '--force', '--skip-generate', '--skip-seed'], {
        cwd: join(REPO, 'packages', 'db'),
        env,
        stdio: 'pipe',
      });
      break;
    } catch (err) {
      const out = `${String((err as { stdout?: Buffer }).stdout ?? '')}${String((err as { stderr?: Buffer }).stderr ?? '')}`;
      if (attempt >= 3 || !out.includes('P1001')) throw err;
    }
  }
  execFileSync(process.execPath, [TSX_CLI, 'prisma/seed.ts'], {
    cwd: join(REPO, 'packages', 'db'),
    env: {
      ...env,
      NODE_ENV: 'development',
      SEED_DEMO_SOURCE: 'true',
      DEMO_SITE_URL: DEMO_URL,
      SEED_ADMIN_EMAIL: secrets.adminEmail,
      SEED_ADMIN_PASSWORD: secrets.adminPassword,
    },
    stdio: 'pipe',
  });
}

export async function flushRedis(): Promise<void> {
  assertDestructiveTargets();
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

// ---------------------------------------------------------------- web derlemesi

const WEB_SKIP = new Set(['node_modules', '.next', '.screenshots', 'tsconfig.tsbuildinfo', 'scripts']);

function hashTree(dir: string, h: ReturnType<typeof createHash>, root: string, skip: Set<string>): void {
  for (const entry of readdirSync(dir).sort()) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) hashTree(full, h, root, skip);
    else {
      h.update(relative(root, full).replace(/\\/g, '/'));
      h.update(readFileSync(full));
    }
  }
}

/**
 * Web'i e2e için `API_ORIGIN=http://127.0.0.1:3101` ile derler. Kaynak (apps/web + packages/shared/src) ve
 * API_ORIGIN özeti değişmediyse önceki derleme yeniden kullanılır.
 */
export function buildWeb(): { rebuilt: boolean; ms: number; source: string } {
  const started = Date.now();
  // E2E_WEB_REF=<git ref>: web kaynağı çalışma ağacı yerine o commit'ten alınır (çalışma ağacında yarım web
  // değişiklikleri varken yığını sabit bir web ile koşmak için). Varsayılan: çalışma ağacı.
  // Karışık kaynak uyarısı: yalnızca apps/web ref'ten gelir; @oto/shared (transpilePackages) ve node_modules
  // (pnpm-lock.yaml) her zaman çalışma ağacındandır. api/worker/demo-site da çalışma ağacının dist'idir.
  const ref = process.env.E2E_WEB_REF?.trim() || null;
  const commit = ref ? execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim() : null;
  const source = commit ? `git ${ref} (${commit.slice(0, 7)})` : 'çalışma ağacı';
  const h = createHash('sha256');
  h.update(`API_ORIGIN=${API_URL}\n`);
  if (commit) h.update(`ref=${commit}\n`);
  else hashTree(WEB_SRC, h, WEB_SRC, WEB_SKIP);
  hashTree(join(REPO, 'packages', 'shared', 'src'), h, REPO, new Set());
  // Bağımlılık sürümleri (next, react…) değişirse derleme yenilenir.
  h.update(readFileSync(join(REPO, 'pnpm-lock.yaml')));
  const digest = h.digest('hex');
  const marker = join(WEB_BUILD, '.e2e-hash');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === digest && existsSync(join(WEB_BUILD, '.next', 'BUILD_ID'))) {
    return { rebuilt: false, ms: Date.now() - started, source };
  }
  rmSync(WEB_BUILD, { recursive: true, force: true });
  mkdirSync(WEB_BUILD, { recursive: true });
  if (commit) {
    const tarball = execFileSync('git', ['archive', '--format=tar', commit, 'apps/web'], { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
    const untar = spawnSync('tar', ['-x', '-f', '-', '--strip-components=2'], { cwd: WEB_BUILD, input: tarball });
    if (untar.status !== 0) throw new Error(`git archive açılamadı: ${String(untar.stderr)}`);
    for (const entry of WEB_SKIP) rmSync(join(WEB_BUILD, entry), { recursive: true, force: true });
  } else {
    for (const entry of readdirSync(WEB_SRC)) {
      if (WEB_SKIP.has(entry)) continue;
      cpSync(join(WEB_SRC, entry), join(WEB_BUILD, entry), { recursive: true });
    }
  }
  symlinkSync(join(WEB_SRC, 'node_modules'), join(WEB_BUILD, 'node_modules'), 'junction');
  mkdirSync(LOG_DIR, { recursive: true });
  const result = spawnSync(process.execPath, [join(WEB_BUILD, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: WEB_BUILD,
    // NEXT_STANDALONE=0: `next start` ile çalıştırılır; Linux/CI'da da standalone çıktısı üretilmez.
    env: { ...baseEnv(), API_ORIGIN: API_URL, NEXT_TELEMETRY_DISABLED: '1', NEXT_STANDALONE: '0' },
    encoding: 'utf8',
    windowsHide: true,
  });
  writeFileSync(join(LOG_DIR, 'web-build.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.status !== 0) throw new Error(`web e2e derlemesi başarısız (bkz. ${join(LOG_DIR, 'web-build.log')})`);
  writeFileSync(marker, digest);
  return { rebuilt: true, ms: Date.now() - started, source };
}

// ---------------------------------------------------------------- yığın

export function startProcesses(secrets: StackSecrets): void {
  const common = {
    ...baseEnv(),
    // development: TELEGRAM_MODE=polling yalnız NODE_ENV!=test iken otomatik başlar; production localhost URL'leri reddeder.
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    DATABASE_URL,
    REDIS_URL,
    DATA_ENCRYPTION_KEY: secrets.dataEncryptionKey,
    TELEGRAM_BOT_TOKEN: secrets.botToken,
    TELEGRAM_API_BASE: TELEGRAM_URL,
    // Worker "Analizi gör" bağlantısını buradan üretir; loopback olmayan .test adı (bkz. env.ts).
    PUBLIC_BASE_URL: WEB_ORIGIN,
  };

  spawnTracked('demo-site', join(REPO, 'apps', 'demo-site', 'dist', 'main.js'), [], {
    cwd: join(REPO, 'apps', 'demo-site'),
    env: { ...baseEnv(), NODE_ENV: 'development', DEMO_HOST: '127.0.0.1', DEMO_PORT: String(PORTS.demo), DEMO_SEED: '42', DEMO_SIZE: String(DEMO_SIZE), DEMO_TICK_MS: '0' },
  });

  spawnTracked('api', join(REPO, 'apps', 'api', 'dist', 'main.js'), [], {
    cwd: join(REPO, 'apps', 'api'),
    env: {
      ...common,
      PORT: String(PORTS.api),
      JWT_PRIVATE_KEY: secrets.jwtPrivateKey,
      JWT_PUBLIC_KEY: secrets.jwtPublicKey,
      COOKIE_SECURE: 'false',
      TRUST_PROXY: '1',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_SECURE: 'false',
      SMTP_FROM: 'Oto Fırsat E2E <no-reply@oto-e2e.test>',
      HIBP_ENABLED: 'false',
      TELEGRAM_MODE: 'polling',
      TELEGRAM_BOT_USERNAME: 'oto_e2e_bot',
      PROXY_CHECK_URL: `${DEMO_URL}/robots.txt`,
    },
  });

  const workerEnv = {
    ...common,
    BOT_CONTACT_URL: `${WEB_ORIGIN}/bot`,
    SCHEDULER_TICK_MS: '2000',
    MONITOR_INTERVAL_MS: '5000',
    SHUTDOWN_TIMEOUT_MS: '2000',
    // Düşük eşzamanlılık: paylaşılan makinede DB baskısını azaltır (scheduler tx'i 5 sn varsayılan zaman aşımına sahip).
    SCRAPE_CONCURRENCY: '1',
    ANALYZE_CONCURRENCY: '2',
    MATCH_CONCURRENCY: '2',
    NOTIFY_CONCURRENCY: '2',
  };
  const workerMain = join(REPO, 'apps', 'worker', 'dist', 'main.js');
  spawnTracked('worker', workerMain, [], { cwd: join(REPO, 'apps', 'worker'), env: workerEnv });
  spawnTracked('scheduler', workerMain, ['--role=scheduler'], { cwd: join(REPO, 'apps', 'worker'), env: workerEnv });

  spawnTracked('web', join(WEB_BUILD, 'node_modules', 'next', 'dist', 'bin', 'next'), ['start', '-p', String(PORTS.web), '-H', '127.0.0.1'], {
    cwd: WEB_BUILD,
    env: {
      ...baseEnv(),
      API_ORIGIN: API_URL,
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_STANDALONE: '0',
      // Çalışma zamanı: demo-site ilan görselleri (http) CSP img-src'e eklenir.
      CSP_IMG_EXTRA: DEMO_URL,
    },
  });
}

export async function waitReady(): Promise<void> {
  await waitFor('demo-site', () => httpOk(`${DEMO_URL}/robots.txt`), 30_000, () => logTail('demo-site'));
  await waitFor('api /health/ready', () => httpOk(`${API_URL}/api/v1/health/ready`), 60_000, () => logTail('api'));
  await waitFor('web', () => httpOk(`http://127.0.0.1:${PORTS.web}/`), 60_000, () => logTail('web'));
}

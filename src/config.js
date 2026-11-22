import path from 'node:path';

export function loadConfig(env = process.env) {
  const secret = env.APP_SECRET || '';
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || path.resolve('data'),
    appSecret: secret,
    adminPassword: env.ADMIN_PASSWORD || '',
    // Sesja wygasa po bezczynności (minuty)
    sessionMinutes: Number(env.SESSION_MINUTES || 120),
    // Ustaw na "true" tylko gdy aplikacja stoi za HTTPS
    secureCookie: env.SECURE_COOKIE === 'true',
  };
}

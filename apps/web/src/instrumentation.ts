export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadServerConfig } = await import('@flower/core');
    loadServerConfig();
    const { startNotificationWorker } = await import('./server/worker');
    startNotificationWorker();
  }
}

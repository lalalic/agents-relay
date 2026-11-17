// Installation shell only. Dashboard and API behavior remain in dashboard.js.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost','127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {});
  });
}

// Register only for a top-level phone page, never for an embedded call frame.
export let registration;
if (window.top === window && window.isSecureContext && 'serviceWorker' in navigator) {
    const worker = new URL('./sw.js', import.meta.url);
    registration = navigator.serviceWorker.register(worker, {scope: new URL('./', worker).pathname, updateViaCache: 'none'});
    void registration.catch(error => console.warn('[ACP Phone] PWA registration failed:', error.message));
}

import {registration} from './pwa.js';

const report = document.querySelector('#report');
const log = text => {report.textContent += `${text}\n`;};
window.addEventListener('beforeinstallprompt', () => {
    document.querySelector('#install-status').textContent = 'Chrome предложил установку. Можно установить приложение через меню браузера.';
});
window.addEventListener('appinstalled', () => {
    document.querySelector('#install-status').textContent = 'Браузер сообщил об установке приложения.';
});
log(`Адрес: ${location.href}`);
log(`Браузер: ${navigator.userAgent}`);
log(`Безопасный контекст: ${window.isSecureContext}`);
log(`Service Worker API: ${'serviceWorker' in navigator}`);
log(`Установленный режим: ${['fullscreen', 'standalone', 'minimal-ui'].find(mode => matchMedia(`(display-mode: ${mode})`).matches) || 'browser'}`);
if (!window.isSecureContext) log('Препятствие: нужен HTTPS с сертификатом, которому доверяет телефон.');
if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)) {
    log('Локальный адрес: проверка страницы не подтверждает возможность создания WebAPK облачным сервисом Android.');
}
async function check() {
    try {
        const response = await fetch('./manifest.webmanifest', {cache: 'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        log(`Манифест: HTTP ${response.status}; display=${manifest.display}`);
        const base = response.url;
        const start = await fetch(new URL(manifest.start_url, base), {cache: 'no-store'});
        log(`Стартовая страница: HTTP ${start.status}`);
        for (const icon of manifest.icons ?? []) {
            const image = new Image();
            image.src = new URL(icon.src, base).href;
            await image.decode();
            log(`Иконка ${icon.sizes}: ${image.naturalWidth}×${image.naturalHeight}`);
        }
    } catch (error) {log(`Ошибка файлов PWA: ${error.message}`);}
    if (!registration) return;
    try {
        const worker = await registration;
        log(`Service worker scope: ${worker.scope}`);
        const update = () => log(`Service worker: ${worker.active?.state || worker.installing?.state || worker.waiting?.state || 'нет активного'}`);
        update();
        (worker.installing || worker.active)?.addEventListener('statechange', update);
    } catch (error) {log(`Ошибка регистрации service worker: ${error.message}`);}
}
void check();

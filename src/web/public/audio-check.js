const status = document.querySelector('#status');
const report = document.querySelector('#report');
const output = document.querySelector('#output');
const supportsWebOutput = typeof globalThis.AudioContext?.prototype.setSinkId === 'function';
document.querySelector('#web-output-support').textContent = supportsWebOutput
    ? 'Поддерживается. Для переключения нужен доступный выход в списке ниже.'
    : 'Не поддерживается в этом браузере.';
let context;
let media;
let stream;
let mediaUrl;
let busy = false;
let generation = 0;

function log(message) {
    report.textContent += `${message}\n`;
}

function stop() {
    generation++;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    media?.pause();
    media = undefined;
    if (mediaUrl) URL.revokeObjectURL(mediaUrl);
    mediaUrl = undefined;
    void context?.close().catch(() => {});
    context = undefined;
}

function samples() {
    const rate = 24000;
    const data = new Float32Array(rate);
    for (let i = 0; i < data.length; i++) {
        const envelope = Math.min(1, i / 240, (data.length - i - 1) / 240);
        data[i] = 0.15 * envelope * Math.sin(2 * Math.PI * 440 * i / rate);
    }
    return {rate, data};
}

function wav({rate, data}) {
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const view = new DataView(bytes);
    const label = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    label(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true);
    label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    label(36, 'data'); view.setUint32(40, data.length * 2, true);
    data.forEach((value, i) => view.setInt16(44 + i * 2, Math.round(value * 32767), true));
    return new Blob([bytes], {type: 'audio/wav'});
}

async function refresh() {
    const selected = output.value;
    output.replaceChildren(new Option('Системный выход', ''));
    const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    for (const [index, device] of outputs.entries()) {
        output.add(new Option(device.label || `Выход ${index + 1}`, device.deviceId));
    }
    if ([...output.options].some((option) => option.value === selected)) output.value = selected;
    log(`Доступных выходов: ${outputs.length}. ${outputs.map((device) => device.label || '(без названия)').join(', ')}`);
}

async function test(kind, capture = false) {
    stop();
    const current = generation;
    try {
        // Create and resume within the button gesture, before permission prompts.
        context = new AudioContext();
        const activeContext = context;
        await activeContext.resume();
        if (current !== generation) return;
        if (capture) {
            const acquired = await navigator.mediaDevices.getUserMedia({
                audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true},
            });
            if (current !== generation) {
                acquired.getTracks().forEach((track) => track.stop());
                return;
            }
            stream = acquired;
            await refresh();
        }
        if (current !== generation) return;
        const tone = samples();
        if (kind === 'web') {
            if (output.value) {
                if (activeContext.setSinkId) await activeContext.setSinkId(output.value);
                else log('Выбор выхода Web Audio недоступен; тест использует системный выход.');
            }
            if (current !== generation) return;
            const buffer = activeContext.createBuffer(1, tone.data.length, tone.rate);
            buffer.copyToChannel(tone.data, 0);
            const source = activeContext.createBufferSource();
            source.buffer = buffer;
            source.connect(activeContext.destination);
            await new Promise((resolve) => {
                source.onended = resolve;
                source.start();
                // Closing a context may not emit ended; keep cancellation bounded.
                setTimeout(resolve, 1500);
            });
        } else {
            await activeContext.close();
            if (current !== generation) return;
            context = undefined;
            mediaUrl = URL.createObjectURL(wav(tone));
            media = new Audio(mediaUrl);
            media.volume = 1;
            if (output.value) {
                if (media.setSinkId) await media.setSinkId(output.value);
                else log('Выбор выхода обычного аудио недоступен; тест использует системный выход.');
            }
            if (current !== generation) return;
            const activeMedia = media;
            await new Promise((resolve, reject) => {
                activeMedia.onended = resolve;
                activeMedia.onerror = () => reject(new Error('Ошибка воспроизведения WAV.'));
                activeMedia.play().catch(reject);
                setTimeout(resolve, 3000);
            });
        }
        if (current !== generation) return;
        log(`${kind === 'web' ? 'Web Audio' : 'Обычное аудио'}${capture ? ', режим звонка' : ''}: тест выполнен.`);
        status.textContent = 'Тест завершён. Сравните громкость и расположение динамика.';
    } finally {
        if (current === generation) stop();
    }
}

function action(id, fn) {
    document.querySelector(id).addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try { await fn(); } catch (error) {
            status.textContent = error.message;
            log(`${error.name}: ${error.message}`);
        } finally { busy = false; }
    });
}

action('#web-audio', () => test('web'));
action('#media-audio', () => test('media'));
action('#capture', () => test('web', true));
action('#media-capture', () => test('media', true));
action('#refresh', refresh);
action('#choose', async () => {
    if (!navigator.mediaDevices?.selectAudioOutput) throw new Error('В этой версии Chrome нет диалога выбора аудиовыхода.');
    const device = await navigator.mediaDevices.selectAudioOutput();
    await refresh();
    if (![...output.options].some((option) => option.value === device.deviceId)) {
        output.add(new Option(device.label || 'Выбранный выход', device.deviceId));
    }
    output.value = device.deviceId;
    status.textContent = 'Выход выбран. Запустите тест звука.';
});
document.querySelector('#stop').addEventListener('click', () => {
    stop();
    status.textContent = 'Звук остановлен, тестовый микрофон выключен.';
});
window.addEventListener('pagehide', stop);
document.addEventListener('visibilitychange', () => {if (document.hidden) stop();});
log(navigator.userAgent);
try {
    const fullscreen = localStorage.getItem('acp-phone.fullscreen-diagnostic')
        || sessionStorage.getItem('acp-phone.fullscreen-diagnostic');
    if (fullscreen) {
        log(`Полный экран — последний звонок: ${fullscreen}`);
        const events = JSON.parse(fullscreen);
        const last = events.at(-1);
        document.querySelector('#fullscreen-result').textContent = last.error || ({
            'API-unavailable': 'Браузер не предоставляет Fullscreen API.',
            'not-requested': 'Запрос полного экрана не выполнялся.',
            'installed-fullscreen': 'Приложение запущено в установленном полноэкранном режиме.',
            'waiting-for-audio': 'Ожидается подготовка звука перед запросом полного экрана.',
            'requesting': 'Запрос отправлен, результат ещё не получен.',
            'entered-fullscreen': 'Браузер сообщил о включении полного экрана.',
            'left-fullscreen': 'Браузер вышел из полного экрана во время звонка.',
            'request-resolved': last.active ? 'Браузер подтвердил режим сразу после запроса; состояние после запуска звука ещё не проверено.' : 'Запрос завершился, но полный экран не активен.',
            'after-frame-load': last.active ? 'После загрузки звонка браузер сообщает: полный экран активен.' : 'После загрузки звонка полный экран не активен.',
            'after-audio-ready': last.active ? 'После включения звука браузер сообщает: полный экран активен.' : 'После включения звука полный экран не активен.',
        }[last.result] || last.result);
    }
} catch {}
log(`HTTPS: ${window.isSecureContext}`);
log(`Web Audio выбор выхода: ${supportsWebOutput}`);
log(`Обычное аудио выбор выхода: ${typeof HTMLMediaElement.prototype.setSinkId === 'function'}`);
log(`Диалог выбора выхода: ${typeof navigator.mediaDevices?.selectAudioOutput === 'function'}`);
log(`Audio Session API: ${Boolean(navigator.audioSession)}`);
log(`Датчик приближения (ProximitySensor API): ${typeof globalThis.ProximitySensor === 'function'}`);
void refresh().catch((error) => log(error.message));

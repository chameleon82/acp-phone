/** Browser API: provider credentials and agent configuration stay on the server. */
import {ACP_PHONE_SKINS, isSkin} from './skins.js';
import {createBrowserId} from './browser-id.js';
export {ACP_PHONE_SKINS};

export function createAcpPhone({baseUrl = window.location.origin, skin = 'default', fullscreen = 'auto', keepAwake = true} = {}) {
    if (!isSkin(skin)) throw new TypeError(`Unknown ACP Phone skin: ${skin}`);
    const base = new URL(baseUrl, window.location.href);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    let activeCall;
    return {
        async getContacts({signal} = {}) {
            const response = await fetch(new URL('api/contacts', base), {signal});
            if (!response.ok) throw new Error('Unable to load ACP Phone contacts.');
            const {contacts} = await response.json();
            return contacts;
        },
        openCall(contactId, {onEnd, skin: callSkin = skin, fullscreen: callFullscreen = fullscreen} = {}) {
            if (!isSkin(callSkin)) throw new TypeError(`Unknown ACP Phone skin: ${callSkin}`);
            if (typeof contactId !== 'string' || !contactId.trim()) throw new TypeError('A contact ID is required.');
            if (activeCall) throw new Error('An ACP Phone call is already open.');
            const channel = createBrowserId(crypto);
            const url = new URL('call', base);
            url.searchParams.set('contact', contactId);
            url.searchParams.set('skin', callSkin);
            url.searchParams.set('channel', channel);
            url.searchParams.set('hostOrigin', window.location.origin);
            if (!keepAwake) url.searchParams.set('keepAwake', 'false');
            const dialog = document.createElement('dialog');
            const mobile = window.matchMedia?.('(max-width: 600px), (pointer: coarse)').matches ?? false;
            dialog.setAttribute('aria-label', 'ACP Phone call');
            Object.assign(dialog.style, {padding: '0', border: '0', width: 'min(100vw, 520px)',
                height: 'min(100dvh, 900px)', maxWidth: '100vw', maxHeight: '100dvh',
                overflow: 'hidden', boxSizing: 'border-box', background: '#111827'});
            if (mobile) Object.assign(dialog.style, {inset: '0', margin: '0', width: '100vw',
                height: '100dvh', maxWidth: '100vw', maxHeight: '100dvh', borderRadius: '0'});
            const frame = document.createElement('iframe');
            frame.title = 'ACP Phone call';
            frame.allow = 'microphone; autoplay; screen-wake-lock';
            frame.allowFullscreen = true;
            frame.src = url.href;
            Object.assign(frame.style, {display: 'block', width: '100%', height: '100%', border: '0'});
            const callSurface = document.createElement('div');
            Object.assign(callSurface.style, {width: '100%', height: '100%', background: '#111827'});
            callSurface.append(frame);
            dialog.append(callSurface);
            let closingTimer;
            let finished = false;
            const fullscreenLog = [];
            const recordFullscreen = (result, error) => {
                fullscreenLog.push({result, error: error ? `${error.name}: ${error.message}` : undefined,
                    requested: callFullscreen, mobile, enabled: document.fullscreenEnabled,
                    active: Boolean(document.fullscreenElement),
                    viewport: {width: window.innerWidth, height: window.innerHeight},
                    screen: {width: window.screen?.width, height: window.screen?.height},
                    userActivation: window.navigator?.userActivation?.isActive});
                try {sessionStorage.setItem('acp-phone.fullscreen-diagnostic', JSON.stringify(fullscreenLog.slice(-8)));} catch {}
                try {localStorage.setItem('acp-phone.fullscreen-diagnostic', JSON.stringify(fullscreenLog.slice(-8)));} catch {}
            };
            const fullscreenChanged = () => {
                if (!finished) recordFullscreen(document.fullscreenElement ? 'entered-fullscreen' : 'left-fullscreen');
            };
            document.addEventListener?.('fullscreenchange', fullscreenChanged);
            const originalOverflow = document.body.style.overflow;
            const exitOwnFullscreen = () => {
                if (document.fullscreenElement === callSurface) {
                    try {Promise.resolve(document.exitFullscreen?.()).catch(() => {});} catch {}
                }
            };
            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(closingTimer);
                window.removeEventListener('message', receive);
                document.removeEventListener?.('fullscreenchange', fullscreenChanged);
                exitOwnFullscreen();
                dialog.close();
                dialog.remove();
                document.body.style.overflow = originalOverflow;
                activeCall = undefined;
                onEnd?.({contactId});
            };
            const close = () => {
                if (finished || closingTimer) return;
                frame.contentWindow?.postMessage({type: 'acp-phone.end', channel}, base.origin);
                closingTimer = setTimeout(finish, 2500);
            };
            let fullscreenRequested = false;
            const requestCallFullscreen = () => {
                if (finished || closingTimer || fullscreenRequested) return;
                if (window.matchMedia?.('(display-mode: fullscreen)').matches) {
                    recordFullscreen('installed-fullscreen');
                    return;
                }
                if (!(callFullscreen === true || (callFullscreen === 'auto' && mobile))) {
                    recordFullscreen('not-requested');
                    return;
                }
                fullscreenRequested = true;
                try {
                    recordFullscreen('requesting');
                    if (!callSurface.requestFullscreen) {recordFullscreen('API-unavailable'); return;}
                    Promise.resolve(callSurface.requestFullscreen({navigationUI: 'hide'})).then(() => {
                        recordFullscreen('request-resolved');
                        if (finished) exitOwnFullscreen();
                    }).catch(error => {recordFullscreen('request-rejected', error);});
                } catch (error) {recordFullscreen('request-threw', error);}
            };
            const receive = event => {
                if (event.origin !== base.origin || event.source !== frame.contentWindow
                    || event.data?.channel !== channel) return;
                if (event.data.type === 'acp-phone.ended') finish();
                if (event.data.type === 'acp-phone.audio-ready') {
                    recordFullscreen('after-audio-ready');
                    requestCallFullscreen();
                }
            };
            frame.addEventListener('load', () => {if (!finished) recordFullscreen('after-frame-load');});
            window.addEventListener('message', receive);
            dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
            document.body.append(dialog);
            document.body.style.overflow = 'hidden';
            activeCall = {close};
            dialog.showModal();
            // Navigation and permission prompts can exit fullscreen. Make one
            // request once audio is ready, while the original click activation
            // is still available; do not consume it before loading the frame.
            recordFullscreen('waiting-for-audio');
            return activeCall;
        },
    };
}

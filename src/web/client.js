/** Browser API: provider credentials and agent configuration stay on the server. */
export function createAcpPhone({baseUrl = window.location.origin} = {}) {
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
        openCall(contactId, {onEnd} = {}) {
            if (typeof contactId !== 'string' || !contactId.trim()) throw new TypeError('A contact ID is required.');
            if (activeCall) throw new Error('An ACP Phone call is already open.');
            const channel = crypto.randomUUID();
            const url = new URL('call', base);
            url.searchParams.set('contact', contactId);
            url.searchParams.set('channel', channel);
            url.searchParams.set('hostOrigin', window.location.origin);
            const dialog = document.createElement('dialog');
            dialog.setAttribute('aria-label', 'ACP Phone call');
            Object.assign(dialog.style, {padding: '0', border: '0', width: 'min(100vw, 520px)',
                height: 'min(100dvh, 900px)', maxWidth: '100vw', maxHeight: '100dvh',
                overflow: 'hidden', boxSizing: 'border-box', background: '#111827'});
            const frame = document.createElement('iframe');
            frame.title = 'ACP Phone call';
            frame.allow = 'microphone; autoplay';
            frame.src = url.href;
            Object.assign(frame.style, {display: 'block', width: '100%', height: '100%', border: '0'});
            dialog.append(frame);
            let closingTimer;
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                clearTimeout(closingTimer);
                window.removeEventListener('message', receive);
                dialog.close();
                dialog.remove();
                activeCall = undefined;
                onEnd?.({contactId});
            };
            const close = () => {
                if (finished || closingTimer) return;
                frame.contentWindow?.postMessage({type: 'acp-phone.end', channel}, base.origin);
                closingTimer = setTimeout(finish, 2500);
            };
            const receive = event => {
                if (event.origin !== base.origin || event.source !== frame.contentWindow
                    || event.data?.channel !== channel) return;
                if (event.data.type === 'acp-phone.ended') finish();
            };
            window.addEventListener('message', receive);
            dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
            document.body.append(dialog);
            activeCall = {close};
            dialog.showModal();
            return activeCall;
        },
    };
}

export function createThinkingAudio({present, synthesize, synthesizeStream}) {
    return async ({transcript = '', draft = '', previous = '', language = 'en', signal, onAudio}) => {
        const text = (await present({transcript, draft, previous, language, signal}))?.trim();
        if (!text || text.length > 180) throw new Error('Invalid waiting acknowledgement.');
        signal?.throwIfAborted();
        if (synthesizeStream && onAudio) {
            let first = true;
            for await (const audio of synthesizeStream({text, signal, speed: 1.1})) {
                signal?.throwIfAborted();
                await onAudio({text: first ? text : '', contentType: audio.contentType,
                    encoding: audio.encoding, sampleRate: audio.sampleRate, audioBase64: audio.bytes.toString('base64')});
                first = false;
            }
            return;
        }
        const audio = await synthesize({text, signal});
        return {text, contentType: audio.contentType, audioBase64: audio.bytes.toString('base64')};
    };
}

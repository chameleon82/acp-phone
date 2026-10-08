import OpenAI from 'openai';

const DEFAULTS = {
    transcriptionModel: 'gpt-4o-mini-transcribe',
    presentationModel: 'gpt-4.1-mini',
    ttsModel: 'gpt-4o-mini-tts',
    voice: 'marin',
    responseFormat: 'mp3',
};

/** Creates independent OpenAI ports for transcription, spoken-text preparation, and synthesis. */
export function createOpenAiSpeechAdapters({apiKey, baseURL, ...options}) {
    if (!apiKey) throw new TypeError('An OpenAI API key is required.');
    const client = new OpenAI({apiKey, ...(baseURL ? {baseURL} : {})});
    const config = {...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== ''))};

    return {
        speechToText: {
            async transcribe({audio, locale, signal}) {
                const file = new File([audio.bytes], audio.filename, {type: audio.contentType});
                const result = await client.audio.transcriptions.create({
                    file,
                    model: config.transcriptionModel,
                    ...(locale ? {language: locale} : {}),
                }, requestOptions(signal));
                return result.text;
            },
        },
        replyPresenter: createOpenAiReplyPresenter({client, ...config}),
        textToSpeech: {
            async synthesize({text, signal}) {
                const response = await client.audio.speech.create({
                    model: config.ttsModel,
                    voice: config.voice,
                    input: text,
                    response_format: config.responseFormat,
                }, requestOptions(signal));
                return {
                    bytes: Buffer.from(await response.arrayBuffer()),
                    contentType: contentTypeFor(config.responseFormat),
                    filename: `agent-reply.${config.responseFormat}`,
                };
            },
        },
    };
}

export function createOpenAiReplyPresenter({client, presentationModel = DEFAULTS.presentationModel}) {
    if (!client?.responses?.create) throw new TypeError('An OpenAI client with responses.create is required.');

    return {
        async present({agentText, maxCharacters, signal}) {
            const response = await client.responses.create({
                model: presentationModel,
                instructions: [
                    'Rewrite the supplied ACP agent response for natural speech.',
                    `Keep it at or below ${maxCharacters} characters.`,
                    'Preserve concrete instructions, caveats, values, decisions, and uncertainty.',
                    'Do not add facts, promises, or advice not present in the source.',
                    'Return only the spoken response.',
                ].join(' '),
                input: agentText,
            }, requestOptions(signal));
            return response.output_text;
        },
    };
}

export function createDeterministicReplyPresenter() {
    return {
        async present({agentText, maxCharacters}) {
            if (agentText.length <= maxCharacters) return agentText;
            const excerpt = agentText.slice(0, Math.max(0, maxCharacters - 1));
            const ending = excerpt.lastIndexOf(' ');
            return `${(ending > 0 ? excerpt.slice(0, ending) : excerpt).trim()}…`;
        },
    };
}

function requestOptions(signal) {
    return signal ? {signal} : undefined;
}

function contentTypeFor(format) {
    return {
        aac: 'audio/aac',
        flac: 'audio/flac',
        mp3: 'audio/mpeg',
        opus: 'audio/ogg',
        pcm: 'audio/pcm',
        wav: 'audio/wav',
    }[format] ?? 'application/octet-stream';
}

export class VoiceCallError extends Error {
    constructor(message, {code = 'VOICE_CALL_FAILED', cause, status = 500} = {}) {
        super(message, {cause});
        this.name = 'VoiceCallError';
        this.code = code;
        this.status = status;
    }
}

export class ValidationError extends VoiceCallError {
    constructor(message) {
        super(message, {code: 'INVALID_REQUEST', status: 400});
        this.name = 'ValidationError';
    }
}

export class TargetNotFoundError extends VoiceCallError {
    constructor(targetId) {
        super(`The ACP target "${targetId}" is not available.`, {
            code: 'ACP_TARGET_NOT_FOUND',
            status: 404,
        });
        this.name = 'TargetNotFoundError';
    }
}

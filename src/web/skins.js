export const ACP_PHONE_SKINS = Object.freeze([
    Object.freeze({id: 'default', label: 'ACP Phone'}),
    Object.freeze({id: 'telegram', label: 'Telegram'}),
    Object.freeze({id: 'whatsapp', label: 'WhatsApp'}),
    Object.freeze({id: 'matrix', label: 'Matrix'}),
]);

export function isSkin(value) {
    return ACP_PHONE_SKINS.some(skin => skin.id === value);
}

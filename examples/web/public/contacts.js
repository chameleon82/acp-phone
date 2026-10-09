import {createAcpPhone, ACP_PHONE_SKINS} from '/acp-phone.js';

const phone = createAcpPhone();
const list = document.querySelector('#agent-list');
const status = document.querySelector('#contacts-status');
const skinSelect = document.querySelector('#skin');
for (const skin of ACP_PHONE_SKINS) skinSelect.add(new Option(skin.label, skin.id));
try {
    const saved = localStorage.getItem('acp-phone.skin');
    if (ACP_PHONE_SKINS.some(skin => skin.id === saved)) skinSelect.value = saved;
} catch {}
skinSelect.addEventListener('change', () => {
    try {localStorage.setItem('acp-phone.skin', skinSelect.value);} catch {}
});
try {
    const contacts = await phone.getContacts();
    status.textContent = contacts.length ? 'Choose an agent to start a call.' : 'No agents configured.';
    for (const contact of contacts) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-contact';
        const icon = document.createElement('span');
        icon.className = 'contact-avatar';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = contact.label.split(/\s+/).map(word => word[0]).join('').slice(0, 2).toUpperCase();
        const name = document.createElement('span');
        name.className = 'contact-name';
        name.textContent = contact.label;
        const action = document.createElement('span');
        action.className = 'contact-action';
        action.textContent = 'Call';
        button.append(icon, name, action);
        button.addEventListener('click', () => {
            try {
                phone.openCall(contact.id, {skin: skinSelect.value, onEnd: () => button.focus()});
            } catch (error) {status.textContent = error.message;}
        });
        list.append(button);
    }
} catch (error) {status.textContent = error.message;}

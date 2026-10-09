import assert from 'node:assert/strict';
import test from 'node:test';
import {animateMatrixNotes} from '../src/web/public/matrix-notes.js';

test('Matrix retains its rain through new text and interruption, then adds the next spoken reply', () => {
    function element() {
        return {
            children: [], style: {setProperty() {}}, classList: {add() {}, remove() {}},
            set textContent(value) {this.text = value; this.firstChild = {textContent: value};},
            get textContent() {return this.text ?? '';},
            setAttribute() {},
            append(child) {child.parentElement = this; this.children.push(child);},
            remove() {
                if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            },
        };
    }
    const host = element();
    const notes = element();
    host.append(notes);
    notes.scrollHeight = 300;
    notes.scrollTop = 0;
    notes.querySelector = () => element();
    notes.getBoundingClientRect = () => ({top: 0, bottom: 300, left: 0, height: 300});
    let update;
    let disconnected = false;
    const sources = [{textContent: 'Hello'}, {textContent: 'First answer'}];
    const controller = animateMatrixNotes({
        notes, sources,
        document: {createElement: element, createRange: () => ({setStart() {}, setEnd() {},
            getBoundingClientRect: () => ({top: 30, bottom: 44, left: 10, width: 8, height: 14})})},
        MutationObserver: class {
            constructor(callback) {update = callback;}
            observe() {}
            disconnect() {disconnected = true;}
        },
    });
    try {
        controller.dissolve();
        const rain = host.children.find(child => child.className === 'matrix-rain');
        const column = rain.children.find(child => child.className === 'matrix-rain-column');
        assert.ok(column);
        const originalHeads = rain.children.find(child => child.className === 'matrix-rain-heads');
        sources[1].textContent = 'Second answer';
        update();
        controller.cancel();
        assert.ok(host.children.includes(rain));
        assert.ok(rain.children.includes(originalHeads));
        const background = notes.children.find(child => child.className === 'matrix-background-text');
        assert.equal(background.style.opacity, '');
        assert.equal(background.children[1].textContent, 'Second answer');
        controller.dissolve();
        assert.equal(host.children.filter(child => child.className === 'matrix-rain').length, 1);
        assert.ok(rain.children.includes(column));
        assert.equal(rain.children.filter(child => child.className === 'matrix-rain-heads').length, 2);
        assert.equal(sources[1].textContent, 'Second answer');
    } finally {controller.destroy();}
    assert.equal(disconnected, true);
    assert.equal(host.children.some(child => child.className === 'matrix-rain'), false);
});

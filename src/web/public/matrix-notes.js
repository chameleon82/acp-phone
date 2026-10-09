/** Decorative copy: original transcripts remain intact for call logic and accessibility. */
export function animateMatrixNotes({document, MutationObserver, notes, sources, reducedMotion = false}) {
    const randomBetween = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);
    const background = document.createElement('div');
    background.className = 'matrix-background-text';
    background.setAttribute('aria-hidden', 'true');
    notes.append(background);
    notes.querySelector('dl').classList.add('sr-only');
    const paragraphs = sources.map(() => {
        const paragraph = document.createElement('p');
        background.append(paragraph);
        return paragraph;
    });
    const previous = [];
    let rain;
    const columns = new Map();
    const cleanupTimers = new Set();
    const activeLetters = new Set();
    let characterPool = [];
    let mutationTimer;
    let destroyed = false;

    function replaceCharacter(character) {
        const choices = characterPool.filter(candidate => candidate !== character);
        return choices[Math.floor(Math.random() * choices.length)] ?? character;
    }
    function changeOneSymbol(text) {
        const symbols = text.split('\n');
        const index = Math.floor(Math.random() * symbols.length);
        symbols[index] = replaceCharacter(symbols[index]);
        return symbols.join('\n');
    }
    function scheduleCharacterChanges() {
        if (destroyed || mutationTimer !== undefined || !columns.size) return;
        mutationTimer = setTimeout(() => {
            mutationTimer = undefined;
            if (destroyed) return;
            if (document.visibilityState !== 'hidden') {
                // Update only a few symbols; changing entire columns at once
                // would make the background flash again.
                const candidates = [...columns.values()];
                const changes = Math.min(25, candidates.length);
                for (let i = 0; i < changes; i++) {
                    const index = Math.floor(Math.random() * candidates.length);
                    const [column] = candidates.splice(index, 1);
                    column.textContent = changeOneSymbol(column.textContent);
                }
                const letters = [...activeLetters];
                if (letters.length) {
                    const letter = letters[Math.floor(Math.random() * letters.length)];
                    const character = replaceCharacter(letter.textContent);
                    letter.textContent = character;
                    letter.setAttribute('data-character', character);
                    letter.setAttribute('data-trail', changeOneSymbol(letter.getAttribute('data-trail')));
                }
            }
            scheduleCharacterChanges();
        }, randomBetween(250, 550));
        mutationTimer.unref?.();
    }
    function cancel() {
        background.style.opacity = '';
        notes.parentElement.classList.add('matrix-reading');
    }
    function render() {
        const changed = sources.some((source, index) => previous[index] !== source.textContent.slice(-2000));
        if (!changed) return;
        cancel();
        sources.forEach((source, index) => {
            const text = source.textContent.slice(-2000);
            previous[index] = text;
            paragraphs[index].textContent = text;
        });
        notes.scrollTop = notes.scrollHeight;
    }
    function dissolve() {
        if (reducedMotion) return;
        render(); // Include final text even when its observer callback is still pending.
        cancel();
        const bounds = notes.getBoundingClientRect();
        const range = document.createRange();
        if (!rain) {
            rain = document.createElement('div');
            rain.className = 'matrix-rain';
            rain.setAttribute('aria-hidden', 'true');
            notes.parentElement.append(rain);
        }
        const rainBounds = rain.getBoundingClientRect();
        const columnStep = 12;
        const characters = [];
        const headsPerColumn = new Map();
        const fallingLetters = document.createElement('div');
        fallingLetters.className = 'matrix-rain-heads';
        let count = 0;
        for (const paragraph of paragraphs) {
            const node = paragraph.firstChild;
            if (!node) continue;
            let offset = 0;
            for (const character of paragraph.textContent) {
                const end = offset + character.length;
                range.setStart(node, offset);
                range.setEnd(node, end);
                offset = end;
                if (!/[\p{L}\p{N}]/u.test(character)) continue;
                const rect = range.getBoundingClientRect();
                if (rect.bottom < bounds.top || rect.top > bounds.bottom || count >= 96) continue;
                characters.push(character);
                const headColumn = Math.floor((rect.left - rainBounds.left) / columnStep);
                const heads = headsPerColumn.get(headColumn) ?? 0;
                if (heads >= 2) continue;
                headsPerColumn.set(headColumn, heads + 1);
                const trailLength = Math.ceil(rainBounds.height / Math.max(rect.height, 12)) + 2;
                const letter = document.createElement('span');
                letter.className = 'matrix-rain-letter';
                letter.textContent = character;
                letter.setAttribute('data-character', character);
                letter.setAttribute('data-trail', Array(trailLength).fill(character).join('\n'));
                letter.style.left = `${rect.left - rainBounds.left}px`;
                letter.style.top = `${rect.top - rainBounds.top}px`;
                letter.style.setProperty('--rain-distance', `${rainBounds.height * 2 + 80}px`);
                letter.style.setProperty('--rain-duration', `${randomBetween(24, 36)}s`);
                letter.style.setProperty('--rain-delay', `${randomBetween(0, 1.5)}s`);
                letter.style.setProperty('--rain-shimmer-duration', `${randomBetween(1.3, 3)}s`);
                letter.style.setProperty('--trail-shimmer-duration', `${randomBetween(2, 4.5)}s`);
                letter.style.setProperty('--shimmer-delay', `${-randomBetween(0, 5)}s`);
                fallingLetters.append(letter);
                activeLetters.add(letter);
                count++;
            }
        }
        if (!count) {cancel(); return;}
        characterPool = [...new Set([...characters, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'])];
        // Keep persistent rain across the whole viewport, including the call's side padding.
        const columnCount = Math.ceil(rainBounds.width / columnStep);
        const trailLength = Math.ceil(rainBounds.height / 12) + 4;
        for (const [key, column] of columns) {
            if (key >= columnCount) {column.remove(); columns.delete(key);}
        }
        for (let key = 0; key < columnCount; key++) {
            const character = characters[key % characters.length];
            let column = columns.get(key);
            if (!column) {
                column = document.createElement('span');
                column.className = 'matrix-rain-column';
                column.style.top = '0px';
                column.style.setProperty('--column-appear-duration', `${randomBetween(5, 9)}s`);
                column.style.setProperty('--column-shimmer-duration', `${randomBetween(3.5, 7)}s`);
                column.style.setProperty('--column-shimmer-delay', `${-randomBetween(0, 8)}s`);
                rain.append(column);
                columns.set(key, column);
            }
            column.style.left = `${key * columnStep}px`;
            column.textContent = Array(trailLength).fill(character).join('\n');
        }
        rain.append(fallingLetters);
        scheduleCharacterChanges();
        background.style.opacity = '0';
        notes.parentElement.classList.remove('matrix-reading');
        // Completed letters leave their persistent columns behind, without accumulating DOM forever.
        const timer = setTimeout(() => {
            for (const letter of fallingLetters.children) activeLetters.delete(letter);
            fallingLetters.remove();
            cleanupTimers.delete(timer);
        }, 38000);
        timer.unref?.();
        cleanupTimers.add(timer);
    }
    const observer = new MutationObserver(render);
    for (const source of sources) observer.observe(source, {childList: true, characterData: true, subtree: true});
    render();
    return {dissolve, cancel, destroy() {
        destroyed = true;
        clearTimeout(mutationTimer);
        mutationTimer = undefined;
        activeLetters.clear();
        observer.disconnect();
        for (const timer of cleanupTimers) clearTimeout(timer);
        cleanupTimers.clear();
        rain?.remove();
        rain = undefined;
        columns.clear();
        notes.parentElement.classList.remove('matrix-reading');
    }};
}

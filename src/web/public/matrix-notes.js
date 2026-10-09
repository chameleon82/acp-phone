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
        const fallingLetters = document.createElement('div');
        fallingLetters.className = 'matrix-rain-heads';
        let count = 0;
        const updatedColumns = new Set();
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
                if (rect.bottom < bounds.top || rect.top > bounds.bottom || count >= 400) continue;
                const columnKey = Math.round((rect.left - bounds.left) / Math.max(rect.width, 1));
                const trailLength = Math.ceil(bounds.height / Math.max(rect.height, 12)) + 2;
                if (!columns.has(columnKey)) {
                    const column = document.createElement('span');
                    column.className = 'matrix-rain-column';
                    column.textContent = Array(trailLength + 2).fill(character).join('\n');
                    column.style.left = `${rect.left - bounds.left}px`;
                    column.style.top = '0px';
                    column.style.setProperty('--column-delay', `${-randomBetween(0, 8)}s`);
                    column.style.setProperty('--column-flow-duration', `${randomBetween(2.8, 5.5)}s`);
                    column.style.setProperty('--column-shimmer-duration', `${randomBetween(3.5, 7)}s`);
                    column.style.setProperty('--column-appear-duration', `${randomBetween(5, 9)}s`);
                    const hue = randomBetween(120, 150);
                    column.style.setProperty('--column-dark', `hsl(${hue} 40% 24%)`);
                    column.style.setProperty('--column-green', `hsl(${hue} 40% 43%)`);
                    column.style.setProperty('--column-light', `hsl(${hue} 65% 82%)`);
                    rain.append(column);
                    columns.set(columnKey, column);
                } else if (!updatedColumns.has(columnKey)) {
                    columns.get(columnKey).textContent = Array(trailLength + 2).fill(character).join('\n');
                }
                updatedColumns.add(columnKey);
                const letter = document.createElement('span');
                letter.className = 'matrix-rain-letter';
                letter.textContent = character;
                letter.setAttribute('data-character', character);
                letter.setAttribute('data-trail', Array(trailLength).fill(character).join('\n'));
                letter.style.left = `${rect.left - bounds.left}px`;
                letter.style.top = `${rect.top - bounds.top}px`;
                letter.style.setProperty('--rain-distance', `${bounds.height * 2 + 80}px`);
                letter.style.setProperty('--rain-duration', `${randomBetween(24, 36)}s`);
                letter.style.setProperty('--rain-delay', `${randomBetween(0, 1.5)}s`);
                letter.style.setProperty('--rain-shimmer-duration', `${randomBetween(1.3, 3)}s`);
                letter.style.setProperty('--trail-shimmer-duration', `${randomBetween(2, 4.5)}s`);
                fallingLetters.append(letter);
                count++;
            }
        }
        if (!count) {cancel(); return;}
        rain.append(fallingLetters);
        background.style.opacity = '0';
        notes.parentElement.classList.remove('matrix-reading');
        // Completed letters leave their persistent columns behind, without accumulating DOM forever.
        const timer = setTimeout(() => {fallingLetters.remove(); cleanupTimers.delete(timer);}, 38000);
        timer.unref?.();
        cleanupTimers.add(timer);
    }
    const observer = new MutationObserver(render);
    for (const source of sources) observer.observe(source, {childList: true, characterData: true, subtree: true});
    render();
    return {dissolve, cancel, destroy() {
        observer.disconnect();
        for (const timer of cleanupTimers) clearTimeout(timer);
        cleanupTimers.clear();
        rain?.remove();
        rain = undefined;
        columns.clear();
        notes.parentElement.classList.remove('matrix-reading');
    }};
}

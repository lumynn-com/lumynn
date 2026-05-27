import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownToState } from '../markdownToState';

interface StateLike {
    name: string;
    text?: string;
    meta?: { checked?: boolean; loose?: boolean };
    children?: StateLike[];
}

function generate(markdown: string): StateLike[] {
    return new MarkdownToState({
        footnote: false,
        math: false,
        isGitlabCompatibilityEnabled: false,
        trimUnnecessaryCodeBlockEmptyLines: false,
        frontMatter: false,
    }).generate(markdown) as unknown as StateLike[];
}

test('MarkdownToState supports loose task lists without keeping checkbox marker text', () => {
    const states = generate(`- [ ] first

- [x] second

- [ ] third
`);

    assert.equal(states.length, 1);
    assert.equal(states[0].name, 'task-list');
    assert.equal(states[0].meta?.loose, true);

    const items = states[0].children ?? [];
    assert.deepEqual(items.map(item => item.meta?.checked), [false, true, false]);
    assert.deepEqual(
        items.map(item => item.children?.find(child => child.name === 'paragraph')?.text),
        ['first', 'second', 'third'],
    );
});

test('MarkdownToState treats empty task list items as task items', () => {
    const states = generate(`- [ ]

- [x]
`);

    assert.equal(states.length, 1);
    assert.equal(states[0].name, 'task-list');

    const items = states[0].children ?? [];
    assert.deepEqual(items.map(item => item.meta?.checked), [false, true]);
    assert.deepEqual(
        items.map(item => item.children?.find(child => child.name === 'paragraph')?.text),
        ['', ''],
    );
});

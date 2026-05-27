import assert from "node:assert/strict";
import test from "node:test";
import { MarkdownToState } from "../markdownToState";

interface StateLike {
  name: string;
  text?: string;
  children?: StateLike[];
}

function parse(markdown: string): StateLike[] {
  return new MarkdownToState({
    footnote: true,
    math: true,
    isGitlabCompatibilityEnabled: true,
    trimUnnecessaryCodeBlockEmptyLines: false,
    frontMatter: true
  }).generate(markdown) as StateLike[];
}

function taskTexts(states: StateLike[]): string[] {
  const texts: string[] = [];

  function visit(node: StateLike): void {
    if (node.name === "task-list-item") {
      texts.push(node.children?.find((child) => child.name === "paragraph")?.text ?? "");
    }
    node.children?.forEach(visit);
  }

  states.forEach(visit);
  return texts;
}

test("Muya reparses loose task lists without keeping checkbox markers as text", () => {
  const states = parse("- [ ] weeqe\n\n- [ ] eqeqwqe\n\n- [ ] kkklll\n");

  assert.deepEqual(taskTexts(states), ["weeqe", "eqeqwqe", "kkklll"]);
});

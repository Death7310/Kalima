// Curriculum tests: every lesson must be well-formed and solvable.
//
// For each lesson, from a fresh boot, every command step's `solution` is typed
// into the simulator and its `check` must pass; `true` typed first must NOT
// pass (a check that is satisfied before the learner does anything is broken).
// Finally the whole curriculum is replayed in one session to catch lessons
// that only work on a pristine machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, load } from './harness.mjs';

const K0 = load({ quiet: true });
const catalogue = K0.lessons.all().map(({ module, lesson }) => ({ moduleId: module.id, id: lesson.id }));

test('curriculum is well-formed', () => {
  const seen = new Set();
  for (const mod of K0.lessons.modules) {
    assert.ok(mod.id && mod.title && mod.summary, `module ${mod.id}: id, title and summary are required`);
    assert.ok(Number.isFinite(mod.order), `module ${mod.id}: numeric order is required`);
    for (const l of mod.lessons) {
      const where = `lesson ${l.id}`;
      assert.ok(l.id && l.title && l.intro, `${where}: id, title and intro are required`);
      assert.ok(!seen.has(l.id), `${where}: duplicate lesson id`);
      seen.add(l.id);
      assert.ok(Array.isArray(l.objectives) && l.objectives.length, `${where}: objectives are required`);
      assert.ok(Array.isArray(l.steps) && l.steps.length, `${where}: steps are required`);
      const stepIds = new Set();
      for (const s of l.steps) {
        assert.ok(s.id && s.prompt, `${where}: every step needs id and prompt`);
        assert.ok(!stepIds.has(s.id), `${where}: duplicate step id ${s.id}`);
        stepIds.add(s.id);
        const kinds = [s.info === true, s.answer != null, s.check != null].filter(Boolean).length;
        assert.equal(kinds, 1, `${where}/${s.id}: a step is exactly one of info, question (answer) or command (check)`);
        if (!s.info) {
          assert.ok(s.solution != null, `${where}/${s.id}: solution is required`);
          assert.ok(s.hint, `${where}/${s.id}: hint is required`);
        }
      }
      for (const q of l.quiz || []) {
        assert.ok(q.q && Array.isArray(q.choices) && q.choices.length >= 2, `${where}: quiz question needs q and choices`);
        assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.choices.length, `${where}: quiz answer index out of range`);
        assert.ok(q.why, `${where}: quiz question needs an explanation (why)`);
      }
    }
  }
});

async function playLesson(sim, lessonId, { strict }) {
  const { K } = sim;
  const { lesson } = K.lessons.get(lessonId);
  let events = [];
  const off = K.events.on('command', (e) => events.push(e));
  try {
    for (const step of lesson.steps) {
      const where = `${lessonId}/${step.id}`;
      if (step.info) continue;
      if (step.answer != null) {
        const answers = Array.isArray(step.solution) ? step.solution : [step.solution];
        for (const a of answers) assert.ok(K.lessons.checkAnswer(step, a), `${where}: answer check rejects its own solution "${a}"`);
        assert.ok(!K.lessons.checkAnswer(step, ''), `${where}: an empty answer must not pass`);
        continue;
      }
      if (strict) {
        events = [];
        await sim.type('true');
        assert.ok(!events.some((e) => K.lessons.check(step.check, e)), `${where}: check passes before the learner has done anything`);
      }
      events = [];
      const lines = Array.isArray(step.solution) ? step.solution : [step.solution];
      if (step.input) sim.term.feed(...step.input);
      let transcript = '';
      for (const line of lines) {
        const r = await sim.type(line);
        transcript += `$ ${line}\n${r.output}`;
      }
      sim.term.inputs.length = 0;
      assert.ok(events.some((e) => K.lessons.check(step.check, e)),
        `${where}: solution does not satisfy the check\n--- transcript ---\n${transcript.slice(-1500)}`);
      assert.doesNotMatch(transcript, /simulator error/, `${where}: solution triggers a simulator error`);
    }
  } finally { off(); }
}

for (const { id } of catalogue) {
  test(`lesson ${id} is solvable from a fresh boot`, async () => {
    const sim = await boot({ quiet: true });
    await playLesson(sim, id, { strict: true });
  });
}

test('the whole curriculum can be played in order in one session', async () => {
  const sim = await boot({ quiet: true });
  for (const { id } of catalogue) await playLesson(sim, id, { strict: false });
});

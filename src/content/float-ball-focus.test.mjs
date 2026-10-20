import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { focusSearchInputWhenVisible } from './src/content/float-ball.ts';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { focusSearchInputWhenVisible } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const makeHarness = ({ disabled = false, visible = true, activeElement = null } = {}) => {
  const frames = [];
  let focusCount = 0;
  let blurCount = 0;
  const root = { activeElement };
  const input = {
    disabled,
    getRootNode: () => root,
    focus: () => {
      focusCount += 1;
      root.activeElement = input;
    },
    blur: () => {
      blurCount += 1;
      root.activeElement = null;
    },
  };
  const overlay = { classList: { contains: (name) => name === 'visible' && visible } };
  const trigger = {};
  const scheduleFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  return {
    frames,
    input,
    overlay,
    trigger,
    scheduleFrame,
    get focusCount() { return focusCount; },
    get blurCount() { return blurCount; },
    set visible(value) { visible = value; },
    set activeElement(value) { root.activeElement = value; },
  };
};

const flushFrame = (harness) => harness.frames.shift()();

test('focuses the idle search input only after the overlay has rendered visible', () => {
  const harness = makeHarness();

  focusSearchInputWhenVisible(
    harness.input,
    harness.overlay,
    harness.trigger,
    harness.scheduleFrame,
  );

  assert.equal(harness.focusCount, 0);
  flushFrame(harness);
  assert.equal(harness.focusCount, 0);
  flushFrame(harness);
  assert.equal(harness.focusCount, 1);
});

test('retries focus when recorder audit/task-end rendering enables the input later', () => {
  const harness = makeHarness({ disabled: true });

  focusSearchInputWhenVisible(
    harness.input,
    harness.overlay,
    harness.trigger,
    harness.scheduleFrame,
  );
  flushFrame(harness);
  flushFrame(harness);
  assert.equal(harness.focusCount, 0);

  harness.input.disabled = false;
  flushFrame(harness);
  assert.equal(harness.focusCount, 1);
});

test('does not steal focus from another control and does not focus after close', () => {
  const otherControl = {};
  const harness = makeHarness({ activeElement: otherControl });

  focusSearchInputWhenVisible(
    harness.input,
    harness.overlay,
    harness.trigger,
    harness.scheduleFrame,
  );
  flushFrame(harness);
  flushFrame(harness);
  assert.equal(harness.focusCount, 0);

  harness.visible = false;
  harness.input.blur();
  focusSearchInputWhenVisible(
    harness.input,
    harness.overlay,
    harness.trigger,
    harness.scheduleFrame,
  );
  flushFrame(harness);
  assert.equal(harness.focusCount, 0);
  assert.equal(harness.blurCount, 1);
});

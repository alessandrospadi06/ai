'use strict';

// Guards the most likely regressions when editing this shader:
//  - a uniform used in GLSL but never wired from JS (or vice-versa)
//  - an attribute read in JS (this.x) that was never registered
//  - the spectral-dispersion IOR / key-light math in _applyUniforms

const test = require('node:test');
const assert = require('node:assert');
const { loadScript } = require('./helpers/loadScript');

const { DiamondRefractive, source, attributes, createMockPc } = loadScript();

const FRAG = DiamondRefractive.MAIN_FRAG;

// Every `uXyz` token referenced in the fragment shader.
const usedUniforms = new Set((FRAG.match(/\bu[A-Z][A-Za-z0-9]*/g) || []));
// Every `setParameter('uXyz', ...)` target anywhere in the JS.
const wiredUniforms = new Set(
  [...source.matchAll(/setParameter\(\s*'(u[A-Za-z0-9]+)'/g)].map((m) => m[1])
);

test('every uniform used in MAIN_FRAG is wired via setParameter', () => {
  const missing = [...usedUniforms].filter((u) => !wiredUniforms.has(u));
  assert.deepStrictEqual(missing, [], `unwired uniforms: ${missing.join(', ')}`);
});

test('every setParameter target is actually declared/used in MAIN_FRAG', () => {
  const orphan = [...wiredUniforms].filter((u) => !usedUniforms.has(u));
  assert.deepStrictEqual(orphan, [], `orphan setParameter calls: ${orphan.join(', ')}`);
});

test('legacy per-channel IOR uniforms were fully removed', () => {
  for (const dead of ['uIorR', 'uIorG', 'uIorB']) {
    assert.ok(!new RegExp('\\b' + dead + '\\b').test(source), `stale reference to ${dead}`);
  }
});

test('fragment shader implements the new realism features', () => {
  for (const token of ['spectrumRGB', 'iorAt', 'traceChannel', 'proceduralEnv', 'uKeyDir', 'uSaturation', 'uAbsorption']) {
    assert.ok(FRAG.includes(token), `MAIN_FRAG missing "${token}"`);
  }
});

// Known non-attribute `this.*` members (runtime state + methods).
const RUNTIME_MEMBERS = new Set([
  'app', 'entity', 'on',
  '_time', '_cam', '_rt', '_tex', '_layer', '_prepassCam', '_prepassMat',
  '_mainMat', '_proxies', '_dummy',
  'initialize', 'update', '_applyUniforms', '_makeRenderTarget', '_onDestroy'
]);

test('every attribute read via this.<name> is a registered attribute', () => {
  const reads = new Set([...source.matchAll(/this\.([a-zA-Z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const unknown = [...reads].filter((name) => {
    if (RUNTIME_MEMBERS.has(name)) return false;
    if (name.startsWith('_')) return false;
    return !(name in attributes);
  });
  assert.deepStrictEqual(unknown, [], `this.<x> with no matching attribute: ${unknown.join(', ')}`);
});

test('key attributes keep sensible defaults', () => {
  assert.strictEqual(attributes.iorBase.default, 2.417);
  assert.strictEqual(attributes.dispersionSamples.default, 4);
  assert.strictEqual(attributes.dispersionSamples.precision, 0);
  assert.ok(attributes.saturation.default > 1);
  assert.ok(attributes.studioContrast.default > 1);
  assert.ok('keyLightIntensity' in attributes);
  assert.ok('absorption' in attributes);
});

// ── Behavioural: _applyUniforms with mocked attribute values + material ──
function makeInstance(overrides) {
  const pc = createMockPc();
  const inst = Object.create(DiamondRefractive.prototype);
  inst.app = { scene: { skybox: null }, graphicsDevice: {} };
  inst._mainMat = new pc.ShaderMaterial({});
  inst._tex = { id: 'tex' };
  // Defaults for every registered attribute (rgb → {r,g,b}).
  for (const [name, opts] of Object.entries(attributes)) {
    if (opts.type === 'rgb') {
      const d = opts.default || [1, 1, 1];
      inst[name] = { r: d[0], g: d[1], b: d[2] };
    } else if (opts.type === 'number' || opts.type === 'boolean') {
      inst[name] = opts.default;
    }
  }
  Object.assign(inst, overrides);
  return inst;
}

test('_applyUniforms wires dispersion + spectral sample count', () => {
  const inst = makeInstance({ iorBase: 2.42, dispersion: 3.0, dispersionSamples: 6.4 });
  inst._applyUniforms();
  const p = inst._mainMat.params;
  assert.strictEqual(p.uIorBase, 2.42);
  assert.strictEqual(p.uDispersion, 3.0);
  assert.strictEqual(p.uDispSamples, 6); // rounded integer
  assert.ok(inst._mainMat.updates >= 1);
});

test('_applyUniforms clamps spectral samples to >= 1', () => {
  const inst = makeInstance({ dispersionSamples: 0 });
  inst._applyUniforms();
  assert.strictEqual(inst._mainMat.params.uDispSamples, 1);
});

test('_applyUniforms builds a unit-length key-light direction', () => {
  const inst = makeInstance({ keyAzimuth: 0.7, keyElevation: 0.6 });
  inst._applyUniforms();
  const d = inst._mainMat.params.uKeyDir;
  const len = Math.hypot(d[0], d[1], d[2]);
  assert.ok(Math.abs(len - 1) < 1e-6, `key dir not unit length: ${len}`);
});

test('_applyUniforms uses procedural fallback when no envMap/skybox', () => {
  const inst = makeInstance({});
  inst._applyUniforms();
  assert.strictEqual(inst._mainMat.params.uHasEnv, false);
});

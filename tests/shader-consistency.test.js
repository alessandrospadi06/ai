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

test('facet walk is the size-invariant ray-march (gem radius scaled, no fixed-world spiral)', () => {
  assert.ok(FRAG.includes('uGemRadius'), 'expected uGemRadius (bounding-radius scale)');
  assert.ok(FRAG.includes('uFacetWalk'), 'expected uFacetWalk (march fraction)');
  assert.ok(FRAG.includes('worldToUV'), 'expected screen-space projection of the marched point');
  assert.ok(!FRAG.includes('uFacetStep'), 'stale fixed-world spiral step still present');
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

test('attribute set is the small master-control surface', () => {
  // The 6 core sliders + env/misc — and nothing more (parameters were reduced).
  const expected = [
    'mainCamera', 'envMap',
    'ior', 'fire', 'brilliance', 'sparkle', 'exposure', 'facetScale',
    'envBrightness', 'envRotation', 'bodyTint',
    'autoRotateSpeed', 'showBackNormals'
  ].sort();
  assert.deepStrictEqual(Object.keys(attributes).sort(), expected);
  assert.strictEqual(attributes.ior.default, 2.417);
  assert.ok(attributes.fire.default > 0);
  assert.ok(attributes.brilliance.default >= 1, 'brilliance default should bias away from glassy');
  // legacy fine-grained knobs are gone
  for (const dead of ['dispersionSamples', 'studioContrast', 'keyLightIntensity', 'absorption', 'facetStep', 'whiteLevel']) {
    assert.ok(!(dead in attributes), `legacy attribute "${dead}" still exposed`);
  }
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

test('"fire" master drives both dispersion strength and spectral sample count', () => {
  const inst = makeInstance({ ior: 2.42, fire: 2.0 });
  inst._applyUniforms();
  const p = inst._mainMat.params;
  assert.strictEqual(p.uIorBase, 2.42);
  assert.ok(Math.abs(p.uDispersion - 3.6) < 1e-9, `uDispersion=${p.uDispersion}`); // 2.0*1.8
  assert.strictEqual(p.uDispSamples, 8); // round(3 + 2.0*2.5)
  assert.ok(inst._mainMat.updates >= 1);
});

test('spectral samples stay in [1,10] across the fire range', () => {
  const lo = makeInstance({ fire: 0 }); lo._applyUniforms();
  assert.strictEqual(lo._mainMat.params.uDispSamples, 3); // round(3 + 0)
  const hi = makeInstance({ fire: 10 }); hi._applyUniforms();
  assert.strictEqual(hi._mainMat.params.uDispSamples, 10); // clamped
});

test('"brilliance" master drives contrast/levels/saturation together', () => {
  const inst = makeInstance({ brilliance: 1.0 });
  inst._applyUniforms();
  const p = inst._mainMat.params;
  assert.ok(Math.abs(p.uContrastBoost - 1.30) < 1e-9);
  assert.ok(Math.abs(p.uSaturation - 1.28) < 1e-9);
  assert.ok(Math.abs(p.uStudioContrast - 1.65) < 1e-9);
  assert.ok(p.uWhite < 0.85, 'higher brilliance should pull the white point down');
});

test('"facetScale" feeds the size-invariant march + gem radius is wired', () => {
  const inst = makeInstance({ facetScale: 0.42 });
  inst._gemRadius = 3.3;
  inst._applyUniforms();
  assert.strictEqual(inst._mainMat.params.uFacetWalk, 0.42);
  assert.strictEqual(inst._mainMat.params.uGemRadius, 3.3);
});

test('_applyUniforms builds a unit-length key-light direction (from envRotation)', () => {
  const inst = makeInstance({ envRotation: 0.7 });
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

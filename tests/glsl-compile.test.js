'use strict';

// Compiles + links every GLSL program in the script against a real (headless)
// WebGL context. Catches syntax / type / varying-mismatch errors that a static
// review would miss. WebGL1 is GLSL ES 1.00 — the same dialect PlayCanvas
// accepts as source before it transpiles to ES 3.00 for WebGL2.

const test = require('node:test');
const assert = require('node:assert');
const createGL = require('gl');
const { loadScript } = require('./helpers/loadScript');

const { DiamondRefractive } = loadScript();

const gl = createGL(16, 16);
// dFdx/dFdy live behind this extension in WebGL1 (core in the WebGL2 PlayCanvas uses).
gl.getExtension('OES_standard_derivatives');
const DERIV_EXT = '#extension GL_OES_standard_derivatives : enable\n';

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
  const log = gl.getShaderInfoLog(sh);
  return { ok, log, sh };
}

function compileAndLink(name, vertSrc, fragSrc, { needsDerivatives = false } = {}) {
  const v = compile(gl.VERTEX_SHADER, vertSrc);
  assert.ok(v.ok, `${name} vertex shader failed to compile:\n${v.log}`);

  const f = compile(gl.FRAGMENT_SHADER, needsDerivatives ? DERIV_EXT + fragSrc : fragSrc);
  assert.ok(f.ok, `${name} fragment shader failed to compile:\n${f.log}`);

  const prog = gl.createProgram();
  gl.attachShader(prog, v.sh);
  gl.attachShader(prog, f.sh);
  // Match the attribute semantics the script declares.
  gl.bindAttribLocation(prog, 0, 'aPosition');
  gl.bindAttribLocation(prog, 1, 'aNormal');
  gl.linkProgram(prog);
  const linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
  assert.ok(linked, `${name} program failed to link:\n${gl.getProgramInfoLog(prog)}`);
}

test('PREPASS program compiles and links', () => {
  compileAndLink('PREPASS', DiamondRefractive.PREPASS_VERT, DiamondRefractive.PREPASS_FRAG);
});

test('MAIN program compiles and links', () => {
  compileAndLink('MAIN', DiamondRefractive.MAIN_VERT, DiamondRefractive.MAIN_FRAG);
});

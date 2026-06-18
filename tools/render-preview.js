'use strict';

// Faithful offscreen smoke-render of the shader using a real headless WebGL
// context and the SAME two-pass pipeline PlayCanvas runs:
//   PASS 1  cull FRONT  → write back-face world normals into an FBO texture
//   PASS 2  cull BACK   → main shader refracts/disperses, sampling that texture
// Geometry is a flat-shaded icosphere (facets → visible fire + salt&pepper).
// Output: a PNG to eyeball dispersion colour, studio contrast and the key flash.
//
//   node tools/render-preview.js [out.png] [W] [H] [dispersionSamples]
//
// This is a DEV tool (not a unit test); it is intentionally not part of `npm test`.

const fs = require('fs');
const zlib = require('zlib');
const createGL = require('gl');
const { loadScript } = require('../tests/helpers/loadScript');

const OUT = process.argv[2] || 'preview.png';
const W = parseInt(process.argv[3] || '640', 10);
const H = parseInt(process.argv[4] || '640', 10);
const DISP = parseInt(process.argv[5] || '6', 10);

const { DiamondRefractive, attributes } = loadScript();

// ───────────────────────────── tiny mat4 helpers (column-major) ──────────────
function ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k];
    o[c*4+r] = s;
  }
  return o;
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
}
function normalize3(v){ const l=Math.hypot(v[0],v[1],v[2])||1; return [v[0]/l,v[1]/l,v[2]/l]; }
function sub3(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; }
function cross3(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot3(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function lookAt(eye, center, up) {
  const z = normalize3(sub3(eye, center));
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
          -dot3(x,eye),-dot3(y,eye),-dot3(z,eye),1];
}
function rotY(a){ const c=Math.cos(a),s=Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }
function rotX(a){ const c=Math.cos(a),s=Math.sin(a); return [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]; }
function mat3from4(m){ return [m[0],m[1],m[2], m[4],m[5],m[6], m[8],m[9],m[10]]; }

// ───────────────────────────── flat-shaded icosphere ─────────────────────────
function icosphere(subdiv) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],
    [0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],
    [t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]
  ].map(normalize3);
  let faces = [
    [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
    [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
    [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]
  ];
  for (let s = 0; s < subdiv; s++) {
    const next = [];
    const mid = {};
    const getMid = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (mid[key] !== undefined) return mid[key];
      const m = normalize3([(verts[a][0]+verts[b][0]), (verts[a][1]+verts[b][1]), (verts[a][2]+verts[b][2])]);
      verts.push(m); return (mid[key] = verts.length - 1);
    };
    for (const [a, b, c] of faces) {
      const ab = getMid(a, b), bc = getMid(b, c), ca = getMid(c, a);
      next.push([a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]);
    }
    faces = next;
  }
  // Flat shading: one normal per triangle, expand to unique vertices.
  const pos = [], nrm = [];
  for (const [a, b, c] of faces) {
    const va = verts[a], vb = verts[b], vc = verts[c];
    const n = normalize3(cross3(sub3(vb, va), sub3(vc, va)));
    for (const v of [va, vb, vc]) { pos.push(v[0], v[1], v[2]); nrm.push(n[0], n[1], n[2]); }
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), count: faces.length * 3 };
}

// ───────────────────────────── PNG encoder (zlib, no deps) ───────────────────
function writePNG(file, width, height, rgba) {
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    // flip vertically (GL origin is bottom-left)
    rgba.copy(raw, y * (width * 4 + 1) + 1, (height - 1 - y) * width * 4, (height - y) * width * 4);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  fs.writeFileSync(file, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ───────────────────────────── GL setup ──────────────────────────────────────
const gl = createGL(W, H, { preserveDrawingBuffer: true });
gl.getExtension('OES_standard_derivatives');
const DERIV = '#extension GL_OES_standard_derivatives : enable\n';

function sh(type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(vs, fs, deriv) {
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, deriv ? DERIV + fs : fs));
  gl.bindAttribLocation(p, 0, 'aPosition'); gl.bindAttribLocation(p, 1, 'aNormal');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const prepass = program(DiamondRefractive.PREPASS_VERT, DiamondRefractive.PREPASS_FRAG, false);
const main = program(DiamondRefractive.MAIN_VERT, DiamondRefractive.MAIN_FRAG, true);

const geo = icosphere(3);
const posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.STATIC_DRAW);
const nrmBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf); gl.bufferData(gl.ARRAY_BUFFER, geo.nrm, gl.STATIC_DRAW);

function bindAttribs() {
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
}

// back-normal render target
const rtTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, rtTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const depthRB = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
const fbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rtTex, 0);
gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);

// matrices
const model = mul(rotY(0.6), rotX(0.35));
const eye = [0, 0, 3.2];
const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
const proj = perspective(45 * Math.PI / 180, W / H, 0.1, 100);
const vp = mul(proj, view);
const nrmMat = mat3from4(model); // pure rotation → normal matrix == upper 3x3

function setMat(prog, name, m) { gl.uniformMatrix4fv(gl.getUniformLocation(prog, name), false, new Float32Array(m)); }
function setMat3(prog, name, m) { gl.uniformMatrix3fv(gl.getUniformLocation(prog, name), false, new Float32Array(m)); }

gl.enable(gl.DEPTH_TEST);

// ── PASS 1: back-face normals ──
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.viewport(0, 0, W, H);
gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.useProgram(prepass);
gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
bindAttribs();
setMat(prepass, 'matrix_model', model); setMat(prepass, 'matrix_viewProjection', vp); setMat3(prepass, 'matrix_normal', nrmMat);
gl.drawArrays(gl.TRIANGLES, 0, geo.count);

// ── PASS 2: main shader ──
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, W, H);
gl.clearColor(0.06, 0.06, 0.07, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
gl.useProgram(main);
gl.cullFace(gl.BACK);
bindAttribs();
setMat(main, 'matrix_model', model); setMat(main, 'matrix_viewProjection', vp); setMat3(main, 'matrix_normal', nrmMat);

const U = (n) => gl.getUniformLocation(main, n);
gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rtTex); gl.uniform1i(U('uBackNormalMap'), 0);
// a dummy cube for the sampler (unused: uHasEnv=false → procedural studio)
const cubeTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex);
for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeTex); gl.uniform1i(U('uEnvMap'), 1);

gl.uniform3fv(U('view_position'), new Float32Array(eye));
gl.uniform2fv(U('uResolution'), new Float32Array([W, H]));
gl.uniform1i(U('uHasEnv'), 0);

const num = (k, d) => (attributes[k] && attributes[k].default !== undefined ? attributes[k].default : d);
gl.uniform1f(U('uEnvBrightness'), num('envBrightness', 0.8));
gl.uniform1f(U('uEnvRotation'), 0);
gl.uniform1f(U('uStudioContrast'), num('studioContrast', 1.6));
gl.uniform1f(U('uIorBase'), num('iorBase', 2.417));
gl.uniform1f(U('uDispersion'), num('dispersion', 2.2));
gl.uniform1i(U('uDispSamples'), DISP);
gl.uniform1f(U('uFresnelBoost'), num('fresnelBoost', 1));
gl.uniform1f(U('uExposure'), num('exposure', 1.5));
gl.uniform1f(U('uContrastBoost'), num('contrastBoost', 1.15));
gl.uniform1f(U('uSaturation'), num('saturation', 1.2));
gl.uniform1f(U('uBlack'), num('blackLevel', 0.02));
gl.uniform1f(U('uWhite'), num('whiteLevel', 0.7));
gl.uniform3fv(U('uBodyTint'), new Float32Array(num('bodyTint', [0.98, 0.99, 1])));
gl.uniform1i(U('uBounces'), num('internalBounces', 4));
gl.uniform1f(U('uFacetDetail'), num('facetDetail', 0.5));
gl.uniform1f(U('uFacetStep'), num('facetStep', 0.1));
gl.uniform1f(U('uAbsorption'), num('absorption', 0.15));
gl.uniform3fv(U('uAbsorptionColor'), new Float32Array(num('absorptionColor', [1, 1, 1])));
const az = num('keyAzimuth', 0.7), el = num('keyElevation', 0.6), ce = Math.cos(el);
gl.uniform3fv(U('uKeyDir'), new Float32Array([ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)]));
gl.uniform3fv(U('uKeyColor'), new Float32Array(num('keyLightColor', [1, 1, 1])));
gl.uniform1f(U('uKeyIntensity'), num('keyLightIntensity', 1.6));
gl.uniform1f(U('uKeySharpness'), num('keyLightSharpness', 900));
gl.uniform1i(U('uSparkleCount'), num('sparkleCount', 12));
gl.uniform1f(U('uSparkleSharpness'), num('sparkleSharpness', 460));
gl.uniform1f(U('uSparkleIntensity'), num('sparkleIntensity', 0.9));
gl.uniform1f(U('uTime'), 0.3);
gl.uniform1i(U('uShowBack'), 0);

gl.drawArrays(gl.TRIANGLES, 0, geo.count);

const pixels = Buffer.alloc(W * H * 4);
gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
writePNG(OUT, W, H, pixels);
console.log('wrote', OUT, W + 'x' + H, 'dispSamples=' + DISP);

'use strict';

// Loads Diamondrefractive.js in a sandbox with a mock PlayCanvas (`pc`) global,
// so the script can be inspected/exercised without the real engine or WebGL.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'Diamondrefractive.js');

function makeDestroyable(obj) {
  obj.destroyed = false;
  obj.destroy = function () { obj.destroyed = true; };
  return obj;
}

// A minimal but faithful mock of the subset of the PlayCanvas API the script uses.
function createMockPc() {
  let layerId = 0;
  const pc = {
    SEMANTIC_POSITION: 'POSITION',
    SEMANTIC_NORMAL: 'NORMAL',
    PIXELFORMAT_RGBA8: 'rgba8',
    FILTER_NEAREST: 'nearest',
    ADDRESS_CLAMP_TO_EDGE: 'clamp',
    CULLFACE_FRONT: 'front',
    CULLFACE_BACK: 'back',

    // Captures the script type + its registered attributes.
    __scriptName: null,
    __scriptType: null,
    __attributes: {},

    createScript(name) {
      pc.__scriptName = name;
      const Script = function () {};
      Script.attributes = {
        add(attrName, opts) { pc.__attributes[attrName] = opts; }
      };
      pc.__scriptType = Script;
      return Script;
    },

    Color: function (r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; },

    Vec3: (function () {
      function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
      Vec3.prototype.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
      Vec3.prototype.add = function (v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; };
      Vec3.prototype.mulScalar = function (s) { this.x *= s; this.y *= s; this.z *= s; return this; };
      return Vec3;
    })(),

    // Column-major 4x4 (matches PlayCanvas). Only what the script needs.
    Mat4: (function () {
      function Mat4() { this.data = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
      Mat4.prototype.mul2 = function (a, b) {
        const A = a.data, B = b.data, o = new Array(16).fill(0);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
          for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
        this.data = o; return this;
      };
      return Mat4;
    })(),

    Texture: function (device, opts) {
      this.device = device;
      Object.assign(this, opts || {});
      makeDestroyable(this);
    },

    RenderTarget: function (opts) {
      Object.assign(this, opts || {});
      makeDestroyable(this);
    },

    Layer: function (opts) {
      Object.assign(this, opts || {});
      this.id = ++layerId;
      this.meshInstances = [];
      this.addMeshInstances = (m) => { this.meshInstances.push.apply(this.meshInstances, m); };
      this.removeMeshInstances = (m) => {
        this.meshInstances = this.meshInstances.filter((x) => m.indexOf(x) === -1);
      };
    },

    Entity: function (name) {
      this.name = name;
      this.children = [];
      this._pos = [0, 0, 0];
      this._rot = [0, 0, 0, 1];
      this.addComponent = (type, opts) => {
        this[type] = Object.assign({ type }, opts || {});
        return this[type];
      };
      this.addChild = (c) => { this.children.push(c); };
      this.setPosition = () => {};
      this.setRotation = () => {};
      this.getPosition = () => this._pos;
      this.getRotation = () => this._rot;
      this.rotateLocal = function () { this._rotated = (this._rotated || 0) + 1; };
      makeDestroyable(this);
    },

    MeshInstance: function (mesh, material, node) {
      this.mesh = mesh; this.material = material; this.node = node;
    },

    ShaderMaterial: function (opts) {
      Object.assign(this, opts || {});
      this.params = {};
      this.updates = 0;
      this.setParameter = (k, v) => { this.params[k] = v; };
      this.update = () => { this.updates++; };
      makeDestroyable(this);
    }
  };
  return pc;
}

function loadScript() {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const pc = createMockPc();
  const consoleErrors = [];
  const sandbox = {
    pc,
    console: {
      error: (...a) => consoleErrors.push(a.join(' ')),
      log: () => {},
      warn: () => {}
    },
    Math
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'Diamondrefractive.js' });

  return {
    pc,
    source,
    consoleErrors,
    DiamondRefractive: sandbox.DiamondRefractive || pc.__scriptType,
    attributes: pc.__attributes,
    createMockPc
  };
}

module.exports = { loadScript, createMockPc, SCRIPT_PATH };

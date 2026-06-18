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

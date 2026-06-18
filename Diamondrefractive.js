/**

 * DiamondRefractive.js — PlayCanvas 2.19.5  |  v5.0 "Two-Pass Real Refraction"

 * Senior Graphics Programmer — WebGL2

 *

 * ═══════════════════════════════════════════════════════════════════════════

 * COS'È CAMBIATO (la differenza vera rispetto a tutte le versioni precedenti)

 * ───────────────────────────────────────────────────────────────────────────

 * Le v3/v4 NON rifrangevano: campionavano solo una cubemap lungo un raggio

 * piegato → sasso lucido. Qui c'è rifrazione VERA, tecnica two-pass (la stessa

 * del tutorial Codrops e degli esempi refraction di PlayCanvas):

 *

 *   PASS 1 (prepass)  → una camera dedicata renderizza SOLO le facce POSTERIORI

 *                       della gemma (cull FRONT) e scrive la loro NORMALE reale

 *                       in un Render Target. Così il pass principale sa dove e

 *                       come è orientata la superficie interna lontana.

 *

 *   PASS 2 (main)     → la faccia frontale rifrange in entrata (Snell), il raggio

 *                       attraversa la pietra, colpisce la VERA back-face (letta

 *                       dalla texture del prepass), lì o esce o fa Total Internal

 *                       Reflection. 3 indici di rifrazione (R/G/B) → dispersione.

 *                       Fresnel miscela rifrazione e riflessione ambientale.

 *

 * È questa coerenza con la geometria reale del retro che dà la profondità "a

 * pozzo" e la struttura interna del taglio (impossibile in single-pass).

 *

 * ═══════════════════════════════════════════════════════════════════════════

 * SETUP EDITOR

 * ───────────────────────────────────────────────────────────────────────────

 *  1. Metti questo script SULLA STESSA entity della mesh del diamante

 *     (componente Render o Model). La mesh DEVE avere normali FLAT.

 *  2. Trascina la tua camera di scena nell'attributo "Main Camera".

 *  3. Collega una cubemap di studio in "Environment Cubemap" (consigliata:

 *     quella generata, prefiltrata con mip).

 *  4. Lo script crea da solo: layer dedicato, render target, camera di prepass

 *     e materiali. Non devi configurare nessun materiale a mano.

 *

 *  DEBUG: metti "Show Back Normals" = true per vedere a schermo la texture del

 *  prepass. Se vedi la silhouette della gemma colorata (normali) → il pass 1

 *  funziona. Se è tutto vuoto → camera/layer non agganciati (vedi console).

 */



var DiamondRefractive = pc.createScript('diamondRefractive');



DiamondRefractive.attributes.add('mainCamera', {

    type: 'entity', title: '① Main Camera',

    description: 'La camera di scena. Il prepass la sincronizza ogni frame.'

});

DiamondRefractive.attributes.add('envMap', {

    type: 'asset', assetType: 'cubemap', title: '② Environment Cubemap',

    description: 'Studio prefiltrato con mip. Senza → fallback procedurale.'

});



DiamondRefractive.attributes.add('iorBase',     { type: 'number', default: 2.417, min: 1.3, max: 3.0, title: 'IOR (verde)' });

DiamondRefractive.attributes.add('dispersion',  { type: 'number', default: 1.67, min: 0.0, max: 8.0, title: 'Dispersion (fire)' });

DiamondRefractive.attributes.add('fresnelBoost',{ type: 'number', default: 1.0, min: 0.2, max: 3.0, title: 'Fresnel Boost' });

DiamondRefractive.attributes.add('envBrightness',{ type: 'number', default: 0.6, min: 0.1, max: 5.0, title: 'Env Brightness' });

DiamondRefractive.attributes.add('envRotation', { type: 'number', default: 0, min: -3.15, max: 3.15, title: 'Env Rotation Y' });

DiamondRefractive.attributes.add('bodyTint',    { type: 'rgb', default: [0.97, 0.99, 1.0], title: 'Body Tint' });

DiamondRefractive.attributes.add('exposure',    { type: 'number', default: 1.4, min: 0.2, max: 4.0, title: 'Exposure' });

DiamondRefractive.attributes.add('contrastBoost',{ type: 'number', default: 1.0, min: 1.0, max: 4.0, title: 'Contrast' });

DiamondRefractive.attributes.add('blackLevel',  { type: 'number', default: 0.0, min: 0.0, max: 0.4, title: 'Black Level',

    description: 'Sotto questo valore → nero puro. Alzalo per neri più profondi (più contrasto).' });

DiamondRefractive.attributes.add('whiteLevel',  { type: 'number', default: 0.6, min: 0.2, max: 1.5, title: 'White Level',

    description: 'Sopra questo valore → bianco puro (brillanza). Abbassalo per più bianchi bruciati.' });



DiamondRefractive.attributes.add('internalBounces',{ type: 'number', default: 4, min: 1, max: 6, precision: 0, title: 'Internal Bounces',

    description: 'Rimbalzi interni: più alti = più faccette/struttura interna.' });

DiamondRefractive.attributes.add('facetDetail',{ type: 'number', default: 0.5, min: 0.0, max: 0.5, title: 'Facet Detail',

    description: 'Moltiplica le faccette apparenti (tilt deterministico). 0 = solo geometria reale.' });

DiamondRefractive.attributes.add('facetStep',{ type: 'number', default: 0.1, min: 0.0, max: 0.5, precision: 4, title: 'Facet Walk (mondo)',

    description: 'Distanza-MONDO per rimbalzo (invariante allo zoom). Tarala sulla scala della gemma. 0 = disattiva.' });



DiamondRefractive.attributes.add('sparkleCount',     { type: 'number', default: 12, min: 0, max: 24, precision: 0, title: 'Sparkle Count' });

DiamondRefractive.attributes.add('sparkleSharpness', { type: 'number', default: 460, min: 50, max: 1024, title: 'Sparkle Sharpness' });

DiamondRefractive.attributes.add('sparkleIntensity', { type: 'number', default: 0.97, min: 0, max: 10, title: 'Sparkle Intensity' });



DiamondRefractive.attributes.add('autoRotateSpeed',  { type: 'number', default: 0, min: 0, max: 90, title: 'Auto Rotate (°/s)' });

DiamondRefractive.attributes.add('showBackNormals',  { type: 'boolean', default: false, title: '🛠 Show Back Normals (debug)' });



// ════════════════════════════════════════════════════════════════════════════

// SHADER PREPASS — scrive la normale mondo della back-face in RGB

// ════════════════════════════════════════════════════════════════════════════



DiamondRefractive.PREPASS_VERT = /* glsl */`

    attribute vec3 aPosition;

    attribute vec3 aNormal;

    uniform mat4 matrix_model;

    uniform mat4 matrix_viewProjection;

    uniform mat3 matrix_normal;

    varying vec3 vNormalW;

    void main(void) {

        vNormalW = normalize(matrix_normal * aNormal);

        gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);

    }

`;

DiamondRefractive.PREPASS_FRAG = /* glsl */`

    precision highp float;

    varying vec3 vNormalW;

    void main(void) {

        // Encode normale [-1,1] → [0,1]. Alpha = 1 = "hit" (maschera).

        gl_FragColor = vec4(normalize(vNormalW) * 0.5 + 0.5, 1.0);

    }

`;



// ════════════════════════════════════════════════════════════════════════════

// SHADER MAIN

// ════════════════════════════════════════════════════════════════════════════



DiamondRefractive.MAIN_VERT = /* glsl */`

    attribute vec3 aPosition;

    attribute vec3 aNormal;

    uniform mat4 matrix_model;

    uniform mat4 matrix_viewProjection;

    uniform mat3 matrix_normal;

    varying vec3 vNormalW;

    varying vec3 vPositionW;

    void main(void) {

        vec4 posW  = matrix_model * vec4(aPosition, 1.0);

        vPositionW = posW.xyz;

        vNormalW   = normalize(matrix_normal * aNormal);

        gl_Position = matrix_viewProjection * posW;

    }

`;



DiamondRefractive.MAIN_FRAG = /* glsl */`

    precision highp float;



    uniform samplerCube uEnvMap;

    uniform bool        uHasEnv;

    uniform sampler2D   uBackNormalMap;   // texture del prepass (normali retro)

    uniform vec2        uResolution;



    uniform vec3  view_position;          // BUILT-IN camera world pos

    uniform mat4  matrix_viewProjection;  // BUILT-IN view-proj (walk aspect-corretto)

    uniform float uEnvBrightness, uEnvRotation;

    uniform float uIorR, uIorG, uIorB;

    uniform float uFresnelBoost, uExposure, uContrastBoost;

    uniform float uBlack, uWhite;

    uniform vec3  uBodyTint;

    uniform int   uBounces;

    uniform float uFacetDetail;

    uniform float uFacetStep;

    uniform int   uSparkleCount;

    uniform float uSparkleSharpness, uSparkleIntensity, uTime;

    uniform bool  uShowBack;



    varying vec3 vNormalW;

    varying vec3 vPositionW;



    vec3 rotateY(vec3 v, float a){ float c=cos(a),s=sin(a); return vec3(c*v.x+s*v.z, v.y, -s*v.x+c*v.z); }

    float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }



    vec3 proceduralEnv(vec3 d){

        d = normalize(d);

        float h = d.y*0.5+0.5;

        vec3 base = mix(vec3(0.06,0.07,0.09), vec3(0.9,0.92,0.97), smoothstep(0.1,0.95,h));

        float az = atan(d.z, d.x), el = asin(clamp(d.y,-1.0,1.0));

        base += vec3(0.7)*smoothstep(0.55,1.0, sin(az*3.0)*cos(el*2.5));

        base += vec3(1.0)*smoothstep(0.9,1.0, sin(az*13.0+1.3)*sin(el*9.0+0.7));

        return base;

    }

    vec3 sampleEnv(vec3 dir){

        vec3 d = rotateY(normalize(dir), uEnvRotation);

        return (uHasEnv ? textureCube(uEnvMap, d).rgb : proceduralEnv(d)) * uEnvBrightness;

    }



    float fresnel(float cosT, float ior){

        float r0 = (1.0-ior)/(1.0+ior); r0*=r0;

        return r0 + (1.0-r0)*pow(clamp(1.0-cosT,0.0,1.0),5.0);

    }



    // Rifrazione di un singolo canale (lunghezza d'onda), 2 segmenti interni.

    //   1) entrata aria→diamante sulla faccia frontale

    //   2) attraversa fino alla VERA back-face (letta dal prepass)

    //   3) lì: se Snell lo permette ESCE; altrimenti TIR → rimbalza e riesce

    // Tilt deterministico ancorato alla normale reale: moltiplica le faccette

    // APPARENTI a ogni rimbalzo restando coerente (no rumore). 0 = solo geometria.

    vec3 facetTilt(vec3 baseN, int b){

        if(uFacetDetail < 0.001) return baseN;

        vec3 up = abs(baseN.y)<0.999 ? vec3(0,1,0) : vec3(1,0,0);

        vec3 T = normalize(cross(up, baseN)), B = cross(baseN, T);

        float a = float(b+1)*2.39996;   // golden angle → distribuzione regolare

        return normalize(baseN + (T*cos(a)+B*sin(a))*uFacetDetail);

    }



    // Rifrazione di un canale con N rimbalzi interni. Il raggio entra dalla

    // faccia frontale reale, poi rimbalza alternando RETRO reale (Nb) e FRONTE

    // reale (Nf): ogni rimbalzo TIR lo fa visitare un nuovo orientamento di

    // faccia → più struttura interna. Esce appena Snell lo permette.

    // Rifrazione di un canale. Ad ogni rimbalzo "cammina" in screen-space e

    // RICAMPIONA la texture del retro in un punto diverso → ogni rimbalzo colpisce

    // una FACCIA REALE diversa del padiglione = più struttura interna vera.

    vec3 traceChannel(vec3 I, vec3 Nf, vec2 uv0, float wpp, float ior){

        vec3 dir = refract(I, Nf, 1.0/ior);

        if(dot(dir,dir) < 1e-5) return sampleEnv(reflect(I, Nf));



        vec3 tp = vec3(1.0);



        for(int b=0; b<6; b++){

            if(b >= uBounces) break;



            // Campionamento ANCORATO all'ingresso (uv0), SENZA accumulo → niente

            // deriva quando cambi Facet Walk. Ventaglio radiale a spirale che

            // cresce col parametro: le facce si infittiscono CENTRATE, non slittano.

            float a = float(b) * 2.39996;                  // golden angle

            float r = uFacetStep * sqrt(float(b)) / wpp;   // raggio in pixel (spirale di Fermat)

            vec2 off = vec2(cos(a), sin(a)) * r / uResolution;

            vec4 s = texture2D(uBackNormalMap, clamp(uv0 + off, 0.001, 0.999));

            if(s.a <= 0.5){

                // Fuori silhouette: campiona l'ambiente lungo il raggio (riflesso)

                // invece di inventare una normale → niente "buchi" neri.

                return sampleEnv(dir) * tp;

            }

            vec3 n = facetTilt(normalize(s.rgb * 2.0 - 1.0), b);

            if(dot(dir, n) > 0.0) n = -n;



            vec3 o = refract(dir, n, ior);

            if(dot(o,o) < 1e-5){

                dir = reflect(dir, n);      // TIR → resta dentro, prossima faccia

                tp *= 0.95;

            } else {

                return sampleEnv(o) * tp;   // esce

            }

        }

        return sampleEnv(dir) * tp;

    }



    float sparkles(vec3 V, vec3 N){

        float r = 0.0;

        for(int i=0;i<24;i++){

            if(i>=uSparkleCount) break;

            float fi = float(i);

            float phi = 6.2831853 * fract(fi*0.61803);

            float th  = acos(sqrt(fract(fi*0.7548 + 0.3)));

            vec3 up = abs(N.y)<0.999 ? vec3(0,1,0) : vec3(1,0,0);

            vec3 T = normalize(cross(up,N)), B = cross(N,T);

            vec3 L = normalize(T*sin(th)*cos(phi) + N*cos(th) + B*sin(th)*sin(phi));

            vec3 H = normalize(L+V);

            r += pow(max(dot(N,H),0.0), uSparkleSharpness);

        }

        return r;

    }



    void main(void){

        vec3 N = normalize(vNormalW);

        vec3 V = normalize(view_position - vPositionW);

        vec3 I = -V;



        // Normale del retro dal prepass (screen-space). Approssimazione standard:

        // il punto di uscita si proietta circa sullo stesso pixel (gem convessa).

        vec2 uv = gl_FragCoord.xy / uResolution;

        vec4 bn = texture2D(uBackNormalMap, uv);

        bool hitBack = bn.a > 0.5;

        vec3 Nb = normalize(bn.rgb * 2.0 - 1.0);



        if(uShowBack){ gl_FragColor = vec4(hitBack ? (Nb*0.5+0.5) : vec3(0.0), 1.0); return; }



        // Unità-mondo per pixel (derivate di vPositionW) → passo facet zoom-stabile.

        float wpp = max(0.5 * (length(dFdx(vPositionW)) + length(dFdy(vPositionW))), 1e-6);



        // [DISPERSIONE] tre cammini, un canale ciascuno

        vec3 refr = vec3(

            traceChannel(I, N, uv, wpp, uIorR).r,

            traceChannel(I, N, uv, wpp, uIorG).g,

            traceChannel(I, N, uv, wpp, uIorB).b

        ) * uBodyTint;



        // [FRESNEL] riflessione ambientale esterna

        float F = clamp(fresnel(max(dot(N,V),0.0), uIorG) * uFresnelBoost, 0.0, 1.0);

        vec3 refl = sampleEnv(reflect(I, N));



        vec3 color = mix(refr, refl, F);



        // ── LIVELLI ad alto contrasto (NO Reinhard: era lui a fare il latte) ──

        // Il contrasto è già nei campioni d'ambiente; qui lo preserviamo invece

        // di comprimerlo. Crush dei neri + clip dei bianchi = salt&pepper iJewel.

        color *= uExposure;

        color = clamp((color - vec3(uBlack)) / max(uWhite - uBlack, 1e-3), 0.0, 1.0);

        // contrasto lineare attorno al pivot → separa nettamente le facce

        color = clamp(0.5 + (color - 0.5) * uContrastBoost, 0.0, 1.0);

        // glint speculari additivi (clippano a bianco = brillanza)

        color += vec3(sparkles(V, N) * uSparkleIntensity);

        color = clamp(color, 0.0, 1.0);

        color = pow(color, vec3(1.0/2.2));



        gl_FragColor = vec4(color, 1.0);

    }

`;



// ════════════════════════════════════════════════════════════════════════════

// SETUP

// ════════════════════════════════════════════════════════════════════════════



DiamondRefractive.prototype.initialize = function () {

    this._time = 0;

    var app = this.app, device = app.graphicsDevice;



    // --- Camera principale ---

    this._cam = this.mainCamera || (app.root.findComponent('camera') ? app.root.findComponent('camera').entity : null);

    if (!this._cam) { console.error('DiamondRefractive: nessuna Main Camera. Assegnala nell\'Inspector.'); return; }



    // --- Render target per le normali del retro ---

    this._makeRenderTarget(device.width, device.height);



    // --- Layer dedicato per il prepass ---

    this._layer = new pc.Layer({ name: 'DiamondBackface' });

    app.scene.layers.insert(this._layer, 0);



    // --- Camera di prepass (renderizza SOLO il layer backface nel RT) ---

    var camEnt = new pc.Entity('DiamondPrepassCam');

    camEnt.addComponent('camera', {

        clearColor: new pc.Color(0, 0, 0, 0),

        clearColorBuffer: true,

        clearDepthBuffer: true,

        layers: [this._layer.id],

        priority: (this._cam.camera.priority || 0) - 1,   // renderizza PRIMA della main

        renderTarget: this._rt

    });

    app.root.addChild(camEnt);

    this._prepassCam = camEnt;



    // --- Materiali ---

    this._prepassMat = new pc.ShaderMaterial({

        uniqueName: 'DiamondBackNormal',

        attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL },

        vertexGLSL: DiamondRefractive.PREPASS_VERT,

        fragmentGLSL: DiamondRefractive.PREPASS_FRAG

    });

    this._prepassMat.cull = pc.CULLFACE_FRONT;   // scarta le facce frontali → resta il RETRO



    this._mainMat = new pc.ShaderMaterial({

        uniqueName: 'DiamondMain',

        attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL },

        vertexGLSL: DiamondRefractive.MAIN_VERT,

        fragmentGLSL: DiamondRefractive.MAIN_FRAG

    });

    this._mainMat.cull = pc.CULLFACE_BACK;       // faccia frontale



    // --- Mesh sorgente ---

    var src = this.entity.render ? this.entity.render.meshInstances

            : (this.entity.model ? this.entity.model.meshInstances : []);

    if (!src.length) { console.error('DiamondRefractive: nessuna mesh sull\'entity.'); return; }



    // Applica il materiale principale alla mesh visibile.

    for (var i = 0; i < src.length; i++) src[i].material = this._mainMat;



    // Crea istanze "proxy" della stessa mesh sul layer backface (materiale prepass).

    // NB: pc 2.x → new pc.MeshInstance(mesh, material, node)

    var proxies = [];

    for (var j = 0; j < src.length; j++) {

        proxies.push(new pc.MeshInstance(src[j].mesh, this._prepassMat, this.entity));

    }

    this._layer.addMeshInstances(proxies);

    this._proxies = proxies;



    this._applyUniforms();



    this.on('attr', this._applyUniforms, this);

    this.on('destroy', this._onDestroy, this);

};



DiamondRefractive.prototype._makeRenderTarget = function (w, h) {

    var device = this.app.graphicsDevice;

    if (this._tex) this._tex.destroy();

    if (this._rt)  this._rt.destroy();

    this._tex = new pc.Texture(device, {

        name: 'DiamondBackNormalTex',

        width: Math.max(2, w), height: Math.max(2, h),

        format: pc.PIXELFORMAT_RGBA8, mipmaps: false,

        minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,

        addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE

    });

    this._rt = new pc.RenderTarget({ colorBuffer: this._tex, depth: true });  // pc 2.x: niente device qui

    if (this._prepassCam) this._prepassCam.camera.renderTarget = this._rt;

    if (this._mainMat) this._mainMat.setParameter('uBackNormalMap', this._tex);

};



DiamondRefractive.prototype._applyUniforms = function () {

    var m = this._mainMat; if (!m) return;

    var cube = (this.envMap && this.envMap.resource) ? this.envMap.resource : (this.app.scene.skybox || null);

    var hasEnv = !!cube;

    if (hasEnv) m.setParameter('uEnvMap', cube);

    else {

        if (!this._dummy) {

            this._dummy = new pc.Texture(this.app.graphicsDevice, { cubemap: true, width: 1, height: 1, format: pc.PIXELFORMAT_RGBA8 });

        }

        m.setParameter('uEnvMap', this._dummy);

    }

    m.setParameter('uHasEnv', hasEnv);

    m.setParameter('uBackNormalMap', this._tex);



    var base = this.iorBase, d = this.dispersion;

    m.setParameter('uIorR', base - 0.007 * d);

    m.setParameter('uIorG', base);

    m.setParameter('uIorB', base + 0.009 * d);



    m.setParameter('uEnvBrightness', this.envBrightness);

    m.setParameter('uEnvRotation',   this.envRotation);

    m.setParameter('uFresnelBoost',  this.fresnelBoost);

    m.setParameter('uExposure',      this.exposure);

    m.setParameter('uContrastBoost', this.contrastBoost);

    m.setParameter('uBlack',         this.blackLevel);

    m.setParameter('uWhite',         this.whiteLevel);

    m.setParameter('uBodyTint',      [this.bodyTint.r, this.bodyTint.g, this.bodyTint.b]);

    m.setParameter('uBounces',       Math.round(this.internalBounces));

    m.setParameter('uFacetDetail',   this.facetDetail);

    m.setParameter('uFacetStep',     this.facetStep);

    m.setParameter('uSparkleCount',  Math.round(this.sparkleCount));

    m.setParameter('uSparkleSharpness', this.sparkleSharpness);

    m.setParameter('uSparkleIntensity', this.sparkleIntensity);

    m.setParameter('uShowBack', this.showBackNormals);

    m.update();

};



DiamondRefractive.prototype.update = function (dt) {

    if (!this._mainMat || !this._cam) return;

    this._time += dt;



    if (this.autoRotateSpeed > 0) this.entity.rotateLocal(0, this.autoRotateSpeed * dt, 0);



    // Resize RT se cambia la risoluzione del canvas.

    var device = this.app.graphicsDevice;

    if (this._tex && (this._tex.width !== device.width || this._tex.height !== device.height)) {

        this._makeRenderTarget(device.width, device.height);

    }



    // Sincronizza la camera di prepass con la principale (stessa vista → screen-space allineato).

    var mc = this._cam, pc_ = this._prepassCam;

    pc_.setPosition(mc.getPosition());

    pc_.setRotation(mc.getRotation());

    var s = mc.camera, dst = pc_.camera;

    dst.projection = s.projection; dst.fov = s.fov; dst.horizontalFov = s.horizontalFov;

    dst.nearClip = s.nearClip; dst.farClip = s.farClip;

    dst.aspectRatioMode = s.aspectRatioMode; dst.aspectRatio = s.aspectRatio;



    this._mainMat.setParameter('uResolution', [device.width, device.height]);

    this._mainMat.setParameter('uTime', this._time);

    this._mainMat.setParameter('uShowBack', this.showBackNormals);

};



DiamondRefractive.prototype._onDestroy = function () {

    if (this._proxies && this._layer) this._layer.removeMeshInstances(this._proxies);

    if (this._layer) this.app.scene.layers.remove(this._layer);

    if (this._prepassCam) this._prepassCam.destroy();

    if (this._rt) this._rt.destroy();

    if (this._tex) this._tex.destroy();

    if (this._mainMat) this._mainMat.destroy();

    if (this._prepassMat) this._prepassMat.destroy();

    if (this._dummy) this._dummy.destroy();

};


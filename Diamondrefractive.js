/**
 * DiamondRefractive.js — PlayCanvas 2.19.5  |  v7.0 "Brilliant"
 * Senior Graphics Programmer — WebGL2
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITETTURA (invariata e collaudata): RIFRAZIONE VERA two-pass
 * ───────────────────────────────────────────────────────────────────────────
 *   PASS 1 (prepass)  → una camera dedicata renderizza SOLO le facce POSTERIORI
 *                       (cull FRONT) e scrive la loro NORMALE mondo reale in un
 *                       Render Target.
 *   PASS 2 (main)     → la faccia frontale rifrange in entrata (Snell), il raggio
 *                       marcia dentro la pietra colpendo la VERA back-face (dal
 *                       prepass), lì esce o fa Total Internal Reflection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COSA CAMBIA RISPETTO ALLA v6
 * ───────────────────────────────────────────────────────────────────────────
 *  1. FACET WALK CORRETTO (era il bug principale): prima si camminava una
 *     DISTANZA-MONDO fissa in una spirale screen-space → diamanti grandi e
 *     piccoli avevano densità di faccette diversa e la spirale era DECENTRATA.
 *     Ora è un RAY-MARCH screen-space lungo il RAGGIO RIFRATTO reale, che parte
 *     dal frammento stesso (→ sempre centrato) e avanza di una frazione del
 *     RAGGIO DELLA PIETRA (misurato dall'AABB della mesh) → resa IDENTICA su
 *     pietre grandi e piccole, a qualsiasi zoom.
 *  2. MENO PARAMETRI: ~25 manopole accorpate in 6 controlli "master"
 *     (Fire, Brilliance, Sparkle, IOR, Exposure, Facet Scale). Lo script ricava
 *     da soli tutti gli uniform interni → meno cose da regolare.
 *  3. MENO "VETRO", PIÙ DIAMANTE: default più contrastati (neri più profondi,
 *     bianchi che scattano), più fire e scintillazione → aspetto brillante.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SETUP EDITOR
 * ───────────────────────────────────────────────────────────────────────────
 *  1. Script SULLA STESSA entity della mesh del diamante. Mesh con normali FLAT.
 *  2. Trascina la camera di scena in "Main Camera".
 *  3. (Consigliato) collega una cubemap HDR di studio in "Environment Cubemap".
 *     Senza → fallback procedurale studio ad alto contrasto.
 *  4. Lo script crea da solo layer, render target, camera di prepass e materiali.
 *
 *  I 6 SLIDER CHE USERAI:
 *    • Fire        → quantità di "fuoco" (dispersione spettrale colorata).
 *    • Brilliance  → contrasto bianco/nero e scatto dei lampi.
 *    • Sparkle     → scintillazione + flash della key light.
 *    • IOR         → indice di rifrazione (diamante 2.417, vetro 1.5).
 *    • Exposure    → luminosità globale.
 *    • Facet Scale → quanto "in profondità" pesca la struttura interna.
 *
 *  DEBUG: "Show Back Normals" mostra la texture del prepass (silhouette colorata
 *  = pass 1 OK; tutto vuoto = camera/layer non agganciati).
 */

var DiamondRefractive = pc.createScript('diamondRefractive');

// ── ① Riferimenti ───────────────────────────────────────────────────────────
DiamondRefractive.attributes.add('mainCamera', {
    type: 'entity', title: '① Main Camera',
    description: 'La camera di scena. Il prepass la sincronizza ogni frame.'
});
DiamondRefractive.attributes.add('envMap', {
    type: 'asset', assetType: 'cubemap', title: '② Environment Cubemap',
    description: 'Studio HDR prefiltrato. Senza → fallback procedurale.'
});

// ── ② Aspetto principale — i 6 controlli che userai davvero ──────────────────
DiamondRefractive.attributes.add('ior', { type: 'number', default: 2.417, min: 1.3, max: 3.0, title: 'IOR',
    description: 'Indice di rifrazione. Diamante ≈ 2.417, vetro ≈ 1.5, zaffiro ≈ 1.77.' });
DiamondRefractive.attributes.add('fire', { type: 'number', default: 1.2, min: 0.0, max: 2.5, title: 'Fire (dispersione)',
    description: 'Quantità di fuoco colorato. Pilota forza E numero di campioni spettrali.' });
DiamondRefractive.attributes.add('brilliance', { type: 'number', default: 1.1, min: 0.0, max: 2.0, title: 'Brilliance (contrasto)',
    description: 'Master del contrasto bianco/nero e dello scatto dei lampi. Più alto = meno "vetro".' });
DiamondRefractive.attributes.add('sparkle', { type: 'number', default: 1.2, min: 0.0, max: 2.0, title: 'Sparkle',
    description: 'Scintillazione + flash della key light.' });
DiamondRefractive.attributes.add('exposure', { type: 'number', default: 1.5, min: 0.2, max: 4.0, title: 'Exposure' });
DiamondRefractive.attributes.add('facetScale', { type: 'number', default: 0.6, min: 0.0, max: 1.5, precision: 3, title: 'Facet Scale',
    description: 'Profondità del ray-march interno (frazione del raggio pietra). INVARIANTE a dimensione/zoom.' });

// ── ③ Ambiente ───────────────────────────────────────────────────────────────
DiamondRefractive.attributes.add('envBrightness', { type: 'number', default: 0.9, min: 0.1, max: 5.0, title: 'Env Brightness' });
DiamondRefractive.attributes.add('envRotation',   { type: 'number', default: 0, min: -3.15, max: 3.15, title: 'Env Rotation Y',
    description: 'Ruota i riflessi (e con essi la direzione della key light).' });
DiamondRefractive.attributes.add('bodyTint',      { type: 'rgb', default: [0.98, 0.99, 1.0], title: 'Body Tint' });

// ── ④ Misc ────────────────────────────────────────────────────────────────────
DiamondRefractive.attributes.add('autoRotateSpeed', { type: 'number', default: 0, min: 0, max: 90, title: 'Auto Rotate (°/s)' });
DiamondRefractive.attributes.add('showBackNormals', { type: 'boolean', default: false, title: '🛠 Show Back Normals (debug)' });

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
    uniform mat4  matrix_viewProjection;  // BUILT-IN view-proj

    uniform float uEnvBrightness, uEnvRotation, uStudioContrast;
    uniform float uIorBase, uDispersion;
    uniform int   uDispSamples;
    uniform float uFresnelBoost, uExposure, uContrastBoost, uSaturation;
    uniform float uBlack, uWhite;
    uniform vec3  uBodyTint;
    uniform int   uBounces;
    uniform float uFacetDetail;
    uniform float uFacetWalk;             // ampiezza campionamento faccette (frazione del raggio-schermo)
    uniform float uGemUvRadius;           // raggio della pietra proiettato in spazio-UV → invarianza scala
    uniform float uAbsorption;
    uniform vec3  uAbsorptionColor;
    uniform vec3  uKeyDir, uKeyColor;
    uniform float uKeyIntensity, uKeySharpness;
    uniform int   uSparkleCount;
    uniform float uSparkleSharpness, uSparkleIntensity, uTime;
    uniform bool  uShowBack;

    varying vec3 vNormalW;
    varying vec3 vPositionW;

    vec3 rotateY(vec3 v, float a){ float c=cos(a),s=sin(a); return vec3(c*v.x+s*v.z, v.y, -s*v.x+c*v.z); }
    float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }

    // ── Spettro visibile → RGB (approssimazione Zucconi 6, GPU-friendly) ──
    vec3 bump3y(vec3 x, vec3 yoffset){ vec3 y = vec3(1.0) - x*x; return clamp(y - yoffset, 0.0, 1.0); }
    vec3 spectrumRGB(float w){
        float x = clamp((w - 400.0) / 300.0, 0.0, 1.0);
        const vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
        const vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
        const vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
        const vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
        const vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
        const vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
        return bump3y(c1 * (x - x1), y1) + bump3y(c2 * (x - x2), y2);
    }

    // IOR(λ) — Cauchy del diamante ancorata all'IOR utente al centro (550nm).
    float iorAt(float w){
        float cw = 2.3845 + 10942.0 / (w*w);
        float c0 = 2.3845 + 10942.0 / (550.0*550.0);
        return uIorBase + (cw - c0) * uDispersion;
    }

    // Ambiente procedurale "studio": softbox alto + pavimento scuro + key/fill.
    // L'alto contrasto qui è ciò che crea il pattern bianco/nero del brillante.
    vec3 proceduralEnv(vec3 d){
        d = normalize(d);
        float h = d.y * 0.5 + 0.5;
        vec3 col = mix(vec3(0.015,0.02,0.03), vec3(1.15,1.18,1.25), smoothstep(0.40,0.96,h));
        col *= mix(0.18, 1.0, smoothstep(0.0, 0.22, abs(d.y)));           // banda d'orizzonte scura
        float key  = max(dot(d, normalize(vec3( 0.55,0.70, 0.45))), 0.0);  // softbox principale
        col += vec3(1.6,1.58,1.5) * pow(key, 6.0);
        float fill = max(dot(d, normalize(vec3(-0.60,0.20,-0.50))), 0.0);  // riempimento laterale
        col += vec3(0.40,0.42,0.5) * pow(fill, 3.0);
        col = max(vec3(0.0), (col - 0.18) * uStudioContrast + 0.18);       // contrasto attorno al grigio medio
        return col;
    }

    vec3 sampleEnv(vec3 dir){
        vec3 d = rotateY(normalize(dir), uEnvRotation);
        return (uHasEnv ? textureCube(uEnvMap, d).rgb : proceduralEnv(d)) * uEnvBrightness;
    }

    float fresnel(float cosT, float ior){
        float r0 = (1.0-ior)/(1.0+ior); r0*=r0;
        return r0 + (1.0-r0)*pow(clamp(1.0-cosT,0.0,1.0),5.0);
    }

    vec3 facetTilt(vec3 baseN, int b){
        if(uFacetDetail < 0.001) return baseN;
        vec3 up = abs(baseN.y)<0.999 ? vec3(0,1,0) : vec3(1,0,0);
        vec3 T = normalize(cross(up, baseN)), B = cross(baseN, T);
        float a = float(b+1)*2.39996;   // golden angle → distribuzione regolare
        return normalize(baseN + (T*cos(a)+B*sin(a))*uFacetDetail);
    }

    // Traccia un raggio monocromatico (IOR dato). Rifrange sulla faccia frontale,
    // poi legge la VERA back-face normal dal prepass per la rifrazione d'uscita.
    // Il PRIMO campione (b=0) cade ESATTAMENTE sul frammento (uv0) → rifrazione
    // primaria sempre visibile e centrata. I campioni successivi si allargano di
    // una frazione del raggio della pietra IN SPAZIO-SCHERMO (uGemUvRadius) →
    // densità faccette identica su pietre grandi e piccole, a qualsiasi zoom.
    vec3 traceChannel(vec3 I, vec3 Nf, vec2 uv0, float ior){
        vec3 dir = refract(I, Nf, 1.0/ior);
        if(dot(dir,dir) < 1e-5) return sampleEnv(reflect(I, Nf));

        vec3 tp = vec3(1.0);
        vec3 absorb = (vec3(1.0) - clamp(uAbsorptionColor, 0.0, 1.0)) * uAbsorption + vec3(uAbsorption) * 0.15;

        for(int b=0; b<6; b++){
            if(b >= uBounces) break;

            // b=0 → offset nullo (campiona il frammento). Raggio del campione in
            // spazio-UV ∝ dimensione su schermo della pietra → invariante a scala.
            float t   = (uBounces > 1) ? float(b) / float(uBounces - 1) : 0.0;
            float ang = float(b) * 2.39996;              // golden angle → distribuzione regolare
            vec2  off = vec2(cos(ang), sin(ang)) * (uFacetWalk * uGemUvRadius * t);
            vec4  s   = texture2D(uBackNormalMap, clamp(uv0 + off, 0.001, 0.999));
            if(s.a <= 0.5){
                return sampleEnv(dir) * tp;              // fuori silhouette → ambiente (niente buchi neri)
            }
            vec3 n = facetTilt(normalize(s.rgb * 2.0 - 1.0), b);
            if(dot(dir, n) > 0.0) n = -n;

            tp *= exp(-absorb);                          // assorbimento sul segmento percorso

            vec3 o = refract(dir, n, ior);
            if(dot(o,o) < 1e-5){
                dir = reflect(dir, n);                   // TIR → resta dentro, prossima faccia
                tp *= 0.96;
            } else {
                return sampleEnv(o) * tp;                // esce
            }
        }
        return sampleEnv(dir) * tp;
    }

    float sparkles(vec3 V, vec3 N){
        float r = 0.0;
        for(int i=0;i<24;i++){
            if(i>=uSparkleCount) break;
            float fi = float(i);
            float phi = 6.2831853 * fract(fi*0.61803 + uTime*0.03);
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

        // Debug: mostra la normale del retro al pixel corrente.
        if(uShowBack){
            vec4 bn = texture2D(uBackNormalMap, gl_FragCoord.xy / uResolution);
            gl_FragColor = vec4(bn.a > 0.5 ? bn.rgb : vec3(0.0), 1.0);
            return;
        }

        // [DISPERSIONE SPETTRALE] integra N lunghezze d'onda → fire realistico.
        // Dove i cammini coincidono resta bianco; dove l'IOR li separa → colore.
        vec2 uv = gl_FragCoord.xy / uResolution;
        vec3 refr = vec3(0.0);
        vec3 wsum = vec3(0.0);
        for(int i=0;i<12;i++){
            if(i >= uDispSamples) break;
            float t = (uDispSamples > 1) ? float(i)/float(uDispSamples-1) : 0.5;
            float w = mix(400.0, 700.0, t);
            vec3 srgb = spectrumRGB(w);
            float ior = iorAt(w);
            vec3 env = traceChannel(I, N, uv, ior);
            refr += env * srgb;
            wsum += srgb;
        }
        refr /= max(wsum, vec3(1e-3));
        refr *= uBodyTint;

        // [FRESNEL] riflessione ambientale esterna (specchio sulla faccia frontale)
        float F = clamp(fresnel(max(dot(N,V),0.0), uIorBase) * uFresnelBoost, 0.0, 1.0);
        vec3 refl = sampleEnv(reflect(I, N));
        vec3 color = mix(refr, refl, F);

        // [KEY LIGHT] flash speculare diretto sulle faccette (scorre con la rotazione)
        vec3 Hk = normalize(uKeyDir + V);
        float spec = pow(max(dot(N, Hk), 0.0), uKeySharpness) * uKeyIntensity;
        color += uKeyColor * spec;

        // ── LIVELLI ad alto contrasto, ma PRESERVANDO il fire ──
        color *= uExposure;
        color = clamp((color - vec3(uBlack)) / max(uWhite - uBlack, 1e-3), 0.0, 4.0);
        color = 0.5 + (color - 0.5) * uContrastBoost;          // contrasto attorno al pivot
        float l = luma(color);
        color = mix(vec3(l), color, uSaturation);              // satura il fire PRIMA del roll-off
        color = color / (1.0 + max(color - 1.0, vec3(0.0)));   // shoulder filmica (no clip secco)
        color = clamp(color, 0.0, 1.0);

        // glint speculari additivi (scintillazione, clippano a bianco = brillanza)
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
    this._gemRadius = 1.0;
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
    this._meshInstances = src;
    this._gemRadius = this._computeGemRadius();

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

// Raggio (world-space) e centro della sfera contenitiva dall'AABB delle mesh.
DiamondRefractive.prototype._computeGemRadius = function () {
    var mi = this._meshInstances;
    if (!mi || !mi.length) return this._gemRadius || 1.0;
    var r = 0.0, ci = 0;
    for (var k = 0; k < mi.length; k++) {
        var he = mi[k].aabb.halfExtents;
        var rr = Math.sqrt(he.x * he.x + he.y * he.y + he.z * he.z);
        if (rr > r) { r = rr; ci = k; }
    }
    if (!this._gemCenter) this._gemCenter = new pc.Vec3();
    this._gemCenter.copy(mi[ci].aabb.center);
    return r > 1e-4 ? r : (this._gemRadius || 1.0);
};

// Proietta un punto mondo nel clip-space normalizzato (NDC xy) della camera.
DiamondRefractive.prototype._projectNdc = function (cam, p) {
    var vp = this._vp || (this._vp = new pc.Mat4());
    vp.mul2(cam.projectionMatrix, cam.viewMatrix);
    var d = vp.data;
    var x = d[0] * p.x + d[4] * p.y + d[8]  * p.z + d[12];
    var y = d[1] * p.x + d[5] * p.y + d[9]  * p.z + d[13];
    var w = d[3] * p.x + d[7] * p.y + d[11] * p.z + d[15];
    if (Math.abs(w) < 1e-6) w = (w < 0 ? -1e-6 : 1e-6);
    return { x: x / w, y: y / w };
};

// Raggio della pietra proiettato in spazio-UV [0,1]: misura quanto è grande la
// pietra SULLO SCHERMO ora → il campionamento faccette diventa invariante a
// dimensione e zoom (occupa sempre la stessa frazione della pietra).
DiamondRefractive.prototype._computeGemUvRadius = function () {
    var cam = (this._cam && this._cam.camera) ? this._cam.camera : null;
    var c = this._gemCenter;
    if (!cam || !c) return this._gemUvRadius || 0.15;
    var edge = this._tmpEdge || (this._tmpEdge = new pc.Vec3());
    edge.copy(this._cam.right).mulScalar(this._gemRadius || 1.0).add(c);
    var nc = this._projectNdc(cam, c), ne = this._projectNdc(cam, edge);
    var dx = ne.x - nc.x, dy = ne.y - nc.y;
    var uvR = 0.5 * Math.sqrt(dx * dx + dy * dy);   // NDC (2 unità) → UV (1 unità)
    if (uvR > 1e-4 && isFinite(uvR)) this._gemUvRadius = uvR;
    return this._gemUvRadius || 0.15;
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

    // ── IOR + "Fire": un solo slider pilota forza dispersione E n. campioni ──
    var fire = Math.max(0.0, this.fire);
    m.setParameter('uIorBase', this.ior);
    m.setParameter('uDispersion', fire * 1.8);
    m.setParameter('uDispSamples', Math.max(1, Math.min(10, Math.round(3.0 + fire * 2.5))));

    // ── "Brilliance": un solo slider pilota contrasto, livelli e saturazione ──
    var b = Math.max(0.0, this.brilliance);
    m.setParameter('uContrastBoost', 1.0 + 0.30 * b);
    m.setParameter('uBlack', 0.015 * b);
    m.setParameter('uWhite', Math.max(0.25, 0.85 - 0.16 * b));
    m.setParameter('uSaturation', 1.0 + 0.28 * b);
    m.setParameter('uStudioContrast', 1.0 + 0.65 * b);
    m.setParameter('uFresnelBoost', 1.0);

    // ── "Sparkle": scintillazione + flash key light ──
    var sp = Math.max(0.0, this.sparkle);
    m.setParameter('uSparkleIntensity', sp * 0.8);
    m.setParameter('uSparkleCount', Math.max(0, Math.min(24, Math.round(6.0 + sp * 6.0))));
    m.setParameter('uSparkleSharpness', 520.0);
    m.setParameter('uKeyIntensity', sp * 1.3);
    m.setParameter('uKeySharpness', 1100.0);

    // Key light: direzione legata alla rotazione dell'ambiente (elevazione fissa).
    var az = this.envRotation + 0.6, el = 0.6, ce = Math.cos(el);
    m.setParameter('uKeyDir', [ce * Math.cos(az), Math.sin(el), ce * Math.sin(az)]);
    m.setParameter('uKeyColor', [1.0, 1.0, 1.0]);

    // Ambiente
    m.setParameter('uEnvBrightness', this.envBrightness);
    m.setParameter('uEnvRotation', this.envRotation);
    m.setParameter('uExposure', this.exposure);
    m.setParameter('uBodyTint', [this.bodyTint.r, this.bodyTint.g, this.bodyTint.b]);

    // ── Struttura interna (ray-march invariante alla scala) ──
    m.setParameter('uBounces', 4);
    m.setParameter('uFacetDetail', 0.28);
    m.setParameter('uFacetWalk', Math.max(0.0, this.facetScale));
    m.setParameter('uGemUvRadius', this._gemUvRadius || 0.15);

    // Assorbimento neutro (diamante incolore) — costante, non più esposto.
    m.setParameter('uAbsorption', 0.12);
    m.setParameter('uAbsorptionColor', [1.0, 1.0, 1.0]);

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

    // Dimensione su schermo aggiornata (scala/zoom animati) → invarianza scala.
    this._gemRadius = this._computeGemRadius();
    this._mainMat.setParameter('uGemUvRadius', this._computeGemUvRadius());
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

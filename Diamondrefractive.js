/**
 * DiamondRefractive.js — PlayCanvas 2.19.5  |  v6.0 "Spectral Fire"
 * Senior Graphics Programmer — WebGL2
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITETTURA (invariata e collaudata): RIFRAZIONE VERA two-pass
 * ───────────────────────────────────────────────────────────────────────────
 *   PASS 1 (prepass)  → una camera dedicata renderizza SOLO le facce POSTERIORI
 *                       (cull FRONT) e scrive la loro NORMALE mondo reale in un
 *                       Render Target. Il pass principale sa così dove e come è
 *                       orientata la superficie interna lontana.
 *
 *   PASS 2 (main)     → la faccia frontale rifrange in entrata (Snell), il raggio
 *                       attraversa la pietra, colpisce la VERA back-face (dal
 *                       prepass), lì esce o fa Total Internal Reflection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COSA CAMBIA RISPETTO ALLA v5 (per avvicinarsi alla reference fotografica)
 * ───────────────────────────────────────────────────────────────────────────
 *  1. DISPERSIONE SPETTRALE VERA ("fire"): non più 3 IOR fissi (R/G/B), ma
 *     integrazione su N lunghezze d'onda con IOR(λ) fisica (Cauchy del diamante)
 *     e risposta spettrale→RGB (Zucconi). Genera lampi colorati realistici sui
 *     bordi delle faccette dove i cammini si separano.  → attr "Dispersion Samples"
 *  2. AMBIENTE STUDIO ad ALTO CONTRASTO: softbox in alto + pavimento scuro +
 *     key/fill → il pattern "salt & pepper" (bianco/nero netto) tipico del
 *     brillante nasce dal riflesso di un ambiente contrastato.  → attr "Studio Contrast"
 *  3. KEY LIGHT speculare diretta: flash bianchi netti che scorrono sulle
 *     faccette quando la gemma ruota.  → attr "Key Light *"
 *  4. ASSORBIMENTO Beer–Lambert lungo il cammino interno → profondità/corpo.
 *  5. TONE-MAP che PRESERVA il fire: crush dei neri + shoulder morbida +
 *     SATURAZIONE, invece del clip secco che spegneva i colori.  → attr "Saturation"
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SETUP EDITOR
 * ───────────────────────────────────────────────────────────────────────────
 *  1. Metti questo script SULLA STESSA entity della mesh del diamante
 *     (componente Render o Model). La mesh DEVE avere normali FLAT.
 *  2. Trascina la tua camera di scena nell'attributo "Main Camera".
 *  3. (Consigliato) Collega una cubemap di studio HDR prefiltrata in
 *     "Environment Cubemap". Senza → fallback procedurale studio.
 *  4. Lo script crea da solo: layer, render target, camera di prepass e
 *     materiali. Niente da configurare a mano.
 *
 *  DEBUG: "Show Back Normals" = true mostra la texture del prepass. Silhouette
 *  colorata (normali) → pass 1 OK. Tutto vuoto → camera/layer non agganciati.
 *
 *  PERFORMANCE: il costo principale è (Dispersion Samples × Internal Bounces)
 *  fetch di texture. Default 4×4 = ottimo compromesso. Per più fire alza i
 *  campioni a 6–8 (hero shot); per mobile tieni 3.
 */

var DiamondRefractive = pc.createScript('diamondRefractive');

// ── ① Riferimenti ─────────────────────────────────────────────────────────
DiamondRefractive.attributes.add('mainCamera', {
    type: 'entity', title: '① Main Camera',
    description: 'La camera di scena. Il prepass la sincronizza ogni frame.'
});
DiamondRefractive.attributes.add('envMap', {
    type: 'asset', assetType: 'cubemap', title: '② Environment Cubemap',
    description: 'Studio HDR prefiltrato con mip. Senza → fallback procedurale.'
});

// ── ② Indice di rifrazione e dispersione ────────────────────────────────────
DiamondRefractive.attributes.add('iorBase',      { type: 'number', default: 2.417, min: 1.3, max: 3.0, title: 'IOR (centro spettro)',
    description: 'IOR al centro del visibile. Diamante ≈ 2.417, vetro ≈ 1.5, zaffiro ≈ 1.77.' });
DiamondRefractive.attributes.add('dispersion',   { type: 'number', default: 2.2, min: 0.0, max: 8.0, title: 'Dispersion (fire)',
    description: 'Scala la separazione fisica IOR(λ). Più alto = più "fuoco" colorato.' });
DiamondRefractive.attributes.add('dispersionSamples', { type: 'number', default: 4, min: 1, max: 12, precision: 0, title: 'Dispersion Samples',
    description: 'Lunghezze d\'onda integrate. 3 = economico, 6–8 = fire vivido (più costoso).' });

// ── ③ Riflessione / ambiente ────────────────────────────────────────────────
DiamondRefractive.attributes.add('fresnelBoost', { type: 'number', default: 1.0, min: 0.2, max: 3.0, title: 'Fresnel Boost' });
DiamondRefractive.attributes.add('envBrightness',{ type: 'number', default: 0.8, min: 0.1, max: 5.0, title: 'Env Brightness' });
DiamondRefractive.attributes.add('envRotation',  { type: 'number', default: 0, min: -3.15, max: 3.15, title: 'Env Rotation Y' });
DiamondRefractive.attributes.add('studioContrast',{ type: 'number', default: 1.6, min: 0.2, max: 3.0, title: 'Studio Contrast',
    description: 'Contrasto dell\'ambiente procedurale → genera il pattern bianco/nero.' });

// ── ④ Corpo / assorbimento ──────────────────────────────────────────────────
DiamondRefractive.attributes.add('bodyTint',        { type: 'rgb', default: [0.98, 0.99, 1.0], title: 'Body Tint' });
DiamondRefractive.attributes.add('absorption',      { type: 'number', default: 0.15, min: 0.0, max: 4.0, title: 'Absorption',
    description: 'Attenuazione Beer–Lambert lungo il cammino interno → profondità. 0 = vetro perfetto.' });
DiamondRefractive.attributes.add('absorptionColor', { type: 'rgb', default: [1.0, 1.0, 1.0], title: 'Absorption Color',
    description: 'Colore che SOPRAVVIVE all\'assorbimento (diamante ≈ neutro).' });

// ── ⑤ Key light (flash speculare diretto) ───────────────────────────────────
DiamondRefractive.attributes.add('keyLightIntensity', { type: 'number', default: 1.6, min: 0.0, max: 10.0, title: 'Key Light Intensity' });
DiamondRefractive.attributes.add('keyLightSharpness', { type: 'number', default: 900, min: 10, max: 4000, title: 'Key Light Sharpness',
    description: 'Più alto = flash più piccoli e netti.' });
DiamondRefractive.attributes.add('keyLightColor',     { type: 'rgb', default: [1.0, 1.0, 1.0], title: 'Key Light Color' });
DiamondRefractive.attributes.add('keyAzimuth',        { type: 'number', default: 0.7, min: -3.15, max: 3.15, title: 'Key Light Azimuth' });
DiamondRefractive.attributes.add('keyElevation',      { type: 'number', default: 0.6, min: -1.57, max: 1.57, title: 'Key Light Elevation' });

// ── ⑥ Tone mapping / contrasto ──────────────────────────────────────────────
DiamondRefractive.attributes.add('exposure',     { type: 'number', default: 1.5, min: 0.2, max: 4.0, title: 'Exposure' });
DiamondRefractive.attributes.add('contrastBoost',{ type: 'number', default: 1.15, min: 1.0, max: 4.0, title: 'Contrast' });
DiamondRefractive.attributes.add('saturation',   { type: 'number', default: 1.2, min: 0.0, max: 2.5, title: 'Saturation',
    description: 'Esalta i colori di dispersione (fire) senza bruciarli a bianco.' });
DiamondRefractive.attributes.add('blackLevel',   { type: 'number', default: 0.02, min: 0.0, max: 0.4, title: 'Black Level',
    description: 'Sotto questo valore → nero puro. Alzalo per neri più profondi (più contrasto).' });
DiamondRefractive.attributes.add('whiteLevel',   { type: 'number', default: 0.7, min: 0.2, max: 1.5, title: 'White Level',
    description: 'Sopra questo valore → verso il bianco (brillanza). Abbassalo per più bianchi.' });

// ── ⑦ Struttura interna / faccette ──────────────────────────────────────────
DiamondRefractive.attributes.add('internalBounces',{ type: 'number', default: 4, min: 1, max: 6, precision: 0, title: 'Internal Bounces',
    description: 'Rimbalzi interni: più alti = più faccette/struttura interna.' });
DiamondRefractive.attributes.add('facetDetail',{ type: 'number', default: 0.5, min: 0.0, max: 0.5, title: 'Facet Detail',
    description: 'Moltiplica le faccette apparenti (tilt deterministico). 0 = solo geometria reale.' });
DiamondRefractive.attributes.add('facetStep',{ type: 'number', default: 0.1, min: 0.0, max: 0.5, precision: 4, title: 'Facet Walk (mondo)',
    description: 'Distanza-MONDO per rimbalzo (invariante allo zoom). Tarala sulla scala della gemma. 0 = disattiva.' });

// ── ⑧ Scintillazione (sparkle) ──────────────────────────────────────────────
DiamondRefractive.attributes.add('sparkleCount',     { type: 'number', default: 12, min: 0, max: 24, precision: 0, title: 'Sparkle Count' });
DiamondRefractive.attributes.add('sparkleSharpness', { type: 'number', default: 460, min: 50, max: 1024, title: 'Sparkle Sharpness' });
DiamondRefractive.attributes.add('sparkleIntensity', { type: 'number', default: 0.9, min: 0, max: 10, title: 'Sparkle Intensity' });

// ── ⑨ Misc ──────────────────────────────────────────────────────────────────
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
    uniform mat4  matrix_viewProjection;  // BUILT-IN view-proj

    uniform float uEnvBrightness, uEnvRotation, uStudioContrast;
    uniform float uIorBase, uDispersion;
    uniform int   uDispSamples;
    uniform float uFresnelBoost, uExposure, uContrastBoost, uSaturation;
    uniform float uBlack, uWhite;
    uniform vec3  uBodyTint;
    uniform int   uBounces;
    uniform float uFacetDetail;
    uniform float uFacetStep;
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

    // Traccia un raggio monocromatico (IOR dato). Entra dalla faccia frontale,
    // rimbalza sulla VERA back-face (prepass) ricampionando in screen-space a
    // spirale (ogni rimbalzo colpisce una faccia reale diversa → struttura),
    // applica assorbimento Beer–Lambert, esce appena Snell lo permette.
    vec3 traceChannel(vec3 I, vec3 Nf, vec2 uv0, float wpp, float ior){
        vec3 dir = refract(I, Nf, 1.0/ior);
        if(dot(dir,dir) < 1e-5) return sampleEnv(reflect(I, Nf));

        vec3 tp = vec3(1.0);
        vec3 absorb = (vec3(1.0) - clamp(uAbsorptionColor, 0.0, 1.0)) * uAbsorption + vec3(uAbsorption) * 0.15;

        for(int b=0; b<6; b++){
            if(b >= uBounces) break;

            float a = float(b) * 2.39996;                  // golden angle
            float r = uFacetStep * sqrt(float(b)) / wpp;   // raggio in pixel (spirale di Fermat)
            vec2 off = vec2(cos(a), sin(a)) * r / uResolution;
            vec4 s = texture2D(uBackNormalMap, clamp(uv0 + off, 0.001, 0.999));
            if(s.a <= 0.5){
                return sampleEnv(dir) * tp;   // fuori silhouette → ambiente (niente buchi neri)
            }
            vec3 n = facetTilt(normalize(s.rgb * 2.0 - 1.0), b);
            if(dot(dir, n) > 0.0) n = -n;

            tp *= exp(-absorb);               // assorbimento sul segmento percorso

            vec3 o = refract(dir, n, ior);
            if(dot(o,o) < 1e-5){
                dir = reflect(dir, n);        // TIR → resta dentro, prossima faccia
                tp *= 0.96;
            } else {
                return sampleEnv(o) * tp;     // esce
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

        // Normale del retro dal prepass (screen-space). Approssimazione standard:
        // il punto di uscita si proietta circa sullo stesso pixel (gem convessa).
        vec2 uv = gl_FragCoord.xy / uResolution;
        vec4 bn = texture2D(uBackNormalMap, uv);
        bool hitBack = bn.a > 0.5;
        vec3 Nb = normalize(bn.rgb * 2.0 - 1.0);

        if(uShowBack){ gl_FragColor = vec4(hitBack ? (Nb*0.5+0.5) : vec3(0.0), 1.0); return; }

        // Unità-mondo per pixel (derivate di vPositionW) → passo facet zoom-stabile.
        float wpp = max(0.5 * (length(dFdx(vPositionW)) + length(dFdy(vPositionW))), 1e-6);

        // [DISPERSIONE SPETTRALE] integra N lunghezze d'onda → fire realistico.
        // Dove i cammini coincidono resta bianco; dove l'IOR li separa → colore.
        vec3 refr = vec3(0.0);
        vec3 wsum = vec3(0.0);
        for(int i=0;i<12;i++){
            if(i >= uDispSamples) break;
            float t = (uDispSamples > 1) ? float(i)/float(uDispSamples-1) : 0.5;
            float w = mix(400.0, 700.0, t);
            vec3 srgb = spectrumRGB(w);
            float ior = iorAt(w);
            vec3 env = traceChannel(I, N, uv, wpp, ior);
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
        // contrasto lineare attorno al pivot → separa nettamente le facce
        color = 0.5 + (color - 0.5) * uContrastBoost;
        // saturazione: esalta i colori di dispersione PRIMA del roll-off
        float l = luma(color);
        color = mix(vec3(l), color, uSaturation);
        // shoulder filmica: comprime i picchi mantenendo la tinta (no clip secco a bianco)
        color = color / (1.0 + max(color - 1.0, vec3(0.0)));
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

    // IOR + dispersione spettrale (la separazione IOR(λ) avviene nello shader)
    m.setParameter('uIorBase',    this.iorBase);
    m.setParameter('uDispersion', this.dispersion);
    m.setParameter('uDispSamples', Math.max(1, Math.round(this.dispersionSamples)));

    // Ambiente / riflessione
    m.setParameter('uEnvBrightness', this.envBrightness);
    m.setParameter('uEnvRotation',   this.envRotation);
    m.setParameter('uStudioContrast',this.studioContrast);
    m.setParameter('uFresnelBoost',  this.fresnelBoost);

    // Corpo / assorbimento
    m.setParameter('uBodyTint',       [this.bodyTint.r, this.bodyTint.g, this.bodyTint.b]);
    m.setParameter('uAbsorption',     this.absorption);
    m.setParameter('uAbsorptionColor',[this.absorptionColor.r, this.absorptionColor.g, this.absorptionColor.b]);

    // Key light (direzione mondo da azimuth/elevation)
    var ce = Math.cos(this.keyElevation);
    m.setParameter('uKeyDir', [ce * Math.cos(this.keyAzimuth), Math.sin(this.keyElevation), ce * Math.sin(this.keyAzimuth)]);
    m.setParameter('uKeyColor', [this.keyLightColor.r, this.keyLightColor.g, this.keyLightColor.b]);
    m.setParameter('uKeyIntensity', this.keyLightIntensity);
    m.setParameter('uKeySharpness', this.keyLightSharpness);

    // Tone mapping
    m.setParameter('uExposure',      this.exposure);
    m.setParameter('uContrastBoost', this.contrastBoost);
    m.setParameter('uSaturation',    this.saturation);
    m.setParameter('uBlack',         this.blackLevel);
    m.setParameter('uWhite',         this.whiteLevel);

    // Struttura interna
    m.setParameter('uBounces',     Math.round(this.internalBounces));
    m.setParameter('uFacetDetail', this.facetDetail);
    m.setParameter('uFacetStep',   this.facetStep);

    // Scintillazione
    m.setParameter('uSparkleCount',     Math.round(this.sparkleCount));
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

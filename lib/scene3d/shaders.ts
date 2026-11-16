// GLSL for the 3D fire view. Terrain shape, ground colour, fire positions, wind and sun angle are data; flames and smoke are simulated here.

/** Daytime smoke haze: thin smoke that hangs low and drifts downwind of the fire, thickest where the drifted-smoke map says smoke has passed.
 *  uHaze: density per metre at the base height, scale height in metres, gain on the drifted-smoke map, share that is present everywhere.
 *  The shader that includes this declares uE1Rect and uFogBase. At night uHaze.x is 0 and none of this runs. */
export const HAZE_FN = /* glsl */ `
uniform sampler2D uSmearMap; uniform vec4 uHaze; uniform vec3 uHazeCol; uniform float uHazeLit;
float hazeAt(vec2 xz){ return clamp(texture2D(uSmearMap, (xz - uE1Rect.xy) * uE1Rect.zw).g * uHaze.z, 0., 1.); }
// Optical depth of the haze between two points (the haze thins exponentially with height).
float hazeDepth(vec3 from, vec3 to){
  // Heights are measured from the fire's ground level and never count as below it, so low plains do not fill with haze. No upper limit: seen from high up the path is long but almost all of it is above the haze.
  float a = max((from.y - uFogBase) / uHaze.y, 0.), b = max((to.y - uFogBase) / uHaze.y, 0.), ea = exp(-min(a, 80.)), eb = exp(-min(b, 80.));
  float k = abs(a - b) < 1e-3 ? ea : (ea - eb) / (b - a);
  // How smoky the path is: each end counts by how much of the haze lies near it, so a view from high above takes the ground's value, not the camera's.
  float w = uHaze.w + (1. - uHaze.w) * (hazeAt(from.xz) * ea + hazeAt(to.xz) * eb) / max(ea + eb, 1e-6);
  return uHaze.x * w * distance(from, to) * k;
}`;

/** Lighting shared by the ground and the plants. Fire maps: r smoke source, g fire light, b burned ground, a smouldering. */
export const LIGHT = /* glsl */ `
uniform vec3 uSunDir, uSunCol, uSkyAmb, uGroundAmb, uFogCol, uFireCol;
uniform float uFogDensity, uFogBase, uTime, uShadowK, uFireLight, uDay;
uniform sampler2D uE0, uE1, uShadow0, uShadow1, uNoise;
uniform vec4 uE0Rect, uE1Rect;
${HAZE_FN}
float inside01(vec2 u){ vec2 e = min(u, 1. - u); return smoothstep(0., .05, min(e.x, e.y)); }
vec4 fireMap(vec2 xz){
  vec2 u0 = (xz - uE0Rect.xy) * uE0Rect.zw, u1 = (xz - uE1Rect.xy) * uE1Rect.zw;
  return mix(texture2D(uE1, u1), texture2D(uE0, u0), inside01(u0));
}
float plumeShadow(vec2 xz){ vec2 u0 = (xz - uE0Rect.xy) * uE0Rect.zw, u1 = (xz - uE1Rect.xy) * uE1Rect.zw; return exp(-uShadowK * mix(texture2D(uShadow1, u1).r, texture2D(uShadow0, u0).r, inside01(u0))); }
float fireFlicker(vec2 xz){ return .78 + .44 * texture2D(uNoise, xz * .002 + uTime * vec2(.31, .17)).r; }
// Direct sun reaching the ground (sh = share of sun left after the smoke), plus the warm diffuse light that filters down through smoke.
vec3 sunThroughSmoke(float sh, float ndl){ return uSunCol * (sh * (.3 + .7 * ndl) + (1. - sh) * pow(sh + .02, .12) * .42 * vec3(1., .8, .58)); }
// By day the skylight under a plume has come through the smoke as well: dimmer and orange-brown rather than blue.
vec3 skyUnderSmoke(vec3 amb, float sh){ return mix(amb, dot(amb, vec3(.3, .5, .2)) * vec3(1.3, .92, .56), (1. - sh) * .8 * uDay); }
vec3 applyFog(vec3 col, vec3 wp){
  float d = distance(cameraPosition, wp), a = (cameraPosition.y - uFogBase) / 1600., b = (wp.y - uFogBase) / 1600.;
  float k = abs(a - b) < 1e-3 ? exp(-a) : (exp(-a) - exp(-b)) / (b - a);
  col = mix(col, uFogCol, 1. - exp(-uFogDensity * d * k));
  if (uHaze.x > 0.) col = mix(col, uHazeCol * uHazeLit, 1. - exp(-hazeDepth(cameraPosition, wp)));
  return col;
}`;

export const TERRAIN_VERT = /* glsl */ `
attribute vec2 aMerc;
uniform vec4 uImgST[4];
varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv0, vUv1, vUv2, vUv3;
void main(){
  vWorld = position; vNormal = normal;
  vUv0 = aMerc * uImgST[0].xy + uImgST[0].zw; vUv1 = aMerc * uImgST[1].xy + uImgST[1].zw; vUv2 = aMerc * uImgST[2].xy + uImgST[2].zw; vUv3 = aMerc * uImgST[3].xy + uImgST[3].zw;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.);
}`;
export const TERRAIN_FRAG = /* glsl */ `
${LIGHT}
uniform sampler2D uImg0, uImg1, uImg2, uImg3;
uniform float uImgCount, uEmberGain;
uniform vec3 uImgGain[4];
uniform vec3 uFallback;
varying vec3 vWorld; varying vec3 vNormal; varying vec2 vUv0, vUv1, vUv2, vUv3;
void main(){
  vec3 alb = uFallback; vec4 t;
  t = texture2D(uImg0, vUv0); alb = mix(alb, t.rgb * uImgGain[0], inside01(vUv0) * t.a);
  if (uImgCount > 1.5) { t = texture2D(uImg1, vUv1); alb = mix(alb, t.rgb * uImgGain[1], inside01(vUv1) * t.a); }
  if (uImgCount > 2.5) { t = texture2D(uImg2, vUv2); alb = mix(alb, t.rgb * uImgGain[2], inside01(vUv2) * t.a); }
  if (uImgCount > 3.5) { t = texture2D(uImg3, vUv3); alb = mix(alb, t.rgb * uImgGain[3], inside01(vUv3) * t.a); }
  float dist = distance(cameraPosition, vWorld);
  // Close-range detail finer than the imagery resolves.
  float n1 = texture2D(uNoise, vWorld.xz * .031).r, n2 = texture2D(uNoise, vWorld.xz * .19).g, n3 = texture2D(uNoise, vWorld.xz * .9).b;
  float nearK = smoothstep(700., 30., dist);
  alb *= mix(1., .6 + (n1 * .35 + n2 * .35 + n3 * .3) * .82, nearK);
  // Burned ground, with a ragged edge.
  vec4 fm = fireMap(vWorld.xz);
  float far = smoothstep(600., 9000., dist);
  float rag = mix(texture2D(uNoise, vWorld.xz * .0031).a * .6 + n1 * .4, texture2D(uNoise, vWorld.xz * .00042).r * .55 + texture2D(uNoise, vWorld.xz * .0017).g * .45, far);
  float burn = smoothstep(.36, .6 + far * .25, fm.b + (rag - .5) * mix(.6, 1.1, far) * step(.02, fm.b));
  // Fresh burn is near black close up; from high up a burn scar reads as dark brown with the ground showing through.
  float ashy = smoothstep(.6, .9, n2) * .55 + smoothstep(.7, .95, n3) * .25;
  // By daylight char is dark grey-brown with pale ash on it; lit only by the fire at night it reads as black.
  vec3 ash = mix(mix(vec3(.012, .011, .010), vec3(.11, .1, .095), ashy), mix(vec3(.034, .030, .027), vec3(.24, .225, .21), ashy * 1.15) + alb * .06, uDay);
  ash = mix(ash, alb * .3 + vec3(.022, .018, .015), far);
  alb = mix(alb, ash, burn * mix(.95, .85, far));
  vec3 n = normalize(vNormal);
  vec2 g = vec2(texture2D(uNoise, vWorld.xz * .19 + vec2(.004, 0.)).g, texture2D(uNoise, vWorld.xz * .19 + vec2(0., .004)).g) - n2;
  n = normalize(n + vec3(-g.x, 0., -g.y) * 5. * nearK);
  float ndl = max(dot(n, uSunDir), 0.);
  float sh = plumeShadow(vWorld.xz);
  vec3 light = sunThroughSmoke(sh, ndl) + skyUnderSmoke(mix(uGroundAmb, uSkyAmb, n.y * .5 + .5), sh);
  light += uFireCol * fm.g * uFireLight * fireFlicker(vWorld.xz);
  vec3 col = alb * light;
  float emb = pow(texture2D(uNoise, vWorld.xz * .45 + uTime * .004).b, 9.) * min(fm.a, 1.);
  col += vec3(1., .32, .04) * emb * uEmberGain * (.6 + .4 * sin(uTime * 3. + n3 * 40.));
  gl_FragColor = vec4(applyFog(col, vWorld), 1.);
}`;

/** Plants: camera-facing cards cut from photo-scanned models, 8 directions by 2 camera heights, lit with baked normals. */
export const VEG_VERT = /* glsl */ `
attribute vec3 iPos; attribute vec4 iA; attribute vec3 iTint;
uniform vec4 uVar[12];
uniform vec3 uKindDist;
uniform vec2 uWindDir;
uniform float uTime, uWindSpeed;
varying vec2 vUv; varying vec2 vCell; varying vec3 vTint; varying vec3 vWorld; varying vec3 vBase; varying vec3 vR, vU, vB; varying float vBurn; varying float vDist;
float hash12(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  int vi = int(iA.z + .5); vec4 var = uVar[vi]; float s = iA.x;
  vec3 c = iPos + vec3(0., var.y * s, 0.);
  vec3 toCam = cameraPosition - c; float dist = length(toCam); toCam /= dist;
  float maxD = var.z < .5 ? uKindDist.x : (var.z < 1.5 ? uKindDist.y : uKindDist.z);
  float fade = 1. - smoothstep(maxD * .65, maxD, dist);
  float az = atan(toCam.x, -toCam.z), fi = floor(mod((az - iA.y) / 6.2831853 * 8. + .5, 8.));
  float row = step(.5236, asin(clamp(toCam.y, -1., 1.)) + (hash12(iPos.xz) - .5) * .24);
  float fAz = iA.y + fi * .7853982, fEl = row > .5 ? .8727 : .1745;
  vB = vec3(sin(fAz) * cos(fEl), sin(fEl), -cos(fAz) * cos(fEl)); vR = normalize(cross(vec3(0., 1., 0.), vB)); vU = cross(vB, vR);
  vec3 Rc = cross(vec3(0., 1., 0.), toCam); float rl = length(Rc); Rc = rl > 1e-3 ? Rc / rl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 Uc = cross(toCam, Rc);
  float r = var.x * s * step(.001, fade);
  float sway = sin(uTime * 1.7 + iPos.x * .05 + iPos.z * .07) * .6 + sin(uTime * 3.1 + iPos.x * .21) * .3;
  vec3 wp = c + (Rc * position.x + Uc * position.y) * r + vec3(uWindDir.x, 0., uWindDir.y) * sway * uWindSpeed * .006 * (position.y * .5 + .5) * r;
  vUv = position.xy * .5 + .5; vCell = vec2(row * 8. + fi, float(vi)); vTint = iTint * var.w; vWorld = wp; vBase = iPos; vBurn = iA.w; vDist = dist + (1. - fade) * 1e5;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.);
}`;
export const VEG_FRAG = /* glsl */ `
${LIGHT}
uniform sampler2D uAtlas, uAtlasN;
uniform vec2 uGrid;
varying vec2 vUv; varying vec2 vCell; varying vec3 vTint; varying vec3 vWorld; varying vec3 vBase; varying vec3 vR, vU, vB; varying float vBurn; varying float vDist;
void main(){
  vec2 uv = vec2((vCell.x + clamp(vUv.x, .004, .996)) / uGrid.x, 1. - (vCell.y + 1. - clamp(vUv.y, .004, .996)) / uGrid.y);
  vec4 t = texture2D(uAtlas, uv);
  float thr = mix(.42, .2, smoothstep(40., 700., vDist)) + vBurn * .28;
  if (t.a < thr || vDist > 9e4) discard;
  vec3 nt = texture2D(uAtlasN, uv).xyz * 2. - 1.;
  vec3 n = normalize(vR * nt.x + vU * nt.y + vB * nt.z);
  float ndl = dot(n, uSunDir), ao = mix(.4, 1., smoothstep(0., .75, vUv.y));
  float sh = plumeShadow(vBase.xz);
  vec3 light = uSunCol * (sh * (max(ndl, 0.) * .85 + .1 + max(-ndl, 0.) * .32 * vec3(.9, 1., .5)) + (1. - sh) * pow(sh + .02, .12) * .42 * vec3(1., .8, .58) * ao) + skyUnderSmoke(mix(uGroundAmb, uSkyAmb, n.y * .5 + .5), sh) * ao;
  vec4 fm = fireMap(vBase.xz);
  light += uFireCol * fm.g * uFireLight * fireFlicker(vBase.xz) * (.6 + .4 * n.y);
  vec3 col = t.rgb * vTint * light;
  col = mix(col, mix(vec3(.02) + t.rgb * .05, vec3(.03, .026, .022) + t.rgb * vec3(.2, .13, .07), uDay) * light, vBurn);
  gl_FragColor = vec4(applyFog(col, vWorld), 1.);
}`;

/** Soft shadow laid on the ground behind each plant, pointing away from the sun. */
export const SHADOW_VERT = /* glsl */ `
attribute vec3 iPos; attribute vec2 iS;
uniform vec3 uSunDir; uniform float uMaxDist;
varying vec2 vUv; varying float vK;
void main(){
  vec2 d = -normalize(uSunDir.xz + vec2(1e-5)); float len = clamp(iS.y * sqrt(max(1. - uSunDir.y * uSunDir.y, 0.)) / max(uSunDir.y, .12), iS.x * .5, iS.y * 5.);
  vec2 p = vec2(-d.y, d.x) * position.x * iS.x * .55 + d * (position.y * .5 + .5) * (len + iS.x * .3) - d * iS.x * .3;
  vec3 wp = iPos + vec3(p.x, .25, p.y);
  vUv = position.xy; vK = 1. - smoothstep(uMaxDist * .6, uMaxDist, distance(cameraPosition, wp));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.);
}`;
export const SHADOW_FRAG = /* glsl */ `
uniform float uStrength;
varying vec2 vUv; varying float vK;
void main(){ float a = (1. - smoothstep(.25, 1., length(vUv))) * uStrength * vK; if (a < .004) discard; gl_FragColor = vec4(0., 0., 0., a); }`;

/** Flames: camera-facing cards with a procedural flame, leaning with the wind. Kept visible from far away by growing with distance. */
export const FLAME_VERT = /* glsl */ `
attribute vec3 iPos; attribute vec4 iP;
uniform vec2 uWindDir; uniform float uLean, uFlameRef, uFogBase; uniform vec4 uE1Rect;
${HAZE_FN}
varying vec2 vUv; varying vec3 vP; varying float vHz;
void main(){
  vec3 toCam = cameraPosition - iPos; float dist = length(toCam); toCam /= dist;
  vHz = uHaze.x > 0. ? exp(-hazeDepth(cameraPosition, iPos + vec3(0., 2., 0.))) : 1.;
  float grow = max(1., dist / uFlameRef), w = iP.x * grow, h = iP.y * mix(1., .55, smoothstep(1., 8., grow)) * grow;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 R = cross(vec3(0., 1., 0.), toCam); float rl = length(R); R = rl > 1e-3 ? R / rl : camR;
  float top = smoothstep(.45, .9, toCam.y);
  R = normalize(mix(R, camR, top)); vec3 U = normalize(mix(vec3(0., 1., 0.), camU, top));
  float y = position.y * .5 + .5;
  vec3 wp = iPos + R * position.x * w * .5 + U * y * h + vec3(uWindDir.x, 0., uWindDir.y) * uLean * y * y * h * (1. - top);
  vUv = vec2(position.x, y); vP = vec3(iP.z, iP.w, grow);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.);
}`;
export const FLAME_FRAG = /* glsl */ `
uniform sampler2D uNoise; uniform float uTime, uFlameGain;
varying vec2 vUv; varying vec3 vP; varying float vHz;
void main(){
  float seed = vP.x, y = vUv.y, tt = uTime * (1. + seed * .5);
  float n1 = texture2D(uNoise, vec2(vUv.x * .22 + seed * 7.31, y * .34 - tt * .95 - seed * 3.)).r;
  float n2 = texture2D(uNoise, vec2(vUv.x * .55 + seed * 3.7, y * .8 - tt * 1.7)).g;
  float n3 = texture2D(uNoise, vec2(vUv.x * 1.3 + seed * 1.3, y * 1.9 - tt * 2.9)).b;
  float width = mix(.92, .06, pow(y, .75));
  float d = abs(vUv.x + (n1 - .5) * 1.2 * y + (n2 - .5) * .35 * y) / width;
  float shape = smoothstep(1., .2, d);
  float tear = smoothstep(.12 + y * 1.02, .42 + y * 1.02, n2 * .55 + n1 * .5 + n3 * .22 + (1. - y) * .42);
  float a = shape * tear * smoothstep(0., .04, y);
  #ifdef DEPTH_ONLY
  // Written to the depth buffer so smoke behind a flame does not dim it; smoke in front still does.
  if (a < .3) discard; gl_FragColor = vec4(0.); return;
  #endif
  if (a < .003) discard;
  float heat = a * (1.2 - y * .9) + (n3 - .5) * .3 * a;
  vec3 col = mix(vec3(.7, .06, 0.), vec3(1., .33, .02), smoothstep(.08, .5, heat));
  col = mix(col, vec3(1., .6, .12), smoothstep(.5, .95, heat)); col = mix(col, vec3(1., .88, .55), smoothstep(1.05, 1.5, heat));
  float I = uFlameGain * vP.y * (.5 + heat * 1.2);
  gl_FragColor = vec4(col * I * a * mix(.25, 1., vHz), a * .4);
}`;

/** Embers thrown up from the fire line. */
export const EMBER_VERT = /* glsl */ `
attribute vec4 iSeed;
uniform float uTime, uWindSpeed, uPx; uniform vec2 uWindDir;
varying float vA;
void main(){
  float life = 2.5 + 4.5 * iSeed.x, ph = fract(uTime / life + iSeed.y), age = ph * life;
  vec3 p = position + vec3(uWindDir.x, 0., uWindDir.y) * uWindSpeed * .7 * age * (.4 + iSeed.z)
    + vec3(0., (3. + 5. * iSeed.z) * age - .5 * age * age, 0.)
    + vec3(sin(age * 3.1 + iSeed.x * 40.), sin(age * 2.3 + iSeed.y * 40.) * .6, cos(age * 2.7 + iSeed.z * 40.)) * (.5 + age * .7);
  vec4 mv = viewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uPx * (.06 + .1 * iSeed.w) / max(-mv.z, 1.), 1., 9.);
  vA = (1. - ph) * smoothstep(0., .08, ph) * (.5 + .5 * sin(age * 9. + iSeed.w * 30.));
}`;
export const EMBER_FRAG = /* glsl */ `
uniform float uFlameGain; varying float vA;
void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .1, d) * vA; if (a < .01) discard; gl_FragColor = vec4(vec3(1., .5, .12) * uFlameGain * 1.6 * a, 0.); }`;

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = position; vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.); gl_Position = p.xyww; }`;
export const SKY_FRAG = /* glsl */ `
uniform vec3 uSun, uMoon, uZenith, uHorizon, uSunDisc, uMoonCol; uniform float uStars, uFogBase; uniform vec4 uE1Rect;
${HAZE_FN}
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir); float h = max(d.y, 0.);
  vec3 col = mix(uZenith, uHorizon, pow(1. - h, 3.5));
  float cs = max(dot(d, uSun), 0.);
  col += uSunDisc * (pow(cs, 700.) * .6 + pow(cs, 14.) * .1 + smoothstep(.99988, .99996, cs) * 30.);
  float cm = max(dot(d, uMoon), 0.);
  col += uMoonCol * (smoothstep(.99984, .99993, cm) * 5. + pow(cm, 400.) * .1);
  vec3 p = d * 230., ip = floor(p); float hs = fract(sin(dot(ip, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  col += vec3(step(.9987, hs) * smoothstep(.5, 0., length(fract(p) - .5)) * uStars * smoothstep(0., .15, d.y) * hs);
  col = mix(col, uHorizon * .85, smoothstep(0., -.06, d.y));
  if (uHaze.x > 0.) { // looking up through the haze layer: thick toward the horizon, thin overhead
    float a = clamp((cameraPosition.y - uFogBase) / uHaze.y, 0., 80.), w = uHaze.w + (1. - uHaze.w) * hazeAt(cameraPosition.xz);
    col = mix(col, uHazeCol * uHazeLit, 1. - exp(-uHaze.x * w * uHaze.y * exp(-a) / max(d.y, .025)));
  }
  gl_FragColor = vec4(col, 1.);
}`;

export const FS_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

/** Downwind smear of the smoke source: how much smoke has drifted over each spot once the plumes have levelled off. */
export const SMEAR_FRAG = /* glsl */ `
uniform sampler2D uE1; uniform vec2 uWindUv; uniform float uSizeM, uTexelM, uCap, uReach;
varying vec2 vUv;
void main(){
  float layer = 0., total = 0.;
  for (int i = 0; i < 80; i++) {
    float f = (float(i) + .5) / 80., s = uReach * f * f, ds = uReach * 2. * f / 80.;
    float lod = log2(max((.1 * s + 250.) / uTexelM, 1.));
    float v = textureLod(uE1, vUv - uWindUv * (s / uSizeM), lod).r * ds * exp(-s / (uReach * .55));
    total += v; layer += v * smoothstep(uCap * .7, uCap * 1.3, s);
  }
  gl_FragColor = vec4(layer, total, 0., 1.);
}`;

/** Smoke density, shared by the ray-march and the shadow bake. Each fire feeds a buoyant plume that rises, bends downwind and levels off into a drifting layer; density is ray-marched and lit by the sun, the sky and the fire below. */
export const SMOKE_FN = /* glsl */ `
precision highp sampler3D;
uniform sampler2D uE0, uE1, uSmear, uH0, uH1;
uniform sampler3D uVol;
uniform vec4 uE0Rect, uE1Rect;
uniform vec3 uSunDir;
uniform vec2 uWind;
uniform float uWindSpeed, uTime, uHmax, uLeanLen, uLayerAlt, uGroundRef, uYTop, uDensity, uLayerDens, uSmearInv, uCover, uSmoulderK, uE0Texel, uE1Texel;
float inside01(vec2 u){ vec2 e = min(u, 1. - u); return smoothstep(0., .05, min(e.x, e.y)); }
float groundH(vec2 xz){
  vec2 u0 = (xz - uE0Rect.xy) * uE0Rect.zw, u1 = (xz - uE1Rect.xy) * uE1Rect.zw;
  return mix(texture2D(uH1, u1).r, texture2D(uH0, u0).r, inside01(u0));
}
vec4 fireSrc(vec2 xz, float blur){
  vec2 u0 = (xz - uE0Rect.xy) * uE0Rect.zw, u1 = (xz - uE1Rect.xy) * uE1Rect.zw;
  float w0 = inside01(u0) * (1. - smoothstep(700., 1800., blur));
  vec4 e = textureLod(uE1, u1, log2(max(blur / uE1Texel, 1.)));
  if (w0 > 0.) e = mix(e, textureLod(uE0, u0, log2(max(blur / uE0Texel, 1.))), w0);
  return e;
}
const mat3 R1 = mat3(0.6517, 0.2478, -0.7168, -0.0469, 0.9565, 0.2880, 0.7570, -0.1541, 0.6350), R2 = mat3(-0.1465, -0.2363, -0.9606, -0.9102, 0.4124, 0.0374, 0.3873, 0.8798, -0.2755), R3 = mat3(0.2084, 0.8378, -0.5047, -0.0989, -0.4953, -0.8631, -0.9730, 0.2298, -0.0203); // each octave is turned so the tiling noise never lines up with itself
// Billow noise with features of about 20, 80, 320 or 1280 m (k = 0..3).
float oct(vec3 q, float k){
  if (k < .5) return texture(uVol, R3 * q / 80. + .13).r;
  if (k < 1.5) return texture(uVol, R2 * q / 320. + .71).r;
  if (k < 2.5) return texture(uVol, R1 * q / 1280. + .37).r;
  return texture(uVol, q / 5120.).r;
}
// Billows sized to the plume: blend the two octaves either side of the wanted feature size, so eddies grow as the plume widens.
float billows(vec3 q, float feat){
  float lg = clamp(log2(feat / 20.) * .5, 0., 3.), k = floor(lg), t = lg - k, a = oct(q, k);
  if (t < .03 || k > 2.5) return a;
  return (mix(a, oct(q, k + 1.), t) - .5) * (1. + .4 * (1. - abs(2. * t - 1.))) + .5;
}
float fine(vec3 q, float feat){ float k = clamp(floor(log2(feat / 20.) * .5 + .5), 0., 3.); return texture(uVol, R2 * q / (32. * pow(4., k)) + .29).g; }
// detail: 1 full noise, 0 cheaper noise (light samples), -1 no noise (shadow bake).
float smoke(vec3 p, float blurMin, float detail, out float glow, out float young){
  glow = 0.; young = 0.;
  float gh = groundH(p.xz), z0 = p.y - gh;
  if (z0 < -30. || p.y > uYTop) return 0.;
  float z = max(p.y - mix(gh, uGroundRef, clamp(z0 / uHmax, 0., 1.)), 0.);
  float f = clamp(z / uHmax, 0., .985);
  float s = uLeanLen * pow(-log(1. - f), 1.25);
  float sig = 14. + .15 * s + z * .2, blur = max(sig, blurMin);
  vec4 e = fireSrc(p.xz - uWind * s, blur);
  float column = (e.r + e.a * uSmoulderK * smoothstep(500., 60., z)) * (1. + 2.5 * f * f) * smoothstep(.985, .8, f);
  float dz = (p.y - uLayerAlt) / (.15 * uHmax);
  float lay = texture2D(uSmear, (p.xz - uE1Rect.xy) * uE1Rect.zw).r * uSmearInv * exp(-.5 * dz * dz);
  if (column < 1e-7 && lay < 1e-4) return 0.;
  glow = fireSrc(p.xz, max(blur, 60.)).g * exp(-z0 / 220.);
  young = smoothstep(520., 30., z + sig);
  if (detail < -.5) return column * .8 + lay * uLayerDens * .8;
  vec3 adv = vec3(uWind.x, 0., uWind.y) * (uWindSpeed * uTime * .55);
  float d = 0.;
  if (column > 1e-7) { // solid in the core, broken into billows toward the edge
    vec3 q = p - adv - vec3(0., uTime * 3.2 * (1. - f), 0.);
    float cov = 1. - exp(-column * blur / uCover), n = billows(q, blur * 1.6), v = cov - (1. - n) * .92;
    if (detail > .5) v -= (1. - fine(q, blur * 1.6)) * .2;
    d += column * smoothstep(0., .1, v) * (.9 + 1.2 * n);
  }
  if (lay > 1e-4) { // drifted smoke: soft, streaked along the wind
    vec3 q = p - adv; float qa = dot(q.xz, uWind); vec2 qc = q.xz - uWind * qa; vec3 ql = vec3(qc + uWind * qa * .4, q.y * 1.6);
    float n = (texture(uVol, ql / 5200.).r * .55 + texture(uVol, R1 * ql / 1500. + .37).r * .45 - .5) * 1.25 + .5, cov = 1. - exp(-lay * 2.6), v = cov - (1. - n) * .7;
    d += lay * uLayerDens * smoothstep(0., .3, v) * (.5 + n);
  }
  return d * 1.6;
}`;

/** Volumetric smoke. Each fire feeds a buoyant plume that rises, bends downwind and levels off into a drifting layer; density is ray-marched and lit by the sun, the sky and the fire below. */
export const SMOKE_FRAG = /* glsl */ `
${SMOKE_FN}
uniform sampler2D tDepth;
uniform mat4 uInvProj, uInvView;
uniform vec3 uCamPos, uSunCol, uSkyAmb, uGroundAmb, uFireCol;
uniform float uFireGlow, uJitter, uStepMin, uStepK, uMaxT, uDay, uFogBase;
${HAZE_FN}
uniform int uSteps, uLightSteps;
varying vec2 vUv;
float hg(float c, float g){ float k = 1. + g * g - 2. * g * c; return (1. - g * g) / (k * sqrt(k)); }
void main(){
  float depth = texture2D(tDepth, vUv).r;
  vec4 v = uInvProj * vec4(vUv * 2. - 1., depth * 2. - 1., 1.); v /= v.w;
  vec3 wp = (uInvView * v).xyz, rd = wp - uCamPos; float tScene = length(rd); rd /= tScene;
  if (depth > .99999) tScene = uMaxT;
  float tEnd = min(tScene, uMaxT), t = 0.;
  if (uCamPos.y > uYTop) { if (rd.y >= 0.) { gl_FragColor = vec4(0., 0., 0., 1.); return; } t = (uYTop - uCamPos.y) / rd.y; }
  else if (rd.y > 1e-4) tEnd = min(tEnd, (uYTop - uCamPos.y) / rd.y);
  float t0 = t, jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uJitter * vec2(47., 17.), vec2(.06711056, .00583715))));
  vec3 L = vec3(0.); float Tr = 1., tSum = 0., wSum = 0.;
  float cosT = dot(rd, uSunDir), phase = mix(hg(cosT, .62), hg(cosT, -.2), .35);
  for (int i = 0; i < 200; i++) {
    if (i >= uSteps || t >= tEnd || Tr < .012) break;
    float dt = max(uStepMin + t0 * .011, (t - t0) * uStepK); dt = min(dt, max(tEnd - t, 1.));
    vec3 p = uCamPos + rd * (t + dt * jit);
    float glow, young, dens = smoke(p, dt * .5, 1., glow, young);
    if (dens > 1e-7) {
      float od = 0., st = 14. + dt * .5; vec3 lp = p; float g2, y2;
      for (int j = 0; j < 6; j++) { if (j >= uLightSteps) break; lp += uSunDir * st; od += smoke(lp, st * .6, 0., g2, y2) * st; st *= 2.3; }
      od *= uDensity;
      // By day, light scattered many times keeps the inside of a thick column from going black.
      vec3 sun = uSunCol * (exp(-od * mix(vec3(.92, 1., 1.15), vec3(.8, 1., 1.4), uDay)) * phase + (exp(-od * .14) * .17 + .06 * uDay) * mix(vec3(1.), vec3(1.06, .88, .66), uDay * (1. - exp(-od * .5))));
      float up = smoke(p + vec3(0., 180. + dt, 0.), 120. + dt, 0., g2, y2) * uDensity * (300. + dt * 2.);
      vec3 amb = uSkyAmb * (mix(.25, .45, uDay) + mix(.75, .55, uDay) * exp(-up)) + uGroundAmb * .35;
      vec3 alb = mix(mix(vec3(.8, .78, .75), vec3(.62, .59, .545), uDay), vec3(.42, .36, .3), young * .75);
      vec3 S = (sun + amb) * alb + uFireCol * glow * uFireGlow * mix(.35, 1., young);
      float Ti = exp(-dens * uDensity * dt), wi = Tr * (1. - Ti);
      L += wi * S; tSum += wi * (t + dt * .5); wSum += wi; Tr *= Ti;
    }
    t += dt;
  }
  if (uHaze.x > 0. && wSum > 1e-4) { // haze lying between the eye and the smoke
    float th = exp(-hazeDepth(uCamPos, uCamPos + rd * (tSum / wSum)));
    L = L * th + (1. - Tr) * uHazeCol * uHazeLit * (1. - th);
  }
  gl_FragColor = vec4(L, Tr);
}`;
/** How much smoke lies between each patch of ground and the sun: marched once, since the wind and the sun are fixed. */
export const SHADOW_BAKE_FRAG = /* glsl */ `
${SMOKE_FN}
uniform vec3 uRect;
varying vec2 vUv;
void main(){
  vec2 xz = uRect.xy + vUv * uRect.z; vec3 p = vec3(xz.x, groundH(xz) + 2., xz.y); float od = 0., st = 22., g, y;
  for (int i = 0; i < 28; i++) { p += uSunDir * st; if (p.y > uYTop) break; od += smoke(p, st * .6, -1., g, y) * st; st *= 1.3; }
  gl_FragColor = vec4(od, 0., 0., 1.);
}`;

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene, tSmoke; uniform vec2 uSmokeTexel;
varying vec2 vUv;
void main(){
  // 3 x 3 tent (1-2-1 each way). uSmokeTexel is one smoke pixel when the smoke is drawn at reduced size, less when it is drawn at full size.
  vec2 e = uSmokeTexel;
  vec4 s = texture2D(tSmoke, vUv) * .25
    + (texture2D(tSmoke, vUv + vec2(e.x, 0.)) + texture2D(tSmoke, vUv - vec2(e.x, 0.)) + texture2D(tSmoke, vUv + vec2(0., e.y)) + texture2D(tSmoke, vUv - vec2(0., e.y))) * .125
    + (texture2D(tSmoke, vUv + e) + texture2D(tSmoke, vUv - e) + texture2D(tSmoke, vUv + vec2(e.x, -e.y)) + texture2D(tSmoke, vUv + vec2(-e.x, e.y))) * .0625;
  vec3 c = texture2D(tScene, vUv).rgb;
  gl_FragColor = vec4(c * pow(vec3(s.a), vec3(.93, 1., 1.16)) + s.rgb, 1.);
}`;
export const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * .5 + (texture2D(tSrc, vUv + uTexel * vec2(1., 1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(-1., 1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1., -1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(-1., -1.)).rgb) * .125;
  if (uThreshold > 0.) { float l = max(c.r, max(c.g, c.b)); c *= max(l - uThreshold, 0.) / max(l, 1e-4); c = min(c, vec3(60.)); }
  gl_FragColor = vec4(c, 1.);
}`;
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSrc, tAdd; uniform vec2 uTexel; uniform float uSpread;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb * .25 + (texture2D(tSrc, vUv + uTexel * vec2(1., 0.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(-1., 0.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0., 1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0., -1.)).rgb) * .125
    + (texture2D(tSrc, vUv + uTexel).rgb + texture2D(tSrc, vUv - uTexel).rgb + texture2D(tSrc, vUv + uTexel * vec2(1., -1.)).rgb + texture2D(tSrc, vUv + uTexel * vec2(-1., 1.)).rgb) * .0625;
  gl_FragColor = vec4(c * uSpread + texture2D(tAdd, vUv).rgb, 1.);
}`;
export const FINAL_FRAG = /* glsl */ `
uniform sampler2D tComp, tBloom; uniform float uExposure, uBloom, uGrain, uTime;
varying vec2 vUv;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main(){
  vec3 c = (texture2D(tComp, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom) * uExposure;
  c = aces(c * .82);
  c = pow(c, vec3(1. / 2.2));
  vec2 q = vUv - .5; c *= 1. - dot(q, q) * .42;
  float g = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - .5) * uGrain;
  gl_FragColor = vec4(c, 1.);
}`;
export const COPY_FRAG = /* glsl */ `uniform sampler2D tSrc; uniform float uGain; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * uGain, 1.); }`;

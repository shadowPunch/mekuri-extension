
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), stage = $('stage'), canvas = $('gl'), shadowEl = $('shadow'), msgEl = $('msg'), bar = $('bar');
const WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PI = Math.PI, TILT = 0.25, EDGE = 6, EXT = location.protocol.indexOf('extension') >= 0;
let CURL = 0.15, SPEED = 1;   // curl radius as a share of page width; animation speed multiplier
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = { doc: null, cur: 0, pref: 'auto', rtl: false, dbl: true, turn: null, zoom: 'page', rot: 0, tool: 'read', view: 'book',
  hl: '#FFE066', pen: '#D6293E', W: 0, H: 0, dpr: 1, pw: 0, ph: 0, pwFit: 1, spineX: 0, topY: 0, panX: 0, panY: 1e9, maxX: 0, maxY: 0,
  tw: 0, th: 0, texKey: '' };
try { const p = JSON.parse(localStorage.getItem('mekuri') || '{}'); if (p.pref) S.pref = p.pref; S.rtl = !!p.rtl; if (p.view === 'scroll') S.view = 'scroll';
  if (p.zoom === 'page' || p.zoom === 'width' || (p.zoom >= 0.3 && p.zoom <= 8)) S.zoom = p.zoom;
  if (p.curl >= 0.03 && p.curl <= 0.18) CURL = p.curl; if (p.speed >= 0.2 && p.speed <= 5) SPEED = p.speed; } catch (e) {}
const savePrefs = () => { try { localStorage.setItem('mekuri', JSON.stringify({ pref: S.pref, rtl: S.rtl, view: S.view, zoom: S.zoom, curl: CURL, speed: SPEED })); } catch (e) {} };

let msgTimer = 0;
function say(text, sticky) {
  clearTimeout(msgTimer);
  if (!text) { msgEl.hidden = true; return; }
  msgEl.textContent = text; msgEl.hidden = false;
  if (!sticky) msgTimer = setTimeout(() => { msgEl.hidden = true; }, 6000);
}

/* ---------- WebGL ---------- */
const glOpts = { alpha: true, antialias: true, premultipliedAlpha: true };
let gl = canvas.getContext('webgl2', glOpts); const gl2 = !!gl;
if (!gl) gl = canvas.getContext('webgl', glOpts);
if (!gl) { say('This browser has WebGL turned off, so the book cannot be drawn. Turn on hardware acceleration and reload.', true); return; }

const VS = `
attribute vec2 aUV;
uniform vec2 uSize; uniform float uXOff; uniform float uLeaf; uniform vec4 uFold;
uniform vec2 uOrigin; uniform vec2 uStage; uniform float uMirror; uniform float uCam;
varying vec2 vUV; varying vec2 vP; varying float vS; varying float vClipX;
const float PI = 3.14159265;
void main(){
  vec2 p = vec2(uXOff + aUV.x*uSize.x, aUV.y*uSize.y);
  vec2 pos = p; float z = 0.0; float s = 0.0;
  if (uLeaf > 0.5) {
    vec2 dir = vec2(cos(uFold.w), sin(uFold.w));
    s = dot(p - uFold.xy, dir);
    float r = uFold.z;
    if (s > 0.0) {
      float th = s / r; vec2 base = p - dir*s;
      if (th < PI) { pos = base + dir*(r*sin(th)); z = r*(1.0 - cos(th)); }
      else { pos = base - dir*(s - PI*r); z = 2.0*r; }
    }
  }
  vUV = aUV; vP = p; vS = s;
  vec2 c = uStage*0.5;
  vec2 sp = vec2(uOrigin.x + uMirror*pos.x, uOrigin.y + pos.y);
  sp = c + (sp - c)*(uCam/(uCam - z));
  vClipX = uMirror*(sp.x - uOrigin.x);
  gl_Position = vec4(sp.x/uStage.x*2.0 - 1.0, 1.0 - sp.y/uStage.y*2.0, -z/(uSize.x*4.0), 1.0);
}`;
const FS = `
precision highp float;
varying vec2 vUV; varying vec2 vP; varying float vS; varying float vClipX;
uniform sampler2D uTex; uniform sampler2D uBack;
uniform float uLeaf; uniform float uGhost; uniform float uFlipU; uniform float uSpine; uniform float uClip; uniform float uShadowK;
uniform vec4 uFold; uniform vec2 uSize; uniform vec3 uPaper;
const float PI = 3.14159265;
void main(){
  if (uClip > 0.5 && vClipX < 0.0) discard;
  float w = uSize.x; float r = uFold.z;
  vec3 front = texture2D(uTex, vec2(mix(vUV.x, 1.0 - vUV.x, uFlipU), vUV.y)).rgb;
  vec3 backT = texture2D(uBack, vec2(mix(1.0 - vUV.x, vUV.x, uFlipU), vUV.y)).rgb;
  float th = uLeaf > 0.5 ? max(vS, 0.0)/r : 0.0;
  vec3 col = front;
  if (th > PI*0.5) col = uGhost > 0.5 ? mix(uPaper, front, 0.10) : backT;
  float ax = abs(vP.x);
  float sh = 1.0 - uSpine*(0.20*exp(-ax/(0.03*w)) + 0.05*exp(-ax/(0.22*w)));
  if (th > 0.0) {
    if (th < PI*0.5) sh *= 1.0 - 0.30*sin(th);
    else if (th < PI) sh *= mix(0.70, 1.0, smoothstep(0.0, 0.9, (th - PI*0.5)/(PI*0.5)));
  } else if (uShadowK > 0.0) {
    vec2 dir = vec2(cos(uFold.w), sin(uFold.w));
    float sq = dot(vP - uFold.xy, dir);
    float s1 = sq > 0.0 ? exp(-max(sq - r, 0.0)/(0.9*r)) : 0.0;
    vec2 src = vP + dir*(PI*r - 2.0*sq);
    vec2 o = max(max(-src, src - uSize), 0.0);
    float s2 = sq <= 0.0 ? 1.0 - smoothstep(0.0, 2.2*r, length(o)) : 0.0;
    sh *= 1.0 - uShadowK*(s1 + 0.8*s2);
  }
  gl_FragColor = vec4(col*sh, 1.0);
}`;
function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s)); return s; }
const prog = gl.createProgram();
gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog); gl.useProgram(prog);
const U = {};
['uSize','uXOff','uLeaf','uFold','uOrigin','uStage','uMirror','uCam','uTex','uBack','uGhost','uFlipU','uSpine','uClip','uShadowK','uPaper']
  .forEach(n => { U[n] = gl.getUniformLocation(prog, n); });
const NX = 72, NY = 36;
const verts = new Float32Array((NX + 1)*(NY + 1)*2); const idx = new Uint16Array(NX*NY*6);
for (let j = 0, k = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { verts[k++] = i/NX; verts[k++] = j/NY; }
for (let j = 0, k = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const a = j*(NX + 1) + i, b = a + NX + 1;
  idx[k++] = a; idx[k++] = b; idx[k++] = a + 1; idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1; }
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
const aUV = gl.getAttribLocation(prog, 'aUV'); gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
gl.uniform1i(U.uTex, 0); gl.uniform1i(U.uBack, 1); gl.depthFunc(gl.LEQUAL);
const PAPER = [0.98, 0.975, 0.955];
const blankTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, blankTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([250, 249, 244, 255]));

/* ---------- book model ---------- */
const nSpreads = () => !S.doc ? 1 : (S.dbl ? Math.floor(S.doc.n/2) + 1 : S.doc.n);
const leftOf = k => (S.dbl && k >= 1 && 2*k <= S.doc.n) ? 2*k : 0;
const rightOf = k => { const p = S.dbl ? 2*k + 1 : k + 1; return (k >= 0 && p <= S.doc.n) ? p : 0; };
const firstPage = k => leftOf(k) || rightOf(k) || 1;
const spreadOf = p => S.dbl ? Math.floor(p/2) : p - 1;

/* ---------- marks: highlights and drawings, stored per page in unrotated page coordinates (0..1) ---------- */
const AN = { map: new Map(), ver: new Map(), undo: [] };
const annosOf = p => AN.map.get(p) || [];
const verOf = p => AN.ver.get(p) || 0;
const toDisp = (u, v) => S.rot === 90 ? [1 - v, u] : S.rot === 180 ? [1 - u, 1 - v] : S.rot === 270 ? [v, 1 - u] : [u, v];
const toBase = (x, y) => S.rot === 90 ? [y, 1 - x] : S.rot === 180 ? [1 - x, 1 - y] : S.rot === 270 ? [1 - y, x] : [x, y];
function drawAnnos(ctx, p, x, y, fw, fh, baked) {
  for (const a of annosOf(p)) {
    ctx.save();
    if (a.t === 'hl') {
      if (baked) ctx.globalCompositeOperation = 'multiply'; else ctx.globalAlpha = 0.45;
      ctx.fillStyle = a.c; ctx.beginPath();
      for (const r of a.r) { const p0 = toDisp(r[0], r[1]), p1 = toDisp(r[0] + r[2], r[1] + r[3]);
        ctx.rect(x + Math.min(p0[0], p1[0])*fw, y + Math.min(p0[1], p1[1])*fh, Math.abs(p1[0] - p0[0])*fw, Math.abs(p1[1] - p0[1])*fh); }
      ctx.fill();
    } else {
      ctx.strokeStyle = ctx.fillStyle = a.c; ctx.lineWidth = Math.max(1, a.w*(S.rot % 180 ? fh : fw)); ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      a.pts.forEach((q, i) => { const d = toDisp(q[0], q[1]); if (i) ctx.lineTo(x + d[0]*fw, y + d[1]*fh); else ctx.moveTo(x + d[0]*fw, y + d[1]*fh); });
      if (a.pts.length === 1) ctx.lineTo(x + toDisp(a.pts[0][0], a.pts[0][1])[0]*fw + 0.01, y + toDisp(a.pts[0][0], a.pts[0][1])[1]*fh);
      ctx.stroke();
    }
    ctx.restore();
  }
}
let persistTimer = 0;
function touch(p) {
  AN.ver.set(p, verOf(p) + 1); schedule(); refreshInk(); if (S.view === 'scroll') pumpScroll();
  clearTimeout(persistTimer); persistTimer = setTimeout(() => { if (!S.doc || !S.doc.id) return;
    try { localStorage.setItem('mekuri-marks:' + S.doc.id, JSON.stringify([...AN.map].filter(e => e[1].length))); } catch (e) {} }, 400);
}
function addAnno(p, a) { if (!AN.map.has(p)) AN.map.set(p, []); AN.map.get(p).push(a); AN.undo.push([p, a]); touch(p); }
function undo() { const u = AN.undo.pop(); if (!u) return; const arr = annosOf(u[0]), i = arr.indexOf(u[1]); if (i >= 0) { arr.splice(i, 1); touch(u[0]); } }

/* ---------- page textures ---------- */
const cache = new Map(); let want = [], busy = false, texTimer = 0;
const texFor = p => { const e = cache.get(p); return e && e.tex ? e.tex : blankTex; };
function upload(e, cnv) {
  if (!e.tex) e.tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, e.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cnv);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (gl2) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
  else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
}
function clearCache() { for (const e of cache.values()) if (e.tex) gl.deleteTexture(e.tex); cache.clear(); }
function evict() {
  if (cache.size <= 12) return;
  const here = firstPage(S.cur);
  const far = [...cache.keys()].filter(p => !want.includes(p)).sort((a, b) => Math.abs(b - here) - Math.abs(a - here));
  while (cache.size > 12 && far.length) { const p = far.shift(); const e = cache.get(p); if (e.tex) gl.deleteTexture(e.tex); cache.delete(p); }
}
function schedule() {
  if (!S.doc || !S.texKey || S.view === 'scroll') return;
  want = [];
  for (const k of [S.cur, S.cur + 1, S.cur - 1, S.cur + 2]) {
    if (k < 0 || k >= nSpreads()) continue;
    for (const p of [rightOf(k), leftOf(k)]) if (p) want.push(p);
  }
  pump();
}
async function pump() {
  if (busy) return; busy = true;
  try {
    for (;;) {
      const doc = S.doc, key = S.texKey;
      const p = want.find(q => { const e = cache.get(q); return !e || e.key !== key || e.av !== verOf(q); });
      if (!p || !doc) break;
      const av = verOf(p); let cnv = null;
      try { cnv = await doc.render(p, S.tw, S.th); } catch (err) { console.warn('Page ' + p + ' failed to render', err); }
      if (doc !== S.doc || key !== S.texKey) continue;
      const e = cache.get(p) || {}; e.key = key; e.av = av;
      if (cnv) upload(e, cnv);
      cache.set(p, e); evict(); refreshInk(); requestDraw();
      await new Promise(r => setTimeout(r, 0));
    }
  } finally { busy = false; }
}

/* ---------- layout, zoom and pan ---------- */
function layout() {
  const rc = stage.getBoundingClientRect(), W = rc.width, H = rc.height;
  if (W < 10 || H < 10) return;
  S.W = W; S.H = H; S.dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(W*S.dpr), ch = Math.round(H*S.dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const asp = S.doc ? S.doc.aspect : 0.7;
  const scroll = S.view === 'scroll'; app.dataset.view = S.view; $('scroller').hidden = !scroll;
  const dbl = scroll ? false : S.pref === 'auto' ? (W > H*1.1 && W >= 640) : S.pref === 'double';
  if (dbl !== S.dbl && S.doc) { const p = firstPage(S.cur); S.turn = null; S.dbl = dbl; S.cur = clamp(spreadOf(p), 0, nSpreads() - 1); S.panY = 1e9; }
  else S.dbl = dbl;
  const n = S.dbl ? 2 : 1;
  const side = scroll ? 20 : EDGE;
  S.pwFit = Math.min((W - 2*side)/n, (H - 2*EDGE - (scroll ? 12 : 0))*asp);
  S.pw = S.zoom === 'page' ? S.pwFit : S.zoom === 'width' ? (W - 2*side - 16)/n : S.pwFit*S.zoom;
  S.ph = S.pw/asp;
  if (scroll) { hideLayers(); updateUI(); buildScroll(); requestDraw(); return; }
  clearScroll();
  clearTimeout(texTimer); texTimer = setTimeout(retex, S.texKey ? 220 : 0);
  place(); updateUI(); buildLayers();
}
function place() {
  const bw = (S.dbl ? 2 : 1)*S.pw, bh = S.ph;
  S.maxX = bw > S.W ? (bw - S.W)/2 + EDGE : 0; S.maxY = bh > S.H ? (bh - S.H)/2 + EDGE : 0;
  S.panX = clamp(S.panX, -S.maxX, S.maxX); S.panY = clamp(S.panY, -S.maxY, S.maxY);
  const left = (S.W - bw)/2 + S.panX; S.topY = (S.H - bh)/2 + S.panY;
  S.spineX = S.dbl ? left + S.pw : (S.rtl ? left + S.pw : left);
  positionLayers(); requestDraw();
}
function retex() {
  const tw = clamp(Math.round(S.pw*S.dpr*1.1), 480, 2200);
  if (!S.texKey || Math.abs(tw - S.tw)/S.tw > 0.08) {
    S.tw = tw; S.th = Math.round(tw/(S.doc ? S.doc.aspect : 0.7)); S.texKey = S.tw + 'x' + S.th;
  }
  schedule();
}
function setZoom(z) { S.zoom = z; S.panY = 1e9; savePrefs(); layout(); }
const zoomBy = f => setZoom(clamp(S.pw/S.pwFit*f, 0.4, 6));

/* ---------- drawing ---------- */
let raf = 0, lastShadow = '';
const requestDraw = () => { if (!raf) raf = requestAnimationFrame(frame); };
function frame(now) {
  raf = 0;
  const T = S.turn;
  if (T && T.anim) {
    const a = T.anim, x = clamp((now - a.start)/a.dur, 0, 1);
    T.t = a.from + (a.to - a.from)*a.ease(x);
    if (x >= 1) commit(a.to); else requestDraw();
  }
  draw();
}
function bindPage(unit, tex) { gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
function draw() {
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (!S.doc || !S.pw || S.view === 'scroll') return;
  const T = S.turn, A = T ? T.A : S.cur, t = T ? T.t : 0, w = S.pw, h = S.ph;
  const rr = CURL*w*Math.sin(PI*t), r = Math.max(rr, 0.004*w), d = w*(1 - t) - PI*rr/2;
  const tilt = T ? Math.min(TILT, 2*(1 - PI*PI*CURL/2)*w/h)*T.yn*Math.sin(PI*t) : 0;
  // a backward turn is the mirror image: the page lifts from its other edge and bends the other way
  const mir = !!(T && T.mir), mm = (S.rtl ? -1 : 1)*(mir ? -1 : 1), one = !S.dbl;
  const ox = S.spineX + (one && mir ? (S.rtl ? -w : w) : 0);
  gl.uniform2f(U.uSize, w, h); gl.uniform2f(U.uOrigin, ox, S.topY); gl.uniform2f(U.uStage, S.W, S.H);
  gl.uniform1f(U.uMirror, mm); gl.uniform1f(U.uFlipU, S.rtl !== mir ? 1 : 0); gl.uniform1f(U.uCam, 5*w);
  gl.uniform4f(U.uFold, d, T ? T.yf : h/2, r, tilt);
  gl.uniform1f(U.uSpine, S.dbl ? 1 : 0); gl.uniform3fv(U.uPaper, PAPER);
  gl.uniform1f(U.uShadowK, T ? 0.42*clamp(rr/(0.05*w), 0, 1) : 0);
  const count = NX*NY*6;
  gl.disable(gl.DEPTH_TEST); gl.uniform1f(U.uLeaf, 0); gl.uniform1f(U.uClip, 0); gl.uniform1f(U.uGhost, 0);
  bindPage(gl.TEXTURE1, blankTex);
  const L = one ? 0 : mir ? rightOf(A + 1) : leftOf(A), Rr = mir ? (one ? rightOf(A) : leftOf(A)) : rightOf(T ? A + 1 : A);
  if (L) { gl.uniform1f(U.uXOff, -w); bindPage(gl.TEXTURE0, texFor(L)); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0); }
  if (Rr) { gl.uniform1f(U.uXOff, 0); bindPage(gl.TEXTURE0, texFor(Rr)); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0); }
  if (T) {
    gl.enable(gl.DEPTH_TEST); gl.uniform1f(U.uLeaf, 1); gl.uniform1f(U.uXOff, 0);
    gl.uniform1f(U.uClip, S.dbl ? 0 : 1); gl.uniform1f(U.uGhost, S.dbl ? 0 : 1);
    bindPage(gl.TEXTURE0, texFor(mir ? (one ? rightOf(A + 1) : leftOf(A + 1)) : rightOf(A)));
    bindPage(gl.TEXTURE1, S.dbl ? texFor(mir ? rightOf(A) : leftOf(A + 1)) : blankTex);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  }
  const hasL = S.dbl && (L || (T && t > 0.5)), hasR = T ? (Rr || t < 0.5) : !!Rr;
  const x0 = hasL ? -w : 0, x1 = hasR ? w : 0;
  const left = one ? (S.rtl ? S.spineX - w : S.spineX) : mm < 0 ? S.spineX - x1 : S.spineX + x0;
  const css = `left:${left}px;top:${S.topY}px;width:${one ? w : Math.max(0, x1 - x0)}px;height:${h}px`;
  if (css !== lastShadow) { shadowEl.style.cssText = css; lastShadow = css; }
}

/* ---------- page overlays: selectable text, find marks, fresh ink ---------- */
const LAY = [$('layA'), $('layB')].map(el => ({ el, fl: el.children[0], ink: el.children[1], tl: el.children[2] }));
let VIS = [], layerGen = 0, stroke = null;
function hideLayers() { layerGen++; VIS = []; LAY.forEach(l => { l.el.hidden = true; }); }
function restSlots() {      // pages lying flat right now, with the screen x of each page's left edge relative to the spine
  if (!S.doc || S.turn || S.view === 'scroll') return [];
  const out = [], a = leftOf(S.cur), b = rightOf(S.cur);
  if (S.dbl) { if (a) out.push({ p: a, dx: S.rtl ? 0 : -S.pw }); if (b) out.push({ p: b, dx: S.rtl ? -S.pw : 0 }); }
  else if (b) out.push({ p: b, dx: S.rtl ? -S.pw : 0 });
  return out;
}
function textIndex(tc) { let s = ''; const starts = [], lens = [];
  for (const it of tc.items) { if (it.str === undefined) continue; starts.push(s.length); lens.push(it.str.length); s += it.str + (it.hasEOL ? '\n' : ''); }
  return { low: s.toLowerCase().replace(/\n/g, ' '), starts, lens }; }
async function buildText(s, info, fit, alive) {      // selectable text over one page; false if the view changed meanwhile
  const doc = S.doc; s.tl.textContent = ''; s.fl.textContent = ''; s.divs = null; s.hasText = false;
  if (info.page && pdfjsLib.renderTextLayer) {
    try {
      const tc = await info.page.getTextContent(); if (!alive()) return false;
      const divs = []; s.tl.style.width = s.tl.style.height = ''; s.tl.style.setProperty('--scale-factor', fit);
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: s.tl, viewport: info.page.getViewport({ scale: fit, rotation: info.rotation }), textDivs: divs }).promise;
      if (!alive()) return false;
      s.divs = divs; s.ti = textIndex(tc); doc.texts.set(s.p, s.ti);
    } catch (e) { console.warn('Text layer failed', e); }
  } else if (info.runs) {     // sample booklet: lay a span over every line that was painted
    s.tl.removeAttribute('data-main-rotation'); s.tl.style.width = s.tl.style.height = '100%'; s.divs = [];
    for (const r of info.runs) { const d = document.createElement('span'); d.textContent = r.str;
      d.style.cssText = `left:${r.x*s.fw}px;top:${r.y*s.fh}px;font-size:${r.h*s.fh/1.15}px`; s.tl.appendChild(d);
      const mw = d.getBoundingClientRect().width; if (mw > 0) d.style.transform = `scaleX(${r.w*s.fw/mw})`; s.divs.push(d); }
    s.ti = textIndex({ items: info.runs.map(r => ({ str: r.str, hasEOL: true })) });
  }
  if (s.divs) {               // how far the text reaches sideways, measured from the page's left edge
    const eb = s.el.getBoundingClientRect(); let a = 1e9, b = -1e9;
    for (const d of s.divs) { if (!d.isConnected || !/\S/.test(d.textContent)) continue; const r = d.getBoundingClientRect();
      if (r.width < 1) continue; a = Math.min(a, r.left - eb.left); b = Math.max(b, r.right - eb.left); }
    if (b > a) { s.hasText = true; s.tx0 = a + (s.ox || 0); s.tx1 = b + (s.ox || 0); }
  }
  return true;
}
async function buildLayers() {
  hideLayers(); const gen = layerGen, doc = S.doc, slots = restSlots(), vis = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i], l = LAY[i];
    let info; try { info = await doc.info(s.p); } catch (e) { continue; }
    if (gen !== layerGen) return;
    const fit = Math.min(S.pw/info.vw, S.ph/info.vh);
    s.fw = info.vw*fit; s.fh = info.vh*fit; s.ox = (S.pw - s.fw)/2; s.oy = (S.ph - s.fh)/2; Object.assign(s, l);
    l.el.style.cssText = `left:${S.spineX + s.dx + s.ox}px;top:${S.topY + s.oy}px;width:${s.fw}px;height:${s.fh}px`; l.el.hidden = false;
    l.ink.width = Math.round(s.fw*S.dpr); l.ink.height = Math.round(s.fh*S.dpr);
    l.ink.getContext('2d').clearRect(0, 0, l.ink.width, l.ink.height);
    if (!(await buildText(s, info, fit, () => gen === layerGen))) return;
    vis.push(s);
  }
  if (gen !== layerGen) return;
  VIS = vis; positionLayers(); refreshInk(); drawFind();
}
function positionLayers() { if (S.view === 'scroll') return; for (const s of VIS) { s.el.style.left = (S.spineX + s.dx + s.ox) + 'px'; s.el.style.top = (S.topY + s.oy) + 'px'; } }

/* ---------- scroll view: every page stacked in one ordinary scrolling column, drawn only while near the window ---------- */
const scroller = $('scroller'); let SP = [], io = null, scrollGen = 0, sBusy = false;
function clearScroll() { if (!SP.length) return; scrollGen++; if (io) io.disconnect(); io = null; scroller.textContent = ''; SP = []; }
function buildScroll() {
  const keep = S.cur; clearScroll(); scrollGen++; VIS = [];
  const doc = S.doc; if (!doc) return;
  io = new IntersectionObserver(es => { for (const en of es) { const sp = SP[+en.target.dataset.i]; if (sp) sp.near = en.isIntersecting; } pumpScroll(); },
    { root: scroller, rootMargin: '120% 0px' });
  const frag = document.createDocumentFragment();
  for (let p = 1; p <= doc.n; p++) {
    const el = document.createElement('div'); el.className = 'spage'; el.dataset.i = p - 1;
    el.style.width = S.pw + 'px'; el.style.height = S.ph + 'px';
    el.innerHTML = '<canvas class="pg"></canvas><div class="findLayer"></div><canvas class="ink"></canvas><div class="textLayer"></div>';
    frag.appendChild(el);
    SP.push({ p, el, pg: el.children[0], fl: el.children[1], ink: el.children[2], tl: el.children[3], near: false, built: false, av: -1 });
  }
  scroller.appendChild(frag); SP.forEach(sp => io.observe(sp.el));
  scrollToPage(keep + 1);
}
function scrollToPage(p) { const sp = SP[clamp(p, 1, SP.length) - 1]; if (sp) scroller.scrollTop = sp.el.offsetTop - 8; }
async function pumpScroll() {
  if (sBusy) return; sBusy = true; const gen = scrollGen;
  try {
    for (;;) {
      for (const sp of SP) if (!sp.near && sp.built) { sp.built = false; sp.av = -1; sp.pg.width = sp.pg.height = 0; sp.ink.width = sp.ink.height = 0; sp.tl.textContent = ''; sp.fl.textContent = ''; sp.divs = null; }
      VIS = SP.filter(q => q.built);
      const sp = SP.find(q => q.near && (!q.built || q.av !== verOf(q.p))); if (!sp) break;
      const doc = S.doc, info = await doc.info(sp.p); if (gen !== scrollGen) return;
      const w = S.pw, h = w*info.vh/info.vw, tw = Math.round(w*S.dpr), th = Math.round(h*S.dpr), av = verOf(sp.p);
      sp.el.style.height = h + 'px'; sp.fw = w; sp.fh = h;
      let c = null; try { c = await doc.render(sp.p, tw, th); } catch (e) { console.warn('Page ' + sp.p + ' failed to render', e); }
      if (gen !== scrollGen) return;
      if (c) { sp.pg.width = tw; sp.pg.height = th; sp.pg.getContext('2d').drawImage(c, 0, 0); c.width = c.height = 0; }
      sp.av = av;
      if (!sp.built) { sp.ink.width = tw; sp.ink.height = th; if (!(await buildText(sp, info, w/info.vw, () => gen === scrollGen))) return; sp.built = true; }
      VIS = SP.filter(q => q.built); refreshInk(); drawFind();
    }
  } finally { sBusy = false; if (gen !== scrollGen && S.view === 'scroll') pumpScroll(); }
}
let scrollRaf = 0;
scroller.addEventListener('scroll', () => { if (scrollRaf) return; scrollRaf = requestAnimationFrame(() => { scrollRaf = 0;
  const y = scroller.scrollTop + scroller.clientHeight*0.4; let k = 0;
  for (let i = 0; i < SP.length; i++) { if (SP[i].el.offsetTop <= y) k = i; else break; }
  if (k !== S.cur) { S.cur = k; updateUI(); } }); });
function setView(v) { if (v === S.view) return; finishTurn(); S.view = v; S.panY = 1e9; savePrefs(); layout(); }
function strokePath(ctx, pts, w, h) { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q[0]*w, q[1]*h) : ctx.moveTo(q[0]*w, q[1]*h));
  if (pts.length === 1) ctx.lineTo(pts[0][0]*w + 0.01, pts[0][1]*h); ctx.stroke(); }
function refreshInk() {     // marks show here until the page texture has been re-rendered with them baked in
  for (const s of VIS) {
    const ctx = s.ink.getContext('2d'), w = s.ink.width, h = s.ink.height; ctx.clearRect(0, 0, w, h);
    const e = cache.get(s.p); if (S.view === 'scroll' ? s.av !== verOf(s.p) : (!e || e.av !== verOf(s.p))) drawAnnos(ctx, s.p, 0, 0, w, h, false);
    if (stroke && stroke.s === s) { ctx.strokeStyle = S.pen; ctx.lineWidth = Math.max(1, 0.0045*w); ctx.lineCap = ctx.lineJoin = 'round'; strokePath(ctx, stroke.pts, w, h); }
  }
}
function slotAt(e) { for (const s of VIS) { const b = s.el.getBoundingClientRect();
  if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) return { s, x: (e.clientX - b.left)/b.width, y: (e.clientY - b.top)/b.height, b }; }
  return null; }
function highlightSelection() {
  const sel = window.getSelection(); if (!sel || sel.isCollapsed || !VIS.length) return false;
  const per = new Map(), boxes = VIS.map(s => s.el.getBoundingClientRect());
  for (let i = 0; i < sel.rangeCount; i++) for (const rc of sel.getRangeAt(i).getClientRects()) {
    if (rc.width < 1 || rc.height < 1) continue;
    const cx = rc.left + rc.width/2, cy = rc.top + rc.height/2;
    const k = boxes.findIndex(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom); if (k < 0) continue;
    const b = boxes[k]; if (rc.width > b.width*0.98 && rc.height > b.height*0.5) continue;
    const p0 = toBase((rc.left - b.left)/b.width, (rc.top - b.top)/b.height), p1 = toBase((rc.right - b.left)/b.width, (rc.bottom - b.top)/b.height);
    const p = VIS[k].p; if (!per.has(p)) per.set(p, []);
    per.get(p).push([Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])]);
  }
  per.forEach((r, p) => addAnno(p, { t: 'hl', c: S.hl, r }));
  sel.removeAllRanges(); return per.size > 0;
}
function eraseAt(hit) {
  const arr = annosOf(hit.s.p), W = hit.b.width, H = hit.b.height;
  for (let i = arr.length - 1; i >= 0; i--) { const a = arr[i]; let on = false;
    if (a.t === 'hl') on = a.r.some(r => { const p0 = toDisp(r[0], r[1]), p1 = toDisp(r[0] + r[2], r[1] + r[3]);
      return hit.x >= Math.min(p0[0], p1[0]) && hit.x <= Math.max(p0[0], p1[0]) && hit.y >= Math.min(p0[1], p1[1]) && hit.y <= Math.max(p0[1], p1[1]); });
    else on = a.pts.some(q => { const d = toDisp(q[0], q[1]); return Math.hypot((d[0] - hit.x)*W, (d[1] - hit.y)*H) < 10; });
    if (on) { arr.splice(i, 1); touch(hit.s.p); return; } }
}
// Text selection is driven by hand: the caret snaps to the nearest piece of text, so the selection
// does not jump to the end of the page when the pointer crosses a margin or the gap between lines.
let selDrag = null;
function caretAt(x, y, spans) {
  let best = null, bd = 1e9;
  for (const q of spans) { const r = q.r, dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0, dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dy*4 + dx; if (d < bd) { bd = d; best = q; } }
  if (!best) return null;
  const r = best.r, node = best.node;
  if (x <= r.left) return [node, 0]; if (x >= r.right) return [node, node.length];
  const cr = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, (r.top + r.bottom)/2) : null;
  return [node, cr && cr.startContainer === node ? cr.startOffset : Math.round((x - r.left)/r.width*node.length)];
}
function startSel(x, y) {
  const spans = [];
  for (const s of VIS) for (const d of s.divs || []) { if (!d.isConnected || !d.firstChild || d.firstChild.nodeType !== 3) continue;
    const r = d.getBoundingClientRect(); if (r.width > 0 && r.height > 0) spans.push({ node: d.firstChild, r }); }
  const c = caretAt(x, y, spans); if (!c) return false;
  selDrag = { spans, a: c }; window.getSelection().setBaseAndExtent(c[0], c[1], c[0], c[1]); return true;
}
// pressing on text always starts a selection, wherever on the page the text is
document.addEventListener('mousedown', e => {
  if (e.button || e.detail > 1 || S.tool === 'draw' || S.tool === 'erase' || !(e.target.closest && e.target.closest('.textLayer span'))) return;
  if (startSel(e.clientX, e.clientY)) e.preventDefault();
});
document.addEventListener('mousemove', e => { if (!selDrag) return; const c = caretAt(e.clientX, e.clientY, selDrag.spans);
  if (c) window.getSelection().setBaseAndExtent(selDrag.a[0], selDrag.a[1], c[0], c[1]); });
document.addEventListener('mouseup', () => { selDrag = null; if (S.tool === 'hl') setTimeout(highlightSelection, 0); });

/* ---------- find ---------- */
const F = { q: '', hits: [], idx: -1, gen: 0 };
async function runFind(q) {
  F.q = q.trim().toLowerCase(); F.hits = []; F.idx = -1; const gen = ++F.gen, doc = S.doc;
  if (!F.q || !doc || !doc.text) { showFind(); drawFind(); return; }
  const here = firstPage(S.cur);
  for (let p = 1; p <= doc.n; p++) {
    let ti; try { ti = await doc.text(p); } catch (e) { continue; }
    if (gen !== F.gen || doc !== S.doc) return;
    for (let a = ti.low.indexOf(F.q); a >= 0; a = ti.low.indexOf(F.q, a + F.q.length)) { F.hits.push({ p, a }); if (F.idx < 0 && p >= here) F.idx = F.hits.length - 1; }
    if (p % 8 === 0 || p === doc.n) { showFind(); drawFind(); }
  }
  if (F.idx < 0 && F.hits.length) F.idx = 0;
  showFind(); drawFind(); if (F.idx >= 0) revealHit();
}
function showFind() { $('qCount').textContent = !F.q ? '' : F.hits.length ? (F.idx + 1) + ' of ' + F.hits.length : 'No matches'; }
function revealHit() { const h = F.hits[F.idx]; if (!h) return; const k = spreadOf(h.p);
  if (S.view === 'scroll') { F.reveal = true; const sp = SP[h.p - 1]; if (!sp || !sp.built) goTo(k); drawFind(); return; }
  if (k === S.cur + 1 && !S.turn) flip(true); else if (k === S.cur - 1 && !S.turn) flip(false); else if (k !== S.cur) goTo(k); else drawFind(); }
function stepFind(dir) { if (!F.hits.length) return; F.idx = (F.idx + dir + F.hits.length) % F.hits.length; showFind(); revealHit(); }
function drawFind() {
  for (const s of VIS) {
    s.fl.textContent = ''; if (!F.q || !s.divs) continue;
    const box = s.el.getBoundingClientRect(), ti = s.ti;
    const locate = off => { let i = 0; while (i + 1 < ti.starts.length && ti.starts[i + 1] <= off) i++;
      const node = s.divs[i] && s.divs[i].firstChild; return node ? [node, Math.min(off - ti.starts[i], node.length)] : null; };
    F.hits.forEach((h, n) => {
      if (h.p !== s.p) return;
      const a = locate(h.a), b = locate(h.a + F.q.length); if (!a || !b) return;
      try { const rg = document.createRange(); rg.setStart(a[0], a[1]); rg.setEnd(b[0], b[1]);
        for (const rc of rg.getClientRects()) { if (rc.width < 0.5 || rc.width > box.width*0.98) continue; const m = document.createElement('i');
          if (n === F.idx) m.className = 'on';
          m.style.cssText = `left:${rc.left - box.left - 1}px;top:${rc.top - box.top - 1}px;width:${rc.width + 2}px;height:${rc.height + 2}px`; s.fl.appendChild(m); }
      } catch (e) {}
    });
  }
  if (F.reveal && S.view === 'scroll') { const on = scroller.querySelector('.findLayer i.on'); if (on) { F.reveal = false; on.scrollIntoView({ block: 'center' }); } }
}
function openFind(on) { $('findRow').hidden = !on; app.classList.toggle('finding', on);
  if (on) { showBar(true); $('q').focus(); $('q').select(); } else { $('q').blur(); runFind(''); $('q').value = ''; } }
let findTimer = 0;
$('q').addEventListener('input', e => { clearTimeout(findTimer); const v = e.target.value; findTimer = setTimeout(() => runFind(v), 180); });
$('q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') openFind(false); });
$('qNext').addEventListener('click', () => stepFind(1)); $('qPrev').addEventListener('click', () => stepFind(-1));
$('qClose').addEventListener('click', () => openFind(false)); $('findBtn').addEventListener('click', () => openFind($('findRow').hidden));

/* ---------- turning ---------- */
const canTurn = fwd => !!S.doc && (fwd ? S.cur < nSpreads() - 1 : S.cur > 0);
const easeOut = x => 1 - Math.pow(1 - x, 3), easeInOut = x => 0.5 - 0.5*Math.cos(PI*x);
function settled() { updateUI(); schedule(); buildLayers(); }
function commit(to) { const T = S.turn; if (!T) return; S.cur = (to >= 0.5) !== T.mir ? T.A + 1 : T.A; S.turn = null; settled(); }
function finishTurn() { const T = S.turn; if (T) commit(T.anim ? T.anim.to : T.t); }
function startTurn(fwd, y) {
  const yy = clamp(y, 0, S.ph); hideLayers();
  S.turn = { A: fwd ? S.cur : S.cur - 1, t: 0, mir: !fwd, yf: yy, yn: (yy - S.ph/2)/(S.ph/2), anim: null };
}
function flip(fwd) {
  if (S.view === 'scroll') { goTo(S.cur + (fwd ? 1 : -1)); return; }
  finishTurn();
  if (!canTurn(fwd)) return;
  if (reduceMotion) { S.cur += fwd ? 1 : -1; settled(); requestDraw(); return; }
  startTurn(fwd, S.ph*0.88);
  S.turn.anim = { from: 0, to: 1, start: performance.now(), dur: 760/SPEED, ease: easeInOut };
  requestDraw();
}
function goTo(k) { S.turn = null; S.cur = clamp(k, 0, nSpreads() - 1);
  if (S.view === 'scroll') { scrollToPage(S.cur + 1); updateUI(); return; }
  settled(); requestDraw(); }
// single-page view: find the turn amount that puts the curl's leading edge at x = g*w
function solveT(g) { let lo = 0, hi = 1;
  for (let i = 0; i < 22; i++) { const m = (lo + hi)/2; if (1 - m - (PI/2 - 1)*CURL*Math.sin(PI*m) > g) lo = m; else hi = m; }
  return (lo + hi)/2; }

// A press counts as a page turn only in the strip along a page's outer edge, and that strip stops short of the text.
// Everywhere else a drag selects text. Missing a turn is acceptable; turning during a selection is not.
function turnZone(e) {
  if (!S.doc || S.turn) return null;
  const m = toModel(e), w = S.pw; if (m.y < -20 || m.y > S.ph + 20) return null;
  let fwd, dist;
  if (S.dbl) { fwd = m.x >= 0; dist = w - Math.abs(m.x); } else { fwd = w - m.x <= m.x; dist = fwd ? w - m.x : m.x; }
  if (dist < -30) return null;
  const p = S.dbl ? (fwd ? rightOf(S.cur) : leftOf(S.cur)) : rightOf(S.cur); if (!p) return null;
  const s = VIS.find(v => v.p === p); let zone;
  if (!s) zone = S.doc.pdf ? clamp(0.06*w, 20, 40) : 0.3*w;
  else if (!s.hasText) zone = 0.35*w;
  else zone = Math.min(clamp(0.12*w, 28, 90), (fwd !== S.rtl ? w - s.tx1 : s.tx0) - 16);
  return dist <= Math.max(zone, 6) ? { fwd } : null;
}
let drag = null;
const toModel = e => { const rc = canvas.getBoundingClientRect();
  return { x: (S.rtl ? -1 : 1)*(e.clientX - rc.left - S.spineX), y: e.clientY - rc.top - S.topY }; };
canvas.addEventListener('pointerdown', e => {
  if (!S.doc || e.button) return;
  if (S.tool === 'draw' || S.tool === 'erase') {
    const hit = slotAt(e); if (!hit) return;
    if (S.tool === 'erase') { eraseAt(hit); return; }
    stroke = { s: hit.s, pts: [[hit.x, hit.y]] }; refreshInk();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {} return;
  }
  const sel = window.getSelection(), hadSel = !!(sel && !sel.isCollapsed); if (hadSel) sel.removeAllRanges();
  if (S.turn) { finishTurn(); requestDraw(); return; }
  const z = turnZone(e);
  if (!z) { startSel(e.clientX, e.clientY); return; }
  if (!canTurn(z.fwd)) return;
  const m = toModel(e);
  drag = { fwd: z.fwd, x0: m.x, y0: m.y, cx: e.clientX, cy: e.clientY, moved: false, hadSel, hist: [] };
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
});
function strokeMove(e) { const b = stroke.s.el.getBoundingClientRect(), x = clamp((e.clientX - b.left)/b.width, 0, 1), y = clamp((e.clientY - b.top)/b.height, 0, 1);
  const l = stroke.pts[stroke.pts.length - 1]; if (Math.hypot((x - l[0])*b.width, (y - l[1])*b.height) > 1.5) { stroke.pts.push([x, y]); refreshInk(); } }
scroller.addEventListener('pointerdown', e => {
  if (e.button || e.clientX > scroller.getBoundingClientRect().left + scroller.clientWidth) return;     // not the scrollbar
  if (S.tool === 'draw' || S.tool === 'erase') {
    const hit = slotAt(e); if (!hit) return; e.preventDefault();
    if (S.tool === 'erase') { eraseAt(hit); return; }
    stroke = { s: hit.s, pts: [[hit.x, hit.y]] }; refreshInk();
    try { scroller.setPointerCapture(e.pointerId); } catch (err) {} return;
  }
  if (!(e.target.closest && e.target.closest('.textLayer span')) && e.detail < 2) startSel(e.clientX, e.clientY);
});
scroller.addEventListener('pointermove', e => { if (stroke) strokeMove(e); });
scroller.addEventListener('pointerup', () => { if (stroke) release(); });
scroller.addEventListener('pointercancel', () => { if (stroke) release(); });
canvas.addEventListener('pointermove', e => {
  if (stroke) { strokeMove(e); return; }
  if (!drag) { if (S.tool !== 'draw' && S.tool !== 'erase') canvas.style.cursor = turnZone(e) ? 'grab' : VIS.some(v => v.hasText) ? 'text' : 'default'; else canvas.style.cursor = ''; return; }
  if (!drag.moved) {
    const dx = e.clientX - drag.cx, dy = e.clientY - drag.cy;
    if (Math.hypot(dx, dy) < 8) return;
    // the pull must go sideways toward the spine; anything else becomes a text selection
    if ((S.rtl ? -1 : 1)*dx*(drag.fwd ? -1 : 1) <= 0 || Math.abs(dx) < 1.5*Math.abs(dy)) {
      const d = drag; drag = null; try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
      startSel(d.cx, d.cy); return; }
    drag.moved = true; startTurn(drag.fwd, drag.y0); canvas.classList.add('dragging');
  }
  const m = toModel(e), w = S.pw, T = S.turn; if (!T) return;
  let t;
  if (S.dbl) { const sx = T.mir ? -1 : 1, x0 = Math.max(0, sx*drag.x0); t = (x0 - sx*m.x)/(x0 + w); }
  else { const x0 = clamp(T.mir ? w - drag.x0 : drag.x0, w*0.15, w);
    t = solveT(clamp((T.mir ? w - m.x : m.x)/x0, 0, 1)); }
  T.t = clamp(t, 0, 1);
  T.yf = clamp(m.y, 0, S.ph); T.yn = (T.yf - S.ph/2)/(S.ph/2);
  drag.hist.push([performance.now(), T.t]); if (drag.hist.length > 6) drag.hist.shift();
  requestDraw();
});
function release() {
  if (stroke) { const st = stroke; stroke = null;
    addAnno(st.s.p, { t: 'ink', c: S.pen, w: 0.0045, pts: st.pts.map(q => toBase(q[0], q[1])) }); return; }
  if (!drag) return;
  const dg = drag; drag = null; canvas.classList.remove('dragging');
  if (!dg.moved) { if (!dg.hadSel) flip(dg.fwd); return; }
  const T = S.turn; if (!T) return;
  const hs = dg.hist, now = performance.now(), old = hs.find(q => now - q[0] < 120) || hs[hs.length - 1];
  const dv = T.t - old[1];
  const to = Math.abs(dv) > 0.012 ? (dv > 0 ? 1 : 0) : (T.t > 0.35 ? 1 : 0);
  T.anim = { from: T.t, to, start: now, dur: (220 + 480*Math.abs(to - T.t))/SPEED, ease: easeOut };
  requestDraw();
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);

// wheel: Ctrl zooms; when the page is taller than the window it scrolls, and pushing past the end turns the page
let wheelAt = 0, over = 0;
stage.addEventListener('wheel', e => {
  const zooming = e.ctrlKey || e.metaKey;
  if (S.view === 'scroll' && !zooming) return;        // ordinary scrolling
  e.preventDefault(); const now = performance.now();
  if (zooming) { zoomBy(Math.exp(-e.deltaY*0.0025)); return; }
  const dy = e.shiftKey ? 0 : e.deltaY, dx = e.shiftKey ? e.deltaY : e.deltaX;
  if (S.maxX && dx) { S.panX = clamp(S.panX - dx, -S.maxX, S.maxX); place(); }
  if (!dy || Math.abs(dy) < 2) return;
  if (S.maxY) {
    const ny = clamp(S.panY - dy, -S.maxY, S.maxY);
    if (ny !== S.panY) { S.panY = ny; over = 0; place(); return; }
    over += dy; if (Math.abs(over) < 140 || now - wheelAt < 380) return;
    wheelAt = now; over = 0;
    if (canTurn(dy > 0)) { S.panY = dy > 0 ? S.maxY : -S.maxY; place(); flip(dy > 0); }
    return;
  }
  if (now - wheelAt < 380) return; wheelAt = now; flip(dy > 0);
}, { passive: false });
window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key, typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range';
  if (mod) {
    const c = k.toLowerCase();
    if (c === 'f') openFind(true); else if (c === 'z' && !typing) undo();
    else if (c === 'p' && EXT) printDoc(); else if (c === 's' && EXT) saveDoc();
    else if (k === '=' || k === '+') zoomBy(1.15); else if (k === '-') zoomBy(1/1.15); else if (k === '0') setZoom('page'); else return;
    e.preventDefault(); return;
  }
  if (typing || e.altKey) return;
  if (S.view === 'scroll') { const H = scroller.clientHeight, by = k === ' ' ? (e.shiftKey ? -0.9*H : 0.9*H) : k === 'PageDown' ? 0.9*H : k === 'PageUp' ? -0.9*H : k === 'ArrowDown' ? 80 : k === 'ArrowUp' ? -80 : 0;
    if (by) { scroller.scrollBy({ top: by, behavior: reduceMotion ? 'auto' : 'smooth' }); e.preventDefault(); return; }
    if (k === 'ArrowRight' || k === 'ArrowLeft') { goTo(S.cur + (k === 'ArrowRight' ? 1 : -1)); e.preventDefault(); return; } }
  if (k === 'ArrowRight') flip(!S.rtl); else if (k === 'ArrowLeft') flip(S.rtl);
  else if (k === ' ' || k === 'PageDown' || k === 'ArrowDown') flip(true);
  else if (k === 'PageUp' || k === 'ArrowUp') flip(false);
  else if (k === 'Home') goTo(0); else if (k === 'End') goTo(nSpreads() - 1);
  else if (k === 'f' || k === 'F') fullscreen(); else if (k === 'r' || k === 'R') rotate();
  else if (k === 'Escape') { if (!$('findRow').hidden) openFind(false); else setTool('read'); }
  else return;
  e.preventDefault();
});

/* ---------- toolbar ---------- */
let barTimer = 0;
function showBar(on) { clearTimeout(barTimer);
  if (on) app.classList.add('bar-on'); else barTimer = setTimeout(() => { if (!bar.matches(':hover') && $('findRow').hidden) app.classList.remove('bar-on'); }, 500); }
window.addEventListener('mousemove', e => showBar(e.clientY < 64 || bar.contains(e.target)));
document.addEventListener('mouseleave', e => showBar(e.clientY <= 8));
bar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });   // keep the text selection when a button is pressed
setTimeout(() => showBar(false), 3500);

function updateUI() {
  const n = nSpreads();
  if (S.doc) { if (document.activeElement !== $('pageNo')) $('pageNo').value = firstPage(S.cur); $('pageTotal').textContent = 'of ' + S.doc.n; }
  const scroll = S.view === 'scroll';
  $('vBook').setAttribute('aria-pressed', String(!scroll)); $('vScroll').setAttribute('aria-pressed', String(scroll));
  ['lay1', 'lay2', 'rtl', 'speed', 'soft'].forEach(id => { $(id).disabled = scroll; });
  $('lay1').setAttribute('aria-pressed', String(!S.dbl && !scroll)); $('lay2').setAttribute('aria-pressed', String(S.dbl));
  $('zPage').setAttribute('aria-pressed', String(S.zoom === 'page')); $('zWidth').setAttribute('aria-pressed', String(S.zoom === 'width'));
  $('rtl').setAttribute('aria-pressed', String(S.rtl)); $('rot').disabled = !(S.doc && S.doc.pdf);
  [['tRead', 'read'], ['tHl', 'hl'], ['tDraw', 'draw'], ['tErase', 'erase']].forEach(q => $(q[0]).setAttribute('aria-pressed', String(S.tool === q[1])));
  const th = clamp(S.H/n, 36, S.H), f = n > 1 ? S.cur/(n - 1) : 0;
  $('vbar').hidden = n < 2; $('thumb').style.height = th + 'px'; $('thumb').style.transform = `translateY(${f*(S.H - th)}px)`;
  $('vbar').setAttribute('aria-valuenow', S.cur + 1); $('vbar').setAttribute('aria-valuemax', n);
}
const pagesLabel = k => { const a = leftOf(k), b = rightOf(k); return (a && b ? a + '–' + b : (a || b)) + ' of ' + S.doc.n; };
$('pageNo').addEventListener('change', e => { const v = parseInt(e.target.value, 10); e.target.blur();
  if (S.doc && v >= 1) goTo(spreadOf(clamp(v, 1, S.doc.n))); else updateUI(); });
$('pageNo').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
const vbar = $('vbar'), bubble = $('bubble'); let vdrag = false;
function vseek(e) { const rc = vbar.getBoundingClientRect(), n = nSpreads(), th = clamp(S.H/n, 36, S.H);
  const f = clamp((e.clientY - rc.top - th/2)/Math.max(1, rc.height - th), 0, 1), k = Math.round(f*(n - 1));
  bubble.hidden = false; bubble.textContent = pagesLabel(k); bubble.style.top = clamp(e.clientY - rc.top - 14, 4, rc.height - 32) + 'px';
  if (vdrag && k !== S.cur) goTo(k); }
vbar.addEventListener('pointerdown', e => { vdrag = true; vbar.classList.add('drag'); try { vbar.setPointerCapture(e.pointerId); } catch (err) {} vseek(e); });
vbar.addEventListener('pointermove', e => { if (S.doc) vseek(e); });
const vend = () => { vdrag = false; vbar.classList.remove('drag'); bubble.hidden = true; };
vbar.addEventListener('pointerup', vend); vbar.addEventListener('pointercancel', vend); vbar.addEventListener('pointerleave', () => { if (!vdrag) bubble.hidden = true; });

$('vBook').addEventListener('click', () => setView('book')); $('vScroll').addEventListener('click', () => setView('scroll'));
$('zIn').addEventListener('click', () => zoomBy(1.15)); $('zOut').addEventListener('click', () => zoomBy(1/1.15));
$('zPage').addEventListener('click', () => setZoom('page')); $('zWidth').addEventListener('click', () => setZoom('width'));
$('lay1').addEventListener('click', () => { S.pref = 'single'; savePrefs(); layout(); });
$('lay2').addEventListener('click', () => { S.pref = 'double'; savePrefs(); layout(); });
$('rtl').addEventListener('click', () => { finishTurn(); S.rtl = !S.rtl; savePrefs(); layout(); });
function setTool(t) { S.tool = t; app.dataset.tool = t; updateUI(); paintSwatches(); }
$('tRead').addEventListener('click', () => setTool('read'));
$('tHl').addEventListener('click', () => { if (!highlightSelection()) setTool(S.tool === 'hl' ? 'read' : 'hl'); });
$('tDraw').addEventListener('click', () => setTool(S.tool === 'draw' ? 'read' : 'draw'));
$('tErase').addEventListener('click', () => setTool(S.tool === 'erase' ? 'read' : 'erase'));
$('undo').addEventListener('click', undo);
const HLS = [['#FFE066', 'Yellow'], ['#A8F0B0', 'Green'], ['#FFB3D1', 'Pink']], PENS = [['#D6293E', 'Red'], ['#2B5FD9', 'Blue'], ['#1B1B1F', 'Black']];
function paintSwatches() {      // highlighter colours while highlighting, pen colours otherwise
  const hl = S.tool === 'hl', box = $('swatches'); box.textContent = '';
  (hl ? HLS : PENS).forEach(c => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.style.background = c[0];
    b.title = c[1] + (hl ? ' highlighter' : ' pen'); b.setAttribute('aria-label', b.title); b.setAttribute('aria-pressed', String((hl ? S.hl : S.pen) === c[0]));
    b.addEventListener('click', () => { if (hl) S.hl = c[0]; else S.pen = c[0]; paintSwatches(); }); box.appendChild(b); });
}
paintSwatches();
// speed slider: 0..100 maps to 0.25x..4x; softness slider: 0..100 maps to a curl radius of 3%..18% of the page width
$('speed').value = Math.round(50 + 25*Math.log2(SPEED)); $('soft').value = Math.round((CURL - 0.03)/0.15*100);
$('speed').addEventListener('input', e => { SPEED = Math.pow(2, (e.target.value - 50)/25); savePrefs(); });
$('soft').addEventListener('input', e => { CURL = 0.03 + 0.15*e.target.value/100; savePrefs(); requestDraw(); });
['speed', 'soft'].forEach(id => $(id).addEventListener('change', e => e.target.blur()));
function fullscreen() {
  try { const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
if (!document.fullscreenEnabled) $('fs').hidden = true;
if (EXT && window.chrome && chrome.storage) {      // extension: let the reader take over every PDF the browser opens
  const b = $('defBtn'), paint = v => { b.setAttribute('aria-pressed', String(v)); b.textContent = 'Open all PDFs here: ' + (v ? 'On' : 'Off'); };
  b.hidden = false; chrome.storage.local.get({ intercept: true }, r => paint(r.intercept));
  b.addEventListener('click', () => chrome.storage.local.get({ intercept: true }, r => { chrome.storage.local.set({ intercept: !r.intercept }); paint(!r.intercept); }));
}
$('fs').addEventListener('click', fullscreen);
async function rotate() {
  if (!S.doc || !S.doc.pdf) return;
  finishTurn(); S.rot = (S.rot + 90) % 360;
  const i = await S.doc.info(1); S.doc.aspect = clamp(i.vw/i.vh, 0.3, 3);
  clearCache(); S.texKey = ''; S.panY = 1e9; layout();
}
$('rot').addEventListener('click', rotate);

/* ---------- print and save (extension only: a published page is not allowed to print or download) ---------- */
$('print').hidden = !EXT;
if (!EXT) (window.claude && claude.use ? claude.use('downloads') : Promise.resolve(null)).then(d => { if (!d) $('save').hidden = true; }).catch(() => { $('save').hidden = true; });
async function printDoc() {
  const doc = S.doc; if (!doc) return;
  const root = $('printRoot'); root.textContent = ''; const urls = [];
  try {
    const first = await doc.info(1);
    for (let p = 1; p <= doc.n; p++) {
      say('Preparing page ' + p + ' of ' + doc.n + ' for printing…', true);
      const i = await doc.info(p), w = 1500, h = Math.round(w*i.vh/i.vw);
      const c = await doc.render(p, w, h);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)); c.width = c.height = 0;
      const img = new Image(); img.src = URL.createObjectURL(blob); urls.push(img.src);
      try { await img.decode(); } catch (e) {}
      root.appendChild(img);
    }
    let st = $('printPage'); if (!st) { st = document.createElement('style'); st.id = 'printPage'; document.head.appendChild(st); }
    st.textContent = `@page{size:${first.vw}pt ${first.vh}pt;margin:0}`;
    say(''); window.print();
  } catch (e) { console.error(e); say('The document could not be prepared for printing.'); }
  setTimeout(() => { root.textContent = ''; urls.forEach(u => URL.revokeObjectURL(u)); }, 60000);
}
async function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  if (EXT) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); return; }
  const d = window.claude && claude.use ? await claude.use('downloads') : null;
  if (!d) throw { code: 'unavailable' };
  await d.save({ filename: name, data: blob });
}
const hex = c => [1, 3, 5].map(i => parseInt(c.substr(i, 2), 16)/255);
async function saveDoc() {
  const doc = S.doc; if (!doc || !doc.pdf) { say('Open a PDF first; the sample booklet cannot be saved.'); return; }
  say('Saving…', true);
  try {
    let bytes = await doc.pdf.getData(), name = doc.name.replace(/\.pdf$/i, ''), note = '';
    const marked = [...AN.map].filter(e => e[1].length);
    if (marked.length && typeof PDFLib !== 'undefined') {
      try {     // write the highlights and drawings into a copy of the PDF as real page content
        const out = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        for (const [p, arr] of marked) {
          const pg = out.getPage(p - 1), vp = (await doc.pdf.getPage(p)).getViewport({ scale: 1 });
          const pt = (u, v) => vp.convertToPdfPoint(u*vp.width, v*vp.height);
          for (const a of arr) {
            const c = hex(a.c), color = PDFLib.rgb(c[0], c[1], c[2]);
            if (a.t === 'hl') for (const r of a.r) { const p0 = pt(r[0], r[1]), p1 = pt(r[0] + r[2], r[1] + r[3]);
              pg.drawRectangle({ x: Math.min(p0[0], p1[0]), y: Math.min(p0[1], p1[1]), width: Math.abs(p1[0] - p0[0]), height: Math.abs(p1[1] - p0[1]), color, blendMode: PDFLib.BlendMode.Multiply }); }
            else { const q = a.pts.map(z => pt(z[0], z[1])); if (q.length === 1) q.push([q[0][0] + 0.1, q[0][1]]);
              for (let i = 1; i < q.length; i++) pg.drawLine({ start: { x: q[i - 1][0], y: q[i - 1][1] }, end: { x: q[i][0], y: q[i][1] }, thickness: a.w*vp.width, color, lineCap: PDFLib.LineCapStyle.Round }); }
          }
        }
        bytes = await out.save(); name += '-marked'; note = 'Saved a copy with your marks.';
      } catch (e) { console.error(e); note = 'Your marks could not be written into this PDF, so the original was saved instead.'; }
    }
    await download(bytes, name + '.pdf'); say(note);
  } catch (e) { console.error(e); say(e && e.code === 'declined' ? 'Save cancelled.' : e && e.code === 'rate_limited' ? 'A save is already waiting for your answer.' : 'The file could not be saved from this view.'); }
}
$('print').addEventListener('click', printDoc); $('save').addEventListener('click', saveDoc);

/* ---------- documents ---------- */
function setDoc(doc, name) {
  if (S.doc && S.doc.close) S.doc.close();
  clearCache(); hideLayers(); S.doc = doc; S.cur = 0; S.turn = null; S.texKey = ''; S.panX = 0; S.panY = 1e9; want = [];
  AN.map = new Map(); AN.ver = new Map(); AN.undo = []; F.gen++; F.hits = []; F.idx = -1;
  try { if (doc.id) for (const e of JSON.parse(localStorage.getItem('mekuri-marks:' + doc.id) || '[]')) { AN.map.set(e[0], e[1]); AN.ver.set(e[0], 1); } } catch (e) {}
  $('docName').textContent = name; document.title = name + ' · Mekuri'; layout();
  if (!$('findRow').hidden && $('q').value) runFind($('q').value);
}
let workerReady = null;
function ensureWorker() {
  if (workerReady) return workerReady;
  if (EXT) { pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js'; return workerReady = Promise.resolve(); }
  workerReady = new Promise(resolve => {
    let done = false, wk = null;
    const fallback = () => {            // run the PDF engine on the page itself if a worker cannot start
      if (done) return; done = true; try { if (wk) wk.terminate(); } catch (e) {}
      const s = document.createElement('script'); s.src = WORKER_URL; s.onload = s.onerror = () => resolve(); document.head.appendChild(s);
    };
    try {
      const src = 'try{importScripts(' + JSON.stringify(WORKER_URL) + ');postMessage({boot:1})}catch(e){postMessage({boot:0})}';
      wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      wk.onmessage = e => { if (done) return;
        if (e.data && e.data.boot === 0) { fallback(); return; }
        done = true; wk.onmessage = null; wk.onerror = null; pdfjsLib.GlobalWorkerOptions.workerPort = wk; resolve(); };
      wk.onerror = fallback; setTimeout(fallback, 6000);
    } catch (e) { fallback(); }
  });
  return workerReady;
}
function openFile(file) {
  if (!file) return;
  if (typeof pdfjsLib === 'undefined') { say('The PDF engine did not load. Check your internet connection and reload the page.'); return; }
  openData(() => file.arrayBuffer(), file.name);
}
function fetchUrl(url) {     // XHR, because it can also read file:// when the extension is allowed access to file URLs
  return new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; if (/^https?:/i.test(url)) x.withCredentials = true;
    x.onload = () => (x.status === 0 || x.status === 200) && x.response ? res(x.response) : rej(new Error('HTTP ' + x.status));
    x.onerror = () => rej(new Error('network')); x.send(); });
}
async function openData(getData, name) {
  say('Opening ' + name + '…', true);
  try {
    const data = await getData();
    await ensureWorker();
    const pdf = await pdfjsLib.getDocument(Object.assign({ data }, EXT ? { cMapUrl: 'cmaps/', cMapPacked: true, standardFontDataUrl: 'standard_fonts/' } : {})).promise;
    S.rot = 0;
    const doc = { n: pdf.numPages, aspect: 0.7, pdf, name, id: (pdf.fingerprints && pdf.fingerprints[0]) || '', texts: new Map(), close: () => { pdf.destroy(); },
      async info(p) { const page = await pdf.getPage(p), rotation = (page.rotate + S.rot) % 360, v = page.getViewport({ scale: 1, rotation });
        return { page, rotation, vw: v.width, vh: v.height }; },
      async render(p, tw, th) {
        const i = await doc.info(p), vp = i.page.getViewport({ scale: Math.min(tw/i.vw, th/i.vh), rotation: i.rotation });
        const c = document.createElement('canvas'); c.width = tw; c.height = th;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);
        const ox = (tw - vp.width)/2, oy = (th - vp.height)/2;
        await i.page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, ox, oy] }).promise;
        drawAnnos(ctx, p, ox, oy, vp.width, vp.height, true);
        return c;
      },
      async text(p) { let t = doc.texts.get(p); if (!t) { t = textIndex(await (await pdf.getPage(p)).getTextContent()); doc.texts.set(p, t); } return t; } };
    const i = await doc.info(1); doc.aspect = clamp(i.vw/i.vh, 0.3, 3);
    setDoc(doc, name); say('');
  } catch (err) {
    console.error(err);
    say(err && err.name === 'PasswordException'
      ? 'That PDF is locked with a password. Save an unlocked copy and open that instead.'
      : 'That file could not be read. Check that it is a PDF and try again.');
  }
}
$('file').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop').hidden = true;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) openFile(f); });

/* ---------- sample booklet, drawn in code at tankobon proportions (128 x 182 mm) ---------- */
const GUIDE = [
  { cover: 1 },
  { h: 'Open a PDF', b: 'Move the pointer to the top edge and the toolbar slides in. Press Open PDF, or drop a file anywhere on the window. The file never leaves your computer.' },
  { h: 'Turn the page', b: 'Pull a page across from its outer margin and it bends like paper; grab low or high for a diagonal fold. A click in that margin, the arrow keys or Space turn pages too.' },
  { h: 'Move around', b: 'The bar on the right edge runs through the whole book. Ctrl and the wheel zoom in; a zoomed page scrolls, and scrolling past its end turns it.' },
  { h: 'Select and find', b: 'Drag over text to select and copy it; no tool to switch on. Try it on this page. Ctrl+F finds a word across the whole document.' },
  { h: 'Mark it up', b: 'Highlight the text you selected, draw with the pen, erase a mark, undo with Ctrl+Z. Your marks are remembered for each PDF.' },
  { h: 'Make it yours', b: 'Rotate pages, read one page or two, go right to left for manga, set how fast and softly a page turns. Prefer plain scrolling? Switch Book to Scroll.' },
  { end: 1 }
];
const INK = '#16181D';
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0)/4294967296; }; }
function wrap(put, ctx, text, x, y, maxW, lh) { let line = '';
  for (const word of text.split(' ')) { const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) { put(line, x, y); y += lh; line = word; } else line = test; }
  put(line, x, y); return y + lh; }
function speedPanel(ctx, x, y, w, h, seed, label) {
  const rnd = rng(seed), fx = x + w*(0.38 + 0.24*rnd()), fy = y + h*(0.42 + 0.16*rnd()), far = Math.hypot(w, h);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); ctx.fillStyle = INK;
  for (let i = 0; i < 110; i++) { const an = rnd()*PI*2, wd = 0.004 + rnd()*0.013, inner = (0.30 + rnd()*0.26)*Math.min(w, h);
    ctx.beginPath(); ctx.moveTo(fx + Math.cos(an)*inner, fy + Math.sin(an)*inner);
    ctx.lineTo(fx + Math.cos(an - wd)*far, fy + Math.sin(an - wd)*far); ctx.lineTo(fx + Math.cos(an + wd)*far, fy + Math.sin(an + wd)*far); ctx.fill(); }
  ctx.font = `800 ${Math.round(Math.min(w, h)*0.34)}px "Shippori Mincho",Georgia,serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, fx, fy);
  ctx.restore(); ctx.lineWidth = Math.max(2, w*0.008); ctx.strokeStyle = INK; ctx.strokeRect(x, y, w, h);
}
const sample = { n: GUIDE.length, aspect: 128/182, texts: new Map(), runs: new Map(), name: 'Quick guide',
  async info(p) { if (!sample.runs.has(p)) await sample.render(p, 640, 910); return { vw: 128, vh: 182, runs: sample.runs.get(p) }; },
  async text(p) { return textIndex({ items: (await sample.info(p)).runs.map(r => ({ str: r.str, hasEOL: true })) }); },
  async render(p, tw, th) {
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const ctx = c.getContext('2d'), g = GUIDE[p - 1], m = tw*0.09, serif = '"Shippori Mincho",Georgia,serif', sans = '"Instrument Sans","Segoe UI",sans-serif';
    ctx.fillStyle = '#FAF9F4'; ctx.fillRect(0, 0, tw, th); ctx.fillStyle = INK; ctx.textBaseline = 'alphabetic';
    const runs = [], put = (str, x, y) => { ctx.fillText(str, x, y); const mw = ctx.measureText(str).width, size = parseFloat(ctx.font.match(/([\d.]+)px/)[1]);
      runs.push({ str, x: (ctx.textAlign === 'right' ? x - mw : x)/tw, y: (y - size*0.88)/th, w: mw/tw, h: size*1.15/th }); };
    if (g.cover) {
      speedPanel(ctx, m, m, tw - 2*m, th*0.52, 7, 'めくり');
      ctx.textAlign = 'left'; ctx.font = `800 ${tw*0.12}px ${serif}`; put('Mekuri', m, th*0.70);
      ctx.font = `500 ${tw*0.042}px ${sans}`; const y = wrap(put, ctx, 'A PDF reader whose pages turn like paper.', m, th*0.76, tw - 2*m, tw*0.058);
      ctx.fillStyle = '#5A6070'; ctx.font = `400 ${tw*0.034}px ${sans}`; put('Sample booklet, 8 pages. Turn this page to begin.', m, y + tw*0.03);
    } else if (g.end) {
      ctx.textAlign = 'left'; ctx.font = `800 ${tw*0.11}px ${serif}`; wrap(put, ctx, 'Now open your own.', m, th*0.40, tw - 2*m, tw*0.14);
      ctx.font = `500 ${tw*0.042}px ${sans}`; wrap(put, ctx, 'Open PDF is in the toolbar at the top edge of the window.', m, th*0.62, tw - 2*m, tw*0.06);
    } else {
      speedPanel(ctx, m, m, tw - 2*m, th*0.40, p*31, String(p - 1));
      ctx.textAlign = 'left'; ctx.font = `800 ${tw*0.085}px ${serif}`; put(g.h, m, th*0.56);
      ctx.font = `400 ${tw*0.044}px ${sans}`; wrap(put, ctx, g.b, m, th*0.63, tw - 2*m, tw*0.066);
    }
    ctx.fillStyle = '#5A6070'; ctx.font = `500 ${tw*0.03}px ${sans}`; ctx.textAlign = p % 2 ? 'right' : 'left';
    put(String(p), p % 2 ? tw - m : m, th - m*0.6);
    if (!sample.runs.has(p)) sample.runs.set(p, runs);
    drawAnnos(ctx, p, 0, 0, tw, th, true);
    return c;
  } };

new ResizeObserver(layout).observe(stage);
const fontsReady = document.fonts && document.fonts.load
  ? Promise.all([document.fonts.load('800 40px "Shippori Mincho"', 'めくりMekuri'), document.fonts.load('500 20px "Instrument Sans"')]).catch(() => {})
  : Promise.resolve();
const src = EXT ? new URLSearchParams(location.search).get('src') : null;   // extension: the PDF tab the reader was opened from
Promise.race([fontsReady, new Promise(r => setTimeout(r, 1500))]).then(() => { if (!S.doc && !src) setDoc(sample, 'Quick guide (sample booklet)'); });
if (src && typeof pdfjsLib !== 'undefined') {
  let name = 'PDF'; try { name = decodeURIComponent(new URL(src).pathname.split('/').pop()) || name; } catch (e) {}
  openData(() => fetchUrl(src), name).then(() => { if (!S.doc) setDoc(sample, 'Quick guide (sample booklet)'); });
}
})();

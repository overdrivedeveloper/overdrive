import {useEffect, useRef, type CSSProperties} from 'react';
import {onFrame} from '../lib/scroll';

/**
 * Two pixel-aligned cut-outs of the same object - `bare` and `grown` - where
 * the pointer "grows" the second one in.
 *
 * The bare layer is a plain <img>. Above it a WebGL canvas draws only the
 * grown layer, masked by a decaying trail:
 *   pass 1  trail (ping-pong, 1/4 res): value += brush along the pointer's
 *           path this frame, −decay every frame → grows where you hover,
 *           recedes ~1.5 s after you leave.
 *   pass 2  composite: the trail is thresholded through fbm noise so the
 *           edge breaks up into clumps and blades, and the grown texture is
 *           nudged down a little at the growing edge so plants rise in.
 * Pointer is tracked on window so the layer can sit under other UI with
 * pointer-events: none. Touch / coarse pointers get a slow automatic wander.
 */

type Props = {
  bare: string;
  grown: string;
  /** natural aspect ratio (w / h) of both images */
  aspect: number;
  /** brush radius in CSS px (scaled with the element's width) */
  radius?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  reduced?: boolean;
};

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const TRAIL = `
precision highp float;
uniform sampler2D uPrev;
uniform vec2 uRes;      // element size, css px
uniform vec2 uA;        // pointer last frame, css px, y up
uniform vec2 uB;        // pointer this frame
uniform float uRadius;
uniform float uStrength;
uniform float uDecay;
varying vec2 vUv;

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  float v = texture2D(uPrev, vUv).r;
  float d = segDist(vUv * uRes, uA, uB);
  float b = 1.0 - smoothstep(0.0, uRadius, d);
  v = clamp(v - uDecay + b * b * uStrength, 0.0, 1.0);
  gl_FragColor = vec4(v, 0.0, 0.0, 1.0);
}`;

const COMPOSITE = `
precision highp float;
uniform sampler2D uTrail;
uniform sampler2D uGrown;
uniform vec2 uRes;
uniform float uTime;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  float m = texture2D(uTrail, vUv).r;
  if (m < 0.01) { gl_FragColor = vec4(0.0); return; }
  vec2 px = vUv * uRes;
  float clumps = fbm(px / 70.0 + uTime * 0.02);
  // tall thin cells → blade-like breakup along the edge
  float blades = noise(vec2(px.x / 3.5, px.y / 26.0));
  float g = smoothstep(0.3, 0.62, m + (clumps - 0.5) * 0.6 + (blades - 0.5) * 0.22);
  if (g <= 0.0) { gl_FragColor = vec4(0.0); return; }
  // plants rise into place at the growing edge (sample from above = drawn lower)
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y) - vec2(0.0, (1.0 - g) * 0.018);
  vec4 c = texture2D(uGrown, uv);
  // Keep the original photographic texture and shading, but map foliage to
  // Overdrive's coral/pink ramp. Neutral bark and stone remain silver.
  float luminance = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float foliage = smoothstep(0.035, 0.18, chroma);
  vec3 coral = mix(vec3(0.29, 0.065, 0.055), vec3(1.0, 0.76, 0.70), pow(luminance, 0.72));
  c.rgb = mix(vec3(luminance), coral, foliage);
  float a = c.a * g;
  gl_FragColor = vec4(c.rgb * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

function program(gl: WebGLRenderingContext, frag: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

function target(gl: WebGLRenderingContext, w: number, h: number) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return {tex, fb};
}

// Shared pointer, tracked once for every instance.
const pointer = {x: -1e4, y: -1e4, moved: 0};
let pointerBound = false;
function bindPointer() {
  if (pointerBound) return;
  pointerBound = true;
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.moved = performance.now();
    },
    {passive: true},
  );
}

export function GrowReveal({bare, grown, aspect, radius = 120, className = '', style, alt = '', reduced}: Props) {
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || reduced) return;
    // A fresh canvas per mount: a canvas whose context was lost is painted
    // solid white by Chrome on real GPUs, so a dead one must never stay in
    // the page (React StrictMode mounts effects twice in dev).
    const cv = document.createElement('canvas');
    cv.setAttribute('aria-hidden', 'true');
    cv.className = 'absolute inset-0 h-full w-full';
    const gl = cv.getContext('webgl', {premultipliedAlpha: true, alpha: true, antialias: false});
    if (!gl) return;

    let trailProg: WebGLProgram, compProg: WebGLProgram;
    try {
      trailProg = program(gl, TRAIL);
      compProg = program(gl, COMPOSITE);
    } catch (err) {
      console.warn('GrowReveal disabled:', err);
      return;
    }
    el.appendChild(cv);
    bindPointer();
    // If the GPU drops the context later, take the canvas out rather than show a white block.
    const onLost = (e: Event) => {
      e.preventDefault();
      cv.remove();
    };
    cv.addEventListener('webglcontextlost', onLost);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
    const tu = {prev: u(trailProg, 'uPrev'), res: u(trailProg, 'uRes'), a: u(trailProg, 'uA'), b: u(trailProg, 'uB'), radius: u(trailProg, 'uRadius'), strength: u(trailProg, 'uStrength'), decay: u(trailProg, 'uDecay')};
    const cu = {trail: u(compProg, 'uTrail'), grown: u(compProg, 'uGrown'), res: u(compProg, 'uRes'), time: u(compProg, 'uTime')};

    let grownTex: WebGLTexture | null = null;
    const img = new Image();
    img.decoding = 'async';
    img.src = grown;
    img.onload = () => {
      grownTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, grownTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };

    let W = 0, H = 0, tw = 0, th = 0;
    let rt: {tex: WebGLTexture; fb: WebGLFramebuffer}[] = [];
    let ping = 0;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      W = r.width;
      H = r.height;
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
      tw = Math.max(1, Math.round(W / 4));
      th = Math.max(1, Math.round(H / 4));
      rt.forEach((t) => {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      });
      rt = [target(gl, tw, th), target(gl, tw, th)];
      rt.forEach((t) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), {rootMargin: '100px'});
    io.observe(el);

    const coarse = window.matchMedia('(pointer: coarse)').matches;
    let last: [number, number] | null = null;
    let lastPointer = {x: pointer.x, y: pointer.y};
    let active = 0; // frames of trail left to fade; skip GPU work when idle
    const t0 = performance.now();

    const stop = onFrame((now) => {
      if (!visible || !rt.length) return;
      const r = el.getBoundingClientRect();
      const scale = W / 1200;
      const rad = radius * Math.max(0.55, scale);

      // Pointer in element space, y up.
      let bx: number, by: number, strength: number;
      if (coarse) {
        const t = (now - t0) / 1000;
        bx = W * (0.62 + 0.3 * Math.sin(t * 0.37));
        by = H * (0.32 + 0.18 * Math.sin(t * 0.61 + 1.3));
        strength = 0.07;
      } else {
        // map through the live rect so scroll-driven scaling of a parent stays aligned
        bx = ((pointer.x - r.left) / Math.max(1, r.width)) * W;
        by = (1 - (pointer.y - r.top) / Math.max(1, r.height)) * H;
        const speed = Math.hypot(pointer.x - lastPointer.x, pointer.y - lastPointer.y);
        lastPointer = {x: pointer.x, y: pointer.y};
        const fresh = now - pointer.moved < 120 ? 1 : 0;
        strength = fresh * Math.min(0.16, 0.03 + speed * 0.006);
      }
      const inside = bx > -rad && bx < W + rad && by > -rad && by < H + rad;
      if (!inside) strength = 0;
      const a = last ?? [bx, by];
      last = [bx, by];

      if (strength > 0) active = 140;
      if (active <= 0) return;
      active--;

      // pass 1: trail
      const src = rt[ping], dst = rt[1 - ping];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
      gl.viewport(0, 0, tw, th);
      gl.disable(gl.BLEND);
      gl.useProgram(trailProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(tu.prev, 0);
      gl.uniform2f(tu.res, W, H);
      gl.uniform2f(tu.a, a[0], a[1]);
      gl.uniform2f(tu.b, bx, by);
      gl.uniform1f(tu.radius, rad);
      gl.uniform1f(tu.strength, strength);
      gl.uniform1f(tu.decay, 0.0085);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ping = 1 - ping;

      // pass 2: composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!grownTex) return;
      gl.useProgram(compProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.uniform1i(cu.trail, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, grownTex);
      gl.uniform1i(cu.grown, 1);
      gl.uniform2f(cu.res, W, H);
      gl.uniform1f(cu.time, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      cv.removeEventListener('webglcontextlost', onLost);
      cv.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [grown, radius, reduced]);

  return (
    <div ref={wrap} className={`grow-reveal relative ${className}`} style={{aspectRatio: String(aspect), ...style}}>
      <img src={bare} alt={alt} draggable={false} className="absolute inset-0 h-full w-full select-none" />
    </div>
  );
}

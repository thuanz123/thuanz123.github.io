/* Interactive 3D portrait for the profile card.
 *
 * A sculpted 3D head wearing the reference portrait (assets/images/photos/avatar-texture.jpg, the
 * portrait with the glasses painted out) projected onto it from the front, with real 3D glasses,
 * eyeballs, eyelids and mouth, then repainted every frame as an impressionist painting: short
 * strokes of broken color laid along the forms, in the spirit of Monet's "Impression, Sunrise".
 * The eyes follow the cursor anywhere on the page and the face reacts when poked.
 *
 * A single WebGL canvas is mounted into whichever [data-avatar3d] container is visible ("bust" on
 * desktop, "head" in the small mobile circle). The <img> inside the container is the fallback: it
 * is only hidden once the first frame renders, so a CDN or WebGL failure leaves the old portrait.
 *
 * The geometry is generated in code; the only asset is the texture. Set
 * window.avatar3dOptions = { painterly: false } before this script loads to see the plain render.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js';

const OPTIONS = { painterly: true, ...(window.avatar3dOptions || {}) };

const COLORS = {
    skin: 0xdba082,
    skinFlush: 0xc9644f,
    lipUpper: 0xa85c55,
    lipLower: 0xb86a62,
    nostril: 0x4a221c,
    stubble: 0x7d6a68,
    brow: 0x120c0a,
    hair: 0x0e0a09,
    sclera: 0xeee6df,
    frames: 0x0b0b0c,
    metal: 0xc8cbd0,
    shirt: 0xcfccd2,
    mouth: 0x3a1113,
    teeth: 0xe6dccb,
    tongue: 0xa4504e,
    blush: 0xe0605a,
    heart: '#e8506a',
    star: '#ffcf4a',
    anger: '#e5383b',
};

const V3 = THREE.Vector3;

// Proportions, in head units: the face is about 2 across at the eyes, y = 0 on the eye line and
// +z points out of the face.
const EYE = { x: 0.43, y: 0.02, r: 0.19 };
// Each eye's shape in the portrait: half-width of the opening, and the upper lash line and lower lid
// above and below the pupil (the eye on the viewer's right is a little more open).
const EYE_SHAPES = { [-1]: { hw: 0.176, upper: 0.069, lower: -0.064 }, [1]: { hw: 0.17, upper: 0.08, lower: -0.085 } };
const LID_R = EYE.r + 0.012;
const MOUTH = { y: -0.89, w: 0.31 };
const JAW = new V3(0, -0.47, -0.45);            // hinge the jaw rotates about
const JAW_OPEN = 0.3;                           // jaw rotation at full jawOpen, in radians
const HEAD_BOTTOM = -1.44, HEAD_TOP = 1.62;
const NECK_PIVOT = new V3(0, -0.8, -0.35);      // head turns rotate about the top of the neck
const LOOK_PLANE_Z = 3.5;                       // the cursor is treated as a point on this plane in front of the face
const MAX_EYE = { yaw: 0.42, pitch: 0.3 };
// The portrait only shows the face from slightly to its right, so the head turns less to the left.
const MAX_HEAD = { left: 0.12, right: 0.22, pitch: 0.2 };
const HEAD_FOLLOW = 0.3;                        // fraction of the gaze direction the head turns towards
const FRAMING = {
    bust: { target: new V3(0, -0.05, 0), distance: 11.8 },
    head: { target: new V3(0, 0.38, 0), distance: 9.2 },
};
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Where the reference portrait lands on the head: head coordinates to pixels of the original image,
// fitted to the eyes, mouth corners, chin and the sides of the face. The head is turned about 3°
// in the portrait, which the depth term accounts for. The texture keeps a crop of the image with
// the glasses painted out and the background replaced by the person's own edge colors.
const PORTRAIT = {
    face: { url: new URL('../images/photos/avatar-texture.jpg', import.meta.url).href, crop: [240, 80, 940, 970] },
    x: [199, 6.6, 711.5, 11],
    y: [14.3, -188, 456],
    z0: 0.9,
};

function portraitUv(p, crop) {
    const px = PORTRAIT.x[0] * p.x + PORTRAIT.x[1] * (p.y - EYE.y) + PORTRAIT.x[2] + PORTRAIT.x[3] * (p.z - PORTRAIT.z0);
    const py = PORTRAIT.y[0] * p.x + PORTRAIT.y[1] * (p.y - EYE.y) + PORTRAIT.y[2];
    const [x0, y0, w, h] = crop;
    return [(px - x0) / w, 1 - (py - y0) / h];
}

// Per-vertex (u, v, weight) for the projected portrait: only surfaces facing the camera at rest
// take it; the back keeps its own colors. The portrait barely shows the head's left side (the
// viewer's right), so surfaces facing that way also get (u, v, weight) for the mirrored point on
// the other side, which the portrait shows well. `mirror` forces it, e.g. for that side's ear.
function setPortraitAttribute(geometry, positions, normals, mirror = null) {
    const n = positions.length / 3, direct = new Float32Array(n * 3), mirrored = new Float32Array(n * 3), p = new V3();
    for (let i = 0; i < n; i++) {
        p.fromArray(positions, i * 3);
        direct.set([...portraitUv(p, PORTRAIT.face.crop), smoothstep(-0.25, 0.2, normals[i * 3 + 2])], i * 3);
        const m = mirror ?? (p.x > 0 ? smoothstep(0.45, 0.75, normals[i * 3]) : 0);
        p.x = -p.x;
        mirrored.set([...portraitUv(p, PORTRAIT.face.crop), m], i * 3);
    }
    geometry.setAttribute('portrait', new THREE.BufferAttribute(direct, 3));
    geometry.setAttribute('portraitMirror', new THREE.BufferAttribute(mirrored, 3));
}

// Same, for a mesh already placed in the (rest pose) scene.
function projectPortrait(mesh, mirror = null) {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const positions = new Float32Array(pos.count * 3), normals = new Float32Array(pos.count * 3), v = new V3();
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray(positions, i * 3);
        v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize().toArray(normals, i * 3);
    }
    setPortraitAttribute(g, positions, normals, mirror);
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// Frame-rate independent exponential approach towards a target.
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = (dx, dy, sx, sy) => Math.exp(-((dx / sx) ** 2) - ((dy / sy) ** 2));

function smin(a, b, k) {
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return lerp(b, a, h) - k * h * (1 - h);
}
const smax = (a, b, k) => -smin(-a, -b, k);

// Seeded PRNG and value noise, so the generated details are identical on every page load.
function mulberry32(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash2(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), u = smoothstep(0, 1, x - xi), v = smoothstep(0, 1, y - yi);
    return lerp(lerp(hash2(xi, yi), hash2(xi + 1, yi), u), lerp(hash2(xi, yi + 1), hash2(xi + 1, yi + 1), u), v);
}

// A left/right symmetric function of the angle around the head, smoothly interpolated through
// [|phi|, value] points.
function aroundHead(points) {
    return (phi) => {
        const a = Math.abs(Math.atan2(Math.sin(phi), Math.cos(phi)));
        for (let i = 1; i < points.length; i++) {
            if (a <= points[i][0]) {
                const [a0, v0] = points[i - 1], [a1, v1] = points[i];
                return lerp(v0, v1, smoothstep(a0, a1, a));
            }
        }
        return points[points.length - 1][1];
    };
}

// ---------------------------------------------------------------------------------------------
// Head shape. The skull is lofted through horizontal cross-sections (rounded at the chin and the
// crown), then the face is sculpted on top: brow ridge, nose, lips, chin, cheeks and eye sockets.
// ---------------------------------------------------------------------------------------------

// [y, half-width, center depth, front reach, back reach], from the chin up to the crown.
const SECTIONS = [
    [-1.37, 0.3, 0.4, 0.18, 0.2],
    [-1.28, 0.5, 0.32, 0.3, 0.32],
    [-1.16, 0.68, 0.24, 0.4, 0.42],
    [-1.0, 0.83, 0.15, 0.52, 0.5],
    [-0.85, 0.93, 0.09, 0.62, 0.55],
    [-0.5, 1.0, 0.02, 0.8, 0.66],
    [-0.2, 1.02, -0.05, 0.92, 0.78],
    [0.2, 1.01, -0.15, 1.05, 1.05],
    [0.6, 0.99, -0.2, 1.12, 1.3],
    [1.0, 0.93, -0.25, 1.12, 1.33],
    [1.3, 0.8, -0.3, 1.0, 1.22],
    [1.52, 0.6, -0.33, 0.78, 0.98],
];
const FRONT_N = 2.25, BACK_N = 2.1;   // superellipse exponents: a flatter face, a rounder back

// Cubic Hermite through the sections with slopes taken along y, so the surface (and its shading)
// stays smooth across them.
function section(y) {
    const S = SECTIONS, last = S.length - 1;
    let i = 0;
    while (i < last - 1 && y > S[i + 1][0]) i++;
    const y0 = S[i][0], y1 = S[i + 1][0], h = y1 - y0, t = clamp((y - y0) / h, 0, 1);
    const slope = (j, k) => (S[Math.min(j + 1, last)][k] - S[Math.max(j - 1, 0)][k]) / (S[Math.min(j + 1, last)][0] - S[Math.max(j - 1, 0)][0]);
    const v = (k) => {
        const t2 = t * t, t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * S[i][k] + (t3 - 2 * t2 + t) * h * slope(i, k) + (-2 * t3 + 3 * t2) * S[i + 1][k] + (t3 - t2) * h * slope(i + 1, k);
    };
    const cap = Math.sqrt(clamp((y - HEAD_BOTTOM) / 0.08, 0, 1) * clamp((HEAD_TOP - y) / 0.14, 0, 1));
    return { w: v(1) * cap, c: v(2), f: v(3) * cap, b: v(4) * cap };
}

// phi runs around the head: 0 faces forward, +pi/2 is the head's left (+x).
function headBase(y, phi, out = new V3(), s = section(y)) {
    const sp = Math.sin(phi), cp = Math.cos(phi), e = 2 / (cp > 0 ? FRONT_N : BACK_N);
    return out.set(s.w * Math.sign(sp) * Math.abs(sp) ** e, y, s.c + (cp > 0 ? s.f : s.b) * Math.sign(cp) * Math.abs(cp) ** e);
}

function headNormal(y, phi, out = new V3()) {
    const e = 1e-3, a = headBase(y, phi + e), b = headBase(y, phi - e), c = headBase(y + e, phi), d = headBase(y - e, phi);
    return out.crossVectors(a.sub(b), c.sub(d)).normalize();
}

// Depth of the bare skull's front at (x, y).
function baseFrontZ(x, y, s = section(y)) {
    const e = 2 / FRONT_N;
    const sp = Math.min(1, Math.abs(x) / Math.max(s.w, 1e-6)) ** (1 / e);
    return s.c + s.f * Math.sqrt(Math.max(0, 1 - sp * sp)) ** e;
}

function noseHeight(ax, y) {
    const t = clamp((0.14 - y) / 0.54, 0, 1);   // 0 at the root between the eyes, 1 at the tip
    const ridge = (0.03 + 0.21 * t ** 1.5) * Math.exp(-((ax / (0.07 + 0.045 * t)) ** 2)) * smoothstep(0.24, 0.1, y) * smoothstep(-0.5, -0.38, y);
    const tip = 0.3 * gauss(ax, y + 0.41, 0.13, 0.1);
    const wings = 0.17 * gauss(ax - 0.2, y + 0.47, 0.085, 0.065);
    return smax(smax(ridge, tip, 0.05), wings, 0.04);
}

function faceRelief(x, y) {
    const ax = Math.abs(x);
    const lips = smoothstep(MOUTH.w + 0.05, MOUTH.w - 0.1, ax);
    let d = 0;
    d += 0.055 * Math.exp(-(((y - 0.33) / 0.11) ** 2)) * smoothstep(0.88, 0.35, ax);   // brow ridge
    d += 0.012 * browMask(ax, y);                                                     // brows
    d += 0.035 * gauss(ax - 0.62, y + 0.12, 0.22, 0.16);                              // cheekbones
    d += 0.05 * gauss(ax - 0.5, y + 0.5, 0.28, 0.22);                                 // cheeks
    d += 0.06 * gauss(ax, y + 1.22, 0.28, 0.13);                                      // chin
    d -= 0.03 * gauss(ax, y - MOUTH.y + 0.17, 0.26, 0.045);                           // fold under the lower lip
    d -= 0.012 * gauss(ax, y - MOUTH.y - 0.17, 0.03, 0.07);                           // philtrum
    d += lips * (0.055 * Math.exp(-(((y - MOUTH.y - 0.035) / 0.04) ** 2)) + 0.08 * Math.exp(-(((y - MOUTH.y + 0.06) / 0.055) ** 2)));
    d -= 0.02 * lips * Math.exp(-(((y - MOUTH.y) / 0.012) ** 2));                     // lip line
    d -= 0.018 * gauss(ax - MOUTH.w, y - MOUTH.y, 0.04, 0.04);                        // mouth corners
    return d + noseHeight(ax, y);
}

const EYE_Z = baseFrontZ(EYE.x, EYE.y) + faceRelief(EYE.x, EYE.y) - 0.13;

// Almond-shaped opening in the skin around an eye, in eye-local coordinates (u points towards the
// temple): a little larger than the lids' rest position, with the corners slightly low.
function eyeOpening(u, shape) {
    const k = clamp(u / shape.hw, -1, 1);
    return {
        top: (shape.upper + 0.03) * (1 - k * k) ** 0.75 - 0.03 * k * k + 0.005 * k,
        bottom: (shape.lower - 0.02) * (1 - k * k) ** 0.9 - 0.03 * k * k + 0.005 * k,
        k,
    };
}

// Inside the almond the skin tucks behind the eyelids; around it the skin wraps over them.
function eyeSocket(x, y, z) {
    const side = x < 0 ? -1 : 1;
    const u = (x - side * EYE.x) * side, v = y - EYE.y;
    const r = Math.hypot(u, v);
    if (r > 0.45) return z;
    const shape = EYE_SHAPES[side];
    const { top, bottom, k } = eyeOpening(u, shape);
    const inside = Math.min(top - v, v - bottom, shape.hw - Math.abs(u));
    const ball2 = LID_R * LID_R - u * u - v * v;
    const shell = EYE_Z + Math.sqrt(Math.max(ball2, 0));
    const zIn = ball2 > 0 ? Math.min(z, shell - 0.02) : z - 0.03;
    const zOut = ball2 > 0 ? smax(z, shell + 0.006, 0.035) : z;
    let zz = lerp(zOut, zIn, smoothstep(-0.03, 0.03, inside));
    zz -= 0.01 * Math.exp(-(((v - top - 0.06) / 0.016) ** 2)) * (1 - k * k);       // eyelid crease
    return lerp(zz, z, smoothstep(0.3, 0.45, r));
}

function faceZ(x, y) {
    return eyeSocket(x, y, baseFrontZ(x, y) + faceRelief(x, y));
}

// Slims the cheeks and jaw: the sides of the lower face move in, while the middle of the face (eyes,
// nose, mouth) stays put and the chin is left alone. Everything is modeled and textured at the
// unslimmed position, so the portrait gets squeezed along with the shape.
const CHEEK_SLIM = 0.035;
function slimOffset(x, y) {
    const band = smoothstep(0.1, -0.3, y) * smoothstep(-1.45, -1.0, y);
    return -Math.sign(x) * CHEEK_SLIM * band * smoothstep(0.3, 0.95, Math.abs(x));
}

// ---------------------------------------------------------------------------------------------
// Expressions sculpted into the head as morph targets. Each is a displacement of the rest shape;
// the mouth opens along a seam on the lip line, where the lip vertices are duplicated.
// ---------------------------------------------------------------------------------------------

const HEAD_MORPHS = ['jawOpen', 'smile', 'frown', 'pucker', 'browUp', 'browAngry'];

function expressionOffset(name, p, lowerLip, out) {
    out.set(0, 0, 0);
    const ax = Math.abs(p.x), sx = p.x < 0 ? -1 : 1, y = p.y;
    const front = smoothstep(-0.25, 0.25, p.z);
    const lipBand = smoothstep(MOUTH.w + 0.12, MOUTH.w * 0.4, ax) * Math.exp(-(((y - MOUTH.y) / 0.13) ** 2));
    const corner = gauss(ax - MOUTH.w, y - MOUTH.y, 0.16, 0.13);
    if (name === 'jawOpen') {
        // The jaw swings down rigidly, but the lips stay pinned at the corners, so the mouth opens
        // into a lens shape along the seam rather than a slot.
        const below = lowerLip || y < MOUTH.y - 1e-5;
        let w;
        if (ax < MOUTH.w) w = below ? 1 : 0;
        else {
            const spread = 0.015 + 2.5 * (ax - MOUTH.w);
            w = smoothstep(MOUTH.y + spread / 2, MOUTH.y - spread / 2, y);
        }
        const open = Math.sqrt(Math.max(0, 1 - (ax / MOUTH.w) ** 2));   // 1 mid-mouth, 0 at the corners
        const nearLips = below ? smoothstep(MOUTH.y - 0.18, MOUTH.y, y) : 0;
        w *= lerp(1, open, nearLips) * (1 - 0.8 * smoothstep(0.35, 1.0, ax)) * front;
        const a = JAW_OPEN * w, dy = y - JAW.y, dz = p.z - JAW.z;
        out.y = dy * Math.cos(a) - dz * Math.sin(a) - dy;
        out.z = dy * Math.sin(a) + dz * Math.cos(a) - dz;
        // The upper lip lifts a little in the middle, and both lip edges roll in.
        const seam = Math.exp(-(((y - MOUTH.y) / 0.035) ** 2)) * open * open * front;
        if (!below) out.y += 0.03 * open * Math.exp(-(((y - MOUTH.y) / 0.08) ** 2)) * front;
        out.z -= 0.05 * seam;
    } else if (name === 'smile') {
        out.set(sx * 0.04 * corner, 0.07 * corner, -0.03 * corner);
        out.x += sx * 0.03 * lipBand * (ax / MOUTH.w);
        out.y += 0.01 * lipBand;
        const cheek = gauss(ax - 0.5, y + 0.42, 0.22, 0.22);
        out.y += 0.045 * cheek;
        out.z += 0.025 * cheek;
        out.multiplyScalar(front);
    } else if (name === 'frown') {
        out.y -= 0.045 * gauss(ax - MOUTH.w, y - MOUTH.y, 0.14, 0.1);
        const lowerLipBand = lipBand * Math.exp(-(((y - MOUTH.y + 0.06) / 0.06) ** 2));
        out.y += 0.015 * lowerLipBand;
        out.z += 0.02 * lowerLipBand + 0.015 * gauss(ax, y + 1.15, 0.25, 0.12);
        out.multiplyScalar(front);
    } else if (name === 'pucker') {
        out.x = -p.x * 0.35 * lipBand;
        out.z = 0.06 * lipBand;
        out.multiplyScalar(front);
    } else if (name === 'browUp') {
        out.y = 0.07 * smoothstep(0.95, 0.55, ax) * smoothstep(0.12, 0.28, y) * smoothstep(1.1, 0.55, y) * front;
    } else if (name === 'browAngry') {
        const band = Math.exp(-(((y - 0.36) / 0.13) ** 2)) * front;
        const inner = smoothstep(0.5, 0.1, ax) * band;
        out.set(-sx * 0.02 * inner, -0.055 * inner + 0.015 * smoothstep(0.4, 0.75, ax) * band, 0.015 * inner);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Skin coloring, baked into vertex colors so it moves with the expressions: warmth on the cheeks,
// nose and ears, lips, thick brows, nostrils, light stubble, and the hair on the scalp (full on
// top, clipped short on the sides).
// ---------------------------------------------------------------------------------------------

// Height of the hairline around the head, and where the longer hair on top begins.
const hairlineY = aroundHead([[0, 1.14], [0.5, 1.12], [0.75, 1.03], [0.95, 0.86], [1.15, 0.45], [1.32, 0.1], [1.45, 0.25], [1.75, 0.3], [2.1, 0.1], [2.6, -0.25], [Math.PI, -0.45]]);
const volumeY = aroundHead([[0, 1.14], [0.6, 1.11], [0.9, 0.9], [1.2, 0.6], [1.57, 0.52], [2.2, 0.45], [Math.PI, 0.4]]);

const SKIN = new THREE.Color(COLORS.skin), FLUSH = new THREE.Color(COLORS.skinFlush), LIP_U = new THREE.Color(COLORS.lipUpper);
const LIP_L = new THREE.Color(COLORS.lipLower), BROW = new THREE.Color(COLORS.brow), HAIR = new THREE.Color(COLORS.hair);
const NOSTRIL = new THREE.Color(COLORS.nostril), STUBBLE = new THREE.Color(COLORS.stubble);

function browMask(ax, y) {
    const u = ax;
    if (u < 0.1 || u > 0.8) return 0;
    const center = 0.34 + 0.025 * Math.sin((Math.PI * (u - 0.12)) / 0.66) - 0.05 * smoothstep(0.5, 0.78, u);
    const half = 0.056 * (u < 0.2 ? lerp(0.75, 1, (u - 0.12) / 0.08) : lerp(1, 0.35, ((u - 0.2) / 0.58) ** 1.3));
    return smoothstep(half + 0.012, half - 0.008, Math.abs(y - center)) * smoothstep(0.1, 0.14, u) * smoothstep(0.8, 0.74, u);
}

function headColor(p, phi, lowerLip, out) {
    const ax = Math.abs(p.x), y = p.y, front = smoothstep(-0.1, 0.3, Math.cos(phi));
    out.copy(SKIN);
    out.lerp(FLUSH, (0.35 * gauss(ax - 0.52, y + 0.38, 0.22, 0.18) + 0.3 * gauss(ax, y + 0.42, 0.14, 0.12) + 0.12 * gauss(ax, y + 1.2, 0.25, 0.15)) * front);
    out.lerp(STUBBLE, (0.14 * smoothstep(MOUTH.y - 0.12, MOUTH.y - 0.3, y) * smoothstep(0.75, 0.35, ax) + 0.08 * gauss(ax, y - MOUTH.y - 0.14, 0.22, 0.05)) * front);
    out.lerp(NOSTRIL, 0.9 * gauss(ax - 0.09, y + 0.505, 0.045, 0.02) * front);

    // Lips: a thinner upper lip with a slight cupid's bow and a fuller lower lip.
    const taper = Math.sqrt(Math.max(0, 1 - (ax / MOUTH.w) ** 2));
    if (front > 0 && ax < MOUTH.w + 0.03) {
        const hu = (0.075 + 0.01 * gauss(ax - 0.08, 0, 0.05, 1) - 0.01 * gauss(ax, 0, 0.035, 1)) * taper;
        const hl = 0.12 * taper;
        const upper = !lowerLip && y >= MOUTH.y - 1e-5 ? smoothstep(MOUTH.y + hu + 0.012, MOUTH.y + hu - 0.012, y) : 0;
        const lower = lowerLip || y < MOUTH.y ? smoothstep(MOUTH.y - hl - 0.015, MOUTH.y - hl + 0.01, y) : 0;
        out.lerp(LIP_U, upper * front);
        out.lerp(LIP_L, lower * front);
    }

    out.lerp(BROW, browMask(ax, y) * (0.88 + 0.12 * noise2(p.x * 90, p.y * 25)) * front);

    // Scalp: dense hair on top, clipped short (skin showing through) on the sides and back.
    const line = hairlineY(phi), top = volumeY(phi);
    if (y > line - 0.04) {
        const grain = 0.8 + 0.2 * noise2(p.x * 60 + p.z * 40, p.y * 60);
        out.lerp(HAIR, smoothstep(line - 0.03, line + 0.03, y) * lerp(0.82, 1, smoothstep(line, top, y)) * grain);
    }
    return out;
}

function buildHeadGeometry(detailed) {
    const COLS = detailed ? 200 : 48, ROWS = detailed ? 176 : 40;
    // Columns are packed towards the face, rows evenly with a little extra at the chin and crown.
    const phis = Array.from({ length: COLS }, (_, j) => { const t = (2 * j) / COLS - 1; return Math.PI * t * (0.45 + 0.55 * t * t); });
    const ys = Array.from({ length: ROWS + 1 }, (_, i) => { const u = i / ROWS; return lerp(HEAD_BOTTOM, HEAD_TOP, lerp(u, (1 - Math.cos(Math.PI * u)) / 2, 0.3)); });
    // Snap one row onto the lip line so the mouth can open along it.
    let mouthRow = 0;
    ys.forEach((y, i) => { if (Math.abs(y - MOUTH.y) < Math.abs(ys[mouthRow] - MOUTH.y)) mouthRow = i; });
    const shift = MOUTH.y - ys[mouthRow];
    for (let i = 0; i <= ROWS; i++) ys[i] += shift * Math.max(0, 1 - Math.abs(i - mouthRow) / 6);

    const verts = [];
    for (let i = 0; i <= ROWS; i++) {
        const s = section(ys[i]);
        for (const phi of phis) {
            const p = headBase(ys[i], phi, new V3(), s);
            const fw = smoothstep(0.1, 0.5, Math.cos(phi));
            if (fw > 0) p.z = eyeSocket(p.x, p.y, p.z + faceRelief(p.x, p.y) * fw);
            verts.push({ p, phi, lowerLip: false });
        }
    }
    const at = (i, j) => i * COLS + j;
    const lowerCopy = new Map();
    if (detailed) {
        phis.forEach((phi, j) => {
            const v = verts[at(mouthRow, j)];
            if (Math.cos(phi) > 0 && Math.abs(v.p.x) < MOUTH.w) {
                lowerCopy.set(j, verts.length);
                verts.push({ p: v.p.clone(), phi, lowerLip: true });
            }
        });
    }
    const indices = [];
    for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
            const j2 = (j + 1) % COLS;
            // On the lip line, quads below the seam use the lower lip's copy of the vertices.
            const top = (jj) => (i + 1 === mouthRow && lowerCopy.has(jj) ? lowerCopy.get(jj) : at(i + 1, jj));
            const a = at(i, j), b = at(i, j2), c = top(j), d = top(j2);
            indices.push(a, b, c, b, d, c);
        }
    }

    const shown = verts.map((v) => v.p.clone().setX(v.p.x + slimOffset(v.p.x, v.p.y)));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(shown.flatMap((p) => [p.x, p.y, p.z]), 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    if (!detailed) return g;

    const c = new THREE.Color(), colors = [], blush = [];
    for (const v of verts) {
        headColor(v.p, v.phi, v.lowerLip, c);
        colors.push(c.r, c.g, c.b);
        blush.push(gauss(Math.abs(v.p.x) - 0.52, v.p.y + 0.36, 0.2, 0.15) * smoothstep(0, 0.4, v.p.z));
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('blush', new THREE.Float32BufferAttribute(blush, 1));
    setPortraitAttribute(g, new Float32Array(verts.flatMap((v) => [v.p.x, v.p.y, v.p.z])), g.attributes.normal.array);

    const baseNormals = g.attributes.normal.array;
    const work = new THREE.BufferGeometry();
    work.setIndex(indices);
    const off = new V3();
    g.morphTargetsRelative = true;
    g.morphAttributes.position = [];
    g.morphAttributes.normal = [];
    for (const name of HEAD_MORPHS) {
        const delta = [], moved = [];
        verts.forEach((v, k) => {
            expressionOffset(name, v.p, v.lowerLip, off);
            delta.push(off.x, off.y, off.z);
            moved.push(shown[k].x + off.x, shown[k].y + off.y, shown[k].z + off.z);
        });
        work.setAttribute('position', new THREE.Float32BufferAttribute(moved, 3));
        work.computeVertexNormals();
        const n = work.attributes.normal.array, dn = new Float32Array(n.length);
        for (let k = 0; k < n.length; k++) dn[k] = n[k] - baseNormals[k];
        const position = new THREE.Float32BufferAttribute(delta, 3);
        position.name = name;
        g.morphAttributes.position.push(position);
        g.morphAttributes.normal.push(new THREE.BufferAttribute(dn, 3));
    }
    return g;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

// Blend the projected portrait over a material's own shading. The portrait already has its light
// baked in, so it is shown nearly unlit, run through the inverse of the paint pass's tone curve so
// its colors come out as in the image.
function withPortrait(material, texture, key, before = null, darkOnly = false) {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uPortrait = { value: texture };
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute vec3 portrait;\nattribute vec3 portraitMirror;\nvarying vec3 vPortrait;\nvarying vec3 vPortraitMirror;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPortrait = portrait;\nvPortraitMirror = portraitMirror;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                uniform sampler2D uPortrait;
                varying vec3 vPortrait;
                varying vec3 vPortraitMirror;
                vec3 inverseAces(vec3 y) {
                    y = clamp(y, 0.0, 0.985);
                    vec3 a = 2.43 * y - 2.51, b = 0.59 * y - 0.03, c = 0.14 * y;
                    return (-b - sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
                }`)
            .replace('#include <opaque_fragment>', `
                vec3 portraitColor = mix(texture2D(uPortrait, vPortrait.xy).rgb, texture2D(uPortrait, vPortraitMirror.xy).rgb, vPortraitMirror.z);
                portraitColor *= 0.86 + 0.14 * clamp(normal.z, 0.0, 1.0);
                float portraitWeight = max(vPortrait.z, vPortraitMirror.z)${darkOnly ? ' * smoothstep(0.24, 0.12, dot(portraitColor, vec3(0.299, 0.587, 0.114)))' : ''};
                outgoingLight = mix(outgoingLight, inverseAces(portraitColor), portraitWeight);
                #include <opaque_fragment>`);
        if (before) before(shader);   // e.g. the blush, which goes on top of the portrait
    };
    material.customProgramCacheKey = () => key;
    return material;
}

function addBlush(shader) {
    shader.uniforms.uBlush = blushUniform;
    shader.uniforms.uBlushColor = { value: new THREE.Color(COLORS.blush) };
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float blush;\nvarying float vBlush;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBlush = blush;');
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uBlush;\nuniform vec3 uBlushColor;\nvarying float vBlush;')
        .replace('#include <opaque_fragment>', 'outgoingLight = mix(outgoingLight, outgoingLight * uBlushColor * 1.6, clamp(vBlush * uBlush, 0.0, 1.0) * 0.35);\n#include <opaque_fragment>');
}

const blushUniform = { value: 0 };

function makeMaterials(portrait) {
    const skinParams = { roughness: 0.5, sheen: 0.35, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff8f70), clearcoat: 0.06, clearcoatRoughness: 0.45 };
    const face = new THREE.MeshPhysicalMaterial({ ...skinParams, vertexColors: true });
    const M = {
        face,
        skin: new THREE.MeshPhysicalMaterial({ ...skinParams, color: SKIN.clone().multiplyScalar(0.95) }),
        ear: new THREE.MeshPhysicalMaterial({ ...skinParams, color: SKIN.clone().lerp(FLUSH, 0.35) }),
        neck: new THREE.MeshPhysicalMaterial({ ...skinParams, color: SKIN.clone().multiplyScalar(0.85) }),
        eye: new THREE.MeshPhysicalMaterial({ map: irisTexture(), roughness: 0.55, clearcoat: 0.5, clearcoatRoughness: 0.12, envMapIntensity: 0.6 }),
        lash: new THREE.MeshStandardMaterial({ color: 0x0d0a09, roughness: 0.8 }),
        hair: new THREE.MeshPhysicalMaterial({ color: COLORS.hair, roughness: 0.5, sheen: 0.3, sheenRoughness: 0.35, sheenColor: new THREE.Color(0x3a2418) }),
        frames: new THREE.MeshPhysicalMaterial({ color: COLORS.frames, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08 }),
        metal: new THREE.MeshStandardMaterial({ color: COLORS.metal, metalness: 1, roughness: 0.28 }),
        lens: new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.04, roughness: 0.05, envMapIntensity: 0.5, depthWrite: false }),
        shirt: new THREE.MeshPhysicalMaterial({ color: COLORS.shirt, roughness: 0.9, sheen: 0.8, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff) }),
        mouth: new THREE.MeshStandardMaterial({ color: COLORS.mouth, roughness: 1, envMapIntensity: 0.15 }),
        teeth: new THREE.MeshPhysicalMaterial({ color: COLORS.teeth, roughness: 0.35, clearcoat: 0.4, clearcoatRoughness: 0.2, envMapIntensity: 0.5 }),
        tongue: new THREE.MeshPhysicalMaterial({ color: COLORS.tongue, roughness: 0.55, sheen: 0.4, sheenColor: new THREE.Color(0xff9a8a), envMapIntensity: 0.4 }),
    };
    if (portrait) {
        withPortrait(face, portrait, 'portrait-face', addBlush);
        for (const name of ['skin', 'ear', 'neck', 'shirt']) withPortrait(M[name], portrait, 'portrait');
        // Hair only takes the portrait where the portrait actually shows hair (dark); elsewhere it
        // keeps its own shading instead of picking up skin or background colors.
        withPortrait(M.hair, portrait, 'portrait-hair', null, true);
    } else {
        face.onBeforeCompile = addBlush;
    }
    return M;
}

// The eyeball texture is laid out by angle from the front of the eye (the top rows of the canvas),
// which is where SphereGeometry's pole lands after rotating it to face forward. Iris size and
// colors follow the portrait: a dark, warm brown iris with a crisp dark rim, and a muted,
// pinkish-grey white (the portrait's eyes are in the shade of the lids and lenses).
function irisTexture() {
    const W = 1024, H = 512, canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
    const IRIS = 0.47, PUPIL = 0.17;
    for (let y = 0; y < H; y++) {
        const theta = ((y + 0.5) / H) * Math.PI;
        for (let x = 0; x < W; x++) {
            const lon = x / W;
            let r, g, b;
            if (theta < IRIS + 0.03) {
                const t = clamp((theta - PUPIL) / (IRIS - PUPIL), 0, 1);
                const fiber = 0.78 + 0.44 * noise2(lon * 140, t * 4) * noise2(lon * 37, t * 9 + 3);
                const collarette = 1 + 0.25 * Math.exp(-(((t - 0.32) / 0.08) ** 2));        // lighter ring round the pupil
                const rim = 1 - 0.75 * smoothstep(0.8, 1, t);                               // dark limbal ring
                const warm = 1 - smoothstep(0, 0.5, t);
                r = (62 + 34 * warm) * fiber * collarette * rim;
                g = (44 + 18 * warm) * fiber * collarette * rim;
                b = (36 + 6 * warm) * fiber * collarette * rim;
                const pupil = smoothstep(PUPIL + 0.012, PUPIL - 0.012, theta);
                r = lerp(r, 6, pupil); g = lerp(g, 5, pupil); b = lerp(b, 5, pupil);
                // Blend into the white over the last sliver.
                const edge = smoothstep(IRIS, IRIS + 0.03, theta);
                r = lerp(r, 198, edge); g = lerp(g, 184, edge); b = lerp(b, 176, edge);
            } else {
                const back = smoothstep(IRIS, 1.7, theta);
                const vein = 0.06 * smoothstep(0.78, 1, noise2(lon * 70, theta * 9)) * (1 - back);
                r = 200 - 45 * back; g = (186 - 50 * back) * (1 - vein); b = (178 - 52 * back) * (1 - vein);
            }
            const k = (y * W + x) * 4;
            img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

// Sphere with every vertex passed through fn; the seam is put at the back of the shape.
function warpedSphere(fn, widthSegments = 48, heightSegments = 32) {
    const g = new THREE.SphereGeometry(1, widthSegments, heightSegments, -Math.PI / 2);
    const pos = g.attributes.position, v = new V3();
    for (let i = 0; i < pos.count; i++) {
        fn(v.fromBufferAttribute(pos, i));
        pos.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
}

// Grid surface: vertex(s, column, out) for rows s in [0, 1]; rows should run top to bottom and
// columns left to right as seen from outside for the faces to point outwards.
function gridGeometry(rows, cols, vertex, closeCols = false) {
    const positions = [], indices = [], v = new V3();
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c < cols; c++) {
            vertex(r / rows, c, v);
            positions.push(v.x, v.y, v.z);
        }
    }
    const lastCol = closeCols ? cols : cols - 1;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < lastCol; c++) {
            const a = r * cols + c, b = (r + 1) * cols + c;
            const a2 = r * cols + ((c + 1) % cols), b2 = (r + 1) * cols + ((c + 1) % cols);
            indices.push(a, b, a2, a2, b, b2);
        }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
}

// Tube whose radius varies along the curve: radius(t) scales each ring about its center.
function taperedTube(curve, segments, radius, radialSegments = 8, closed = false) {
    const g = new THREE.TubeGeometry(curve, segments, 1, radialSegments, closed);
    const pos = g.attributes.position, p = new V3(), c = new V3();
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        curve.getPointAt(closed ? t % 1 : t, c);
        const r = radius(t, c);
        for (let j = 0; j <= radialSegments; j++) {
            const k = i * (radialSegments + 1) + j;
            p.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
            pos.setXYZ(k, p.x, p.y, p.z);
        }
    }
    return g;
}

// Concatenate geometries that carry positions and normals, so many parts draw in one call.
function mergeGeometries(list) {
    const positions = [], normals = [], indices = [];
    let offset = 0;
    for (const g of list) {
        positions.push(...g.attributes.position.array);
        normals.push(...g.attributes.normal.array);
        for (const i of g.index.array) indices.push(i + offset);
        offset += g.attributes.position.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setIndex(indices);
    return merged;
}

// ---------------------------------------------------------------------------------------------
// Hair: a volume layer over the top of the head that stands tall at the front, and tapered
// strands sweeping up and back from it. The clipped sides are painted into the skin colors.
// ---------------------------------------------------------------------------------------------

const volumeLift = aroundHead([[0, 0.27], [0.6, 0.27], [1.0, 0.26], [1.57, 0.24], [2.2, 0.16], [Math.PI, 0.12]]);
const volumeRise = aroundHead([[0, 0.22], [0.7, 0.22], [1.2, 0.2], [Math.PI, 0.3]]);

function hairLift(y, phi) {
    const lift = 0.012 + volumeLift(phi) * smoothstep(volumeY(phi), volumeY(phi) + volumeRise(phi), y);
    return lerp(lift, 0.24, smoothstep(1.25, HEAD_TOP, y));  // all columns meet at the crown
}

// Direction the hair volume grows in: off the scalp, tipped upwards at the front so the quiff
// rises from the hairline instead of jutting over the forehead.
function hairDirection(y, phi, out) {
    headNormal(y, phi, out);
    return out.add(new V3(0, 0.8 * smoothstep(-0.2, 0.8, Math.cos(phi)), 0)).normalize();
}

function hairSurface(y, phi, out, normal) {
    headBase(y, phi, out);
    hairDirection(y, phi, normal);
    return out.addScaledVector(normal, hairLift(y, phi));
}

function hairShellGeometry(detailed) {
    const COLS = detailed ? 128 : 32, ROWS = detailed ? 40 : 12, n = new V3();
    return gridGeometry(ROWS, COLS, (s, j, out) => {
        const phi = (j / COLS) * Math.PI * 2 - Math.PI;
        const y0 = volumeY(phi);
        hairSurface(y0 + (HEAD_TOP - 0.002 - y0) * (1 - s) ** 1.4, phi, out, n);
    }, true);
}

// A flat strand lying on the hair volume along a path of (y, phi, lift) points, tapering and
// lifting off towards its tip.
function strandGeometry(path, width, thick) {
    const ROWS = path.length - 1, RING = 6;
    const centers = [], normals = [], n = new V3();
    for (const q of path) {
        const c = hairSurface(q.y, q.phi, new V3(), n);
        centers.push(c.addScaledVector(n, q.lift));
        normals.push(n.clone());
    }
    const T = new V3(), N = new V3(), B = new V3();
    return gridGeometry(ROWS, RING, (s, k, out) => {
        const i = Math.round(s * ROWS);
        T.subVectors(centers[Math.min(i + 1, ROWS)], centers[Math.max(i - 1, 0)]).normalize();
        N.copy(normals[i]).addScaledVector(T, -T.dot(normals[i])).normalize();
        B.crossVectors(T, N);
        const f = 1 - (i / ROWS) ** 1.6, a = (k / RING) * Math.PI * 2;
        out.copy(centers[i]).addScaledVector(B, Math.cos(a) * width * f).addScaledVector(N, (Math.sin(a) + 0.5) * thick * f);
    }, true);
}

function hairStrandsGeometry() {
    const rnd = mulberry32(21), strands = [];
    const add = (y0, phi0, dy, dphi, width, thick, tipLift) => {
        const path = [];
        for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            path.push({ y: Math.min(y0 + dy * t, HEAD_TOP - 0.03), phi: phi0 + dphi * t, lift: tipLift * t ** 2.2 });
        }
        strands.push(strandGeometry(path, width, thick));
    };
    // The quiff: from the front hairline up and back over the top, swept a little to one side.
    for (let i = 0; i < 80; i++) {
        const phi = (rnd() * 2 - 1) * 1.05;
        add(volumeY(phi) + 0.01, phi, 0.36 + rnd() * 0.2, 0.1 + (rnd() - 0.5) * 0.14, 0.05, 0.02, 0.03 + rnd() * 0.09);
    }
    // Everywhere else: shorter strands combed back on top and at the sides, down at the back.
    for (let i = 0; i < 200; i++) {
        const phi = (rnd() * 2 - 1) * Math.PI;
        const back = smoothstep(0.2, -0.6, Math.cos(phi)), side = smoothstep(0.5, 1.3, Math.abs(phi)) * (1 - back);
        const y0 = lerp(volumeY(phi) + 0.02, HEAD_TOP - 0.12, rnd());
        const dy = lerp(0.32, -0.38, back) * (0.7 + 0.6 * rnd());
        add(y0, phi, dy, Math.sign(phi) * 0.45 * side + (rnd() - 0.5) * 0.12, 0.045, 0.018, 0.02 + rnd() * 0.09);
    }
    return mergeGeometries(strands);
}

// ---------------------------------------------------------------------------------------------
// Eyes: a glossy eyeball whose iris rotates to look around, and upper/lower lids that are
// hemispherical shells rotating about the eye's horizontal axis, with lash lines on their rims.
// ---------------------------------------------------------------------------------------------

// The eyeball's own material darkens it under the upper lid and towards the corners. The shading is
// fixed to the eye socket (via the inverse of the socket's transform), so it stays put while the
// eyeball turns.
function eyeballMaterial(base) {
    const material = base.clone();
    const rootInverse = { value: new THREE.Matrix4() };
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uRootInverse = rootInverse;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nuniform mat4 uRootInverse;\nvarying vec3 vRootPos;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRootPos = (uRootInverse * modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vRootPos;')
            .replace('#include <opaque_fragment>', `
                float underLid = smoothstep(-0.04, 0.085, vRootPos.y);
                float corner = smoothstep(0.07, 0.17, abs(vRootPos.x));
                outgoingLight *= 1.0 - 0.5 * underLid - 0.3 * corner;
                #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => 'eyeball';
    return { material, rootInverse: rootInverse.value };
}

function buildEye(side, M) {
    const root = new THREE.Group();
    root.position.set(side * EYE.x, EYE.y, EYE_Z);
    const pivot = new THREE.Group();
    pivot.rotation.order = 'YXZ';
    const { material, rootInverse } = eyeballMaterial(M.eye);
    pivot.add(new THREE.Mesh(new THREE.SphereGeometry(EYE.r, 64, 48).rotateX(Math.PI / 2), material));
    const lid = (start) => new THREE.Mesh(new THREE.SphereGeometry(LID_R, 40, 14, 0, Math.PI * 2, start, Math.PI / 2), M.skin);
    const lash = (tube) => new THREE.Mesh(new THREE.TorusGeometry(LID_R, tube, 6, 40, Math.PI).rotateX(Math.PI / 2), M.lash);
    const upper = lid(0), lower = lid(Math.PI / 2);
    upper.add(lash(0.006));
    lower.add(lash(0.003));
    for (const m of [upper, lower]) m.castShadow = m.receiveShadow = true;
    root.add(pivot, upper, lower);
    // Lid angles that put the rims on the portrait's lash line and lower lid.
    const shape = EYE_SHAPES[side];
    const restUpper = -Math.asin(shape.upper / LID_R), restLower = Math.asin(-shape.lower / LID_R);
    return { side, root, pivot, upper, lower, restUpper, restLower, rootInverse, yaw: 0, pitch: 0 };
}

// ---------------------------------------------------------------------------------------------
// Glasses: big black rectangular frames, heavier along the top, wrapping slightly around the
// face, with metal temples and hinge rivets.
// ---------------------------------------------------------------------------------------------

// Rounded rectangle (superellipse), a little wider at the top than at the bottom.
class SuperEllipse extends THREE.Curve {
    constructor(a, b, n, taper = 0) { super(); this.a = a; this.b = b; this.e = 2 / n; this.taper = taper; }
    getPoint(t, out = new V3()) {
        const c = Math.cos(t * Math.PI * 2), s = Math.sin(t * Math.PI * 2);
        const y = this.b * Math.sign(s) * Math.abs(s) ** this.e;
        return out.set(this.a * Math.sign(c) * Math.abs(c) ** this.e * (1 + (this.taper * y) / this.b), y, 0);
    }
}

function buildGlasses(M) {
    const group = new THREE.Group();
    const A = 0.355, B = 0.27, CX = 0.48, CY = -0.14, K = 0.4;
    const Z = EYE_Z + EYE.r + 0.09 + K * EYE.x * EYE.x;
    const wrap = (x) => Z - K * x * x;
    // Bend geometry built flat around one lens center onto the wrap.
    const bend = (g, cx, cy) => {
        const pos = g.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i) + cx;
            pos.setXYZ(i, x, pos.getY(i) + cy, pos.getZ(i) + wrap(x));
        }
        g.computeVertexNormals();
        return g;
    };
    const rim = new SuperEllipse(A, B, 5, 0.06);
    const lensShape = new THREE.Shape(rim.getPoints(80).map((p) => new THREE.Vector2(p.x, p.y)));
    const at = (side, x, y, dz = 0) => new V3(side * CX + x, CY + y, wrap(side * CX + x) + dz);
    for (const side of [-1, 1]) {
        const frame = bend(taperedTube(rim, 120, (t, p) => 0.024 + 0.02 * smoothstep(0.3 * B, B, p.y), 8, true), side * CX, CY);
        const lens = bend(new THREE.ShapeGeometry(lensShape, 24), side * CX, CY);
        group.add(new THREE.Mesh(frame, M.frames), new THREE.Mesh(lens, M.lens));
        for (const dx of [0.05, 0.1]) {
            const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.013, 10, 8), M.metal);
            rivet.position.copy(at(side, side * (A - dx), B - 0.045, 0.03));
            group.add(rivet);
        }
        const temple = new THREE.QuadraticBezierCurve3(at(side, side * A * 1.04, B * 0.6, -0.02), new V3(side * 1.06, CY + B * 0.6, 0.2), new V3(side * 1.07, 0.15, -0.4));
        group.add(new THREE.Mesh(new THREE.TubeGeometry(temple, 24, 0.016, 6), M.metal));
    }
    const bridge = new THREE.QuadraticBezierCurve3(at(-1, A * 0.95, B * 0.55), new V3(0, CY + B * 0.75, wrap(0) + 0.02), at(1, -A * 0.95, B * 0.55));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(bridge, 16, 0.024, 8), M.frames));
    group.traverse((o) => { if (o.isMesh && o.material !== M.lens) o.castShadow = true; });
    return group;
}

// ---------------------------------------------------------------------------------------------
// Ears, mouth interior, neck and T-shirt
// ---------------------------------------------------------------------------------------------

function earGeometry() {
    // A thin shell whose outer face dips into the bowl of the ear and rises into the rim.
    return warpedSphere((v) => {
        const r = Math.hypot(v.y, v.z);
        let x = v.x * 0.05;
        if (v.x > 0) x -= 0.05 * Math.exp(-((r / 0.6) ** 2)) - 0.018 * Math.exp(-(((r - 0.9) / 0.12) ** 2));
        v.set(x, v.y * 0.38, v.z * 0.23);
    }, 32, 24);
}

// A row of teeth along an arc: [width, height] from the middle outwards (incisors, canine,
// premolars), mirrored to both sides. Each tooth is a rounded box; `down` hangs them from the top
// edge (upper row) instead of standing them on the bottom edge (lower row).
function teethRow(sizes, radius, depth, down) {
    const parts = [];
    let angle = 0;
    sizes.forEach(([w, h], i) => {
        const half = w / 2 / radius;
        angle += half;
        for (const side of [-1, 1]) {
            const a = side * angle;
            const tooth = warpedSphere((v) => {
                const f = (t, e) => Math.sign(t) * Math.abs(t) ** e;
                v.set(f(v.x, 0.5) * w * 0.51, f(v.y, 0.45) * h / 2, f(v.z, 0.6) * depth / 2);
            }, 10, 8);
            tooth.translate(0, down ? -h / 2 : h / 2, 0);
            tooth.applyMatrix4(new THREE.Matrix4().makeRotationY(a).setPosition(radius * Math.sin(a), 0, radius * Math.cos(a)));
            parts.push(tooth);
        }
        angle += half;
    });
    return mergeGeometries(parts);
}

function buildMouthInterior(M) {
    // A deep, dark mouth behind the lips with a row of teeth on top; the lower teeth and the
    // tongue ride on the jaw.
    const frontZ = faceZ(0, MOUTH.y) - 0.06;
    const cavity = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20).scale(0.32, 0.22, 0.3), M.mouth);
    cavity.position.set(0, MOUTH.y - 0.05, frontZ - 0.33);
    // Sized like real teeth relative to the face: about six front teeth fill a smile.
    const upperTeeth = new THREE.Mesh(teethRow([[0.105, 0.125], [0.082, 0.11], [0.088, 0.118], [0.08, 0.1], [0.078, 0.095]], 0.3, 0.05, true), M.teeth);
    upperTeeth.position.set(0, MOUTH.y + 0.1, frontZ - 0.3);
    const jaw = new THREE.Group();
    jaw.position.copy(JAW);
    const lowerTeeth = new THREE.Mesh(teethRow([[0.072, 0.1], [0.076, 0.1], [0.085, 0.105], [0.08, 0.095], [0.08, 0.09]], 0.28, 0.045, false), M.teeth);
    lowerTeeth.position.set(0, MOUTH.y - 0.13, frontZ - 0.4).sub(JAW);   // tucked behind the lower lip
    const tongue = new THREE.Mesh(warpedSphere((v) => v.set(v.x * 0.2, v.y * 0.06 - 0.02 * Math.exp(-((v.x / 0.25) ** 2)) * (v.y > 0 ? 1 : 0), v.z * 0.2), 32, 16), M.tongue);
    tongue.position.set(0, MOUTH.y - 0.1, frontZ - 0.32).sub(JAW);
    jaw.add(lowerTeeth, tongue);
    for (const m of [upperTeeth, lowerTeeth, tongue]) m.receiveShadow = true;
    return { parts: [cavity, upperTeeth, jaw], jaw };
}

function buildBody(M) {
    const group = new THREE.Group();
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 1.6, 32, 1, true).scale(1, 1, 0.78), M.neck);
    neck.position.set(-0.09, -1.3, -0.32);   // the portrait's neck sits a little to one side
    const torso = new THREE.Mesh(warpedSphere((v) => v.set(v.x * 2.25, v.y * 1.15, v.z * 1.05), 64, 40), M.shirt);
    torso.position.set(0, -2.68, -0.35);
    for (const m of [neck, torso]) m.castShadow = m.receiveShadow = true;
    group.add(neck, torso);
    return { group, pickables: [neck, torso] };
}

// ---------------------------------------------------------------------------------------------
// Lighting: a small studio baked into an environment map (soft key, orange rims, cool fill)
// plus matching direct lights for crisp highlights and shadows.
// ---------------------------------------------------------------------------------------------

function studioEnvironment(renderer) {
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x0c0d11);
    const panel = (color, intensity, position, w, h) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
        mesh.position.copy(position);
        mesh.lookAt(0, 0, 0);
        studio.add(mesh);
    };
    panel(0xfff1e2, 6, new V3(-4, 4, 6), 5, 5);
    panel(0xff7a2a, 10, new V3(7, 1, -4), 3, 8);
    panel(0xff9a4a, 5, new V3(-7, 0, -4), 3, 8);
    panel(0x8fa6d6, 1.5, new V3(4, -2, 5), 6, 4);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const texture = pmrem.fromScene(studio, 0.04).texture;
    pmrem.dispose();
    return texture;
}

function addLights(scene) {
    const key = new THREE.DirectionalLight(0xfff0e0, 2.2);
    key.position.set(-3, 4, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2.8, right: 2.8, top: 2.8, bottom: -3.2, near: 1, far: 20 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    const rimRight = new THREE.DirectionalLight(0xff8434, 3.5);
    rimRight.position.set(6, 2.5, -4);
    const rimLeft = new THREE.DirectionalLight(0xff9c50, 1.8);
    rimLeft.position.set(-6, 1.5, -3.5);
    scene.add(key, rimRight, rimLeft, new THREE.HemisphereLight(0x8696b8, 0x3a2a22, 0.35));
}

// ---------------------------------------------------------------------------------------------
// Impressionist repaint. The scene is rendered to a texture; an analysis pass finds the local
// stroke direction (along the forms) and how much detail each area holds; the paint pass then
// lays strokes in four sizes, coarse to fine, each picking up the color under its center with a
// little broken-color jitter, cool violet shadows and warm lights. Fine strokes only go where
// there is detail, so the eyes and glasses stay legible while flat areas stay loose.
// ---------------------------------------------------------------------------------------------

const PAINT_COMMON = /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D uScene;
    uniform vec2 uRes;

    vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
    vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
    float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
    }

    // Dusky blue backdrop with a warm glow, after "Impression, Sunrise" (sRGB).
    vec3 backdrop(vec2 uv) {
        vec3 c = mix(vec3(0.13, 0.15, 0.23), vec3(0.24, 0.27, 0.4), uv.y);
        c *= 0.88 + 0.24 * vnoise(uv * vec2(3.0, 7.0));
        vec2 g = (uv - vec2(0.84, 0.66)) * vec2(uRes.x / uRes.y, 1.0);
        c = mix(c, vec3(0.88, 0.5, 0.24), 0.6 * exp(-dot(g, g) * 22.0));
        c += vec3(0.16, 0.07, 0.03) * exp(-dot(g, g) * 4.0);
        return c;
    }

    // The rendered scene over the backdrop, tone mapped, in sRGB.
    vec3 composite(vec2 uv, float lod) {
        vec4 s = textureLod(uScene, uv, lod);
        vec3 subject = s.a > 1e-4 ? toSrgb(aces(s.rgb / s.a)) : vec3(0.0);
        return mix(backdrop(uv), subject, clamp(s.a, 0.0, 1.0));
    }

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const ANALYSIS_SHADER = /* glsl */ `
    ${PAINT_COMMON}
    void main() {
        vec2 o = 6.0 / uRes;
        float tl = luma(composite(vUv + vec2(-o.x, o.y), 2.0)), t = luma(composite(vUv + vec2(0.0, o.y), 2.0)), tr = luma(composite(vUv + o, 2.0));
        float l = luma(composite(vUv - vec2(o.x, 0.0), 2.0)), r = luma(composite(vUv + vec2(o.x, 0.0), 2.0));
        float bl = luma(composite(vUv - o, 2.0)), b = luma(composite(vUv - vec2(0.0, o.y), 2.0)), br = luma(composite(vUv + vec2(o.x, -o.y), 2.0));
        float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
        float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
        float detail = length(composite(vUv, 0.0) - composite(vUv, 3.0));
        gl_FragColor = vec4(gx, gy, detail, textureLod(uScene, vUv, 2.0).a);
    }
`;

const PAINT_SHADER = /* glsl */ `
    ${PAINT_COMMON}
    uniform sampler2D uInfo;

    vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
    }
    vec3 hsv2rgb(vec3 c) {
        vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
        return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
    }

    // Broken color: jitter each stroke's hue, saturation and value, then push shadows towards
    // cool violet-blue and lights towards warm cream.
    vec3 impress(vec3 c, vec3 r, float jitter) {
        vec3 h = rgb2hsv(c);
        h.x = fract(h.x + (r.x - 0.5) * 0.06 * jitter);
        h.y = clamp(h.y * (1.06 + (r.y - 0.5) * 0.3 * jitter), 0.0, 1.0);
        h.z = clamp(h.z * (1.0 + (r.z - 0.5) * 0.16 * jitter), 0.0, 1.0);
        c = hsv2rgb(h);
        float l = luma(c);
        c = mix(c, c * vec3(0.8, 0.86, 1.2) + vec3(0.03, 0.03, 0.07), smoothstep(0.5, 0.08, l) * 0.55);
        c = mix(c, c * vec3(1.05, 1.0, 0.9), smoothstep(0.55, 0.9, l) * 0.45);
        return c;
    }

    vec4 strokes(vec2 px, float cell, float lenK, float widK, float lod, float minDetail, float maxCover, float jitter, float seed) {
        vec2 id0 = floor(px / cell);
        vec4 best = vec4(0.0);
        float bestDepth = -1.0;
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                vec2 id = id0 + vec2(float(i), float(j));
                vec2 r = hash22(id + seed);
                vec2 center = (id + 0.1 + 0.8 * r) * cell;
                vec2 cuv = center / uRes;
                vec4 info = texture2D(uInfo, cuv);
                if (info.z < minDetail || info.w > maxCover) continue;
                // Strokes follow the forms (along the contours of the light); where the light is
                // flat they follow a slow flow field, lying almost level across the backdrop.
                float flow = mix(0.1 + (vnoise(cuv * 3.0) - 0.5) * 0.5, 0.7 + (vnoise(cuv * 5.0 + 7.0) - 0.5) * 1.2, info.w);
                vec2 along = vec2(-info.y, info.x);
                float g = smoothstep(0.004, 0.03, length(info.xy));
                vec2 dir0 = normalize(mix(vec2(cos(flow), sin(flow)), normalize(along + 1e-6) * sign(along.x + 1e-6), g));
                float ang = atan(dir0.y, dir0.x) + (hash12(id + seed + 5.0) - 0.5) * 0.5 * jitter;
                vec2 dir = vec2(cos(ang), sin(ang));
                vec2 d = px - center;
                float s = dot(d, dir), t = dot(d, vec2(-dir.y, dir.x));
                float L = cell * lenK * (0.75 + 0.5 * r.x), W = cell * widK * (0.75 + 0.5 * r.y);
                t += s * s / L * 0.25 * (r.x - 0.5);
                float sl = s / L, wt = W * (1.0 - 0.45 * sl * sl);
                float e = sl * sl + (t * t) / (wt * wt);
                if (e >= 1.0) continue;
                float depth = hash12(id + seed + 11.0);
                if (depth < bestDepth) continue;
                bestDepth = depth;
                vec3 c = impress(composite(cuv, lod), hash32(id + seed), jitter);
                c *= 1.0 + 0.1 * jitter * (vnoise(vec2(t / W * 5.0, sl * 1.2) + id * 1.7) - 0.5);   // bristle streaks
                best = vec4(c, 1.0 - smoothstep(0.65, 1.0, e));
            }
        }
        return best;
    }

    void main() {
        vec2 px = vUv * uRes;
        float H = uRes.y;
        vec3 col = impress(composite(vUv, 4.0), vec3(0.5), 0.0);   // underpainting
        // Broad strokes for the backdrop only; the figure starts one size down.
        vec4 s = strokes(px, H * 0.04, 1.6, 0.5, 3.2, 0.0, 0.5, 1.0, 1.0);
        col = mix(col, s.rgb, s.a);
        s = strokes(px, H * 0.024, 1.5, 0.45, 2.0, 0.0, 1.0, 0.75, 17.0);
        col = mix(col, s.rgb, s.a);
        s = strokes(px, H * 0.014, 1.4, 0.42, 1.0, 0.012, 1.0, 0.55, 31.0);
        col = mix(col, s.rgb, s.a);
        s = strokes(px, H * 0.0085, 1.3, 0.42, 0.3, 0.02, 1.0, 0.35, 47.0);
        col = mix(col, s.rgb, s.a);
        s = strokes(px, H * 0.0045, 1.2, 0.45, 0.3, 0.05, 1.0, 0.2, 59.0);
        col = mix(col, s.rgb, s.a);
        col *= 0.975 + 0.025 * sin(px.x * 1.9) * sin(px.y * 1.9) + 0.03 * (hash12(floor(px)) - 0.5);   // canvas
        gl_FragColor = vec4(col, 1.0);
    }
`;

function createPainter(renderer) {
    const hdr = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    if (!hdr) return null;
    const sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    const infoTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const uniforms = { uScene: { value: sceneTarget.texture }, uInfo: { value: infoTarget.texture }, uRes: { value: new THREE.Vector2(1, 1) } };
    const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const pass = (fragmentShader) => {
        const scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false })));
        return scene;
    };
    const analysis = pass(ANALYSIS_SHADER), paint = pass(PAINT_SHADER), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return {
        setSize(w, h) {
            sceneTarget.setSize(w, h);
            infoTarget.setSize(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)));
            uniforms.uRes.value.set(w, h);
        },
        render(scene, sceneCamera) {
            renderer.setRenderTarget(sceneTarget);
            renderer.render(scene, sceneCamera);
            renderer.setRenderTarget(infoTarget);
            renderer.render(analysis, camera);
            renderer.setRenderTarget(null);
            renderer.render(paint, camera);
        },
    };
}

// ---------------------------------------------------------------------------------------------
// Sprites for reactions (hearts, dizzy stars, an anger mark), drawn once into canvases.
// ---------------------------------------------------------------------------------------------

function spriteTexture(draw) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e1816';
    draw(ctx);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

const SPRITES = {
    heart: () => spriteTexture((ctx) => {
        ctx.beginPath();
        ctx.moveTo(64, 108);
        ctx.bezierCurveTo(8, 72, 14, 18, 64, 38);
        ctx.bezierCurveTo(114, 18, 120, 72, 64, 108);
        ctx.fillStyle = COLORS.heart;
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.stroke();
    }),
    star: () => spriteTexture((ctx) => {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            const r = i % 2 ? 22 : 54, a = (i / 10) * Math.PI * 2 - Math.PI / 2;
            ctx.lineTo(64 + r * Math.cos(a), 66 + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fillStyle = COLORS.star;
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.stroke();
    }),
    anger: () => spriteTexture((ctx) => {
        ctx.strokeStyle = COLORS.anger;
        ctx.lineWidth = 13;
        for (let i = 0; i < 4; i++) {
            ctx.save();
            ctx.translate(64, 64);
            ctx.rotate((i * Math.PI) / 2);
            ctx.beginPath();
            ctx.moveTo(14, -44);
            ctx.quadraticCurveTo(14, -14, 44, -14);
            ctx.stroke();
            ctx.restore();
        }
    }),
};

// ---------------------------------------------------------------------------------------------
// Expressions and reactions
// ---------------------------------------------------------------------------------------------

// Head morph weights, plus lid angles: the front of a lid's rim sits at y = -sin(angle) * radius,
// so a negative angle raises it. The eyes are closed when upper == lower.
const BASE = { jawOpen: 0, smile: 0, frown: 0, pucker: 0, browUp: 0, browAngry: 0, upper: -0.38, lower: 0.38, wink: 0, blush: 0 };
const IDLE = { ...BASE, smile: 0.12 };
const EXPRESSIONS = {
    idle: IDLE,
    surprise: { ...BASE, jawOpen: 0.35, pucker: 0.45, browUp: 1, upper: -0.95, lower: 0.5, blush: 0.2 },
    laugh: { ...BASE, jawOpen: 0.45, smile: 1, browUp: 0.3, upper: -0.2, lower: -0.05, blush: 0.8 },
    wink: { ...BASE, smile: 0.8, wink: 1, browUp: 0.15, blush: 0.4 },
    shy: { ...BASE, smile: 0.55, upper: -0.32, lower: 0.15, browUp: 0.35, blush: 1 },
    content: { ...BASE, smile: 0.6, upper: -0.4, lower: 0.25, blush: 0.2 },
    boop: { ...BASE, pucker: 0.6, jawOpen: 0.12, browUp: 0.7, upper: -0.8, lower: 0.5, blush: 0.5 },
    grumpy: { ...BASE, frown: 1, browAngry: 1, upper: -0.35, lower: 0.25 },
    dizzy: { ...BASE, jawOpen: 0.25, frown: 0.4, browUp: 0.6, upper: -0.7, lower: 0.55 },
    hmph: { ...BASE, frown: 0.8, browAngry: 0.6, upper: 0.35, lower: 0.35, blush: 0.3 },
};

class Spring {
    constructor(stiffness, damping) { this.k = stiffness; this.c = damping; this.x = 0; this.v = 0; }
    step(dt) {
        // Sub-step so stiff springs stay stable at low frame rates.
        const n = Math.ceil(dt / (1 / 120));
        for (let i = 0; i < n; i++) {
            this.v += (-this.k * this.x - this.c * this.v) * (dt / n);
            this.x += this.v * (dt / n);
        }
        return this.x;
    }
}

// ---------------------------------------------------------------------------------------------
// Scene assembly and runtime
// ---------------------------------------------------------------------------------------------

async function init(mounts) {
    let portrait = null;
    try {
        portrait = await new THREE.TextureLoader().loadAsync(PORTRAIT.face.url);
        portrait.colorSpace = THREE.SRGBColorSpace;
        portrait.anisotropy = 4;
    } catch (err) {
        console.warn('3D avatar: portrait texture unavailable, using plain colors:', err);
    }
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'button');
    canvas.setAttribute('aria-label', 'Interactive 3D painted portrait. Press Enter to poke it.');
    const painter = OPTIONS.painterly ? createPainter(renderer) : null;

    const scene = new THREE.Scene();
    scene.environment = studioEnvironment(renderer);
    scene.environmentIntensity = 0.55;
    addLights(scene);
    const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 60);
    const M = makeMaterials(portrait);

    // Hierarchy: avatar > body, and avatar > headPivot (at the top of the neck) > head (centered
    // on the eye line) so head turns rotate about the neck.
    const avatar = new THREE.Group();
    const body = buildBody(M);
    const headPivot = new THREE.Group();
    headPivot.position.copy(NECK_PIVOT);
    headPivot.rotation.order = 'YXZ';
    const head = new THREE.Group();
    head.position.copy(NECK_PIVOT).negate();
    headPivot.add(head);
    avatar.add(body.group, headPivot);
    scene.add(avatar);

    const face = new THREE.Mesh(buildHeadGeometry(true), M.face);
    face.castShadow = face.receiveShadow = true;
    head.add(face);
    const mouthParts = buildMouthInterior(M);
    head.add(...mouthParts.parts);
    const ears = [-1, 1].map((side) => {
        const ear = new THREE.Mesh(earGeometry(), M.ear);
        ear.position.set(side * 1.04, -0.17, -0.17);
        ear.rotation.y = side > 0 ? -0.5 : Math.PI - 0.5;
        ear.castShadow = ear.receiveShadow = true;
        head.add(ear);
        return ear;
    });
    const eyes = [-1, 1].map((side) => buildEye(side, M));
    eyes.forEach((e) => head.add(e.root));
    const glasses = buildGlasses(M);
    head.add(glasses);

    // The hair hangs from a pivot at the crown so it can sway a little.
    const CROWN = new V3(0, HEAD_TOP, -0.3);
    const hairPivot = new THREE.Group();
    hairPivot.position.copy(CROWN);
    const hair = new THREE.Group();
    hair.position.copy(CROWN).negate();
    const shell = new THREE.Mesh(hairShellGeometry(true), M.hair);
    const strands = new THREE.Mesh(hairStrandsGeometry(), M.hair);
    for (const m of [shell, strands]) m.castShadow = m.receiveShadow = true;
    hair.add(shell, strands);
    hairPivot.add(hair);
    head.add(hairPivot);

    // Project the portrait onto everything that wears it, in the rest pose.
    if (portrait) {
        for (const eye of eyes) {
            eye.upper.rotation.x = eye.restUpper;
            eye.lower.rotation.x = eye.restLower;
        }
        projectPortrait(ears[1], 1);   // the ear the portrait shows edge-on wears its mirror image
        [ears[0], shell, strands, ...eyes.flatMap((e) => [e.upper, e.lower]), ...body.group.children].forEach((m) => projectPortrait(m));
    }
    // The ears follow the slimmed cheeks in (after taking their texture from where they were).
    for (const ear of ears) ear.position.x += slimOffset(ear.position.x, ear.position.y);

    // Clicks are resolved against cheap, static stand-ins rather than the morphing meshes.
    const proxy = (geometry, region, parent) => {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
        mesh.visible = false;
        mesh.userData.region = region;
        parent.add(mesh);
        return mesh;
    };
    const pickables = [
        proxy(buildHeadGeometry(false), 'face', head),
        proxy(hairShellGeometry(false), 'hair', hair),
        ...ears.map((ear) => Object.assign(ear, { userData: { region: 'face' } })),
        ...body.pickables.map((m) => Object.assign(m, { userData: { region: 'body' } })),
    ];
    glasses.traverse((o) => { if (o.isMesh) { o.userData.region = 'glasses'; pickables.push(o); } });

    const textures = Object.fromEntries(Object.entries(SPRITES).map(([name, make]) => [name, make()]));

    // ----- state -----
    let mount = null, framing = FRAMING.bust, running = false, visible = true, firstFrame = true;
    let time = 0, last = performance.now();
    const expr = { ...IDLE };
    let goal = IDLE;
    const springs = {
        yaw: new Spring(110, 9), pitch: new Spring(110, 9), roll: new Spring(110, 9), push: new Spring(160, 12), squash: new Spring(220, 10),
        hairX: new Spring(90, 7), hairY: new Spring(90, 7), hairZ: new Spring(90, 7), glassesY: new Spring(260, 9), glassesTilt: new Spring(200, 8),
    };
    const follow = { yaw: 0, pitch: 0 };
    const override = { yaw: 0, pitch: 0, roll: 0 };
    const prevHead = { yaw: 0, pitch: 0, roll: 0 };
    const gaze = new V3(0, 0, 12), headGaze = new V3(0, 0, 12), desired = new V3();
    const pointer = { x: 0, y: 0, has: false, lastMove: -1e9, touch: false };
    let saccade = new V3(), nextSaccade = 0;
    let blinkStart = -1, nextBlink = rand(1.5, 4);
    let sequence = [], step = null, stepTime = 0, locked = false;
    const pokes = [];
    let pokeVariant = 0;
    const particles = [];
    const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new V3();
    const noseTip = new V3(0, -0.41, faceZ(0, -0.41));

    // ----- reactions -----
    function play(steps, lock = false) {
        sequence = steps.slice();
        locked = lock;
        nextStep();
    }
    function nextStep() {
        step = sequence.shift() || null;
        stepTime = 0;
        goal = step ? EXPRESSIONS[step.expr] : IDLE;
        if (step && step.enter) step.enter();
        if (!step) locked = false;
    }

    function spawn(texture, parent, position, { life = 1.2, size = 0.3, velocity = new V3(0, 1.1, 0), orbit = null } = {}) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: textures[texture], transparent: true, depthWrite: false }));
        sprite.position.copy(position);
        sprite.renderOrder = 10;
        parent.add(sprite);
        particles.push({ sprite, parent, life, age: 0, size, velocity, orbit });
    }

    function hearts(count, origin) {
        for (let i = 0; i < count; i++) {
            const p = origin.clone().add(new V3(rand(-0.35, 0.35), rand(-0.05, 0.2), 0.3));
            spawn('heart', scene, p, { life: rand(1.0, 1.4), size: rand(0.24, 0.34), velocity: new V3(rand(-0.3, 0.3), rand(1.0, 1.4), 0) });
        }
    }

    function knock(local, strength) {
        const k = REDUCED_MOTION ? 0.3 : 1;
        springs.yaw.v += local.x * 1.2 * strength * k;
        springs.pitch.v -= local.y * 2.0 * strength * k;
        springs.roll.v += rand(-0.5, 0.5) * strength * k;
        springs.push.v -= 1.4 * strength * k;
        springs.squash.v += 1.2 * strength * k;
        springs.hairZ.v += rand(-0.4, 0.4) * strength * k;
    }

    const headWorld = (x, y, z) => head.localToWorld(new V3(x, y, z));

    const REACTIONS = {
        face(local) {
            knock(local, 1);
            const variant = pokeVariant++ % 3;
            if (variant === 0) play([{ expr: 'surprise', dur: 0.3 }, { expr: 'laugh', dur: 1.1 }]);
            else if (variant === 1) {
                play([{ expr: 'wink', dur: 1.2 }]);
                hearts(1, headWorld(0.8, 1.2, 0.8));
            } else play([{ expr: 'surprise', dur: 0.2 }, { expr: 'shy', dur: 1.3 }]);
        },
        nose(local) {
            knock(local, 0.5);
            play([{ expr: 'boop', dur: 0.85, gaze: 'nose' }, { expr: 'laugh', dur: 0.9 }]);
            hearts(3, headWorld(0, 1.0, 1.0));
        },
        hair(local) {
            knock(local, 0.35);
            springs.hairZ.v += (local.x >= 0 ? -1 : 1) * 0.8;
            springs.hairX.v -= 0.5;
            play([{ expr: 'grumpy', dur: 1.3, gaze: 'up' }]);
        },
        glasses(local) {
            knock(local, 0.3);
            springs.glassesY.v += 1.6;
            springs.glassesTilt.v += (local.x >= 0 ? 1 : -1) * 2.5;
            play([{ expr: 'surprise', dur: 0.2 }, { expr: 'content', dur: 1.0 }]);
        },
        body(local, point) {
            play([{ expr: 'shy', dur: 1.2, gaze: point.clone() }]);
        },
    };

    function dizzy() {
        pokes.length = 0;
        play([
            {
                expr: 'dizzy', dur: 1.9, gaze: 'spin', head: 'wobble',
                enter: () => {
                    for (let i = 0; i < 3; i++) spawn('star', head, new V3(), { life: 1.9, size: 0.28, orbit: { phase: (i / 3) * Math.PI * 2 } });
                },
            },
            {
                expr: 'hmph', dur: 1.6, head: 'away',
                enter: () => spawn('anger', head, new V3(1.0, 1.7, 0.8), { life: 1.6, size: 0.52, velocity: new V3() }),
            },
        ], true);
    }

    function poke(region, local, point) {
        if (locked) return;
        document.querySelectorAll('.avatar3d-hint').forEach((el) => el.classList.add('avatar3d-hint-done'));
        pokes.push(time);
        while (pokes.length && time - pokes[0] > 3) pokes.shift();
        if (pokes.length >= 6 && region !== 'body') return dizzy();
        REACTIONS[region](local, point);
    }

    // ----- input -----
    function setNdc(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    }

    function pick(clientX, clientY) {
        setNdc(clientX, clientY);
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObjects(pickables, false)[0];
        if (!hit) return null;
        const local = head.worldToLocal(hit.point.clone());
        let region = hit.object.userData.region;
        if (region === 'face' && Math.abs(local.x) < 0.3 && local.y > -0.6 && local.y < 0.1 && local.z > 0.8) region = 'nose';
        return { region, local, point: hit.point };
    }

    const track = (e) => {
        pointer.x = e.clientX; pointer.y = e.clientY;
        pointer.has = true; pointer.lastMove = time; pointer.touch = e.pointerType !== 'mouse';
    };
    window.addEventListener('pointermove', track, { passive: true });
    window.addEventListener('pointerdown', track, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { pointer.has = false; });
    window.addEventListener('blur', () => { pointer.has = false; });

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse') canvas.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : '';
    });
    canvas.addEventListener('pointerleave', () => { canvas.style.cursor = ''; });
    canvas.addEventListener('pointerdown', (e) => {
        const hit = pick(e.clientX, e.clientY);
        if (hit) poke(hit.region, hit.local, hit.point);
    });
    canvas.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        poke('face', new V3(rand(-0.6, 0.6), rand(-0.6, 0.4), 0.8), new V3());
    });

    // ----- per-frame updates -----
    function cursorTarget(out) {
        setNdc(pointer.x, pointer.y);
        raycaster.setFromCamera(ndc, camera);
        const ray = raycaster.ray;
        return out.copy(ray.origin).addScaledVector(ray.direction, (LOOK_PLANE_Z - ray.origin.z) / ray.direction.z);
    }

    function updateGaze(dt) {
        const cursorActive = pointer.has && time - pointer.lastMove < (pointer.touch ? 2.5 : 6);
        const g = step && step.gaze;
        if (g === 'nose') desired.copy(head.localToWorld(tmp.copy(noseTip))).add(new V3(0, 0, 0.1));
        else if (g === 'up') desired.copy(headWorld(0, 4, 2));
        else if (g instanceof V3) desired.copy(g);
        else if (cursorActive) cursorTarget(desired);
        else {
            // Nobody is pointing at anything: mostly look at the viewer with the odd glance away.
            if (time > nextSaccade) {
                saccade = Math.random() < 0.55 ? new V3() : new V3(rand(-1.5, 1.5), rand(-0.8, 0.9), 0);
                nextSaccade = time + rand(1.2, 3.5);
            }
            desired.copy(camera.position).add(saccade);
        }
        gaze.x = damp(gaze.x, desired.x, 22, dt); gaze.y = damp(gaze.y, desired.y, 22, dt); gaze.z = damp(gaze.z, desired.z, 22, dt);
        headGaze.x = damp(headGaze.x, desired.x, 4, dt); headGaze.y = damp(headGaze.y, desired.y, 4, dt); headGaze.z = damp(headGaze.z, desired.z, 4, dt);
    }

    function updateExpression(dt) {
        for (const k in expr) expr[k] = damp(expr[k], goal[k], k === 'blush' ? 5 : 14, dt);

        // Blinking: the upper lid drops onto the lower one.
        if (time > nextBlink && blinkStart < 0) blinkStart = time;
        let blink = 0;
        if (blinkStart >= 0) {
            const t = (time - blinkStart) / 0.16;
            if (t >= 1) {
                blinkStart = -1;
                nextBlink = time + (Math.random() < 0.2 ? 0.25 : rand(2, 5.5));
            } else blink = Math.sin(Math.PI * t);
        }

        HEAD_MORPHS.forEach((name, i) => { face.morphTargetInfluences[i] = expr[name]; });
        mouthParts.jaw.rotation.x = JAW_OPEN * expr.jawOpen;
        for (const eye of eyes) {
            const wink = eye.side > 0 ? expr.wink : 0;
            const lower = lerp(eye.restLower + expr.lower - BASE.lower, 0.0, wink);
            const upper = lerp(eye.restUpper + expr.upper - BASE.upper, 0.0, wink);
            eye.upper.rotation.x = lerp(upper, lower, blink);
            eye.lower.rotation.x = lower;
        }
        blushUniform.value = clamp(expr.blush, 0, 1);
    }

    function updateHead(dt) {
        // Follow the (slow) gaze target with part of the angle.
        const yaw = Math.atan2(headGaze.x, headGaze.z), pitch = Math.atan2(-headGaze.y, Math.hypot(headGaze.x, headGaze.z));
        const followAmount = step && step.head === 'away' ? 0 : HEAD_FOLLOW;
        follow.yaw = damp(follow.yaw, clamp(yaw * followAmount, -MAX_HEAD.left, MAX_HEAD.right), 6, dt);
        follow.pitch = damp(follow.pitch, clamp(pitch * followAmount, -MAX_HEAD.pitch, MAX_HEAD.pitch), 6, dt);

        let oy = 0, op = 0, or = 0;
        const amp = REDUCED_MOTION ? 0.25 : 1;
        if (step && step.head === 'wobble') {
            or = 0.12 * amp * Math.sin(time * 7);
            op = 0.07 * amp * Math.cos(time * 7);
        } else if (step && step.head === 'away') {
            oy = 0.2;
            op = -0.12;
        }
        override.yaw = damp(override.yaw, oy, 7, dt);
        override.pitch = damp(override.pitch, op, 7, dt);
        override.roll = damp(override.roll, or, 10, dt);

        for (const s of Object.values(springs)) s.step(dt);
        const idle = REDUCED_MOTION ? 0 : 1;
        const rot = {
            yaw: follow.yaw + override.yaw + springs.yaw.x,
            pitch: follow.pitch + override.pitch + springs.pitch.x + idle * 0.012 * Math.sin(time * 1.7 - 0.6),
            roll: override.roll + springs.roll.x + idle * 0.02 * Math.sin(time * 0.7) - follow.yaw * 0.1,
        };
        headPivot.rotation.set(rot.pitch, rot.yaw, rot.roll);
        head.position.z = -NECK_PIVOT.z + springs.push.x * 0.4;
        const sq = springs.squash.x * 0.25;
        head.scale.set(1 + sq, 1 - sq, 1 + sq);
        avatar.position.y = idle * 0.015 * Math.sin(time * 1.7);
        body.group.rotation.y = rot.yaw * 0.15;

        // Hair lags behind head motion, then springs back.
        springs.hairY.v -= (rot.yaw - prevHead.yaw) * 1.5;
        springs.hairX.v -= (rot.pitch - prevHead.pitch) * 1.5;
        springs.hairZ.v -= (rot.roll - prevHead.roll) * 1.5;
        Object.assign(prevHead, rot);
        hairPivot.rotation.set(clamp(springs.hairX.x, -0.06, 0.06), clamp(springs.hairY.x, -0.06, 0.06), clamp(springs.hairZ.x, -0.06, 0.06));
        glasses.position.y = springs.glassesY.x * 0.6;
        glasses.rotation.z = springs.glassesTilt.x * 0.3;
    }

    function updateEyes(dt) {
        const spin = step && step.gaze === 'spin';
        const crossed = step && step.gaze === 'nose';
        for (const eye of eyes) {
            let yaw, pitch;
            if (spin) {
                const a = time * 9 * eye.side;
                yaw = 0.38 * Math.cos(a);
                pitch = 0.28 * Math.sin(a);
            } else {
                eye.root.worldToLocal(tmp.copy(gaze));
                yaw = Math.atan2(tmp.x, tmp.z);
                pitch = Math.atan2(-tmp.y, Math.hypot(tmp.x, tmp.z));
            }
            // Keep the iris inside an elliptical range (wider when going cross-eyed).
            const range = crossed ? 1.25 : 1;
            const r = Math.hypot(yaw / (MAX_EYE.yaw * range), pitch / (MAX_EYE.pitch * range));
            if (r > 1) { yaw /= r; pitch /= r; }
            eye.yaw = damp(eye.yaw, yaw, 25, dt);
            eye.pitch = damp(eye.pitch, pitch, 25, dt);
            eye.pivot.rotation.set(eye.pitch, eye.yaw, 0);
            eye.rootInverse.copy(eye.root.matrixWorld).invert();
        }
    }

    function updateParticles(dt) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.age += dt;
            const t = p.age / p.life;
            if (t >= 1) {
                p.parent.remove(p.sprite);
                p.sprite.material.dispose();
                particles.splice(i, 1);
                continue;
            }
            if (p.orbit) {
                const a = time * 4 + p.orbit.phase;
                p.sprite.position.set(1.05 * Math.cos(a), 2.02 + 0.06 * Math.sin(a * 2), 1.05 * Math.sin(a));
            } else {
                p.sprite.position.addScaledVector(p.velocity, dt);
            }
            const pop = Math.min(1, t / 0.15);
            p.sprite.scale.setScalar(p.size * (0.6 + 0.4 * pop) * (p.orbit ? 1 : 1 + 0.25 * Math.sin(time * 10) * (1 - t)));
            p.sprite.material.opacity = Math.min(pop, (1 - t) / 0.3, 1);
        }
    }

    function frame(now) {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        time += dt;
        if (step) {
            stepTime += dt;
            if (stepTime >= step.dur) nextStep();
        }
        updateGaze(dt);
        updateExpression(dt);
        updateHead(dt);
        updateParticles(dt);
        scene.updateMatrixWorld();
        updateEyes(dt);
        if (painter) painter.render(scene, camera);
        else renderer.render(scene, camera);
        if (firstFrame) {
            firstFrame = false;
            mount.classList.add('avatar3d-ready');
        }
    }

    // ----- mounting, sizing and visibility -----
    function resize() {
        const w = mount.clientWidth, h = mount.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        if (painter) {
            const size = renderer.getDrawingBufferSize(new THREE.Vector2());
            painter.setSize(size.x, size.y);
        }
        camera.aspect = w / h;
        camera.position.copy(framing.target).add(new V3(0, 0.15, framing.distance));
        camera.lookAt(framing.target);
        camera.updateProjectionMatrix();
    }

    function remount() {
        const next = mounts.find((m) => m.offsetParent !== null && m.clientWidth > 0);
        if (next && next !== mount) {
            if (mount) mount.classList.remove('avatar3d-ready');
            mount = next;
            framing = FRAMING[mount.dataset.avatar3d] || FRAMING.bust;
            mount.appendChild(canvas);
            firstFrame = true;
        }
        if (mount) resize();
        updateLoop();
    }

    function updateLoop() {
        const shouldRun = !!mount && visible && document.visibilityState === 'visible';
        if (shouldRun === running) return;
        running = shouldRun;
        last = performance.now();
        renderer.setAnimationLoop(running ? frame : null);
    }

    const resizeObserver = new ResizeObserver(remount);
    mounts.forEach((m) => resizeObserver.observe(m));
    new IntersectionObserver((entries) => {
        visible = entries.some((e) => e.isIntersecting);
        updateLoop();
    }).observe(canvas);
    document.addEventListener('visibilitychange', updateLoop);
    canvas.addEventListener('webglcontextlost', () => {
        if (mount) mount.classList.remove('avatar3d-ready');
        renderer.setAnimationLoop(null);
    });

    remount();
}

// Building the scene takes a few hundred milliseconds, so wait until the page has settled; the
// static portrait shows in the meantime.
const mounts = [...document.querySelectorAll('[data-avatar3d]')];
if (mounts.length) {
    // Without WebGL the static portrait stays visible.
    const start = () => init(mounts).catch((err) => console.warn('3D avatar disabled:', err));
    if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 1500 });
    else setTimeout(start, 200);
}

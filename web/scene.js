// The stage: an Echo Show with a coin slot, flagged orders as holographic
// coins on ledger paper, and a receipt that prints the answer.
// Knows nothing about MCP; app.js feeds it data.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const C = { ledger: 0xBFE9B0, ink: 0x14251B, body: 0x1E2433, alexa: 0x05A0D1, rule: 0xE2354B };
const FLOOR = -1.6, EX = -1.75, EY = -.15, SLOT_Y = EY + 1.0;
const FACE_TILT = Math.PI / 2 - .2; // coin faces lean up toward the camera
const HOMES = [[2.55, 1.0, .7], [4.4, 1.55, -.8], [4.45, -.45, .4], [2.35, -1.05, 1.75],
               [-4.35, 1.45, -.6], [-4.55, .1, -.3]];
export const FLOATING = HOMES.length; // coins in the air; the rest wait in the jar
const JX = -3.75, JZ = 1.75, JR = .72, JH = 1.45, JAR_S = .42; // the jar, and coin size inside it
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

export async function createStage(canvasHost, { onFeed, onPour }) {
  await Promise.all([
    document.fonts.load('900 120px "Big Shoulders Display"'), document.fonts.load('700 60px "Big Shoulders Display"'),
    document.fonts.load('600 30px "Instrument Sans"'), document.fonts.load('400 30px "Instrument Sans"'),
    document.fonts.load('400 30px "Sometype Mono"'), document.fonts.load('700 30px "Sometype Mono"'),
  ]);

  // ---- renderer, camera, light ------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  canvasHost.prepend(renderer.domElement);
  renderer.domElement.setAttribute("aria-hidden", "true");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.ledger);
  scene.fog = new THREE.Fog(C.ledger, 13, 30);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), .04).texture;
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 100);
  const CAM = new THREE.Vector3(0, 3.0, 11.5);
  function fit() {
    camera.aspect = innerWidth / innerHeight;
    CAM.z = 11.5 * Math.max(1, 1.55 / camera.aspect); // step back on narrow screens
    camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
  }
  fit(); addEventListener("resize", fit);
  scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x6E8F6A, 1.2));
  const key = new THREE.DirectionalLight(0xFFFFFF, 2.4); key.position.set(-3, 6, 6); scene.add(key);

  // three flat tones: drawn, not rendered
  const ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]), 3, 1);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
  const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...extra });
  const inkMat = new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.BackSide });
  function inked(mesh, t = .035) { // a back-face shell = an ink outline
    const o = new THREE.Mesh(mesh.geometry, inkMat);
    o.scale.setScalar(1 + t); o.raycast = () => {}; mesh.add(o); return mesh;
  }
  const canvas = (w, h) => { const c = Object.assign(document.createElement("canvas"), { width: w, height: h }); return [c, c.getContext("2d")]; };
  const texture = (c, extra = {}) => Object.assign(new THREE.CanvasTexture(c), { colorSpace: THREE.SRGBColorSpace, ...extra });

  // ---- ledger-paper floor --------------------------------------------------------
  {
    const [c, x] = canvas(128, 128);
    x.fillStyle = "#BFE9B0"; x.fillRect(0, 0, 128, 128);
    x.fillStyle = "rgba(20,37,27,.38)"; x.fillRect(0, 0, 128, 3); x.fillRect(0, 0, 3, 128);
    const t = texture(c, { anisotropy: renderer.capabilities.getMaxAnisotropy() });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(64, 64);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ map: t }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; scene.add(floor);
    for (const xr of [-5.55, -5.45]) { // the red double rule down the ledger's margin
      const r = new THREE.Mesh(new THREE.PlaneGeometry(.05, 80), new THREE.MeshBasicMaterial({ color: C.rule }));
      r.rotation.x = -Math.PI / 2; r.position.set(xr, FLOOR + .002, 0); scene.add(r);
    }
  }
  const blobTex = (() => {
    const [c, x] = canvas(128, 128), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(20,37,27,.55)"); g.addColorStop(.6, "rgba(20,37,27,.25)"); g.addColorStop(1, "rgba(20,37,27,0)");
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
  })();
  function blob(w, d) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = FLOOR + .01; scene.add(m); return m;
  }

  // ---- the Echo Show, with a coin slot on top -----------------------------------
  const device = new THREE.Group(); device.position.set(EX, EY, 0); scene.add(device);
  device.add(inked(new THREE.Mesh(new RoundedBoxGeometry(3.1, 2.0, .36, 6, .16), toon(C.body)), .025));
  {
    const [c, x] = canvas(256, 256); // the speaker fabric, drawn as hatching
    x.fillStyle = "#2B3247"; x.fillRect(0, 0, 256, 256); x.strokeStyle = "#11151F"; x.lineWidth = 7;
    for (let i = -256; i < 512; i += 22) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 256, 256); x.stroke(); }
    const t = texture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 1.2);
    const base = inked(new THREE.Mesh(new RoundedBoxGeometry(3.1, .8, 1.1, 6, .28), toon(0xFFFFFF, { map: t })), .025);
    base.position.set(0, -1.05, -.6); device.add(base);
  }
  const slotMat = new THREE.MeshBasicMaterial({ color: 0x05070C });
  const slot = new THREE.Mesh(new RoundedBoxGeometry(1.25, .05, .16, 2, .02), slotMat);
  slot.position.set(0, 1.0, 0); device.add(slot);
  blob(4.6, 2.4).position.set(EX, FLOOR + .01, -.3);

  const [screenCanvas, sctx] = canvas(1280, 800);
  const screenTex = texture(screenCanvas, { anisotropy: 8 });
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.82, 1.76), new THREE.MeshBasicMaterial({ map: screenTex }));
  screenMesh.position.z = .185; device.add(screenMesh);

  const screen = { mode: "idle", head: "", sub: "", accent: "#FF3D7F", heard: "", ask: "" };
  function fitFont(s, text, weight, size, family, max) {
    s.font = `${weight} ${size}px ${family}`;
    while (s.measureText(text).width > max && size > 20) { size -= 6; s.font = `${weight} ${size}px ${family}`; }
  }
  function wrap(s, text, x, y, max, lh) {
    let line = "";
    for (const w of text.split(" ")) {
      if (line && s.measureText(line + w).width > max) { s.fillText(line, x, y); line = ""; y += lh; }
      line += w + " ";
    }
    s.fillText(line, x, y); return y;
  }
  function drawScreen(t) {
    const W = 1280, H = 800, s = sctx;
    s.fillStyle = "#10141C"; s.fillRect(0, 0, W, H); s.textAlign = "left";
    if (screen.ask) { s.fillStyle = "#8C97B8"; fitFont(s, screen.ask, 400, 44, '"Instrument Sans"', 1120); s.fillText(screen.ask, 80, 120); }
    if (screen.mode === "idle") {
      s.fillStyle = "#FFFFFF"; s.font = '900 150px "Big Shoulders Display"';
      s.fillText("Coin in.", 80, 380); s.fillText("Answer out.", 80, 520);
    } else if (screen.mode === "listening") {
      s.fillStyle = "#FFFFFF"; s.font = '900 110px "Big Shoulders Display"';
      wrap(s, screen.heard || "Listening…", 80, 330, 1100, 112);
    } else if (screen.mode === "thinking") {
      for (let i = 0; i < 3; i++) {
        const a = .35 + .65 * Math.max(0, Math.sin(t * 6 - i * .8));
        s.fillStyle = `rgba(5,160,209,${a})`; s.beginPath(); s.arc(560 + i * 80, 420, 24, 0, 7); s.fill();
      }
    } else if (screen.mode === "error") {
      s.fillStyle = "#FFFFFF"; s.font = '900 120px "Big Shoulders Display"'; s.fillText(screen.head, 80, 360);
      s.fillStyle = "#C9D1EA"; s.font = '600 46px "Instrument Sans"'; wrap(s, screen.sub, 84, 450, 1100, 60);
    } else {
      s.fillStyle = screen.accent; s.beginPath(); s.roundRect(80, 236, 24, 250, 12); s.fill();
      s.fillStyle = "#FFFFFF"; fitFont(s, screen.head, 900, 200, '"Big Shoulders Display"', 1060); s.fillText(screen.head, 140, 400);
      s.fillStyle = "#C9D1EA"; fitFont(s, screen.sub, 600, 52, '"Instrument Sans"', 1060); s.fillText(screen.sub, 144, 480);
    }
    s.fillStyle = "#05A0D1"; s.fillRect(0, H - 28, W, 28);
    if (screen.mode === "thinking" || screen.mode === "listening") {
      const x = ((t * 900) % (W + 600)) - 300, g = s.createLinearGradient(x - 300, 0, x + 300, 0);
      g.addColorStop(0, "rgba(190,240,255,0)"); g.addColorStop(.5, "rgba(230,252,255,1)"); g.addColorStop(1, "rgba(190,240,255,0)");
      s.fillStyle = g; s.fillRect(0, H - 28, W, 28);
    }
    screenTex.needsUpdate = true;
  }

  // ---- tiny tween engine (on the animation clock) -----------------------------------
  const ease = {
    back: p => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); },
    out: p => 1 - Math.pow(1 - p, 3),
    in: p => p * p * p,
  };
  const tweens = [];
  let now = 0;
  function to(obj, target, dur, e = ease.back, delay = 0) {
    return new Promise(res => tweens.push({ obj, target, dur: still ? .001 : dur, e, start: now + (still ? 0 : delay), from: null, res }));
  }
  function runTweens() {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (now < tw.start) continue;
      if (!tw.from) tw.from = Object.fromEntries(Object.keys(tw.target).map(k => [k, tw.obj[k]]));
      const p = Math.min((now - tw.start) / tw.dur, 1), v = tw.e(p);
      for (const k in tw.target) tw.obj[k] = tw.from[k] + (tw.target[k] - tw.from[k]) * v;
      if (p === 1) { tweens.splice(i, 1); tw.res(); }
    }
  }
  const wait = s => to({}, {}, s, ease.out);

  // ---- holographic coins ------------------------------------------------------------
  const edgeTex = (() => { // milled edge: ink and paper stripes
    const [c, x] = canvas(64, 8);
    x.fillStyle = "#FFFDF4"; x.fillRect(0, 0, 64, 8); x.fillStyle = "#14251B";
    for (let i = 0; i < 64; i += 8) x.fillRect(i, 0, 4, 8);
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(14, 1); return t;
  })();
  const coinGeo = new THREE.CylinderGeometry(.56, .56, .14, 64);
  let coins = [];
  function makeCoin(item, home) {
    const [c, x] = canvas(512, 512);
    const g = x.createConicGradient(Math.random() * 6, 256, 256);
    item.tones.forEach((col, i) => g.addColorStop(i / (item.tones.length - 1), col));
    x.fillStyle = g; x.fillRect(0, 0, 512, 512);
    x.strokeStyle = "#14251B"; x.lineWidth = 16; x.beginPath(); x.arc(256, 256, 214, 0, 7); x.stroke();
    x.fillStyle = "#14251B"; x.textAlign = "center"; x.textBaseline = "middle";
    fitFont(x, item.face, 900, 200, '"Big Shoulders Display"', 340); x.fillText(item.face, 256, 250);
    x.font = '700 40px "Big Shoulders Display"'; x.fillText(`ORDER ${item.po}`, 256, 392);
    const face = texture(c); face.center.set(.5, .5); face.rotation = Math.PI / 2;
    const cap = new THREE.MeshPhysicalMaterial({
      map: face, emissive: 0xFFFFFF, emissiveMap: face, emissiveIntensity: .3, envMapIntensity: .5,
      roughness: .3, metalness: .15, iridescence: .7, iridescenceIOR: 1.5, iridescenceThicknessRange: [250, 600],
    });
    const side = new THREE.MeshStandardMaterial({ map: edgeTex, roughness: .5 });
    const m = inked(new THREE.Mesh(coinGeo, [side, cap, cap]), .05);
    m.children[0].scale.set(1.045, 1.5, 1.045);
    m.userData = { item, state: "fly", where: home ? "float" : "jar", jarIndex: 0, phase: Math.random() * 6, h: 0, blob: blob(1.3, .9),
                   home: new THREE.Vector3(...(home || [0, 0, 0])), tilt: [(Math.random() - .5) * .5, (Math.random() - .5) * .5] };
    m.rotation.x = Math.PI / 2; m.scale.setScalar(.01); m.position.set(EX, SLOT_Y - .3, 0);
    scene.add(m); return m;
  }
  function disposeCoin(m) {
    scene.remove(m, m.userData.blob);
    m.material[1].map.dispose(); m.material.forEach(x => x.dispose()); m.userData.blob.material.dispose();
  }
  // ---- the jar: every flagged order that isn't floating -----------------------------
  const jar = new THREE.Group(); jar.position.set(JX, FLOOR, JZ); scene.add(jar);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(JR, JR, JH, 48, 1, true),
    new THREE.MeshPhysicalMaterial({ color: 0xF2FFF8, transparent: true, opacity: .2, roughness: .05, side: THREE.DoubleSide, depthWrite: false }));
  glass.position.y = JH / 2; jar.add(glass);
  for (const y of [0, JH]) { // ink rims
    const rim = new THREE.Mesh(new THREE.TorusGeometry(JR, y ? .045 : .03, 8, 64), new THREE.MeshBasicMaterial({ color: C.ink }));
    rim.rotation.x = Math.PI / 2; rim.position.y = y; jar.add(rim);
  }
  for (const sx of [-1, 1]) { // ink silhouette down each side
    const line = new THREE.Mesh(new THREE.BoxGeometry(.035, JH, .035), new THREE.MeshBasicMaterial({ color: C.ink }));
    line.position.set(sx * JR, JH / 2, 0); jar.add(line);
  }
  const glint = new THREE.Mesh(new THREE.PlaneGeometry(.07, JH * .7), new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: .6 }));
  glint.position.set(-JR * .55, JH * .55, JR * .84); glint.rotation.y = -.6; jar.add(glint);
  const [labelCanvas, lx] = canvas(512, 200);
  const labelTex = texture(labelCanvas, { anisotropy: 8 });
  const label = new THREE.Mesh(new THREE.CylinderGeometry(JR + .01, JR + .01, .5, 32, 1, true, -.95, 1.9),
    new THREE.MeshBasicMaterial({ map: labelTex, side: THREE.DoubleSide }));
  label.position.y = .34; jar.add(label);
  function drawLabel(count, period) {
    lx.fillStyle = "#FFFDF4"; lx.fillRect(0, 0, 512, 200);
    lx.strokeStyle = "#14251B"; lx.lineWidth = 8; lx.strokeRect(4, 4, 504, 192);
    lx.fillStyle = "#14251B"; lx.textAlign = "center"; lx.textBaseline = "alphabetic";
    fitFont(lx, `${count} flagged`, 900, 112, '"Big Shoulders Display"', 460); lx.fillText(`${count} flagged`, 256, 118);
    fitFont(lx, period, 700, 40, '"Sometype Mono"', 460); lx.fillText(period, 256, 170);
    labelTex.needsUpdate = true;
  }
  blob(2.0, 1.4).position.set(JX, FLOOR + .01, JZ);

  const jarCoins = () => coins.filter(c => c.userData.where === "jar" && c.userData.state !== "in")
    .sort((a, b) => a.userData.jarIndex - b.userData.jarIndex);
  function jarSpot(i) { // a loose pile: three to a layer, each layer turned
    const layer = Math.floor(i / 3), a = (i % 3) * 2.094 + layer * 1.1;
    return new THREE.Vector3(JX + Math.cos(a) * .36, FLOOR + .08 + layer * .075, JZ + Math.sin(a) * .36);
  }
  function settleJar() { // close the gaps after coins leave
    jarCoins().forEach((m, i) => {
      m.userData.jarIndex = i;
      if (m.userData.state === "jar") { const p = jarSpot(i); to(m.position, { x: p.x, y: p.y, z: p.z }, .35, ease.out); }
    });
  }
  // fly a coin to where it belongs now: its spot in the air, or into the jar from above
  async function goHome(m, delay = 0) {
    const u = m.userData; u.state = "fly"; m.visible = true; u.blob.visible = true;
    if (u.where === "float") {
      await Promise.all([to(m.position, { x: u.home.x, y: u.home.y, z: u.home.z }, .9, ease.back, delay),
                         to(m.scale, { x: 1, y: 1, z: 1 }, .5, ease.out, delay),
                         to(m.rotation, { x: FACE_TILT, y: 0, z: 0 }, .6, ease.out, delay)]);
      if (u.state === "fly") u.state = "float";
    } else {
      const p = jarSpot(u.jarIndex);
      await Promise.all([to(m.position, { x: p.x, y: FLOOR + JH + .9, z: p.z }, .55, ease.out, delay),
                         to(m.scale, { x: JAR_S, y: JAR_S, z: JAR_S }, .55, ease.out, delay),
                         to(m.rotation, { x: u.tilt[0], y: u.phase, z: u.tilt[1] }, .55, ease.out, delay)]);
      await to(m.position, { y: p.y }, .35, ease.in);
      if (u.state === "fly") { u.state = "jar"; tick(); }
    }
  }
  // a coin rises out of the slot and goes home
  function spit(m, delay = 0) {
    m.position.set(EX, SLOT_Y - .3, 0); m.rotation.set(Math.PI / 2, 0, 0);
    return goHome(m, delay);
  }
  // a coin flies over the slot and drops in
  async function swallow(m) {
    m.userData.state = "fly";
    await Promise.all([
      to(m.position, { x: EX, y: SLOT_Y + 1.15, z: 0 }, .5, ease.out),
      to(m.rotation, { x: Math.PI / 2, y: 0, z: 0 }, .5, ease.out),
      to(m.scale, { x: 1, y: 1, z: 1 }, .3, ease.out),
    ]);
    await wait(.06);
    await to(m.position, { y: SLOT_Y - .7 }, .26, ease.in);
    m.visible = false; m.userData.blob.visible = false; m.userData.state = "in";
    clink(); gulp();
  }
  async function gulp() {
    await to(device.scale, { x: 1.05, y: .93, z: 1.05 }, .09, ease.out);
    await to(device.scale, { x: 1, y: 1, z: 1 }, .5, ease.back);
  }

  // ---- the printed receipt ------------------------------------------------------------
  let receipt = null;
  function receiptTexture(r) {
    const W = 560, H = 560 + r.rows.length * 92 + 250, [c, x] = canvas(W, H);
    x.fillStyle = "#FFFDF4"; x.beginPath(); x.moveTo(0, 16); // torn top and bottom edges
    for (let i = 0; i <= W; i += 20) x.lineTo(i, i % 40 ? 0 : 16);
    for (let i = W; i >= 0; i -= 20) x.lineTo(i, H - (i % 40 ? 0 : 16));
    x.closePath(); x.fill();
    const ink = "#14251B", L = 44, R = W - 44;
    x.fillStyle = ink; x.textAlign = "center";
    x.font = '700 30px "Sometype Mono"'; x.fillText("BOOKS.CHECK", W / 2, 90);
    x.font = '400 22px "Sometype Mono"'; x.fillText(r.kicker, W / 2, 124);
    fitFont(x, r.title, 900, 120, '"Big Shoulders Display"', R - L); x.fillText(r.title, W / 2, 260);
    fitFont(x, r.subtitle, 400, 26, '"Sometype Mono"', R - L); x.fillText(r.subtitle, W / 2, 302);
    const dash = y => { x.setLineDash([10, 8]); x.lineWidth = 3; x.strokeStyle = ink; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); x.setLineDash([]); };
    dash(340);
    let y = 392;
    for (const [when, what, amt, hl] of r.rows) {
      if (hl) { // highlighter swipe over the rows that matter
        x.fillStyle = hl === 2 ? "rgba(255,176,32,.55)" : "rgba(255,61,127,.38)";
        x.beginPath(); x.roundRect(L - 12, y - 34, R - L + 24, 76, 10); x.fill();
      }
      x.fillStyle = ink; x.textAlign = "left";
      x.font = '400 21px "Sometype Mono"'; x.fillText(when, L, y - 6);
      x.textAlign = "right"; x.font = `${hl ? 700 : 400} 26px "Sometype Mono"`; x.fillText(amt, R, when ? y + 26 : y + 12);
      const amtW = amt ? x.measureText(amt).width + 20 : 0;
      x.textAlign = "left"; fitFont(x, what, hl ? 700 : 400, 26, '"Sometype Mono"', R - L - amtW); x.fillText(what, L, when ? y + 26 : y + 12);
      y += 92;
    }
    dash(y - 20);
    x.textAlign = "left"; x.font = '700 26px "Sometype Mono"'; x.fillText(r.totalLabel, L, y + 40);
    x.textAlign = "right"; fitFont(x, r.total, 900, 96, '"Big Shoulders Display"', 300);
    x.fillStyle = r.totalColour || "#D61F5E"; x.fillText(r.total, R, y + 70);
    x.fillStyle = ink; x.textAlign = "left"; x.font = '400 24px "Sometype Mono"';
    const end = wrap(x, r.note || "", L, y + 140, R - L, 34);
    x.textAlign = "center"; x.font = '400 22px "Sometype Mono"'; x.fillText("* * *  thank you for checking  * * *", W / 2, Math.max(end + 70, H - 50));
    return Object.assign(texture(c, { anisotropy: 8 }), { userData: { aspect: H / W } });
  }
  function makeReceipt(r) {
    const tex = receiptTexture(r), w = 1.3, h = w * tex.userData.aspect;
    const geo = new THREE.PlaneGeometry(w, h, 1, 40);
    geo.translate(0, -h / 2, 0); // hang from the top edge so it can unroll downward
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) { const f = -pos.getY(i) / h; pos.setZ(i, .5 * f * f); } // the tail curls toward you
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, fog: false }));
    const back = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.DoubleSide }));
    back.position.set(.05, -.05, -.02); m.add(back); // a hard offset shadow, like a sticker
    m.userData.blob = blob(1.8, .9); m.userData.blob.material.opacity = 0;
    return m;
  }
  async function clearReceipt() {
    if (!receipt) return;
    const old = receipt; receipt = null;
    to(old.userData.blob.material, { opacity: 0 }, .2, ease.out);
    await to(old.scale, { y: .01 }, .25, ease.in);
    scene.remove(old, old.userData.blob);
    old.material.map.dispose(); old.geometry.dispose();
  }
  async function printReceipt(model) {
    await clearReceipt();
    const r = receipt = makeReceipt(model);
    r.position.set(EX + .4, SLOT_Y - .2, .3); r.scale.set(.2, .01, 1); r.rotation.y = -.18;
    scene.add(r); r.userData.blob.position.set(.8, FLOOR + .01, .9);
    await Promise.all([to(r.position, { x: .7, y: 1.45, z: .6 }, .6), to(r.scale, { x: 1, y: .04 }, .6)]);
    to(r.userData.blob.material, { opacity: 1 }, 1.2, ease.out);
    for (let i = 1; i <= 8 && receipt === r; i++) await to(r.scale, { y: i / 8 }, .14, ease.out); // printed in jolts
  }

  // ---- sound: a coin dropping in -------------------------------------------------------
  let audio;
  function clink() {
    try {
      audio ||= new AudioContext();
      const t = audio.currentTime;
      for (const [f, d, g0] of [[2200, 0, .22], [3300, .07, .16], [1650, .16, .12]]) {
        const o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(g0, t + d + .005); g.gain.exponentialRampToValueAtTime(.0001, t + d + .35);
        o.connect(g).connect(audio.destination); o.start(t + d); o.stop(t + d + .4);
      }
    } catch { /* no audio: fine */ }
  }

  function tick() {
    try {
      audio ||= new AudioContext();
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 2600 + Math.random() * 1400;
      g.gain.setValueAtTime(.05, t); g.gain.exponentialRampToValueAtTime(.0001, t + .12);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + .14);
    } catch { /* no audio: fine */ }
  }

  // ---- pointer: hover, drag, drop, click ----------------------------------------------------
  const tip = document.getElementById("tip");
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(9, 9);
  let hovered = null, drag = null, locked = false;
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3();
  const v3 = new THREE.Vector3();
  function showTip(m) {
    tip.innerHTML = m === jar ? `<b>${jarCoins().length} more in the jar</b>Click to pour out the next ${Math.min(FLOATING, jarCoins().length)}.`
                              : `<b>Order ${m.userData.item.po}</b>${m.userData.item.tip}`;
    v3.copy(m.position).project(camera);
    if (!tip.dataset.mouse) { tip.style.left = (v3.x * .5 + .5) * innerWidth + "px"; tip.style.top = (-v3.y * .5 + .5) * innerHeight + "px"; }
    tip.style.opacity = 1;
  }
  const hideTip = () => { tip.style.opacity = 0; };
  const setPointer = e => mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const floating = () => coins.filter(c => c.userData.state === "float" || c.userData.state === "jar");
  const nearSlot = m => Math.hypot(m.position.x - EX, m.position.y - (SLOT_Y + .5)) < 1.5;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", e => {
    setPointer(e); ray.setFromCamera(mouse, camera);
    const m = ray.intersectObjects(floating(), false)[0]?.object;
    if (!m && !locked && ray.intersectObject(glass, false).length) { onPour(); return; }
    if (!m || locked) return;
    drag = { m, x0: e.clientX, y0: e.clientY, moved: false };
    m.userData.state = "drag"; dragPlane.constant = -m.position.z;
    el.setPointerCapture(e.pointerId); document.body.classList.add("dragging"); hideTip();
  });
  addEventListener("pointermove", e => {
    setPointer(e); tip.dataset.mouse = "1";
    if (!drag) { tip.style.left = e.clientX + "px"; tip.style.top = e.clientY + "px"; return; }
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.moved = true;
    ray.setFromCamera(mouse, camera);
    if (ray.ray.intersectPlane(dragPlane, hit)) drag.m.position.lerp(hit, .5);
  });
  addEventListener("pointerup", () => {
    if (!drag) return;
    const { m, moved } = drag; drag = null; document.body.classList.remove("dragging");
    if (!moved || nearSlot(m)) onFeed(m.userData.item.po);
    else goHome(m);
  });
  let focused = null; // keyboard focus on a coin's button
  function hover() {
    let m = focused;
    if (!m && !drag) {
      ray.setFromCamera(mouse, camera);
      m = ray.intersectObjects(floating(), false)[0]?.object || (jarCoins().length && ray.intersectObject(glass, false).length ? jar : null);
    }
    if (m !== hovered) {
      hovered = m;
      if (m) showTip(m); else hideTip();
      document.body.style.cursor = m && !focused ? (m === jar ? "pointer" : "grab") : "";
    }
  }

  // ---- loop ---------------------------------------------------------------------------
  jar.userData.h = 0;
  const clock = new THREE.Clock(), black = new THREE.Color(0x05070C), blue = new THREE.Color(C.alexa);
  function frame() {
    const dt = Math.min(clock.getDelta(), .25); now += dt;
    runTweens(); hover();
    const mx = mouse.x === 9 ? 0 : Math.max(-1, Math.min(1, mouse.x)), my = mouse.y === 9 ? 0 : Math.max(-1, Math.min(1, mouse.y));
    // the Echo leans toward the pointer, and hungrily toward a coin held near its slot
    const held = drag && nearSlot(drag.m);
    device.rotation.y += (mx * .22 - device.rotation.y) * .06;
    device.rotation.x += ((held ? .12 : -my * .08) - device.rotation.x) * .08;
    slotMat.color.lerp(held ? blue : black, .2);
    for (const m of coins) {
      const u = m.userData, bob = still ? 0 : Math.sin(now * 1.3 + u.phase);
      u.h += ((hovered === m ? 1 : 0) - u.h) * .15;
      if (u.state === "float") {
        m.position.set(u.home.x, u.home.y + bob * .12, u.home.z);
        m.rotation.set(FACE_TILT, still ? 0 : Math.sin(now * .9 + u.phase) * .35 + Math.sin(now * 9) * .25 * u.h, Math.sin(now * .7 + u.phase) * .08);
        m.scale.setScalar(1 + .12 * u.h);
      } else if (u.state === "jar") m.scale.setScalar(JAR_S * (1 + .25 * u.h));
      else if (u.state === "drag") m.scale.setScalar(1.15);
      const lift = m.position.y - FLOOR; // shadow shrinks and fades as a coin rises
      u.blob.position.set(m.position.x, FLOOR + .01, m.position.z);
      u.blob.scale.setScalar(Math.max(.4, 1.3 - lift * .15)); u.blob.material.opacity = Math.max(.15, 1 - lift * .2);
    }
    jar.userData.h += ((hovered === jar ? 1 : 0) - jar.userData.h) * .15;
    jar.scale.setScalar(1 + .04 * jar.userData.h);
    if (receipt && !still) receipt.rotation.z = Math.sin(now * 1.1) * .015;
    camera.position.set(CAM.x + mx * .35, CAM.y + my * .2, CAM.z); camera.lookAt(0, -.1, 0);
    drawScreen(now);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  device.position.y = 4; frame();
  const arrived = to(device.position, { y: EY }, 1.0, ease.back);

  // ---- what app.js can do -------------------------------------------------------------
  return {
    screen: s => Object.assign(screen, s),
    printReceipt, clearReceipt,
    lock: on => { locked = on; },
    focusCoin: po => { focused = coins.find(c => c.userData.item.po === po) || null; if (!focused) tip.dataset.mouse = ""; },
    hasCoin: po => coins.some(c => c.userData.item.po === po),
    // swap in a new set: the old coins dive into the slot, the new ones pop out;
    // the first few float, the rest drop into the jar
    async setCoins(items, { period }) {
      await arrived;
      const old = coins; coins = [];
      await Promise.all(old.map((m, i) => m.userData.state === "in" ? null :
        (m.userData.state = "fly", to(m.position, { x: EX, y: SLOT_Y - .3, z: 0 }, .45, ease.in, Math.min(i, 12) * .03))));
      old.forEach(disposeCoin);
      drawLabel(items.length, period);
      coins = items.map((it, i) => makeCoin(it, HOMES[i]));
      coins.slice(FLOATING).forEach((m, i) => { m.userData.jarIndex = i; });
      if (old.length) gulp();
      await Promise.all(coins.map((m, i) => {
        if (i < FLOATING && i % 2) setTimeout(gulp, i * 130);
        return spit(m, i < FLOATING ? i * .13 : FLOATING * .13 + (i - FLOATING) * .05);
      }));
    },
    jarCount: () => jarCoins().length,
    // the floating coins drop into the jar and the next ones jump out
    async pour() {
      const pile = jarCoins();
      const up = coins.filter(c => c.userData.where === "float" && c.userData.state === "float");
      const n = Math.min(pile.length, up.length);
      if (!n) return;
      const out = pile.slice(0, n), down = up.slice(0, n); // next most serious out, these back on top
      out.forEach((m, i) => { m.userData.where = "float"; m.userData.home.copy(down[i].userData.home); });
      down.forEach((m, i) => { m.userData.where = "jar"; m.userData.jarIndex = pile.length - n + i; });
      gulp();
      await Promise.all([...out.map((m, i) => goHome(m, i * .08)), ...down.map((m, i) => goHome(m, .25 + i * .1))]);
      settleJar();
    },
    // drop the order's coin in (from the air or the jar); the previous one goes back
    async feed(po) {
      const back = coins.find(c => c.userData.state === "in");
      if (back && back.userData.item.po !== po) {
        if (back.userData.where === "jar") back.userData.jarIndex = jarCoins().length; // back on top of the pile
        spit(back);
      }
      const m = coins.find(c => c.userData.item.po === po);
      hideTip();
      if (m && m.userData.state !== "in") { await swallow(m); settleJar(); }
      else { clink(); await gulp(); }
    },
  };
}

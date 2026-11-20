/* 三维办公室：只负责把「谁在、谁能找谁」画出来，并告诉外面点了谁。
   长相和列表里的头像对得上：颜色相同；Bot 头上有天线、面前有桌子和电脑，人没有；公司外的人站在右边的小台子上。
   座位不是摆的：能互相联系的人被拉近，其余互相推开，算到稳定为止。数据和操作都在 app.js。 */
window.Office = (function () {
  'use strict';
  var THREE = window.THREE, gsap = window.gsap;
  var renderer, scene, camera, canvas, labelBox, onPick, calm = false;
  var pets = {}, model = { nodes: [], links: [], boss: [] }, rel, arcBox, selId = null, selReach = [], selIn = [], moving = null;
  var face = .5, CAM = [7, 9, 10], LOOK = [.8, .5, 0], CREAM = 0xf3efe8, SCREEN = 0xdfe3e8, INK = 0x2a2c30, ARC = 0x2f3237, ARCIN = 0xb7b9be;
  var SHAPES = ['cube', 'round', 'drop', 'cloud'], EXTRA = ['', 'beanie', 'glasses', ''];
  var BOX, CUBE, BALL;

  function clay(c, o) { return new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: .6, metalness: 0, transparent: true }, o || {})); }
  function soft(e) { var g = new THREE.SphereGeometry(1, 32, 24), a = g.attributes.position, f = function (v) { return Math.sign(v) * Math.pow(Math.abs(v), e); }; for (var q = 0; q < a.count; q++) a.setXYZ(q, f(a.getX(q)), f(a.getY(q)), f(a.getZ(q))); g.computeVertexNormals(); return g; }
  function add(parent, geo, m, x, y, z) { var o = new THREE.Mesh(geo, m); o.position.set(x || 0, y || 0, z || 0); o.castShadow = true; parent.add(o); return o; }
  function part(parent, geo, m, x, y, z, sx, sy, sz) { var o = add(parent, geo, m, x, y, z); o.scale.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz); return o; }
  function dur(d) { return calm ? 0 : d; }

  function look(node) { /* 颜色由外面给，和列表头像一样；形状按创建时的序号，之后不变 */
    var c = new THREE.Color(node.color || '#c3b5ee').getHex();
    if (node.kind === 'me') return { c: 0xf7f7f8, shape: 'round', extra: 'scarf' };
    if (node.kind === 'bot') { var i = node.look || 0; return { c: c, shape: SHAPES[i % SHAPES.length], extra: EXTRA[i % EXTRA.length], antenna: true }; }
    return { c: c, shape: 'round', extra: '' };
  }
  function makePet(node, x, z) {
    var mon = null, L = look(node), g = new THREE.Group(), sp = new THREE.Group(), m = clay(L.c), dark = clay(0x1d1b26, { roughness: .15 }), white = clay(0xffffff, { roughness: .2 }), acc = clay(L.extra === 'beanie' ? CREAM : INK), mats = [m, dark, white, acc], screen = null, top = .82, front = .42;
    var jit = ((x * 7 + z * 13) % 1) * .5 - .4; g.position.set(x, 0, z); g.rotation.y = face + jit; scene.add(g); g.add(sp);
    if (node.kind === 'bot') { part(g, BOX, clay(CREAM), 0, .42, -.85, .6, .07, .34); add(g, new THREE.CylinderGeometry(.09, .16, .4, 20), clay(0xe9dfcd), 0, .2, -.85); mon = new THREE.Group(); g.add(mon); part(mon, BOX, clay(0xf4f1f6), 0, .78, -.95, .34, .24, .05); add(mon, new THREE.CylinderGeometry(.04, .04, .14, 12), clay(0xf4f1f6), 0, .54, -.95); screen = part(mon, BOX, clay(SCREEN, { emissive: 0x000000 }), 0, .78, -.9, .27, .17, .015).material; mon.visible = !!node.pc; } /* 没分配电脑或云环境，桌上就没有电脑 */
    if (L.shape === 'cube') { part(sp, CUBE, m, 0, .4, 0, .4, .4, .38); front = .4; }
    else if (L.shape === 'drop') { add(sp, new THREE.LatheGeometry(new THREE.SplineCurve([[0, 0], [.3, .03], [.43, .22], [.4, .44], [.26, .68], [.1, .86], [0, .9]].map(function (p) { return new THREE.Vector2(p[0], p[1]); })).getPoints(28), 36), m, 0, 0, 0); top = .9; }
    else { part(sp, BALL, m, 0, .4, 0, .43, .4, .43); if (L.shape === 'cloud') { part(sp, BALL, m, -.2, .7, 0, .2); part(sp, BALL, m, .2, .7, 0, .2); part(sp, BALL, m, 0, .78, 0, .22); top = .98; } }
    if (L.antenna) { add(sp, new THREE.CylinderGeometry(.025, .03, .22, 10), m, .08, top + .08, 0).rotation.z = -.15; part(sp, BALL, m, .1, top + .25, 0, .09); } /* 天线：只有 Bot 有 */
    [-.15, .15].forEach(function (ex) { part(sp, BALL, dark, ex, .46, front - .03, .065, .09, .04); part(sp, BALL, white, ex - .02, .5, front + .005, .02); });
    add(sp, new THREE.TorusGeometry(.045, .012, 8, 16, Math.PI), dark, 0, .37, front).rotation.z = Math.PI;
    part(sp, BALL, m, -.2, .06, .18, .14, .09, .16); part(sp, BALL, m, .2, .06, .18, .14, .09, .16); part(sp, BALL, m, .42, .34, .2, .11);
    var phone = part(sp, BOX, clay(CREAM), .47, .42, .3, .09, .15, .02);
    if (L.extra === 'scarf') add(sp, new THREE.TorusGeometry(.36, .075, 12, 32), acc, 0, .2, 0).rotation.x = Math.PI / 2;
    if (L.extra === 'beanie') add(sp, new THREE.SphereGeometry(.45, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2.4), acc, 0, .44, 0);
    if (L.extra === 'glasses') [-.15, .15].forEach(function (ex) { add(sp, new THREE.TorusGeometry(.1, .018, 8, 24), acc, ex, .46, front + .01); });
    var hit = part(g, BALL, new THREE.MeshBasicMaterial({ visible: false }), 0, .5, 0, .8); hit.castShadow = false; hit.userData.id = node.id;
    var el = document.createElement('span'); labelBox.appendChild(el);
    var bob = calm ? null : gsap.to(sp.position, { y: .1, duration: .7 + Math.abs(x * 3 + z) % 1 * .5, ease: 'sine.inOut', yoyo: true, repeat: -1 });
    g.scale.setScalar(.01); gsap.to(g.scale, { x: 1.4, y: 1.4, z: 1.4, duration: dur(.5), ease: 'back.out(1.6)' });
    return { jit: jit, g: g, mon: mon, sp: sp, mats: mats, hit: hit, phone: phone, screen: screen, el: el, bob: bob, top: (top > .85 ? 1.5 : 1.3) - (L.antenna ? 0 : .2), glow: null };
  }
  function dropPet(id) { var p = pets[id]; delete pets[id]; p.el.remove(); if (p.bob) p.bob.kill(); if (p.glow) p.glow.kill(); gsap.to(p.g.scale, { x: .01, y: .01, z: .01, duration: dur(.3), onComplete: function () { scene.remove(p.g); } }); }

  function solve() {
    var K = model.nodes.map(function (n) { return n.id; }), pos = {}, link = {}, pin = {}, outs = model.nodes.filter(function (n) { return n.kind === 'out'; });
    K.forEach(function (k) { pos[k] = { x: pets[k].g.position.x, z: pets[k].g.position.z }; });
    outs.forEach(function (n, i) { pin[n.id] = 1; pos[n.id] = { x: 6.1, z: -1.6 + (i - (outs.length - 1) / 2) * 1.5 }; });
    model.links.forEach(function (e) { link[e[0] < e[1] ? e[0] + '|' + e[1] : e[1] + '|' + e[0]] = 1; });
    for (var it = 0; it < 500; it++) { var f = {}; K.forEach(function (k) { f[k] = { x: (-.8 - pos[k].x) * .02, z: -pos[k].z * .02 }; });
      for (var a = 0; a < K.length; a++) for (var b = a + 1; b < K.length; b++) { var A = K[a], B = K[b], dx = pos[B].x - pos[A].x, dz = pos[B].z - pos[A].z, d = Math.max(.3, Math.hypot(dx, dz)), g = -3.2 / (d * d) + (link[A < B ? A + '|' + B : B + '|' + A] ? (d - 2.8) * .22 : 0);
        if (d < 2.6) g -= (2.6 - d) * 1.2; f[A].x += dx / d * g; f[A].z += dz / d * g; f[B].x -= dx / d * g; f[B].z -= dz / d * g; }
      K.forEach(function (k) { if (pin[k]) return; pos[k].x = Math.max(-5, Math.min(3.3, pos[k].x + f[k].x * .25)); pos[k].z = Math.max(-3.6, Math.min(3.6, pos[k].z + f[k].z * .25)); }); }
    return pos;
  }
  function clear(group) { while (group.children.length) { var o = group.children.pop(); if (o.geometry !== BOX && o.geometry !== BALL) o.geometry.dispose(); } }
  function drawRel() {
    clear(rel); clear(arcBox);
    model.boss.forEach(function (e) { if (!pets[e[0]] || !pets[e[1]] || (e[0] !== selId && e[1] !== selId)) return; /* 归谁管的线只在选中这个人时画 */ var a = pets[e[0]].g.position, b = pets[e[1]].g.position, l = part(rel, BOX, clay(0xd3c9f0), (a.x + b.x) / 2, .01, (a.z + b.z) / 2, .05, .012, Math.max(.05, (a.distanceTo(b) - 1.9) / 2)); l.rotation.y = Math.atan2(b.x - a.x, b.z - a.z); l.castShadow = false; });
    var me = pets[selId]; if (!me) return;
    /* 联系是单向的：他能找的人，用深色画高一点的弧线，箭头指向对方；能找他的人，用浅灰画低一点的细弧线，箭头指向他 */
    function arc(from, to, color, lift, r) { var a = from.g.position.clone().setY(1.5), b = to.g.position.clone().setY(1.5), curve = new THREE.QuadraticBezierCurve3(a, a.clone().add(b).multiplyScalar(.5).setY(1.5 + lift + a.distanceTo(b) * .28), b), m = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: .2, roughness: .6 });
      add(arcBox, new THREE.TubeGeometry(curve, 32, r, 8), m).castShadow = false;
      var tip = add(arcBox, new THREE.ConeGeometry(r * 4.5, r * 10, 16), m, 0, 0, 0); tip.castShadow = false; tip.position.copy(curve.getPoint(.93)); tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(.93)); }
    selReach.forEach(function (j) { if (pets[j]) arc(me, pets[j], ARC, .45, .04); });
    selIn.forEach(function (j) { if (pets[j] && selReach.indexOf(j) < 0) arc(pets[j], me, ARCIN, -.05, .03); }); /* 双向的只画一条深色的，避免两条线叠在一起 */
  }
  function dim() { Object.keys(pets).forEach(function (k) { var on = !selId || !pets[selId] || k === selId || selReach.indexOf(k) >= 0 || selIn.indexOf(k) >= 0; pets[k].mats.forEach(function (m) { gsap.to(m, { opacity: on ? 1 : .28, duration: dur(.3) }); }); pets[k].el.classList.toggle('dim', !on); }); }
  /* 视角：off 是镜头在自己平面里的偏移，zoom 是放大倍数。选人时镜头靠过去；手指拖动和双指缩放直接改它。画面始终按屏幕像素重画，所以放大不糊。 */
  /* 视角：镜头绕着一个目标点转。x/y/z 是目标点的平移，zoom 是放大，yaw/pitch 是在默认方向上多转的水平和俯仰角。
     手机（和手机地图一样）：单指拖动移动；双指扭转旋转，双指一起上下推改俯视角度，捏合缩放。电脑：左键拖动旋转，右键或按住 Shift 拖动平移，滚轮缩放。画面始终按屏幕像素重画。 */
  var view = { x: 0, y: 0, z: 0, zoom: 1, yaw: 0, pitch: 0 }, half = 4.7, resetBtn, base = { yaw: 0, pitch: .7, dist: 15 };
  function dirOf(yaw, pitch) { return new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)); }
  function pitchNow() { return Math.max(.32, Math.min(1.45, base.pitch + view.pitch)); }
  function applyView() { var tg = new THREE.Vector3(LOOK[0] + view.x, LOOK[1] + view.y, LOOK[2] + view.z); camera.position.copy(tg).addScaledVector(dirOf(base.yaw + view.yaw, pitchNow()), base.dist); camera.lookAt(tg); camera.zoom = view.zoom; camera.updateProjectionMatrix();
    if (resetBtn) resetBtn.hidden = view.zoom < 1.05 && Math.hypot(view.x, view.y, view.z) < .3 && Math.abs(view.yaw) < .05 && Math.abs(view.pitch) < .05; }
  function home() { gsap.to(view, { x: 0, y: 0, z: 0, zoom: 1, yaw: 0, pitch: 0, duration: dur(.6), ease: 'power2.out', overwrite: true, onUpdate: applyView, onComplete: turnPets }); }
  function turnPets() { /* 转完以后，小家伙们慢慢转身朝向你 */ var f = base.yaw + view.yaw; Object.keys(pets).forEach(function (k, i) { var p = pets[k], to = f + p.jit, cur = p.g.rotation.y; to = cur + Math.atan2(Math.sin(to - cur), Math.cos(to - cur)); gsap.to(p.g.rotation, { y: to, duration: dur(.7), delay: calm ? 0 : i * .04, ease: 'back.out(1.4)' }); }); face = f; }
  function aim() { /* 选中一个人：把他和跟他有箭头的人一起框进画面，留出底部卡片的位置；保持你现在转到的方向 */
    var p = pets[selId]; if (!p) { gsap.to(view, { x: 0, y: 0, z: 0, zoom: 1, duration: dur(.6), ease: 'power2.out', overwrite: true, onUpdate: applyView }); return; }
    var ids = [selId].concat(selReach, selIn).filter(function (k) { return pets[k]; }), c = new THREE.Vector3(), q = new THREE.Vector3(), inv = new THREE.Matrix4(), L = new THREE.Vector3(LOOK[0], LOOK[1], LOOK[2]);
    ids.forEach(function (k) { c.add(pets[k].g.position); }); c.multiplyScalar(1 / ids.length); c.y = 1;
    var cam0 = camera.clone(); cam0.position.copy(L).addScaledVector(dirOf(base.yaw + view.yaw, pitchNow()), base.dist); cam0.lookAt(L); cam0.updateMatrixWorld(); inv.copy(cam0.matrixWorldInverse);
    var cc = c.clone().applyMatrix4(inv), mx = 1.2, my = 1.2; ids.forEach(function (k) { [0, 2.6].forEach(function (y) { q.copy(pets[k].g.position).setY(y).applyMatrix4(inv); mx = Math.max(mx, Math.abs(q.x - cc.x) + 1.1); my = Math.max(my, Math.abs(q.y - cc.y) + .5); }); }); /* 加上人和桌子本身的宽度 */
    var a = canvas.clientWidth / canvas.clientHeight, cardEl = document.getElementById('card'), cardFrac = cardEl ? Math.min(.4, (cardEl.offsetHeight + 24) / canvas.clientHeight) : 0,
      zoom = Math.max(1, Math.min(2.4, Math.min(half * a / (mx * 1.15), half * (1 - cardFrac) / (my * 1.15)))), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam0.quaternion), d = c.clone().sub(L).addScaledVector(up, -cardFrac * half / zoom);
    gsap.to(view, { x: d.x, y: d.y, z: d.z, zoom: zoom, duration: dur(.7), ease: 'power2.out', overwrite: true, onUpdate: applyView }); }
  function nudge(dx, dy, k) { /* 平移 dx,dy 像素；k 是缩放倍率 */
    gsap.killTweensOf(view); var per = 2 * half / canvas.clientHeight / view.zoom, r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    view.x += (-dx * r.x + dy * u.x) * per; view.y += (-dx * r.y + dy * u.y) * per; view.z += (-dx * r.z + dy * u.z) * per; var l = Math.hypot(view.x, view.y, view.z); if (l > 8) { view.x *= 8 / l; view.y *= 8 / l; view.z *= 8 / l; }
    view.zoom = Math.max(.8, Math.min(5, view.zoom * k)); applyView(); }
  function spin(dyaw, dpitch) { gsap.killTweensOf(view); view.yaw += dyaw; view.pitch = Math.max(.32 - base.pitch, Math.min(1.45 - base.pitch, view.pitch + dpitch)); applyView(); }
  function gestures() {
    var pts = {}, moved = 0, last = null, pan = false, turned = false;
    function mid() { var k = Object.keys(pts), a = pts[k[0]], b = pts[k[1]] || a; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), n: k.length }; }
    canvas.addEventListener('pointerdown', function (e) { pts[e.pointerId] = { x: e.clientX, y: e.clientY }; if (Object.keys(pts).length === 1) { moved = 0; pan = e.pointerType !== 'mouse' || e.button === 2 || e.shiftKey; } last = mid(); try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    canvas.addEventListener('pointermove', function (e) { if (!pts[e.pointerId]) return; pts[e.pointerId] = { x: e.clientX, y: e.clientY }; var m = mid(), dx = m.x - last.x, dy = m.y - last.y; moved += Math.abs(dx) + Math.abs(dy); if (moved < 8) { if (m.n === last.n) return; }
      if (m.n >= 2 && last.n >= 2) { var da = m.ang - last.ang; da = Math.atan2(Math.sin(da), Math.cos(da)); nudge(0, 0, last.d > 20 && m.d > 20 ? m.d / last.d : 1); if (Math.abs(da) > .002 || Math.abs(dy) > .5) { spin(-da, dy * .006); turned = true; } }
      else if (m.n === 1 && last.n === 1) { if (pan) nudge(dx, dy, 1); else { spin(-dx * .008, dy * .005); turned = true; } }
      last = m; });
    function up(e) { delete pts[e.pointerId]; if (Object.keys(pts).length) last = mid(); else if (turned) { turned = false; turnPets(); } } canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); if (e.ctrlKey || !e.shiftKey) nudge(0, 0, Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0015))); else nudge(-e.deltaY, 0, 1); }, { passive: false });
    ['gesturestart', 'gesturechange'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });
    return function () { return moved >= 8; };
  }
  function turnBy(d) { gsap.to(view, { yaw: view.yaw + d, duration: dur(.5), ease: 'power2.inOut', overwrite: 'auto', onUpdate: applyView, onComplete: turnPets }); }

  /* 取景：按画面比例选镜头方向（竖屏时把办公室长的一边竖过来），再按办公室的实际外框算缩放，让它铺满可用空间 */
  var BOUND = [[-6, -4.7], [4.8, -4.7], [7.6, -3.8], [7.6, 0.6], [4.8, 4.7], [-6, 4.7]];
  function resize() { var w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); var a = w / h;
    var off = a < .9 ? [-9, 11, 3.5] : [6.2, 8.5, 10], dist = Math.hypot(off[0], off[1], off[2]); base = { yaw: Math.atan2(off[0], off[2]), pitch: Math.asin(off[1] / dist), dist: dist }; face = base.yaw + view.yaw; Object.keys(pets).forEach(function (k) { pets[k].g.rotation.y = face + pets[k].jit; }); /* 人都朝着镜头 */ CAM = [LOOK[0] + off[0], LOOK[1] + off[1], LOOK[2] + off[2]];
    camera.position.set(CAM[0], CAM[1], CAM[2]); camera.lookAt(LOOK[0], LOOK[1], LOOK[2]); camera.updateMatrixWorld();
    var inv = camera.matrixWorldInverse, mx = 0, my = 0, q = new THREE.Vector3(), c = new THREE.Vector3(LOOK[0], LOOK[1], LOOK[2]).applyMatrix4(inv);
    BOUND.forEach(function (b) { [0, 2.4].forEach(function (y) { q.set(b[0], y, b[1]).applyMatrix4(inv); mx = Math.max(mx, Math.abs(q.x - c.x)); my = Math.max(my, Math.abs(q.y - c.y)); }); });
    var s = half = Math.max(my, mx / a) * 1.06; camera.left = -s * a; camera.right = s * a; camera.top = s; camera.bottom = -s; applyView(); }
  var v;
  function frame() { requestAnimationFrame(frame); if (document.hidden) return; renderer.render(scene, camera); var w = canvas.clientWidth, h = canvas.clientHeight;
    Object.keys(pets).forEach(function (k) { var p = pets[k]; p.g.getWorldPosition(v); v.y += p.top * p.g.scale.y + .25; v.project(camera); p.el.style.left = (v.x * .5 + .5) * w + 'px'; p.el.style.top = (-v.y * .5 + .5) * h + 'px'; }); }
  function paint() { var cs = getComputedStyle(document.documentElement), val = function (n, d) { return cs.getPropertyValue(n).trim() || d; }; /* 颜色跟着浅色和深色主题走 */
    scene.background = new THREE.Color(val('--stage', '#f3f3f4')); scene.userData.floor.color.set(val('--floor', '#ffffff')); scene.userData.guest.color.set(val('--guest', '#f6efe9')); scene.userData.gate.color.set(val('--gate', '#dcd9df'));
    ARC = new THREE.Color(val('--arc', '#2f3237')).getHex(); ARCIN = new THREE.Color(val('--arc-in', '#b7b9be')).getHex(); if (rel) drawRel(); }

  return {
    init: function (cv, lb, pick) {
      if (!THREE || !gsap) return false; canvas = cv; labelBox = lb; onPick = pick;
      try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true }); } catch (e) { return false; }
      calm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      renderer.setPixelRatio(Math.min(3, window.devicePixelRatio || 1)); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      BOX = soft(.3); CUBE = soft(.5); BALL = new THREE.SphereGeometry(1, 32, 24); v = new THREE.Vector3();
      scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xffffff, 0xdedee3, .7));
      var sun = new THREE.DirectionalLight(0xffffff, .36); sun.position.set(4, 9, 6); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 5; sun.shadow.bias = -.0006; var sc = sun.shadow.camera; sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = .5; sc.far = 40; scene.add(sun);
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100); camera.position.set(CAM[0], CAM[1], CAM[2]); camera.lookAt(LOOK[0], LOOK[1], LOOK[2]);
      var fm = clay(0xffffff), gm = clay(0xf6efe9), dm = clay(0xdcd9df), floor = part(scene, BOX, fm, -.6, -.2, 0, 5.4, .2, 4.7), out = part(scene, BOX, gm, 6.1, -.2, -1.6, 1.5, .2, 2.2); floor.castShadow = out.castShadow = false; floor.receiveShadow = out.receiveShadow = true;
      scene.userData.floor = fm; scene.userData.guest = gm; scene.userData.gate = dm;
      add(scene, new THREE.TorusGeometry(1.15, .08, 14, 40, Math.PI), dm, 4.75, 0, -1.6).rotation.y = Math.PI / 2; /* 门：公司外的人从这里进来 */
      rel = new THREE.Group(); arcBox = new THREE.Group(); scene.add(rel); scene.add(arcBox); paint();
      if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', paint); }
      var ray = new THREE.Raycaster(), dragged = gestures(); resetBtn = document.getElementById('whole'); if (resetBtn) resetBtn.addEventListener('click', home);
      [['turnL', -Math.PI / 4], ['turnR', Math.PI / 4]].forEach(function (b) { var el = document.getElementById(b[0]); if (el) el.addEventListener('click', function () { turnBy(b[1]); }); });
      canvas.addEventListener('click', function (e) { if (dragged()) return; var r = canvas.getBoundingClientRect(); ray.setFromCamera({ x: (e.clientX - r.left) / r.width * 2 - 1, y: -(e.clientY - r.top) / r.height * 2 + 1 }, camera);
        var hit = ray.intersectObjects(Object.keys(pets).map(function (k) { return pets[k].hit; }))[0]; onPick(hit ? hit.object.userData.id : null); });
      window.addEventListener('resize', resize); if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
      resize(); frame(); return true;
    },
    /* 外面的数据变了就调一次：增减人、更新名牌和红点、重新算座位 */
    sync: function (m) {
      var first = !Object.keys(pets).length, ids = {}; model = m;
      m.nodes.forEach(function (n, i) { ids[n.id] = 1; if (!pets[n.id]) { var t = i * 2.4; pets[n.id] = makePet(n, n.kind === 'me' ? .2 : -.8 + Math.cos(t) * 2.6, n.kind === 'me' ? 2.6 : Math.sin(t) * 2.6); }
        var p = pets[n.id]; p.el.textContent = n.name; if (n.fx) { var chip = document.createElement('b'); chip.className = 'fx'; chip.textContent = n.fx.mark; p.el.appendChild(chip); if (p.fxKey && p.fxKey !== n.fx.id && !calm) gsap.fromTo(p.sp.scale, { x: 1.3, y: .7, z: 1.3 }, { x: 1, y: 1, z: 1, duration: .8, ease: 'elastic.out(1,.35)' }); } p.fxKey = n.fx ? n.fx.id : null; p.el.className = (n.kind === 'me' ? 'me' : '') + (n.busy ? ' busy' : '') + (n.kind === 'out' ? ' out' : '') + (n.badge ? ' wait' : ''); if (n.badge) p.el.setAttribute('data-n', n.badge); else p.el.removeAttribute('data-n');
        if (p.mon) p.mon.visible = !!n.pc;
        if (p.screen) { if (p.glow) { p.glow.kill(); p.glow = null; } p.screen.emissive.setRGB(n.busy ? .05 : 0, n.busy ? .42 : 0, n.busy ? .2 : 0); } /* 正在做事：屏幕亮绿色，和列表里的“正在”一样；不闪 */ });
      Object.keys(pets).forEach(function (k) { if (!ids[k]) dropPet(k); });
      var pos = solve(), d = first ? 0 : dur(.9); if (moving) moving.kill(); rel.visible = arcBox.visible = false;
      Object.keys(pos).forEach(function (k) { gsap.to(pets[k].g.position, { x: pos[k].x, z: pos[k].z, duration: d, ease: 'power2.inOut', overwrite: true }); });
      moving = gsap.delayedCall(d + .03, function () { drawRel(); rel.visible = arcBox.visible = true; aim(); }); dim();
    },
    select: function (id, reach, incoming) { var hop = id && id !== selId; selId = id; selReach = reach || []; selIn = incoming || []; if (!moving || !moving.isActive()) drawRel(); dim(); aim();
      if (hop && pets[id]) gsap.fromTo(pets[id].sp.scale, { x: 1.25, y: .75, z: 1.25 }, { x: 1, y: 1, z: 1, duration: dur(.7), ease: 'elastic.out(1,.4)' }); },
    resize: function () { resize(); }
  };
})();

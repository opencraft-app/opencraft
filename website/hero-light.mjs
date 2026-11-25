import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";

const imageWidth = 1536;
const imageHeight = 1024;
const tailLength = 6;
const paths = [
  [
    [513, 821],
    [586, 836],
    [700, 838],
    [821, 819],
    [944, 777],
    [1017, 730],
    [1035, 689],
    [1022, 658],
    [993, 638],
  ],
  [
    [1027, 590],
    [1084, 555],
    [1118, 519],
    [1134, 471],
    [1161, 434],
  ],
].map(
  (points) => new CatmullRomCurve3(points.map(([x, y]) => new Vector3(x - imageWidth / 2, imageHeight / 2 - y, 0))),
);

export function playHeroLight(figure, reducedMotion) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", { alpha: true, antialias: false, powerPreference: "low-power" });
  if (!context || reducedMotion.matches || document.hidden) return;

  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: false });
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const scene = new Scene();
  const geometry = new BufferGeometry();
  const count = paths.length * tailLength;
  const positions = new Float32Array(count * 3);
  const intensities = new Float32Array(count);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("intensity", new BufferAttribute(intensities, 1));

  const material = new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { pixelRatio: { value: 1 } },
    vertexShader: `
      attribute float intensity;
      uniform float pixelRatio;
      varying float glow;
      void main() {
        glow = intensity;
        gl_PointSize = pixelRatio * (7.0 + intensity * 12.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float glow;
      void main() {
        float radius = length(gl_PointCoord - vec2(0.5));
        float falloff = 1.0 - smoothstep(0.02, 0.5, radius);
        gl_FragColor = vec4(1.0, 0.53 + falloff * 0.33, 0.24 + falloff * 0.41, glow * falloff * falloff);
      }
    `,
  });

  const lights = new Points(geometry, material);
  lights.frustumCulled = false;
  scene.add(lights);
  canvas.setAttribute("aria-hidden", "true");
  figure.append(canvas);

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    const scale = Math.max(width / imageWidth, height / imageHeight);
    camera.left = -width / (2 * scale);
    camera.right = -camera.left;
    camera.top = height / (2 * scale);
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
    material.uniforms.pixelRatio.value = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(figure);
  resize();

  const start = performance.now();
  const position = new Vector3();
  let frame;
  function dispose() {
    cancelAnimationFrame(frame);
    observer.disconnect();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    canvas.remove();
  }

  function render(now) {
    const elapsed = (now - start) / 1000;
    if (elapsed > 5.2 || reducedMotion.matches || document.hidden || context.isContextLost()) {
      dispose();
      return;
    }

    paths.forEach((path, pathIndex) => {
      const front = ((elapsed - pathIndex * 0.55) / 2.25) % 1.22;
      for (let index = 0; index < tailLength; index += 1) {
        const point = pathIndex * tailLength + index;
        const progress = front - index * 0.021;
        const amount = Math.min(1, Math.max(0, progress));
        path.getPointAt(amount, position);
        position.toArray(positions, point * 3);
        const edge = Math.min(1, amount * 15, (1 - amount) * 15);
        intensities[point] = edge * (0.84 - index * 0.116);
      }
    });
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.intensity.needsUpdate = true;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  }

  frame = requestAnimationFrame(render);
}

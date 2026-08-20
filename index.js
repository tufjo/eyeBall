import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

// scene, camera, renderer
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x858585);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

// vsm shadow map
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

document.body.appendChild(renderer.domElement);

// bloom comp
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.08, // strength
  0.8, // smooth radius dispersion
  1.0  // threshold > 1.0 
);
composer.addPass(bloomPass);

// lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const areaLight = new THREE.RectAreaLight(0xffffff, 6.51, 6.4, 6.4);
areaLight.position.set(-5.108, 1.8, 6.5);
areaLight.rotation.set(
  THREE.MathUtils.degToRad(45.316),
  THREE.MathUtils.degToRad(-26.491),
  THREE.MathUtils.degToRad(342.34)
);
scene.add(areaLight);

const shadowLight = new THREE.PointLight(0xffffff, 30.0, 100);
shadowLight.position.set(-5.108, 1.8, 6.5);
shadowLight.castShadow = true;
shadowLight.shadow.mapSize.width = 1024;
shadowLight.shadow.mapSize.height = 1024;
shadowLight.shadow.camera.near = 0.5;
shadowLight.shadow.camera.far = 20;
shadowLight.shadow.radius = 15;
shadowLight.shadow.blurSamples = 25;
shadowLight.shadow.bias = -0.0001;
scene.add(shadowLight);

// material
const textureLoader = new THREE.TextureLoader();
const [coordTex, randTex, baseColorTex] = ['./assets/coord.png', './assets/rand_index.png', './assets/baseColor.png'].map((path) => {
  const tex = textureLoader.load(path);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
});

const sharedDisplacementUniforms = {
  uTime: { value: 0.0 },
  uWiggleFrequency: { value: 7.0 },
  uWiggleStrength: { value: 0.01 }
};

// glsl
const injectDisplacementShader = (shader) => {
  shader.vertexShader = `
    uniform float uTime;
    uniform float uWiggleFrequency;
    uniform float uWiggleStrength;
    varying vec2 vCustomUv;
    const float TWO_PI = 6.28318530718;
  ` + shader.vertexShader.replace(
    '#include <begin_vertex>',
    `
    #include <begin_vertex>
    vCustomUv = uv;
    float timePhase = (uTime / 5000.0) * TWO_PI * 6.0;
    float wave = sin(position.x * uWiggleFrequency + timePhase) 
               * cos(position.y * uWiggleFrequency + timePhase)
               * sin(position.z * uWiggleFrequency + timePhase);
    transformed += normal * (wave * uWiggleStrength);
    `
  );
};

const customMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.0, map: baseColorTex });
customMaterial.userData = { uCoordTex: { value: coordTex }, uRandTex: { value: randTex }, ...sharedDisplacementUniforms };

customMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, customMaterial.userData);
  injectDisplacementShader(shader);

  shader.fragmentShader = `
    uniform sampler2D uCoordTex;
    uniform sampler2D uRandTex;
    uniform float uTime;
    varying vec2 vCustomUv;

    vec4 pingPong(vec4 val, float scale) {
      float period = scale * 2.0;
      vec4 m = mod(val, period);
      return scale - abs(m - scale);
    }
  ` + shader.fragmentShader.replace(
    '#include <map_fragment>',
    `
    #include <map_fragment>
    vec4 texCoord = texture2D(uCoordTex, vCustomUv);
    vec4 texRand = texture2D(uRandTex, vCustomUv);
    vec4 texColor = texture2D(map, vCustomUv);

    float frameOffset = uTime * (0.82 / 820.0);

    vec4 val = texCoord - frameOffset;
    val = val + texRand;
    val = abs(val);
    val = pingPong(val, 0.41);
    val = val * 41.78;

    vec4 val2 = 1.0 - val;

    vec4 emissionMask = 1.0 - step(texCoord, vec4(0.82));
    
    // Reverted diffuse material blending: val controls base/overlay transition
    float maskFac = clamp(val.r, 0.0, 1.0);
    vec4 baseColor = vec4(1.0, 1.0, 1.0, 1.0); 
    vec4 overlayColor = texColor;
    vec4 finalColor = mix(baseColor, overlayColor, maskFac);
    diffuseColor = clamp(finalColor, 0.0, 1.0);
    `
  ).replace(
    '#include <emissivemap_fragment>',
    `
    #include <emissivemap_fragment>
    
    // Only blue emission applied on top driven by emissionMask
    vec3 blueEmit = emissionMask.rgb * vec3(0.26, 0.471, 0.831) * 1.0;
    vec3 whiteEmit = val.rgb * vec3(0.26, 0.471, 0.831) * 0.05;
    
    totalEmissiveRadiance += blueEmit + whiteEmit;
    `
  );
};

// navigation
const mouse = new THREE.Vector2(), smoothMouseEye = new THREE.Vector2(), smoothMouseOther = new THREE.Vector2();
const MAX_ANGLE_EYE = THREE.MathUtils.degToRad(30), MAX_ANGLE_OTHER = THREE.MathUtils.degToRad(20);
const EASE_FACTOR_BASE = 0.025, EASE_FACTOR_OTHER = 0.012;
let targetCameraZ = 5.0, eyeBall, bgPlane, stem, ring;

const easeInExpo = (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1)));

window.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  targetCameraZ = THREE.MathUtils.clamp(targetCameraZ + e.deltaY * 0.005, 2.0, 12.0);
}, { passive: false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// model loaders
const loader = new GLTFLoader();
const models = [
  { name: 'eyeBall', path: './assets/eyeBall.glb', pos: [0, 0, 0] },
  { name: 'bgPlane', path: './assets/bgPlane.glb', pos: [0, 0, -1] },
  { name: 'stem', path: './assets/stem.glb', pos: [0, 0, 0] },
  { name: 'ring', path: './assets/ring.glb', pos: [0, 0, 0] }
];

models.forEach(({ name, path, pos }) => {
  loader.load(path, (gltf) => {
    const obj = gltf.scene;
    obj.position.set(...pos);

    obj.traverse((child) => {
      if (!child.isMesh) return;

      if (name === 'bgPlane') {
        child.receiveShadow = true;
      } else {
        child.castShadow = true;
        child.receiveShadow = true;
      }

      if (name === 'eyeBall') {
        child.geometry.center();
        child.material = customMaterial;
      } else if (name === 'stem') {
        child.material.userData = { ...child.material.userData, ...sharedDisplacementUniforms };
        const origCompile = child.material.onBeforeCompile;
        child.material.onBeforeCompile = (shader) => {
          if (origCompile) origCompile(shader);
          Object.assign(shader.uniforms, sharedDisplacementUniforms);
          injectDisplacementShader(shader);
        };
      }
    });

    if (name === 'eyeBall') eyeBall = obj;
    if (name === 'bgPlane') bgPlane = obj;
    if (name === 'stem') stem = obj;
    if (name === 'ring') ring = obj;

    scene.add(obj);
  });
});

// animation loop
function animate() {
  requestAnimationFrame(animate);

  sharedDisplacementUniforms.uTime.value = (sharedDisplacementUniforms.uTime.value + 1.0) % 820.0;
  camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetCameraZ, EASE_FACTOR_BASE * 2.0);

  smoothMouseOther.lerp(mouse, EASE_FACTOR_OTHER);
  if (stem) stem.rotation.set(-smoothMouseOther.y * MAX_ANGLE_OTHER, smoothMouseOther.x * MAX_ANGLE_OTHER, 0);
  if (ring) ring.rotation.set(-smoothMouseOther.y * MAX_ANGLE_OTHER, smoothMouseOther.x * MAX_ANGLE_OTHER, 0);

  if (eyeBall) {
    const normDist = THREE.MathUtils.clamp(smoothMouseEye.distanceTo(mouse) / 1.5, 0.0, 1.0);
    const dynamicFactor = THREE.MathUtils.lerp(0.01, 0.25, easeInExpo(normDist));
    smoothMouseEye.lerp(mouse, dynamicFactor);
    eyeBall.rotation.set(-smoothMouseEye.y * MAX_ANGLE_EYE, smoothMouseEye.x * MAX_ANGLE_EYE, 0);
  }

  composer.render();
}

animate();
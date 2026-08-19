import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

//scene setup + camera
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x858585);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.z = 5;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// lighting
const pointLight = new THREE.PointLight(0xffffff, 50.0);
pointLight.position.set(2, 3, 4);
scene.add(pointLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambientLight);

// load textures
const textureLoader = new THREE.TextureLoader();
const coordTex = textureLoader.load('./assets/coord.png');
const randTex = textureLoader.load('./assets/rand_index.png');
const baseColorTex = textureLoader.load('./assets/baseColor.png');

//flip Y axis due to glb export issues & configure wrapping
[coordTex, randTex, baseColorTex].forEach((tex) => {
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
});

// standard mat
const customMaterial = new THREE.MeshStandardMaterial({
  roughness: 0.5,
  metalness: 0.0,
  map: baseColorTex
});

customMaterial.userData = {
  uCoordTex: { value: coordTex },
  uRandTex: { value: randTex },
  uTime: { value: 0.0 },
  uWiggleFrequency: { value: 7.0 },
  uWiggleStrength: { value: 0.02 }
};

customMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, customMaterial.userData);

  //for displacement
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

  // ping-pong
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
  //shader
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
    
    float maskFac = clamp(val.r, 0.0, 1.0);
    vec4 baseColor = vec4(1.0, 1.0, 1.0, 1.0); 
    vec4 overlayColor = texColor;
    vec4 finalColor = mix(baseColor, overlayColor, maskFac);
    diffuseColor = clamp(finalColor, 0.0, 1.0);
    `
  );
};

//mouse movement and zoom
const mouse = new THREE.Vector2(0, 0);
const smoothMouse = new THREE.Vector2(0, 0);

const MAX_ANGLE = THREE.MathUtils.degToRad(35);
const EASE_FACTOR = 0.025;

let targetCameraZ = 5.0;
const MIN_ZOOM = 2.0;
const MAX_ZOOM = 12.0;
const ZOOM_SENSITIVITY = 0.005;

let eyeBall = null;
let bgPlane = null;

window.addEventListener('mousemove', (event) => {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('wheel', (event) => {
  event.preventDefault();
  targetCameraZ += event.deltaY * ZOOM_SENSITIVITY;
  targetCameraZ = THREE.MathUtils.clamp(targetCameraZ, MIN_ZOOM, MAX_ZOOM);
}, { passive: false });

// load models
const loader = new GLTFLoader();

loader.load(
  './assets/eyeBall.glb',
  (gltf) => {
    eyeBall = gltf.scene;

    eyeBall.traverse((child) => {
      if (child.isMesh) {
        child.geometry.center();
        child.material = customMaterial;
      }
    });

    eyeBall.position.set(0, 0, 0);
    scene.add(eyeBall);
  },
  undefined,
  (error) => console.error('Error loading eyeBall model:', error)
);

loader.load(
  './assets/bgPlane.glb',
  (gltf) => {
    bgPlane = gltf.scene;

    bgPlane.position.set(0, 0, -2.5); //move bg plane pos

    scene.add(bgPlane);
  },
  undefined,
  (error) => console.error('Error loading bgPlane model:', error)
);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// animation loop
function animate() {
  requestAnimationFrame(animate);

  customMaterial.userData.uTime.value = (customMaterial.userData.uTime.value + 1.0) % 820.0;

  camera.position.z = THREE.MathUtils.lerp(camera.position.z, targetCameraZ, EASE_FACTOR * 2.0);

  if (eyeBall) {
    smoothMouse.x = THREE.MathUtils.lerp(smoothMouse.x, mouse.x, EASE_FACTOR);
    smoothMouse.y = THREE.MathUtils.lerp(smoothMouse.y, mouse.y, EASE_FACTOR);

    eyeBall.rotation.y = smoothMouse.x * MAX_ANGLE;
    eyeBall.rotation.x = -smoothMouse.y * MAX_ANGLE;
  }

  renderer.render(scene, camera);
}

animate();
#ifdef GL_ES
precision mediump float;
#endif

varying vec2 vUV;

uniform sampler2D textureSampler; // scene colour buffer
uniform float u_progress;         // 0-1: how far the ring has expanded
uniform float u_active;           // 1.0 while PULSING, 0.0 when IDLE
uniform vec2  u_resolution;       // viewport width × height in pixels

void main() {
  vec4 scene = texture2D(textureSampler, vUV);

  if (u_active < 0.5) {
    gl_FragColor = scene;
    return;
  }

  // Correct for aspect ratio so the ring stays circular.
  float aspect = u_resolution.x / u_resolution.y;
  vec2  offset = (vUV - 0.5) * vec2(aspect, 1.0);
  float dist   = length(offset); // 0 = centre, ~0.9 = corner of 16:9

  // Ring radius expands from 0 to ~0.9 over the pulse duration.
  float maxRadius = 0.9;
  float ringAt    = u_progress * maxRadius;
  float ringWidth = 0.025;

  // Smooth soft edge — bright at the ring boundary, zero elsewhere.
  float edge = 1.0 - smoothstep(0.0, ringWidth, abs(dist - ringAt));

  // Fade intensity as the ring expands so it feels like it dissipates.
  float intensity = edge * (1.0 - u_progress * 0.6);

  // Neon cyan (#00f5ff) — matches the Pulse City brand and ScanBar active colour.
  vec3 neon = vec3(0.0, 0.961, 1.0);

  gl_FragColor = vec4(mix(scene.rgb, neon, intensity * 0.65), scene.a);
}

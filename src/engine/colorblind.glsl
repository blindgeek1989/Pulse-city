#ifdef GL_ES
precision highp float;
#endif

// Colorblind correction post-process.
//
// Pipeline: simulation → error → redistribution → output
//
// Simulation matrices: Viénot et al. (1999) in sRGB space (column-major GLSL).
// Daltonization: Fidaner (2008) error-redistribution — moves information
// from the lost channel into the two preserved channels, so colorblind
// players can distinguish hues that were previously indistinguishable.
//
// u_mode:  0 = NONE  1 = DEUTERANOPIA  2 = PROTANOPIA  3 = TRITANOPIA

varying vec2      vUV;
uniform sampler2D textureSampler;
uniform int       u_mode;

// ── Simulation matrices (Viénot et al. 1999) ─────────────────────────────────
// Deuteranopia — green M-cone absent
const mat3 SIM_DEUT = mat3(
    vec3(0.625, 0.700, 0.000),  // col 0: R input  → (R', G', B') contributions
    vec3(0.375, 0.300, 0.300),  // col 1: G input
    vec3(0.000, 0.000, 0.700)   // col 2: B input
);

// Protanopia — red L-cone absent
const mat3 SIM_PROT = mat3(
    vec3(0.567, 0.558, 0.000),
    vec3(0.433, 0.442, 0.242),
    vec3(0.000, 0.000, 0.758)
);

// Tritanopia — blue S-cone absent
const mat3 SIM_TRIT = mat3(
    vec3(0.950, 0.000, 0.000),
    vec3(0.050, 0.433, 0.475),
    vec3(0.000, 0.567, 0.525)
);

// ── Error-redistribution matrices (Fidaner 2008) ──────────────────────────────
// Applied to (original − simulated); the result is added back to the original.
// Each matrix shifts the lost-channel error into the two preserved channels.

// Deuteranopia: green lost → redistribute R-error and G-error into B
const mat3 ERR_DEUT = mat3(
    vec3(0.0, 0.0, 0.7),  // col 0: delta.r → (corrR, corrG, corrB)
    vec3(0.0, 0.0, 0.7),  // col 1: delta.g
    vec3(0.0, 0.0, 0.0)   // col 2: delta.b
);

// Protanopia: red lost → redistribute R-error into G and B
const mat3 ERR_PROT = mat3(
    vec3(0.0, 0.7, 0.7),
    vec3(0.0, 0.0, 0.0),
    vec3(0.0, 0.0, 0.0)
);

// Tritanopia: blue lost → redistribute B-error into R and G
const mat3 ERR_TRIT = mat3(
    vec3(0.0, 0.0, 0.0),
    vec3(0.0, 0.0, 0.0),
    vec3(0.7, 0.7, 0.0)
);

void main() {
    vec4 color = texture2D(textureSampler, vUV);

    if (u_mode == 0) {
        gl_FragColor = color;
        return;
    }

    mat3 sim;
    mat3 err;

    if (u_mode == 1) {
        sim = SIM_DEUT; err = ERR_DEUT;
    } else if (u_mode == 2) {
        sim = SIM_PROT; err = ERR_PROT;
    } else {
        sim = SIM_TRIT; err = ERR_TRIT;
    }

    vec3 delta   = color.rgb - sim * color.rgb;  // information lost to the deficiency
    vec3 shifted = color.rgb + err * delta;       // add it back on the preserved axes

    gl_FragColor = vec4(clamp(shifted, 0.0, 1.0), color.a);
}

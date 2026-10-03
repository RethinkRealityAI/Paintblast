// Headless-only: SwiftShader returns 0 for GLSL smoothstep(e, e, x) (undefined
// behaviour), and uikit's clipping/AA uses smoothstep(-fwidth, fwidth, d) where
// fwidth is 0 for its "infinite" clip planes, so every panel and glyph discards.
// Patch shader sources to a defined fallback. Never shipped.
(() => {
  const helper =
    '\nhighp float _pbss(highp float g, highp float d) { return g > 0.0 ? smoothstep(-g, g, d) : step(0.0, d); }\n';
  const re = /smoothstep\(\s*-\s*([\w.]+)\s*,\s*\1\s*,\s*([\w.]+)\s*\)/g;
  for (const Ctx of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!Ctx) continue;
    const orig = Ctx.prototype.shaderSource;
    Ctx.prototype.shaderSource = function (shader, src) {
      if (re.test(src)) {
        re.lastIndex = 0;
        src = src.replace(re, '_pbss($1, $2)');
        const nl = src.startsWith('#version') ? src.indexOf('\n') + 1 : 0;
        src = src.slice(0, nl) + helper + src.slice(nl);
      }
      re.lastIndex = 0;
      return orig.call(this, shader, src);
    };
  }
})();

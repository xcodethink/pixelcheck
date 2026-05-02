import type { DeviceFingerprint } from "./fingerprints.js";

/**
 * Generate a stealth init script for a specific device profile.
 *
 * Implements 15 anti-detection patches:
 *  1. navigator.webdriver = false
 *  2. window.chrome runtime stub
 *  3. Plugin array with realistic Plugin objects (not just numbers)
 *  4. navigator.languages override
 *  5. navigator.platform override
 *  6. hardwareConcurrency / deviceMemory
 *  7. maxTouchPoints
 *  8. screen.* properties
 *  9. WebGL UNMASKED_VENDOR / UNMASKED_RENDERER via Proxy
 *  10. Permissions API repair (notifications)
 *  11. Canvas fingerprint per-session noise (XOR seed)
 *  12. AudioContext fingerprint noise
 *  13. Error stack trace cleanup (remove playwright artifacts)
 *  14. Date.getTimezoneOffset spoofing
 *  15. Connection API stub
 *
 * Uses Proxy + native function disguise so toString() returns "[native code]"
 * and the patches survive basic detection checks.
 */
export function buildStealthScript(fp: DeviceFingerprint): string {
  return `
(() => {
  // ── Helper: define property that looks native ──
  const nativeGet = (obj, prop, val) => {
    const desc = { get: new Proxy(function() {}, {
      apply: () => val,
      get: (target, p) => p === 'toString'
        ? () => \`function get \${prop}() { [native code] }\`
        : Reflect.get(target, p),
    }), configurable: true, enumerable: true };
    try { Object.defineProperty(obj, prop, desc); } catch (e) {}
  };

  // 1. webdriver
  nativeGet(navigator, 'webdriver', false);

  // 2. Chrome runtime (only for Chrome UA)
  ${
    fp.userAgent.includes("Chrome")
      ? `
  if (!window.chrome) {
    window.chrome = {
      runtime: {
        connect: () => {},
        sendMessage: () => {},
        id: undefined,
        onMessage: { addListener: () => {}, removeListener: () => {} },
      },
      loadTimes: () => ({ commitLoadTime: Date.now() / 1000, firstPaintTime: 0 }),
      csi: () => ({ startE: Date.now(), onloadT: Date.now() }),
      app: { isInstalled: false },
    };
  }`
      : "// Safari UA — no chrome object expected"
  }

  // 3. Plugins (realistic Plugin objects, not number array)
  const pluginData = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
  ];
  try {
    const pluginArray = Object.create(PluginArray.prototype);
    pluginData.forEach((p, i) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: p.name },
        filename: { value: p.filename },
        description: { value: p.description },
        length: { value: p.length },
      });
      Object.defineProperty(pluginArray, i, { value: plugin, enumerable: true });
    });
    Object.defineProperty(pluginArray, 'length', { value: pluginData.length });
    nativeGet(navigator, 'plugins', pluginArray);
  } catch (e) {}

  // 4. Languages (will be overridden again per-context)
  nativeGet(navigator, 'languages', Object.freeze(${JSON.stringify(fp.languages)}));
  nativeGet(navigator, 'language', ${JSON.stringify(fp.languages[0])});

  // 5. Platform
  nativeGet(navigator, 'platform', ${JSON.stringify(fp.platform)});

  // 6. Hardware
  nativeGet(navigator, 'hardwareConcurrency', ${fp.cores});
  nativeGet(navigator, 'deviceMemory', ${fp.memory});

  // 7. Touch
  nativeGet(navigator, 'maxTouchPoints', ${fp.maxTouchPoints});

  // 8. Screen
  nativeGet(screen, 'width', ${fp.screen.width});
  nativeGet(screen, 'height', ${fp.screen.height});
  nativeGet(screen, 'availWidth', ${fp.screen.width});
  nativeGet(screen, 'availHeight', ${fp.screen.height - 40});
  nativeGet(screen, 'colorDepth', ${fp.screen.colorDepth});
  nativeGet(screen, 'pixelDepth', ${fp.screen.colorDepth});

  // 9. WebGL
  const hookWebGL = (Proto) => {
    const orig = Proto.prototype.getParameter;
    Proto.prototype.getParameter = new Proxy(orig, {
      apply(target, thisArg, args) {
        if (args[0] === 37445) return ${JSON.stringify(fp.webglVendor)};
        if (args[0] === 37446) return ${JSON.stringify(fp.webglRenderer)};
        return Reflect.apply(target, thisArg, args);
      },
      get(target, prop) {
        if (prop === 'toString') return () => 'function getParameter() { [native code] }';
        return Reflect.get(target, prop);
      },
    });
  };
  if (typeof WebGLRenderingContext !== 'undefined') hookWebGL(WebGLRenderingContext);
  if (typeof WebGL2RenderingContext !== 'undefined') hookWebGL(WebGL2RenderingContext);

  // 10. Permissions API
  if (navigator.permissions) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) => {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(desc);
    };
  }

  // 11. Canvas noise (per-session, not per-call)
  const seed = Math.floor(Math.random() * 256);
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...a) {
    try {
      const ctx = this.getContext('2d');
      if (ctx && this.width > 0 && this.height > 0) {
        const d = ctx.getImageData(0, 0, 1, 1);
        d.data[0] = d.data[0] ^ seed;
        ctx.putImageData(d, 0, 0);
      }
    } catch (e) {}
    return origToDataURL.apply(this, a);
  };

  // 12. AudioContext fingerprint noise
  if (typeof AudioContext !== 'undefined') {
    const origCreate = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function(...a) {
      const osc = origCreate.apply(this, a);
      try { osc.frequency.value += (seed % 10) * 0.001; } catch (e) {}
      return osc;
    };
  }

  // 13. Remove Playwright/automation artifacts from Error stack traces
  const origError = Error;
  try {
    window.Error = class extends origError {
      constructor(...a) {
        super(...a);
        if (this.stack) {
          this.stack = this.stack
            .split('\\n')
            .filter(l => !l.includes('playwright') && !l.includes('__pw') && !l.includes('puppeteer'))
            .join('\\n');
        }
      }
    };
  } catch (e) {}

  // 14. Date.getTimezoneOffset (will be overridden per-persona via context option,
  //     this is fallback for when context option not set)
  // Skipped here — context-level timezoneId is more reliable.

  // 15. Connection API
  if (navigator.connection) {
    nativeGet(navigator.connection, 'effectiveType', '4g');
    nativeGet(navigator.connection, 'rtt', 50);
    nativeGet(navigator.connection, 'downlink', 10);
  } else {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
      configurable: true,
    });
  }
})();
`;
}

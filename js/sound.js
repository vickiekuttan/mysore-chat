// 8-bit sound effects, made on the fly with the Web Audio API (no sound
// files to download). Browsers only allow sound after you've clicked or
// typed something on the page, so the first sounds wait for that.
(function () {
  const KEY = 'pz_sound';
  let ctx = null;
  let last = 0;
  const read = () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch (_) { /* private mode */ } };
  let on = read() !== '0';

  function audio() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!ctx) ctx = new C();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Square-wave notes, like an old sound chip. notes: [[hz, seconds], ...]
  function tune(notes, volume) {
    const a = audio();
    if (!a || a.state !== 'running') return;
    let t = a.currentTime + 0.01;
    const out = a.createGain();
    out.gain.value = volume;
    out.connect(a.destination);
    notes.forEach(([hz, len]) => {
      if (!hz) { t += len; return; }   // a rest
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(hz, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.005);
      g.gain.setValueAtTime(1, t + len * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + len + 0.02);
      t += len;
    });
  }

  const SOUNDS = {
    // someone posts in the room you're looking at
    message: () => tune([[1319, 0.05], [1760, 0.07]], 0.05),
    // a friend chat message, or someone @mentions you
    ping: () => tune([[1047, 0.06], [1319, 0.06], [1568, 0.06], [2093, 0.1]], 0.06),
    // a friend request
    knock: () => tune([[784, 0.07], [0, 0.04], [784, 0.07], [1175, 0.12]], 0.06)
  };

  function play(kind) {
    if (!on || !SOUNDS[kind]) return;
    const now = Date.now();
    if (now - last < 350) return;   // a burst of messages is one blip, not a drum roll
    last = now;
    try { SOUNDS[kind](); } catch (_) { /* no sound is fine */ }
  }

  // Unlock audio on the first click, tap or key press.
  const unlock = () => { if (on) audio(); };
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));

  window.PZ = window.PZ || {};
  window.PZ.sound = {
    play,
    get on() { return on; },
    set(v) { on = !!v; write(on ? '1' : '0'); if (on) { audio(); play('message'); } }
  };
})();

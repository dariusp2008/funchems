const { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

const VIEW_W = 1200;

const buildPath = (shape, curviness, ribbonWidth, viewH) => {
  const CX = VIEW_W / 2;
  const CY = viewH / 2;
  const c = Math.max(0, curviness);
  const room = Math.max(12, CY - Math.max(0, ribbonWidth) / 2 - 6);
  switch (shape) {
    case 'circle': {
      const r = Math.min(90 + c * 0.95, room);
      return `M ${CX - r} ${CY} A ${r} ${r} 0 1 1 ${CX + r} ${CY} A ${r} ${r} 0 1 1 ${CX - r} ${CY} Z`;
    }
    case 'arch': {
      const rise = Math.min(120 + c * 1.1, room * 2);
      return `M 120 ${CY + rise / 2} Q ${CX} ${CY - rise * 1.5} ${VIEW_W - 120} ${CY + rise / 2}`;
    }
    case 'line':
      return `M -320 ${CY} L ${VIEW_W + 320} ${CY}`;
    case 'wave':
    default: {
      const a = Math.min(c * 2.2, room * 2);
      return `M -320 ${CY} Q -160 ${CY - a} 0 ${CY} T 320 ${CY} T 640 ${CY} T 960 ${CY} T 1280 ${CY} T ${VIEW_W + 320} ${CY}`;
    }
  }
};

function TextLoop({
  text = 'Find your best deal',
  shape = 'wave',
  path,
  speed = 90,
  direction = 'forward',
  separator = '◆',
  curviness = 26,
  viewH = 150,
  fontSize = 26,
  fontWeight = 600,
  letterSpacing = 1,
  uppercase = false,
  fontFamily = "'IBM Plex Sans', Helvetica, sans-serif",
  color = '#ffffff',
  ribbon = true,
  ribbonColor = '#111318',
  ribbonWidth = 64,
  pauseOnHover = true,
  style = {}
}) {
  const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
  const H = num(viewH, 150);
  const rw = ribbon ? num(ribbonWidth, 64) : 0;
  const spd = num(speed, 90);

  const rootRef = useRef(null);
  const pathRef = useRef(null);
  const measureRef = useRef(null);
  const headRef = useRef(null);
  const tailRef = useRef(null);
  const [metrics, setMetrics] = useState({ length: 0, reps: 1 });

  const pathId = 'text-loop-' + useId().replace(/:/g, '');
  const d = useMemo(() => path || buildPath(shape, num(curviness, 26), rw, H), [path, shape, curviness, rw, H]);

  const unit = useMemo(() => {
    const base = uppercase ? String(text).toUpperCase() : String(text);
    const gap = separator ? `\u00A0\u00A0${separator}\u00A0\u00A0` : '\u00A0\u00A0\u00A0';
    return `${base}${gap}`;
  }, [text, separator, uppercase]);

  const textStyle = useMemo(
    () => ({ fontSize: num(fontSize, 26) + 'px', fontWeight, letterSpacing: num(letterSpacing, 1) + 'px', fontFamily }),
    [fontSize, fontWeight, letterSpacing, fontFamily]
  );

  useLayoutEffect(() => {
    const pathEl = pathRef.current, measureEl = measureRef.current;
    if (!pathEl || !measureEl) return undefined;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      let length = 0, unitWidth = 0;
      try { length = pathEl.getTotalLength(); unitWidth = measureEl.getComputedTextLength(); } catch (e) { return; }
      if (!length) return;
      const reps = unitWidth > 0 ? Math.max(1, Math.round(length / unitWidth)) : 1;
      setMetrics((prev) => (prev.length === length && prev.reps === reps ? prev : { length, reps }));
    };
    measure();
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [d, unit, fontSize, fontWeight, letterSpacing]);

  useEffect(() => {
    const { length } = metrics;
    const head = headRef.current, tail = tailRef.current;
    if (!head || !tail || !length) return undefined;
    const apply = (offset) => {
      const partner = offset >= 0 ? offset - length : offset + length;
      head.setAttribute('startOffset', String(offset));
      tail.setAttribute('startOffset', String(partner));
    };
    apply(0);
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || spd <= 0) return undefined;

    let raf = 0, last = performance.now(), offset = 0, paused = false;
    const dir = direction === 'reverse' ? -1 : 1;
    const tick = (now) => {
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      if (!paused) {
        offset += dir * spd * dt;
        if (offset > length) offset -= length;
        if (offset < -length) offset += length;
        apply(offset);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const root = rootRef.current;
    const pause = () => { paused = true; };
    const resume = () => { paused = false; };
    if (pauseOnHover && root) {
      root.addEventListener('pointerenter', pause);
      root.addEventListener('pointerleave', resume);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (pauseOnHover && root) {
        root.removeEventListener('pointerenter', pause);
        root.removeEventListener('pointerleave', resume);
      }
    };
  }, [metrics, spd, direction, pauseOnHover]);

  const loopText = unit.repeat(metrics.reps);
  const fitLength = metrics.length || undefined;

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', ...style }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={text}
        style={{ display: 'block', width: '100%', height: '100%' }}
      >
        <path
          ref={pathRef}
          id={pathId}
          d={d}
          fill="none"
          stroke={ribbon ? ribbonColor : 'none'}
          strokeWidth={rw}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text ref={measureRef} style={{ ...textStyle, visibility: 'hidden', pointerEvents: 'none' }} aria-hidden="true">{unit}</text>
        <text style={{ ...textStyle, userSelect: 'none' }} fill={color} dominantBaseline="central" aria-hidden="true">
          <textPath ref={headRef} href={`#${pathId}`} startOffset={0} textLength={fitLength} lengthAdjust="spacing">{loopText}</textPath>
        </text>
        <text style={{ ...textStyle, userSelect: 'none' }} fill={color} dominantBaseline="central" aria-hidden="true">
          <textPath ref={tailRef} href={`#${pathId}`} startOffset={0} textLength={fitLength} lengthAdjust="spacing">{loopText}</textPath>
        </text>
      </svg>
    </div>
  );
}

module.exports = { TextLoop };

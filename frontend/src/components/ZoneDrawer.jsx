import { useEffect, useRef } from 'react';

const HANDLE = 12; // px

/**
 * Simple drag-to-size rectangle drawer used to mark the dustbin zone.
 * Coordinates are normalized 0..1 against the canvas so they are resolution
 * independent (same convention the backend classification uses).
 *   <ZoneDrawer imageDataUrl={...} box={{x1,y1,x2,y2}} onChange={setBox} />
 * Drag a corner to resize; drag inside the box to move it.
 */
export default function ZoneDrawer({ imageDataUrl, box, onChange, canvasW = 640, canvasH = 360 }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const dragRef = useRef(null); // {mode:'corner'|'move', corner}
  const boxRef = useRef(box);
  boxRef.current = box;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const imgUrlRef = useRef(imageDataUrl);
  imgUrlRef.current = imageDataUrl;

  const pos = (e) => {
    const cv = canvasRef.current;
    const r = cv.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { x, y };
  };

  const draw = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, cv.width, cv.height);

    const img = imgRef.current;
    if (img && img.width) {
      const scale = Math.min(cv.width / img.width, cv.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
    } else {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Upload a snapshot of the dustbin area to draw the zone', cv.width / 2, cv.height / 2);
      ctx.textAlign = 'left';
    }

    const b = boxRef.current;
    if (!b) return;
    const x = b.x1 * cv.width, y = b.y1 * cv.height;
    const w = (b.x2 - b.x1) * cv.width, h = (b.y2 - b.y1) * cv.height;
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(34,197,94,0.25)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#22c55e';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      ctx.fillRect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
    }
  };

  useEffect(() => {
    draw();
  });

  useEffect(() => {
    const url = imgUrlRef.current;
    if (!url) return;
    const img = new Image();
    img.onload = () => { imgRef.current = img; draw(); };
    img.onerror = () => { imgRef.current = null; draw(); };
    img.src = url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageDataUrl]);

  const nearestCorner = (p) => {
    const b = boxRef.current;
    if (!b) return null;
    const corners = [
      { corner: 'tl', x: b.x1, y: b.y1 }, { corner: 'tr', x: b.x2, y: b.y1 },
      { corner: 'bl', x: b.x1, y: b.y2 }, { corner: 'br', x: b.x2, y: b.y2 },
    ];
    for (const c of corners) {
      if (Math.hypot((p.x - c.x) * canvasW, (p.y - c.y) * canvasH) <= HANDLE + 4) return c.corner;
    }
    return null;
  };

  const onDown = (e) => {
    const p = pos(e);
    const corner = nearestCorner(p);
    const b = boxRef.current;
    if (corner) { dragRef.current = { mode: 'corner', corner }; return; }
    if (b && p.x > b.x1 && p.x < b.x2 && p.y > b.y1 && p.y < b.y2) {
      dragRef.current = { mode: 'move', dx: p.x - b.x1, dy: p.y - b.y1 };
      return;
    }
    // draw a new box from scratch
    const start = p;
    dragRef.current = { mode: 'new', start };
  };

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  const onMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pos(e);
    const b = boxRef.current || { x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 };
    let next;
    if (drag.mode === 'new') {
      next = {
        x1: clamp01(Math.min(drag.start.x, p.x)), y1: clamp01(Math.min(drag.start.y, p.y)),
        x2: clamp01(Math.max(drag.start.x, p.x)), y2: clamp01(Math.max(drag.start.y, p.y)),
      };
    } else if (drag.mode === 'move') {
      const nx1 = clamp01(p.x - drag.dx), ny1 = clamp01(p.y - drag.dy);
      next = { x1: nx1, y1: ny1, x2: clamp01(nx1 + (b.x2 - b.x1)), y2: clamp01(ny1 + (b.y2 - b.y1)) };
    } else {
      next = { ...b };
      if (drag.corner.includes('l')) next.x1 = clamp01(p.x); else next.x2 = clamp01(p.x);
      if (drag.corner.includes('t')) next.y1 = clamp01(p.y); else next.y2 = clamp01(p.y);
      if (next.x2 - next.x1 < 0.02 || next.y2 - next.y1 < 0.02) return;
    }
    boxRef.current = next;
    onChangeRef.current(next);
    draw();
  };

  const onUp = () => { dragRef.current = null; };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        style={{ width: '100%', maxWidth: canvasW }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      />
    </div>
  );
}
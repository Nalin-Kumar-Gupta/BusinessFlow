import { describe, expect, it } from 'vitest';

import { computeFittedImageBox, mapPinToFrame, mapRectToFrame } from '../../../src/ui/export/pdf/annotation-geometry.js';

describe('pdf annotation geometry', () => {
  it('centers a wide image vertically in the fixed frame', () => {
    const box = computeFittedImageBox(220, 150, 1600, 800);
    expect(box.left).toBe(0);
    expect(box.width).toBe(220);
    expect(box.height).toBeCloseTo(110, 5);
    expect(box.top).toBeCloseTo(20, 5);
  });

  it('centers a tall image horizontally in the fixed frame', () => {
    const box = computeFittedImageBox(220, 150, 800, 1600);
    expect(box.top).toBe(0);
    expect(box.height).toBe(150);
    expect(box.width).toBeCloseTo(75, 5);
    expect(box.left).toBeCloseTo(72.5, 5);
  });

  it('maps pin percentages into the fitted image area (not letterbox)', () => {
    const box = computeFittedImageBox(220, 150, 1600, 800);
    const pin = mapPinToFrame(50, 50, box);
    expect(pin?.left).toBeCloseTo(110, 5);
    expect(pin?.top).toBeCloseTo(75, 5);
  });

  it('maps highlight rectangles into fitted image coordinates', () => {
    const box = computeFittedImageBox(220, 150, 1600, 800);
    const rect = mapRectToFrame({ xPercent: 10, yPercent: 20, widthPercent: 30, heightPercent: 40 }, box);
    expect(rect?.left).toBeCloseTo(22, 5);
    expect(rect?.top).toBeCloseTo(42, 5);
    expect(rect?.width).toBeCloseTo(66, 5);
    expect(rect?.height).toBeCloseTo(44, 5);
  });

  it('clamps out-of-range percentages safely', () => {
    const box = computeFittedImageBox(220, 150, 1600, 800);
    const pin = mapPinToFrame(999, -20, box);
    expect(pin?.left).toBeCloseTo(220, 5);
    expect(pin?.top).toBeCloseTo(20, 5);
  });
});

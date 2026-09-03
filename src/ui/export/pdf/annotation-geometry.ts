export interface FittedImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function computeFittedImageBox(
  frameWidth: number,
  frameHeight: number,
  imageWidth: number,
  imageHeight: number,
): FittedImageBox {
  if (frameWidth <= 0 || frameHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(0, frameWidth), height: Math.max(0, frameHeight) };
  }

  const frameAspect = frameWidth / frameHeight;
  const imageAspect = imageWidth / imageHeight;

  if (imageAspect >= frameAspect) {
    const width = frameWidth;
    const height = width / imageAspect;
    return { left: 0, top: (frameHeight - height) / 2, width, height };
  }

  const height = frameHeight;
  const width = height * imageAspect;
  return { left: (frameWidth - width) / 2, top: 0, width, height };
}

export function mapPinToFrame(
  xPercent: number,
  yPercent: number,
  box: FittedImageBox,
): { left: number; top: number } | undefined {
  if (box.width <= 0 || box.height <= 0) return undefined;
  const left = box.left + (clampPercent(xPercent) / 100) * box.width;
  const top = box.top + (clampPercent(yPercent) / 100) * box.height;
  return { left, top };
}

export function mapRectToFrame(
  rect: { xPercent: number; yPercent: number; widthPercent: number; heightPercent: number } | undefined,
  box: FittedImageBox,
): { left: number; top: number; width: number; height: number } | undefined {
  if (!rect || box.width <= 0 || box.height <= 0) return undefined;

  const left = box.left + (clampPercent(rect.xPercent) / 100) * box.width;
  const top = box.top + (clampPercent(rect.yPercent) / 100) * box.height;
  const width = (clampPercent(rect.widthPercent) / 100) * box.width;
  const height = (clampPercent(rect.heightPercent) / 100) * box.height;
  if (width <= 0 || height <= 0) return undefined;

  return { left, top, width, height };
}

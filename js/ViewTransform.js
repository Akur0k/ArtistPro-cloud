export class ViewTransform {
  constructor(docWidth, docHeight) {
    this.docWidth = docWidth;
    this.docHeight = docHeight;
    this.scale = 1;
    this.rotation = 0;
    this.panX = 0;
    this.panY = 0;
    this.minScale = 0.02;
    this.maxScale = 40;
  }

  setScaleClamped(next) {
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, next));
  }

  fitTo(viewportWidth, viewportHeight, margin = 0.9) {
    this.scale = Math.min(viewportWidth / this.docWidth, viewportHeight / this.docHeight) * margin;
    this.rotation = 0;
    this.panX = 0;
    this.panY = 0;
  }

  cssTransform() {
    return `translate(${this.panX}px, ${this.panY}px) rotate(${this.rotation}rad) scale(${this.scale})`;
  }

  documentToScreen(docX, docY, viewportCenter) {
    const lx = docX - this.docWidth / 2;
    const ly = docY - this.docHeight / 2;
    const sx = lx * this.scale;
    const sy = ly * this.scale;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    return {
      x: viewportCenter.x + (sx * cos - sy * sin) + this.panX,
      y: viewportCenter.y + (sx * sin + sy * cos) + this.panY,
    };
  }

  screenToDocument(clientX, clientY, viewportCenter) {
    const vx = clientX - viewportCenter.x - this.panX;
    const vy = clientY - viewportCenter.y - this.panY;
    const cos = Math.cos(-this.rotation);
    const sin = Math.sin(-this.rotation);
    const lx = (vx * cos - vy * sin) / this.scale;
    const ly = (vx * sin + vy * cos) / this.scale;
    return {
      x: lx + this.docWidth / 2,
      y: ly + this.docHeight / 2,
    };
  }

  reanchor(viewportCenter, anchorDoc, targetClientX, targetClientY) {
    const screenNow = this.documentToScreen(anchorDoc.x, anchorDoc.y, viewportCenter);
    this.panX += targetClientX - screenNow.x;
    this.panY += targetClientY - screenNow.y;
  }
}

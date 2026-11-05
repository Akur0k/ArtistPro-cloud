// Minimal, single-video-track, non-fragmented MP4 (ISO BMFF) muxer.
// Takes pre-encoded H.264 access units (AVCC format: each NAL unit prefixed
// by a 4-byte big-endian length, no Annex-B start codes — exactly what
// WebCodecs' VideoEncoder emits when configured with avc:{format:'avc'}),
// plus the AVCDecoderConfigurationRecord WebCodecs hands back in
// metadata.decoderConfig.description, and produces a playable .mp4 file.
// No external libraries — same spirit as the hand-rolled PNG encoder.

function u8(...bytes) { return new Uint8Array(bytes); }

function u16be(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}
function i16be(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n);
  return b;
}
function u32be(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function fixed1616(n) {
  return u32be(Math.round(n * 65536));
}
function fixed88(n) {
  return u16be(Math.round(n * 256));
}
function strBytes(s) {
  return new TextEncoder().encode(s);
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function box(type, ...payloadParts) {
  const payload = concatBytes(payloadParts);
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(strBytes(type), 4);
  out.set(payload, 8);
  return out;
}

function identityMatrix() {
  return concatBytes([
    u32be(0x00010000), u32be(0), u32be(0),
    u32be(0), u32be(0x00010000), u32be(0),
    u32be(0), u32be(0), u32be(0x40000000),
  ]);
}

function ftypBox() {
  return box('ftyp',
    strBytes('isom'), u32be(512),
    strBytes('isom'), strBytes('iso2'), strBytes('avc1'), strBytes('mp41'),
  );
}

function mvhdBox(timescale, duration) {
  return box('mvhd',
    u32be(0),
    u32be(0), u32be(0),
    u32be(timescale),
    u32be(duration),
    fixed1616(1),
    fixed88(1),
    u16be(0),
    u32be(0), u32be(0),
    identityMatrix(),
    u32be(0), u32be(0), u32be(0), u32be(0), u32be(0), u32be(0),
    u32be(2),
  );
}

function tkhdBox(trackId, duration, width, height) {
  return box('tkhd',
    u8(0, 0, 0, 0x07),
    u32be(0), u32be(0),
    u32be(trackId),
    u32be(0),
    u32be(duration),
    u32be(0), u32be(0),
    u16be(0),
    u16be(0),
    u16be(0),
    u16be(0),
    identityMatrix(),
    fixed1616(width),
    fixed1616(height),
  );
}

function mdhdBox(timescale, duration) {
  return box('mdhd',
    u32be(0),
    u32be(0), u32be(0),
    u32be(timescale),
    u32be(duration),
    u16be(0x55c4), // language = 'und'
    u16be(0),
  );
}

function hdlrBox() {
  return box('hdlr',
    u32be(0),
    u32be(0),
    strBytes('vide'),
    u32be(0), u32be(0), u32be(0),
    concatBytes([strBytes('VideoHandler'), u8(0)]),
  );
}

function vmhdBox() {
  return box('vmhd',
    u8(0, 0, 0, 1),
    u16be(0),
    u16be(0), u16be(0), u16be(0),
  );
}

function urlBox() {
  return box('url ', u8(0, 0, 0, 1));
}

function drefBox() {
  return box('dref', u32be(0), u32be(1), urlBox());
}

function dinfBox() {
  return box('dinf', drefBox());
}

function avcCBox(descriptionBytes) {
  return box('avcC', descriptionBytes);
}

function avc1Box(width, height, avcC) {
  const compressorName = new Uint8Array(32);
  return box('avc1',
    u8(0, 0, 0, 0, 0, 0),
    u16be(1),
    u16be(0), u16be(0),
    u32be(0), u32be(0), u32be(0),
    u16be(width),
    u16be(height),
    fixed1616(72),
    fixed1616(72),
    u32be(0),
    u16be(1),
    compressorName,
    u16be(0x0018),
    i16be(-1),
    avcC,
  );
}

function stsdBox(avc1) {
  return box('stsd', u32be(0), u32be(1), avc1);
}

function sttsBox(sampleCount, sampleDelta) {
  return box('stts', u32be(0), u32be(1), u32be(sampleCount), u32be(sampleDelta));
}

function stscBox(samplesPerChunk) {
  return box('stsc', u32be(0), u32be(1), u32be(1), u32be(samplesPerChunk), u32be(1));
}

// which samples are keyframes (1-based). Without it every frame counts as
// one — Safari then seeks straight onto a delta frame and shows garbage /
// nothing (Chrome and ffmpeg recover by themselves, so it goes unnoticed)
function stssBox(keyIndices) {
  const parts = [u32be(0), u32be(keyIndices.length)];
  for (const i of keyIndices) parts.push(u32be(i + 1));
  return box('stss', ...parts);
}

function stszBox(sizes) {
  const parts = [u32be(0), u32be(0), u32be(sizes.length)];
  for (const s of sizes) parts.push(u32be(s));
  return box('stsz', ...parts);
}

function stcoBox(chunkOffset) {
  return box('stco', u32be(0), u32be(1), u32be(chunkOffset));
}

function stblBox(stsd, stts, stss, stsc, stsz, stco) {
  return box('stbl', stsd, stts, stss, stsc, stsz, stco);
}

function minfBox(vmhd, dinf, stbl) {
  return box('minf', vmhd, dinf, stbl);
}

function mdiaBox(mdhd, hdlr, minf) {
  return box('mdia', mdhd, hdlr, minf);
}

function trakBox(tkhd, mdia) {
  return box('trak', tkhd, mdia);
}

function moovBox(mvhd, trak) {
  return box('moov', mvhd, trak);
}

function mdatBox(payload) {
  return box('mdat', payload);
}

// a frame lasts this many units of the track's clock — a clock ticking only
// `fps` times a second is legal but unusual, and Apple's player is picky
const UNITS_PER_FRAME = 1000;

// samples: array of { data: Uint8Array, key: boolean }, one AVCC access unit
// per video frame, in presentation order. All samples share one duration
// (constant frame rate); timescale: frames per second.
// description: AVCDecoderConfigurationRecord bytes (WebCodecs gives this to
// you directly via the encoder's output metadata).
export function muxMp4({ width, height, timescale, durationTicks, samples, description }) {
  const sizes = samples.map(s => s.data.length);
  const mdatPayload = concatBytes(samples.map(s => s.data));
  const keys = samples.flatMap((s, i) => (s.key ? [i] : []));
  timescale *= UNITS_PER_FRAME;
  durationTicks *= UNITS_PER_FRAME;

  const avcC = avcCBox(description);
  const avc1 = avc1Box(width, height, avcC);
  const stsd = stsdBox(avc1);
  const stts = sttsBox(samples.length, UNITS_PER_FRAME);
  const stss = stssBox(keys);
  const stsc = stscBox(samples.length);
  const stsz = stszBox(sizes);

  function build(mdatOffset) {
    const ftyp = ftypBox();
    const mvhd = mvhdBox(timescale, durationTicks);
    const tkhd = tkhdBox(1, durationTicks, width, height);
    const mdhd = mdhdBox(timescale, durationTicks);
    const hdlr = hdlrBox();
    const vmhd = vmhdBox();
    const dinf = dinfBox();
    const stco = stcoBox(mdatOffset);
    const stbl = stblBox(stsd, stts, stss, stsc, stsz, stco);
    const minf = minfBox(vmhd, dinf, stbl);
    const mdia = mdiaBox(mdhd, hdlr, minf);
    const trak = trakBox(tkhd, mdia);
    const moov = moovBox(mvhd, trak);
    return { ftyp, moov };
  }

  // stco's offset value doesn't change any box's byte length (always a fixed
  // 4-byte field), so build once to measure ftyp+moov, then rebuild with the
  // real offset now known — avoids manual in-place patching.
  let { ftyp, moov } = build(0);
  const mdatHeaderSize = 8;
  const offset = ftyp.length + moov.length + mdatHeaderSize;
  ({ ftyp, moov } = build(offset));

  const mdat = mdatBox(mdatPayload);
  return concatBytes([ftyp, moov, mdat]);
}

// Streaming variant of muxMp4: writes ftyp + mdat header + each sample
// directly to a FileSystemWritableFileStream (OPFS) as they arrive, instead
// of buffering every encoded sample's bytes in a JS array first. Only the
// per-sample sizes (a handful of bytes each) stay in memory — the actual
// encoded video data lives on disk the whole time. This is what makes very
// long exports (thousands of frames) not blow up browser memory.
//
// Layout is ftyp + mdat + moov (moov last). mdat's size field is written as
// a placeholder up front and patched via a positioned write once the total
// is known — this needs FileSystemWritableFileStream's `{type:'write',
// position, data}` form, not just sequential appends.
export class StreamingMp4Writer {
  constructor(writable, { width, height, timescale }) {
    this.writable = writable;
    this.width = width;
    this.height = height;
    this.timescale = timescale;
    this.sizes = [];
    this.keys = [];
    this.offset = 0;
    this.mdatHeaderOffset = null;
    this.mdatPayloadOffset = null;
  }

  async start() {
    await this._append(ftypBox());
    this.mdatHeaderOffset = this.offset;
    // placeholder size (0) — patched in finish() once the true size is known
    await this._append(concatBytes([u32be(0), strBytes('mdat')]));
    this.mdatPayloadOffset = this.offset;
  }

  async addSample(bytes, key) {
    if (key) this.keys.push(this.sizes.length);
    this.sizes.push(bytes.length);
    await this._append(bytes);
  }

  async finish(description, durationTicks) {
    const timescale = this.timescale * UNITS_PER_FRAME;
    durationTicks *= UNITS_PER_FRAME;
    const totalPayload = this.offset - this.mdatPayloadOffset;
    const mdatSize = 8 + totalPayload;
    await this.writable.write({ type: 'write', position: this.mdatHeaderOffset, data: u32be(mdatSize) });

    const avcC = avcCBox(description);
    const avc1 = avc1Box(this.width, this.height, avcC);
    const stsd = stsdBox(avc1);
    const stts = sttsBox(this.sizes.length, UNITS_PER_FRAME);
    const stss = stssBox(this.keys);
    const stsc = stscBox(this.sizes.length);
    const stsz = stszBox(this.sizes);
    const stco = stcoBox(this.mdatPayloadOffset);
    const stbl = stblBox(stsd, stts, stss, stsc, stsz, stco);
    const mvhd = mvhdBox(timescale, durationTicks);
    const tkhd = tkhdBox(1, durationTicks, this.width, this.height);
    const mdhd = mdhdBox(timescale, durationTicks);
    const hdlr = hdlrBox();
    const vmhd = vmhdBox();
    const dinf = dinfBox();
    const minf = minfBox(vmhd, dinf, stbl);
    const mdia = mdiaBox(mdhd, hdlr, minf);
    const trak = trakBox(tkhd, mdia);
    const moov = moovBox(mvhd, trak);

    // the mdat-size patch above seeked the stream backward — resume writing
    // from the real end of the file explicitly, don't rely on cursor state.
    await this.writable.write({ type: 'write', position: this.offset, data: moov });
    this.offset += moov.length;

    await this.writable.close();
  }

  async abort() {
    try { await this.writable.close(); } catch { /* already closed/errored */ }
  }

  async _append(bytes) {
    await this.writable.write(bytes);
    this.offset += bytes.length;
  }
}
